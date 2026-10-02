import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { auditEvents, contracts } from './store.js';
import type { AuditEvent, Contract, Milestone, MilestoneStatus } from './store.js';

/**
 * 合同对账台账：发票、付款、凭证是唯一事实来源。
 * 里程碑状态与合同/项目汇总一律从明细推导，不允许手工维护 paid 字段。
 */

export type VoucherType = 'bank-slip' | 'e-invoice' | 'receipt';
export interface Voucher { type: VoucherType; reference: string; issuedBy: string; amount: number; }
export interface Invoice { id: string; contractId: string; milestoneId: string; number: string; amount: number; idempotencyKey: string; issuedAt: string; createdAt: string; }
export interface Payment { id: string; contractId: string; milestoneId: string; amount: number; method: 'bank-transfer' | 'check' | 'escrow'; voucher: Voucher; idempotencyKey: string; paidAt: string; createdAt: string; }
export interface MilestoneView extends Milestone { invoiced: number; paid: number; status: MilestoneStatus; }
export interface ContractView extends Omit<Contract, 'milestones'> { milestones: MilestoneView[]; invoiced: number; paid: number; version: number; }

export type FinanceErrorCode = 'CONTRACT_NOT_FOUND' | 'MILESTONE_NOT_FOUND' | 'VALIDATION' | 'INVALID_VOUCHER' | 'DUPLICATE_VOUCHER' | 'OVER_INVOICED' | 'OVERPAYMENT' | 'IDEMPOTENCY_CONFLICT' | 'STALE_VERSION';
export class FinanceError extends Error {
  constructor(public readonly status: number, public readonly code: FinanceErrorCode, message: string) { super(message); this.name = 'FinanceError'; }
}

export interface InvoiceInput { contractId: string; milestoneId: string; number: string; amount: number; idempotencyKey: string; issuedAt?: string; expectedVersion?: number; actor?: string; }
export interface PaymentInput { contractId: string; milestoneId: string; amount: number; method?: Payment['method']; voucher: Voucher; idempotencyKey: string; paidAt?: string; expectedVersion?: number; actor?: string; }

const invoices: Invoice[] = [];
const payments: Payment[] = [];
/** 每个合同的乐观锁版本号：任何明细变更都会自增，客户端回传旧版本即冲突 */
const versions = new Map<string, number>();
/** 幂等注册表：键 → 请求指纹 + 已落账记录 id。同键同内容重放安全，同键换内容报错 */
const idempotency = new Map<string, { kind: 'invoice' | 'payment'; fingerprint: string; recordId: string }>();

const round = (n: number) => Math.round(n * 100) / 100;
const VOUCHER_TYPES: VoucherType[] = ['bank-slip', 'e-invoice', 'receipt'];
const VOUCHER_REFERENCE = /^[A-Z0-9][A-Z0-9-]{4,31}$/;
const fingerprintOf = (fields: Record<string, unknown>) => JSON.stringify(fields);

function findContract(contractId: string): Contract {
  const contract = contracts.find(item => item.id === contractId);
  if (!contract) throw new FinanceError(404, 'CONTRACT_NOT_FOUND', `合同 ${contractId} 不存在`);
  return contract;
}
function findMilestone(contract: Contract, milestoneId: string): Milestone {
  const milestone = contract.milestones.find(item => item.id === milestoneId);
  if (!milestone) throw new FinanceError(404, 'MILESTONE_NOT_FOUND', `合同 ${contract.id} 没有节点 ${milestoneId}`);
  return milestone;
}
function assertAmount(amount: number, label: string): number {
  const rounded = round(amount);
  if (!Number.isFinite(rounded) || rounded <= 0) throw new FinanceError(422, 'VALIDATION', `${label}必须为正数`);
  return rounded;
}
function assertVersion(contractId: string, expectedVersion?: number) {
  if (expectedVersion === undefined || expectedVersion === null) return;
  const current = versions.get(contractId) ?? 0;
  if (current !== expectedVersion) throw new FinanceError(409, 'STALE_VERSION', `合同 ${contractId} 的对账明细已变化（当前版本 ${current}，持有版本 ${expectedVersion}），请刷新后重试`);
}
function audit(action: string, entityId: string, actor: string, details: string) {
  const event: AuditEvent = { id: `AUD-${Date.now()}-${auditEvents.length}`, action, entity: 'contract', entityId, actor, at: new Date().toISOString(), details };
  auditEvents.unshift(event);
}

