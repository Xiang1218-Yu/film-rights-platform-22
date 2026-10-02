import { createHash } from 'node:crypto';

export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type MilestoneStatus = 'open' | 'invoiced' | 'paid';
export type VoucherStatus = 'valid' | 'void';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }

export interface Milestone {
  id: string;
  contractId: string;
  name: string;
  due: string;
  amount: number;
  status: MilestoneStatus;
  version: number;
  invoicedAmount: number;
  paidAmount: number;
  remainingAmount: number;
}
export interface Invoice { id: string; contractId: string; milestoneId: string; invoiceNo: string; amount: number; issuedAt: string; createdAt: string; version: number; paidAmount: number; remainingAmount: number; }
export interface Voucher { id: string; contractId?: string; voucherNo: string; amount: number; status: VoucherStatus; issuedAt: string; createdAt: string; version: number; usedAmount: number; remainingAmount: number; }
export interface Payment { id: string; contractId: string; milestoneId: string; invoiceId: string; voucherId: string; paymentNo: string; amount: number; paidAt: string; createdAt: string; version: number; }
export interface Contract {
  id: string;
  projectId: string;
  vendor: string;
  scope: string;
  ceiling: number;
  committed: number;
  invoiced: number;
  paid: number;
  remaining: number;
  milestones: Milestone[];
  invoices: Invoice[];
  vouchers: Voucher[];
  payments: Payment[];
  auditEvents: AuditEvent[];
}

export interface Asset { id: string; projectId: string; name: string; type: AssetType; version: number; status: 'draft' | 'review' | 'approved' | 'locked'; owner: string; checksum: string; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[]; }
export interface Approval { id: string; projectId: string; entityType: 'budget' | 'asset' | 'delivery'; entityId: string; title: string; requestedBy: string; status: ApprovalStatus; approver: string; createdAt: string; comment?: string; }
export interface AuditEvent { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string; contractId?: string; }

interface ContractRecord { id: string; projectId: string; vendor: string; scope: string; ceiling: number; milestones: MilestoneRecord[]; }
interface MilestoneRecord { id: string; name: string; due: string; amount: number; version: number; }
interface InvoiceRecord { id: string; contractId: string; milestoneId: string; invoiceNo: string; amount: number; issuedAt: string; createdAt: string; version: number; }
interface VoucherRecord { id: string; contractId?: string; voucherNo: string; amount: number; status: VoucherStatus; issuedAt: string; createdAt: string; version: number; }
interface PaymentRecord { id: string; contractId: string; milestoneId: string; invoiceId: string; voucherId: string; paymentNo: string; amount: number; paidAt: string; createdAt: string; version: number; }
interface IdempotencyRecord { key: string; action: string; fingerprint: string; status: number; result: unknown; createdAt: string; replays: number; }

interface ActorInput { actor?: string; }
export interface InvoiceInput extends ActorInput {
  milestoneId: string;
  invoiceNo: string;
  amount: number;
  issuedAt?: string;
  expectedStatus?: MilestoneStatus;
  expectedVersion?: number;
}
export interface VoucherInput extends ActorInput {
  voucherNo: string;
  amount: number;
  status?: VoucherStatus;
  issuedAt?: string;
  contractId?: string;
}
export interface PaymentInput extends ActorInput {
  milestoneId: string;
  invoiceId: string;
  voucherId: string;
  paymentNo: string;
  amount: number;
  paidAt?: string;
  expectedStatus?: MilestoneStatus;
  expectedVersion?: number;
}

export class LedgerError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'LedgerError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);
const today = iso(0);

let projects: Project[] = [];
let budgetLines: BudgetLine[] = [];
let contractRecords: ContractRecord[] = [];
let invoiceRecords: InvoiceRecord[] = [];
let voucherRecords: VoucherRecord[] = [];
let paymentRecords: PaymentRecord[] = [];
let assets: Asset[] = [];
let approvals: Approval[] = [];
let auditEvents: AuditEvent[] = [];
let idempotencyRecords: IdempotencyRecord[] = [];
let idSequence = 300;
let ledgerChain: Promise<unknown> = Promise.resolve();

