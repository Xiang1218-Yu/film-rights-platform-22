import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FinanceError, contractLedger, contractView, initFinancePersistence, milestoneTotals, projectFinance, registerInvoice, registerPayment, resetFinanceForTests } from './finance.js';
import { projectSummary } from './domain.js';
import { auditEvents } from './store.js';

beforeEach(() => resetFinanceForTests());

const voucher = (reference: string, amount: number) => ({ type: 'bank-slip' as const, reference, issuedBy: '测试供应商', amount });
const pay = (overrides: Record<string, unknown> = {}) => registerPayment({ contractId: 'CTR-01', milestoneId: 'CTR-01-M3', amount: 400000, voucher: voucher(`BNK-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, 400000), idempotencyKey: `k-${Math.random()}`, ...overrides } as Parameters<typeof registerPayment>[0]);

test('milestone status and contract totals derive from invoice/payment details', () => {
  const view = contractView('CTR-01');
  assert.deepEqual(view.milestones.map(m => m.status), ['paid', 'invoiced', 'open']);
  assert.equal(view.paid, 1700000);
  assert.equal(view.invoiced, 2000000);
  const m1 = view.milestones[0];
  assert.equal(m1.invoiced, 1200000);
  assert.equal(m1.paid, 1200000);
});

test('project summary computes contract totals from ledger details', () => {
  const summary = projectSummary('PRJ-001');
  assert.equal(summary.contractPaid, 1700000 + 440000);
  assert.equal(summary.contractInvoiced, 2000000 + 880000);
  assert.equal(summary.contracts.every(c => typeof c.version === 'number'), true);
});

test('partial payments accumulate and milestone turns paid only when fully covered', () => {
  registerInvoice({ contractId: 'CTR-01', milestoneId: 'CTR-01-M3', number: 'INV-T-1', amount: 1100000, idempotencyKey: 'inv-t-1' });
  const first = pay({ amount: 400000, voucher: voucher('BNK-T-000001', 400000), idempotencyKey: 'pay-t-1' });
  assert.equal(first.contract.milestones[2].status, 'invoiced');
  assert.equal(first.contract.milestones[2].paid, 400000);
  const second = pay({ amount: 700000, voucher: voucher('BNK-T-000002', 700000), idempotencyKey: 'pay-t-2' });
  assert.equal(second.contract.milestones[2].status, 'paid');
  assert.equal(second.contract.paid, 1700000 + 1100000);
  assert.ok(auditEvents.some(e => e.action === 'MILESTONE_PAID'));
});

test('overpayment is rejected, state untouched, and rejection audited', () => {
  const before = contractView('CTR-01');
  assert.throws(
    () => pay({ amount: 1100001, voucher: voucher('BNK-T-000003', 1100001), idempotencyKey: 'pay-t-over' }),
    (error: unknown) => error instanceof FinanceError && error.code === 'OVERPAYMENT' && error.status === 409
  );
  const after = contractView('CTR-01');
  assert.equal(after.paid, before.paid);
  assert.equal(after.version, before.version);
  assert.ok(auditEvents.some(e => e.action === 'PAYMENT_REJECTED' && e.details.includes('超额')));
});

test('over-invoicing beyond milestone amount is rejected', () => {
  assert.throws(
    () => registerInvoice({ contractId: 'CTR-01', milestoneId: 'CTR-01-M2', number: 'INV-T-OVER', amount: 1200001, idempotencyKey: 'inv-t-over' }),
    (error: unknown) => error instanceof FinanceError && error.code === 'OVER_INVOICED'
  );
});

test('same idempotency key replays safely without duplicating records', () => {
  const input = { contractId: 'CTR-01', milestoneId: 'CTR-01-M3', amount: 400000, voucher: voucher('BNK-T-000010', 400000), idempotencyKey: 'pay-t-replay' };
  const first = registerPayment(input);
  const second = registerPayment(input);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.payment.id, first.payment.id);
  assert.equal(milestoneTotals('CTR-01', 'CTR-01-M3').paid, 400000);
  assert.equal(second.contract.version, first.contract.version);
});

test('same idempotency key with different content is a conflict', () => {
  registerPayment({ contractId: 'CTR-01', milestoneId: 'CTR-01-M3', amount: 400000, voucher: voucher('BNK-T-000011', 400000), idempotencyKey: 'pay-t-conflict' });
  assert.throws(
    () => registerPayment({ contractId: 'CTR-01', milestoneId: 'CTR-01-M3', amount: 450000, voucher: voucher('BNK-T-000012', 450000), idempotencyKey: 'pay-t-conflict' }),
    (error: unknown) => error instanceof FinanceError && error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409
  );
  assert.throws(
    () => registerInvoice({ contractId: 'CTR-01', milestoneId: 'CTR-01-M3', number: 'INV-T-X', amount: 400000, idempotencyKey: 'pay-t-conflict' }),
    (error: unknown) => error instanceof FinanceError && error.code === 'IDEMPOTENCY_CONFLICT'
  );
});

test('concurrent payments cannot overdraw a milestone', async () => {
  const attempts = await Promise.allSettled([...Array(5)].map((_, i) => Promise.resolve().then(() =>
    registerPayment({ contractId: 'CTR-01', milestoneId: 'CTR-01-M3', amount: 500000, voucher: voucher(`BNK-T-C0000${i}`, 500000), idempotencyKey: `pay-t-conc-${i}` })
  )));
  const succeeded = attempts.filter(item => item.status === 'fulfilled');
  const rejected = attempts.filter(item => item.status === 'rejected');
  assert.equal(succeeded.length, 2);
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every(item => (item as PromiseRejectedResult).reason instanceof FinanceError && (item as PromiseRejectedResult).reason.code === 'OVERPAYMENT'));
  assert.equal(milestoneTotals('CTR-01', 'CTR-01-M3').paid, 1000000);
  assert.equal(contractView('CTR-01').milestones[2].status, 'invoiced');
});

test('invalid vouchers are rejected: format, amount mismatch, missing fields', () => {
  assert.throws(() => pay({ voucher: voucher('bad ref!', 400000) }), (e: unknown) => e instanceof FinanceError && e.code === 'INVALID_VOUCHER');
  assert.throws(() => pay({ voucher: voucher('BNK-T-000020', 399999) }), (e: unknown) => e instanceof FinanceError && e.code === 'INVALID_VOUCHER');
  assert.throws(() => pay({ voucher: { ...voucher('BNK-T-000021', 400000), issuedBy: '' } }), (e: unknown) => e instanceof FinanceError && e.code === 'INVALID_VOUCHER');
  assert.throws(() => pay({ voucher: undefined }), (e: unknown) => e instanceof FinanceError && e.code === 'INVALID_VOUCHER');
});

test('a voucher reference cannot be reused across payments', () => {
  pay({ voucher: voucher('BNK-T-000030', 400000), idempotencyKey: 'pay-t-dup-1' });
  assert.throws(
    () => pay({ amount: 500000, voucher: voucher('BNK-T-000030', 500000), idempotencyKey: 'pay-t-dup-2' }),
    (e: unknown) => e instanceof FinanceError && e.code === 'DUPLICATE_VOUCHER'
  );
});

test('stale expected version conflicts and current version succeeds', () => {
  const view = contractView('CTR-01');
  assert.throws(
    () => pay({ expectedVersion: view.version + 1 }),
    (e: unknown) => e instanceof FinanceError && e.code === 'STALE_VERSION' && e.status === 409
  );
  const result = pay({ expectedVersion: view.version });
  assert.equal(result.contract.version, view.version + 1);
});

test('unknown contract or milestone returns not found errors', () => {
  assert.throws(() => contractView('CTR-99'), (e: unknown) => e instanceof FinanceError && e.code === 'CONTRACT_NOT_FOUND' && e.status === 404);
  assert.throws(() => pay({ milestoneId: 'CTR-01-M9' }), (e: unknown) => e instanceof FinanceError && e.code === 'MILESTONE_NOT_FOUND' && e.status === 404);
});

test('snapshot persistence recovers ledger, versions and idempotency after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finance-ledger-'));
  const file = join(dir, 'ledger.json');
  try {
    initFinancePersistence(file);
    registerPayment({ contractId: 'CTR-01', milestoneId: 'CTR-01-M3', amount: 400000, voucher: voucher('BNK-T-000040', 400000), idempotencyKey: 'pay-t-persist' });
    const paidBefore = contractView('CTR-01').paid;
    const versionBefore = contractView('CTR-01').version;
    // 模拟进程重启：清空内存态后仅从快照恢复
    resetFinanceForTests();
    initFinancePersistence(file);
    assert.equal(contractView('CTR-01').paid, paidBefore);
    assert.equal(contractView('CTR-01').version, versionBefore);
    const replay = registerPayment({ contractId: 'CTR-01', milestoneId: 'CTR-01-M3', amount: 400000, voucher: voucher('BNK-T-000040', 400000), idempotencyKey: 'pay-t-persist' });
    assert.equal(replay.replayed, true);
    assert.equal(contractView('CTR-01').paid, paidBefore);
  } finally {
    resetFinanceForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger endpoint payload exposes invoices, payments and derived view', () => {
  const ledger = contractLedger('CTR-02');
  assert.equal(ledger.invoices.length, 2);
  assert.equal(ledger.payments.length, 1);
  assert.equal(ledger.contract.milestones[0].status, 'paid');
  assert.equal(ledger.contract.milestones[1].status, 'invoiced');
  const finance = projectFinance('PRJ-001');
  assert.equal(finance.paid, 1700000 + 440000);
});