export function milestoneTotals(contractId: string, milestoneId: string) {
  const invoiced = round(invoices.filter(item => item.contractId === contractId && item.milestoneId === milestoneId).reduce((sum, item) => sum + item.amount, 0));
  const paid = round(payments.filter(item => item.contractId === contractId && item.milestoneId === milestoneId).reduce((sum, item) => sum + item.amount, 0));
  return { invoiced, paid };
}
export function milestoneStatusOf(amount: number, invoiced: number, paid: number): MilestoneStatus {
  if (paid >= amount) return 'paid';
  if (invoiced > 0 || paid > 0) return 'invoiced';
  return 'open';
}
export function contractView(contractId: string): ContractView {
  const contract = findContract(contractId);
  const milestones = contract.milestones.map(milestone => {
    const { invoiced, paid } = milestoneTotals(contract.id, milestone.id);
    return { ...milestone, invoiced, paid, status: milestoneStatusOf(milestone.amount, invoiced, paid) };
  });
  return { ...contract, milestones, invoiced: round(milestones.reduce((sum, item) => sum + item.invoiced, 0)), paid: round(milestones.reduce((sum, item) => sum + item.paid, 0)), version: versions.get(contract.id) ?? 0 };
}
export function contractLedger(contractId: string) {
  const view = contractView(contractId);
  return { contract: view, invoices: invoices.filter(item => item.contractId === contractId), payments: payments.filter(item => item.contractId === contractId) };
}
export function projectFinance(projectId: string) {
  const views = contracts.filter(item => item.projectId === projectId).map(item => contractView(item.id));
  return { contracts: views, committed: round(views.reduce((sum, item) => sum + item.committed, 0)), invoiced: round(views.reduce((sum, item) => sum + item.invoiced, 0)), paid: round(views.reduce((sum, item) => sum + item.paid, 0)), exposure: round(views.reduce((sum, item) => sum + item.ceiling, 0)) };
}

function validateVoucher(voucher: Voucher, amount: number) {
  if (!voucher || typeof voucher !== 'object') throw new FinanceError(422, 'INVALID_VOUCHER', '付款必须附带凭证');
  if (!VOUCHER_TYPES.includes(voucher.type)) throw new FinanceError(422, 'INVALID_VOUCHER', `凭证类型无效，仅支持 ${VOUCHER_TYPES.join('/')}`);
  if (!voucher.reference || !VOUCHER_REFERENCE.test(voucher.reference)) throw new FinanceError(422, 'INVALID_VOUCHER', '凭证编号格式无效（需 6-32 位大写字母、数字或连字符）');
  if (!voucher.issuedBy || !voucher.issuedBy.trim()) throw new FinanceError(422, 'INVALID_VOUCHER', '凭证开具方不能为空');
  if (round(voucher.amount) !== amount) throw new FinanceError(422, 'INVALID_VOUCHER', `凭证金额 ${voucher.amount} 与付款金额 ${amount} 不一致`);
  const duplicate = payments.find(item => item.voucher.reference === voucher.reference);
  if (duplicate) throw new FinanceError(409, 'DUPLICATE_VOUCHER', `凭证 ${voucher.reference} 已用于付款 ${duplicate.id}，不能重复入账`);
}

export function registerInvoice(input: InvoiceInput): { invoice: Invoice; contract: ContractView; replayed: boolean } {
  const contract = findContract(input.contractId);
  const milestone = findMilestone(contract, input.milestoneId);
  const amount = assertAmount(input.amount, '发票金额');
  if (!input.idempotencyKey || !input.idempotencyKey.trim()) throw new FinanceError(422, 'VALIDATION', '缺少幂等键 idempotencyKey');
  if (!input.number || !input.number.trim()) throw new FinanceError(422, 'VALIDATION', '发票号不能为空');
  const number = input.number.trim();
  const fingerprint = fingerprintOf({ kind: 'invoice', contractId: contract.id, milestoneId: milestone.id, number, amount });
  const existing = idempotency.get(input.idempotencyKey);
  if (existing) {
    if (existing.kind === 'invoice' && existing.fingerprint === fingerprint) {
      const invoice = invoices.find(item => item.id === existing.recordId);
      if (invoice) return { invoice, contract: contractView(contract.id), replayed: true };
    }
    throw new FinanceError(409, 'IDEMPOTENCY_CONFLICT', `幂等键 ${input.idempotencyKey} 已绑定其他内容的发票登记，禁止换内容重放`);
  }
  assertVersion(contract.id, input.expectedVersion);
  const { invoiced } = milestoneTotals(contract.id, milestone.id);
  if (round(invoiced + amount) > milestone.amount) throw new FinanceError(409, 'OVER_INVOICED', `节点「${milestone.name}」累计开票 ${round(invoiced + amount)} 将超过节点金额 ${milestone.amount}（已开票 ${invoiced}）`);
  const invoice: Invoice = { id: `INV-${Date.now()}-${invoices.length}`, contractId: contract.id, milestoneId: milestone.id, number, amount, idempotencyKey: input.idempotencyKey, issuedAt: input.issuedAt ?? new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() };
  invoices.push(invoice);
  idempotency.set(input.idempotencyKey, { kind: 'invoice', fingerprint, recordId: invoice.id });
  versions.set(contract.id, (versions.get(contract.id) ?? 0) + 1);
  audit('INVOICE_REGISTERED', contract.id, input.actor ?? '财务专员', `节点「${milestone.name}」登记发票 ${number}，金额 ${amount}，累计开票 ${round(invoiced + amount)} / ${milestone.amount}`);
  persist();
  return { invoice, contract: contractView(contract.id), replayed: false };
}