function nextId(prefix: string) { idSequence += 1; return `${prefix}-${idSequence}`; }
function moneyAmount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new LedgerError(422, 'INVALID_AMOUNT', `${field} 必须是大于 0 的整数金额`, { field });
  }
  return value;
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new LedgerError(422, 'VALIDATION_ERROR', `${field} 不能为空`, { field });
  return value.trim();
}
function isoDate(value: string | undefined, field: string): string {
  const candidate = value ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || Number.isNaN(new Date(`${candidate}T00:00:00Z`).getTime())) {
    throw new LedgerError(422, 'VALIDATION_ERROR', `${field} 必须是 YYYY-MM-DD 日期`, { field });
  }
  return candidate;
}
function addAudit(action: string, entity: string, entityId: string, actor: string, details: Record<string, unknown>, contractId?: string) {
  const event = { id: nextId('AUD'), action, entity, entityId, actor, at: new Date().toISOString(), details: JSON.stringify(details), ...(contractId ? { contractId } : {}) };
  auditEvents.unshift(event);
  return event;
}
function findContract(contractId: string): ContractRecord {
  const contract = contractRecords.find(item => item.id === contractId);
  if (!contract) throw new LedgerError(404, 'CONTRACT_NOT_FOUND', '合同不存在', { contractId });
  return contract;
}
function findMilestoneRecord(contract: ContractRecord, milestoneId: string) {
  const milestone = contract.milestones.find(item => item.id === milestoneId);
  if (!milestone) throw new LedgerError(404, 'MILESTONE_NOT_FOUND', '合同节点不存在', { contractId: contract.id, milestoneId });
  return milestone;
}
function assertStale(milestone: MilestoneRecord, expectedStatus: MilestoneStatus | undefined, expectedVersion: number | undefined) {
  if (expectedStatus && milestoneStatus(milestone.id) !== expectedStatus) {
    throw new LedgerError(409, 'STALE_STATE', '节点状态已变化，请刷新后重试', { currentStatus: milestoneStatus(milestone.id), expectedStatus, currentVersion: milestone.version, expectedVersion });
  }
  if (typeof expectedVersion === 'number' && milestone.version !== expectedVersion) {
    throw new LedgerError(409, 'STALE_VERSION', '节点版本已变化，请刷新后重试', { currentVersion: milestone.version, expectedVersion });
  }
}
function milestoneInvoiced(milestoneId: string) { return invoiceRecords.filter(item => item.milestoneId === milestoneId).reduce((sum, item) => sum + item.amount, 0); }
function milestonePaid(milestoneId: string) { return paymentRecords.filter(item => item.milestoneId === milestoneId).reduce((sum, item) => sum + item.amount, 0); }
function invoicePaid(invoiceId: string) { return paymentRecords.filter(item => item.invoiceId === invoiceId).reduce((sum, item) => sum + item.amount, 0); }
function voucherUsed(voucherId: string) { return paymentRecords.filter(item => item.voucherId === voucherId).reduce((sum, item) => sum + item.amount, 0); }
function milestoneStatus(milestoneId: string): MilestoneStatus {
  const paid = milestonePaid(milestoneId);
  const amount = contractRecords.flatMap(contract => contract.milestones).find(item => item.id === milestoneId)?.amount ?? 0;
  if (paid >= amount && amount > 0) return 'paid';
  return milestoneInvoiced(milestoneId) > 0 ? 'invoiced' : 'open';
}

function toMilestone(contract: ContractRecord, record: MilestoneRecord): Milestone {
  const invoicedAmount = milestoneInvoiced(record.id);
  const paidAmount = milestonePaid(record.id);
  return { id: record.id, contractId: contract.id, name: record.name, due: record.due, amount: record.amount, status: milestoneStatus(record.id), version: record.version, invoicedAmount, paidAmount, remainingAmount: record.amount - paidAmount };
}
function toInvoice(record: InvoiceRecord): Invoice {
  const paidAmount = invoicePaid(record.id);
  return { ...record, paidAmount, remainingAmount: record.amount - paidAmount };
}
function toVoucher(record: VoucherRecord): Voucher {
  const usedAmount = voucherUsed(record.id);
  return { ...record, usedAmount, remainingAmount: record.status === 'valid' ? record.amount - usedAmount : 0 };
}
function toContract(contract: ContractRecord): Contract {
  const milestones = contract.milestones.map(item => toMilestone(contract, item));
  const invoices = invoiceRecords.filter(item => item.contractId === contract.id).map(toInvoice);
  const payments = paymentRecords.filter(item => item.contractId === contract.id);
  const voucherIds = new Set([...voucherRecords.filter(item => item.contractId === contract.id).map(item => item.id), ...payments.map(item => item.voucherId)]);
  const vouchers = voucherRecords.filter(item => voucherIds.has(item.id)).map(toVoucher);
  const committed = milestones.reduce((sum, item) => sum + item.amount, 0);
  const invoiced = invoices.reduce((sum, item) => sum + item.amount, 0);
  const paid = payments.reduce((sum, item) => sum + item.amount, 0);
  return { id: contract.id, projectId: contract.projectId, vendor: contract.vendor, scope: contract.scope, ceiling: contract.ceiling, committed, invoiced, paid, remaining: committed - paid, milestones, invoices, vouchers, payments, auditEvents: auditEvents.filter(event => event.contractId === contract.id) };
}

export function listProjects() { return projects; }
export function listBudgetLines(projectId?: string) { return budgetLines.filter(line => !projectId || line.projectId === projectId); }
export function listAssets(projectId?: string) { return assets.filter(asset => !projectId || asset.projectId === projectId); }
export function listContracts(projectId?: string): Contract[] {
  return contractRecords.filter(contract => !projectId || contract.projectId === projectId).map(toContract);
}
export function getContract(contractId: string): Contract {
  return toContract(findContract(contractId));
}

export function registerVoucher(input: VoucherInput) {
  const actor = input.actor?.trim() || '财务操作员';
  const voucherNo = requiredText(input.voucherNo, 'voucherNo');
  const amount = moneyAmount(input.amount, 'amount');
  const status = input.status === undefined ? 'valid' : input.status;
  if (status !== 'valid' && status !== 'void') throw new LedgerError(422, 'INVALID_VOUCHER_STATUS', '凭证状态只能是 valid 或 void');
  if (voucherRecords.some(item => item.voucherNo === voucherNo)) throw new LedgerError(409, 'DUPLICATE_VOUCHER_NO', '凭证编号已存在', { voucherNo });
  let contractId: string | undefined;
  if (input.contractId) { const contract = findContract(input.contractId); contractId = contract.id; }
  const issuedAt = isoDate(input.issuedAt, 'issuedAt');
  const voucher: VoucherRecord = { id: nextId('VCR'), contractId, voucherNo, amount, status, issuedAt, createdAt: new Date().toISOString(), version: 1 };
  voucherRecords.push(voucher);
  addAudit('REGISTER_VOUCHER', 'voucher', voucher.id, actor, { voucherNo, amount, status, issuedAt }, contractId);
  return { voucher: toVoucher(voucher), contract: contractId ? getContract(contractId) : undefined };
}