export function registerPayment(input: PaymentInput): { payment: Payment; contract: ContractView; replayed: boolean } {
  const contract = findContract(input.contractId);
  const milestone = findMilestone(contract, input.milestoneId);
  const amount = assertAmount(input.amount, '付款金额');
  if (!input.idempotencyKey || !input.idempotencyKey.trim()) throw new FinanceError(422, 'VALIDATION', '缺少幂等键 idempotencyKey');
  const fingerprint = fingerprintOf({ kind: 'payment', contractId: contract.id, milestoneId: milestone.id, amount, voucher: input.voucher?.reference });
  const existing = idempotency.get(input.idempotencyKey);
  if (existing) {
    if (existing.kind === 'payment' && existing.fingerprint === fingerprint) {
      const payment = payments.find(item => item.id === existing.recordId);
      if (payment) return { payment, contract: contractView(contract.id), replayed: true };
    }
    throw new FinanceError(409, 'IDEMPOTENCY_CONFLICT', `幂等键 ${input.idempotencyKey} 已绑定其他内容的付款登记，禁止换内容重放`);
  }
  assertVersion(contract.id, input.expectedVersion);
  validateVoucher(input.voucher, amount);
  // 检查与提交之间没有 await，Node 事件循环内并发请求会串行经过此处，不会超额扣减
  const { paid } = milestoneTotals(contract.id, milestone.id);
  const remaining = round(milestone.amount - paid);
  if (amount > remaining) {
    audit('PAYMENT_REJECTED', contract.id, input.actor ?? '财务专员', `节点「${milestone.name}」付款 ${amount} 超额：剩余应付 ${remaining}（节点金额 ${milestone.amount}，已付 ${paid}），已拒绝`);
    throw new FinanceError(409, 'OVERPAYMENT', `节点「${milestone.name}」剩余应付 ${remaining}，付款 ${amount} 超额，已拒绝`);
  }
  const payment: Payment = { id: `PAY-${Date.now()}-${payments.length}`, contractId: contract.id, milestoneId: milestone.id, amount, method: input.method ?? 'bank-transfer', voucher: { ...input.voucher, amount }, idempotencyKey: input.idempotencyKey, paidAt: input.paidAt ?? new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() };
  payments.push(payment);
  idempotency.set(input.idempotencyKey, { kind: 'payment', fingerprint, recordId: payment.id });
  versions.set(contract.id, (versions.get(contract.id) ?? 0) + 1);
  const paidAfter = round(paid + amount);
  audit('PAYMENT_REGISTERED', contract.id, input.actor ?? '财务专员', `节点「${milestone.name}」付款 ${amount}（凭证 ${payment.voucher.reference}），累计已付 ${paidAfter} / ${milestone.amount}`);
  if (paidAfter >= milestone.amount) audit('MILESTONE_PAID', contract.id, '系统', `节点「${milestone.name}」累计确认付款达到节点金额 ${milestone.amount}，状态转为 paid`);
  persist();
  return { payment, contract: contractView(contract.id), replayed: false };
}

// ---------- 快照持久化：服务重启 / 页面刷新后从磁盘恢复台账与幂等注册表 ----------

interface Snapshot { invoices: Invoice[]; payments: Payment[]; versions: Record<string, number>; idempotency: [string, { kind: 'invoice' | 'payment'; fingerprint: string; recordId: string }][]; auditEvents: AuditEvent[]; }
let snapshotFile: string | null = null;

export function initFinancePersistence(file: string) {
  snapshotFile = file;
  if (!existsSync(file)) return;
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
  invoices.splice(0, invoices.length, ...snapshot.invoices);
  payments.splice(0, payments.length, ...snapshot.payments);
  versions.clear();
  for (const [key, value] of Object.entries(snapshot.versions)) versions.set(key, value);
  idempotency.clear();
  for (const [key, value] of snapshot.idempotency) idempotency.set(key, value);
  auditEvents.splice(0, auditEvents.length, ...snapshot.auditEvents);
}
function persist() {
  if (!snapshotFile) return;
  const snapshot: Snapshot = { invoices, payments, versions: Object.fromEntries(versions), idempotency: [...idempotency.entries()], auditEvents };
  mkdirSync(dirname(snapshotFile), { recursive: true });
  const tmp = `${snapshotFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  renameSync(tmp, snapshotFile);
}

// ---------- 基线台账：供应商已开票并分次付款的历史明细，汇总全部由明细推导 ----------

function seed() {
  const at = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
  const day = (days: number) => at(days).slice(0, 10);
  const seedInvoice = (contractId: string, milestoneId: string, number: string, amount: number, days: number) => invoices.push({ id: `INV-SEED-${invoices.length + 1}`, contractId, milestoneId, number, amount, idempotencyKey: `seed:${number}`, issuedAt: day(days), createdAt: at(days) });
  const seedPayment = (contractId: string, milestoneId: string, amount: number, reference: string, issuedBy: string, days: number) => payments.push({ id: `PAY-SEED-${payments.length + 1}`, contractId, milestoneId, amount, method: 'bank-transfer', voucher: { type: 'bank-slip', reference, issuedBy, amount }, idempotencyKey: `seed:${reference}`, paidAt: day(days), createdAt: at(days) });
  // CTR-01 曜石后期：锁剪交付 120 万已开票并分两次付清；母版验收开票 80 万、已付 50 万
  seedInvoice('CTR-01', 'CTR-01-M1', 'INV-2026-0141', 1200000, -21);
  seedPayment('CTR-01', 'CTR-01-M1', 600000, 'BNK-2026-090201', '曜石后期制作', -14);
  seedPayment('CTR-01', 'CTR-01-M1', 600000, 'BNK-2026-091502', '曜石后期制作', -6);
  seedInvoice('CTR-01', 'CTR-01-M2', 'INV-2026-0158', 800000, -9);
  seedPayment('CTR-01', 'CTR-01-M2', 500000, 'BNK-2026-092403', '曜石后期制作', -3);
  // CTR-02 远景国际：签署节点已付清，版权证明节点已开票待付
  seedInvoice('CTR-02', 'CTR-02-M1', 'INV-2026-0092', 440000, -18);
  seedPayment('CTR-02', 'CTR-02-M1', 440000, 'BNK-2026-091104', '远景国际版权', -12);
  seedInvoice('CTR-02', 'CTR-02-M2', 'INV-2026-0105', 440000, -4);
  // CTR-03 云帧视觉：素材包一已开票，首付 30 万
  seedInvoice('CTR-03', 'CTR-03-M1', 'INV-2026-0177', 500000, -7);
  seedPayment('CTR-03', 'CTR-03-M1', 300000, 'BNK-2026-092505', '云帧视觉', -2);
  for (const contract of contracts) {
    const ops = invoices.filter(item => item.contractId === contract.id).length + payments.filter(item => item.contractId === contract.id).length;
    versions.set(contract.id, ops);
  }
  for (const invoice of invoices) idempotency.set(invoice.idempotencyKey, { kind: 'invoice', fingerprint: fingerprintOf({ kind: 'invoice', contractId: invoice.contractId, milestoneId: invoice.milestoneId, number: invoice.number, amount: invoice.amount }), recordId: invoice.id });
  for (const payment of payments) idempotency.set(payment.idempotencyKey, { kind: 'payment', fingerprint: fingerprintOf({ kind: 'payment', contractId: payment.contractId, milestoneId: payment.milestoneId, amount: payment.amount, voucher: payment.voucher.reference }), recordId: payment.id });
}
seed();

/** 仅测试用：清空台账并重新播种，且关闭持久化 */
export function resetFinanceForTests() {
  snapshotFile = null;
  invoices.splice(0, invoices.length);
  payments.splice(0, payments.length);
  versions.clear();
  idempotency.clear();
  seed();
}