export function registerInvoice(contractId: string, input: InvoiceInput) {
  const actor = input.actor?.trim() || '财务操作员';
  const contract = findContract(contractId);
  const milestone = findMilestoneRecord(contract, requiredText(input.milestoneId, 'milestoneId'));
  assertStale(milestone, input.expectedStatus, input.expectedVersion);
  const invoiceNo = requiredText(input.invoiceNo, 'invoiceNo');
  const amount = moneyAmount(input.amount, 'amount');
  if (invoiceRecords.some(item => item.invoiceNo === invoiceNo)) throw new LedgerError(409, 'DUPLICATE_INVOICE_NO', '发票号已存在', { invoiceNo });
  const alreadyInvoiced = milestoneInvoiced(milestone.id);
  if (alreadyInvoiced + amount > milestone.amount) {
    throw new LedgerError(422, 'INVOICE_EXCEEDS_MILESTONE', '累计发票金额不能超过节点金额', { milestoneAmount: milestone.amount, alreadyInvoiced, amount, remaining: milestone.amount - alreadyInvoiced });
  }
  const issuedAt = isoDate(input.issuedAt, 'issuedAt');
  const invoice: InvoiceRecord = { id: nextId('INV'), contractId: contract.id, milestoneId: milestone.id, invoiceNo, amount, issuedAt, createdAt: new Date().toISOString(), version: 1 };
  invoiceRecords.push(invoice);
  milestone.version += 1;
  addAudit('REGISTER_INVOICE', 'invoice', invoice.id, actor, { contractId: contract.id, milestoneId: milestone.id, invoiceNo, amount, issuedAt, milestoneVersion: milestone.version }, contract.id);
  return { invoice: toInvoice(invoice), milestone: toMilestone(contract, milestone), contract: getContract(contract.id) };
}

export function registerPayment(contractId: string, input: PaymentInput) {
  const actor = input.actor?.trim() || '财务操作员';
  const contract = findContract(contractId);
  const milestone = findMilestoneRecord(contract, requiredText(input.milestoneId, 'milestoneId'));
  assertStale(milestone, input.expectedStatus, input.expectedVersion);
  const invoiceId = requiredText(input.invoiceId, 'invoiceId');
  const voucherId = requiredText(input.voucherId, 'voucherId');
  const paymentNo = requiredText(input.paymentNo, 'paymentNo');
  const amount = moneyAmount(input.amount, 'amount');
  const invoice = invoiceRecords.find(item => item.id === invoiceId);
  if (!invoice || invoice.contractId !== contract.id || invoice.milestoneId !== milestone.id) {
    throw new LedgerError(422, 'INVOICE_NOT_APPLICABLE', '发票不属于该合同节点', { contractId: contract.id, milestoneId: milestone.id, invoiceId });
  }
  const paidForMilestone = milestonePaid(milestone.id);
  if (paidForMilestone + amount > milestone.amount) {
    throw new LedgerError(422, 'OVERPAYMENT_REJECTED', '累计付款不能超过节点金额；超额付款已拒绝', { milestoneAmount: milestone.amount, paidForMilestone, amount, remaining: milestone.amount - paidForMilestone });
  }
  const paidForInvoice = invoicePaid(invoice.id);
  if (paidForInvoice + amount > invoice.amount) {
    throw new LedgerError(422, 'PAYMENT_EXCEEDS_INVOICE', '累计付款不能超过发票金额', { invoiceAmount: invoice.amount, paidForInvoice, remaining: invoice.amount - paidForInvoice });
  }
  const contractPaid = paymentRecords.filter(item => item.contractId === contract.id).reduce((sum, item) => sum + item.amount, 0);
  if (contractPaid + amount > contract.ceiling) {
    throw new LedgerError(422, 'CONTRACT_CEILING_REACHED', '付款后将超过合同总额', { ceiling: contract.ceiling, contractPaid, amount });
  }
  const voucher = voucherRecords.find(item => item.id === voucherId);
  if (!voucher || (voucher.contractId && voucher.contractId !== contract.id)) throw new LedgerError(422, 'VOUCHER_NOT_APPLICABLE', '凭证不适用于该合同', { voucherId, contractId: contract.id });
  if (voucher.status !== 'valid') throw new LedgerError(422, 'INVALID_VOUCHER', '凭证无效，不能登记付款', { voucherId, status: voucher.status });
  const voucherUsedAmount = voucherUsed(voucher.id);
  if (voucherUsedAmount + amount > voucher.amount) {
    throw new LedgerError(422, 'VOUCHER_BALANCE_EXCEEDED', '凭证可用额度不足', { voucherAmount: voucher.amount, voucherUsedAmount, remaining: voucher.amount - voucherUsedAmount });
  }
  if (paymentRecords.some(item => item.paymentNo === paymentNo)) throw new LedgerError(409, 'DUPLICATE_PAYMENT_NO', '付款单号已存在', { paymentNo });
  const paidAt = isoDate(input.paidAt, 'paidAt');
  const payment: PaymentRecord = { id: nextId('PAY'), contractId: contract.id, milestoneId: milestone.id, invoiceId, voucherId, paymentNo, amount, paidAt, createdAt: new Date().toISOString(), version: 1 };
  paymentRecords.push(payment);
  milestone.version += 1;
  const becamePaid = paidForMilestone + amount === milestone.amount;
  addAudit('REGISTER_PAYMENT', 'payment', payment.id, actor, { contractId: contract.id, milestoneId: milestone.id, invoiceId, voucherId, paymentNo, amount, paidAt, milestonePaid: becamePaid, milestoneVersion: milestone.version }, contract.id);
  if (becamePaid) addAudit('MILESTONE_PAID', 'milestone', milestone.id, actor, { contractId: contract.id, amount: milestone.amount, paymentId: payment.id, version: milestone.version }, contract.id);
  return { payment, milestone: toMilestone(contract, milestone), contract: getContract(contract.id) };
}

function normalizedForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedForFingerprint);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, normalizedForFingerprint((value as Record<string, unknown>)[key])]));
  }
  return value;
}
function fingerprint(action: string, payload: unknown) { return createHash('sha256').update(JSON.stringify({ action, payload: normalizedForFingerprint(payload) })).digest('hex'); }

export interface IdempotentResult<T> { key: string; replay: boolean; status: number; value: T; }
async function runLedger<T>(operation: () => T): Promise<T> {
  const result = ledgerChain.then(() => operation());
  ledgerChain = result.then(() => undefined, () => undefined);
  return result;
}
export async function idempotent<T>(keyInput: unknown, action: string, payload: unknown, operation: () => T, status = 201): Promise<IdempotentResult<T>> {
  const key = requiredText(keyInput, 'Idempotency-Key');
  const digest = fingerprint(action, payload);
  return runLedger(() => {
    const existing = idempotencyRecords.find(item => item.key === key);
    if (existing) {
      if (existing.action !== action || existing.fingerprint !== digest) {
        throw new LedgerError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被使用，但请求内容不同；请更换新键', { key, originalAction: existing.action, requestAction: action });
      }
      existing.replays += 1;
      return { key, replay: true, status: existing.status, value: existing.result as T };
    }
    const value = operation();
    idempotencyRecords.push({ key, action, fingerprint: digest, status, result: JSON.parse(JSON.stringify(value)) as T, createdAt: new Date().toISOString(), replays: 0 });
    return { key, replay: false, status, value };
  });
}

function seed() {
  idSequence = 300;
  projects = [
    { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
    { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) }
  ];
  budgetLines = [
    { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
    { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
    { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
    { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
    { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' }
  ];
  contractRecords = [
    { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, milestones: [
      { id: 'MS-101', name: '锁剪交付', due: iso(8), amount: 1200000, version: 3 },
      { id: 'MS-102', name: '母版验收', due: iso(36), amount: 2000000, version: 4 },
      { id: 'MS-103', name: '源文件与交付包归档', due: iso(40), amount: 1100000, version: 1 }
    ] },
    { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, milestones: [
      { id: 'MS-201', name: '签署', due: iso(-16), amount: 440000, version: 3 },
      { id: 'MS-202', name: '交付版权证明', due: iso(4), amount: 440000, version: 2 }
    ] },
    { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, milestones: [
      { id: 'MS-301', name: '素材包一', due: iso(20), amount: 500000, version: 1 }
    ] }
  ];
  invoiceRecords = [
    { id: 'INV-101', contractId: 'CTR-01', milestoneId: 'MS-101', invoiceNo: 'INV-2026-0901', amount: 1200000, issuedAt: iso(-12), createdAt: new Date(now - 12 * 86400000).toISOString(), version: 1 },
    { id: 'INV-102', contractId: 'CTR-01', milestoneId: 'MS-102', invoiceNo: 'INV-2026-0918', amount: 2000000, issuedAt: iso(-5), createdAt: new Date(now - 5 * 86400000).toISOString(), version: 1 },
    { id: 'INV-201', contractId: 'CTR-02', milestoneId: 'MS-201', invoiceNo: 'YJ-2026-021', amount: 440000, issuedAt: iso(-20), createdAt: new Date(now - 20 * 86400000).toISOString(), version: 1 },
    { id: 'INV-202', contractId: 'CTR-02', milestoneId: 'MS-202', invoiceNo: 'YJ-2026-035', amount: 440000, issuedAt: iso(-2), createdAt: new Date(now - 2 * 86400000).toISOString(), version: 1 }
  ];
  voucherRecords = [
    { id: 'VCR-101', contractId: 'CTR-01', voucherNo: 'BANK-V-101', amount: 1200000, status: 'valid', issuedAt: iso(-10), createdAt: new Date(now - 10 * 86400000).toISOString(), version: 1 },
    { id: 'VCR-102', contractId: 'CTR-01', voucherNo: 'BANK-V-102', amount: 1100000, status: 'valid', issuedAt: iso(-7), createdAt: new Date(now - 7 * 86400000).toISOString(), version: 1 },
    { id: 'VCR-201', contractId: 'CTR-02', voucherNo: 'WIRE-201', amount: 440000, status: 'valid', issuedAt: iso(-15), createdAt: new Date(now - 15 * 86400000).toISOString(), version: 1 },
    { id: 'VCR-301', contractId: 'CTR-03', voucherNo: 'VOID-DEMO', amount: 500000, status: 'void', issuedAt: iso(-1), createdAt: new Date(now - 86400000).toISOString(), version: 1 }
  ];
  paymentRecords = [
    { id: 'PAY-101', contractId: 'CTR-01', milestoneId: 'MS-101', invoiceId: 'INV-101', voucherId: 'VCR-101', paymentNo: 'P20260912001', amount: 1200000, paidAt: iso(-9), createdAt: new Date(now - 9 * 86400000).toISOString(), version: 1 },
    { id: 'PAY-102', contractId: 'CTR-01', milestoneId: 'MS-102', invoiceId: 'INV-102', voucherId: 'VCR-102', paymentNo: 'P20260921001', amount: 600000, paidAt: iso(-4), createdAt: new Date(now - 4 * 86400000).toISOString(), version: 1 },
    { id: 'PAY-103', contractId: 'CTR-01', milestoneId: 'MS-102', invoiceId: 'INV-102', voucherId: 'VCR-102', paymentNo: 'P20260924002', amount: 500000, paidAt: iso(-1), createdAt: new Date(now - 86400000).toISOString(), version: 1 },
    { id: 'PAY-201', contractId: 'CTR-02', milestoneId: 'MS-201', invoiceId: 'INV-201', voucherId: 'VCR-201', paymentNo: 'W20260908001', amount: 440000, paidAt: iso(-14), createdAt: new Date(now - 14 * 86400000).toISOString(), version: 1 }
  ];
  assets = [
    { id: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', version: 7, status: 'review', owner: '后期制片', checksum: 'sha256:91b7…e2a1', territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-2), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'] },
    { id: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', version: 4, status: 'approved', owner: '营销部', checksum: 'sha256:42ca…9b02', territories: ['CN'], platforms: ['StreamBox', '短视频'], availableFrom: iso(6), availableTo: iso(180), rightsTags: ['演员-宣传许可'] },
    { id: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', version: 2, status: 'locked', owner: '音乐版权', checksum: 'sha256:113c…78f0', territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-40), availableTo: iso(52), rightsTags: ['音乐-同步许可'] },
    { id: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', version: 3, status: 'review', owner: '视觉总监', checksum: 'sha256:8a10…4a9d', territories: ['全球'], platforms: ['影院'], availableFrom: iso(18), availableTo: iso(365), rightsTags: ['航拍-编辑许可'] }
  ];
  approvals = [
    { id: 'APR-01', projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', status: 'pending', approver: '财务负责人', createdAt: iso(-1) },
    { id: 'APR-02', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', title: 'E01 最终母版锁定', requestedBy: '后期制片', status: 'pending', approver: '总制片人', createdAt: iso(-2) },
    { id: 'APR-03', projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: iso(-5), comment: '已补充航拍授权凭证' }
  ];
  auditEvents = [
    { id: 'AUD-01', action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', at: new Date(now - 86400000).toISOString(), details: '从 V2 复制并调整后期科目' },
    { id: 'AUD-FIN-01', action: 'MIGRATE_LEDGER', entity: 'contract', entityId: 'CTR-01', actor: '系统迁移', at: new Date(now - 86400000).toISOString(), details: '旧合同汇总已拆解为发票、银行凭证和两笔付款明细', contractId: 'CTR-01' },
    { id: 'AUD-FIN-02', action: 'MIGRATE_LEDGER', entity: 'contract', entityId: 'CTR-02', actor: '系统迁移', at: new Date(now - 86400000).toISOString(), details: '旧合同汇总已拆解为发票、银行凭证和付款明细', contractId: 'CTR-02' }
  ];
  idempotencyRecords = [];
}
seed();

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = listContracts(projectId);
  const projectAssets = assets.filter(asset => asset.projectId === projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return {
    project: projects.find(project => project.id === projectId),
    planned,
    forecast,
    actual,
    variance: forecast - planned,
    utilization: planned ? actual / planned : 0,
    committed: lines.reduce((sum, line) => sum + line.committed, 0),
    contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0),
    contractCommitted: projectContracts.reduce((sum, contract) => sum + contract.committed, 0),
    contractInvoiced: projectContracts.reduce((sum, contract) => sum + contract.invoiced, 0),
    contractPaid: projectContracts.reduce((sum, contract) => sum + contract.paid, 0),
    assetCount: projectAssets.length,
    pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length,
    highRiskLines: lines.filter(line => line.risk === 'high'),
    lines,
    contracts: projectContracts,
    assets: projectAssets,
    approvals: projectApprovals
  };
}

export function rightsConflicts(projectId = projects[0].id) {
  const list = assets.filter(asset => asset.projectId === projectId);
  const conflicts: { severity: 'critical' | 'warning'; assetA: string; assetB: string; reason: string }[] = [];
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const a = list[i], b = list[j];
    const sameTag = a.rightsTags.some(tag => b.rightsTags.includes(tag));
    const sameTerritory = a.territories.includes('全球') || b.territories.includes('全球') || a.territories.some(territory => b.territories.includes(territory));
    if (sameTag && sameTerritory && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom) conflicts.push({ severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning', assetA: a.name, assetB: b.name, reason: `同一授权标签在重叠窗口内覆盖相同地域：${a.rightsTags.filter(tag => b.rightsTags.includes(tag)).join('、')}` });
  }
  return conflicts;
}

export function approve(id: string, status: ApprovalStatus, comment = '') {
  const item = approvals.find(approval => approval.id === id); if (!item) return undefined;
  item.status = status; item.comment = comment; auditEvents.unshift({ id: nextId('AUD'), action: status.toUpperCase(), entity: item.entityType, entityId: item.entityId, actor: '当前审批人', at: new Date().toISOString(), details: comment || `${item.title} 已${status === 'approved' ? '通过' : '驳回'}` }); return item;
}
export function createApproval(input: Pick<Approval, 'projectId' | 'entityType' | 'entityId' | 'title' | 'requestedBy' | 'approver'>) { const item: Approval = { ...input, id: nextId('APR'), status: 'pending', createdAt: new Date().toISOString() }; approvals.unshift(item); return item; }
export function dashboard() { return projects.map(project => projectSummary(project.id)).map(summary => ({ id: summary.project?.id, title: summary.project?.title, status: summary.project?.status, forecast: summary.forecast, variance: summary.variance, pendingApprovals: summary.pendingApprovals, rightsConflicts: rightsConflicts(summary.project?.id).length })); }
export function resetLedgerForTests() { seed(); }
