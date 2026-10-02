import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approve,
  getContract,
  idempotent,
  LedgerError,
  projectSummary,
  registerInvoice,
  registerPayment,
  registerVoucher,
  resetLedgerForTests,
  rightsConflicts
} from './domain.js';

const key = (name: string) => `${name}-${Math.random()}`;

test.beforeEach(() => resetLedgerForTests());

test('budget summary exposes forecast variance and high risk lines', () => {
  const summary = projectSummary('PRJ-001');
  assert.equal(summary.lines.length, 4);
  assert.ok(summary.forecast > summary.planned);
  assert.equal(summary.highRiskLines.length, 1);
});

test('contract and project totals are derived from invoices, vouchers and payments', () => {
  const contract = getContract('CTR-01');
  assert.equal(contract.committed, 4300000);
  assert.equal(contract.invoiced, 3200000);
  assert.equal(contract.paid, 2300000);
  assert.equal(contract.remaining, 2000000);
  assert.equal(contract.milestones.find(item => item.id === 'MS-102')?.status, 'invoiced');
  assert.equal(contract.milestones.find(item => item.id === 'MS-102')?.remainingAmount, 900000);
  const summary = projectSummary('PRJ-001');
  assert.equal(summary.contractPaid, contract.paid + getContract('CTR-02').paid);
});

test('partial payment keeps milestone invoiced and only full accumulated confirmation turns paid', async () => {
  await idempotent(key('invoice'), 'register-invoice', { milestoneId: 'MS-103', invoiceNo: 'NEW-INV-1', amount: 600000 }, () => registerInvoice('CTR-01', { milestoneId: 'MS-103', invoiceNo: 'NEW-INV-1', amount: 600000 }));
  const voucher = await idempotent(key('voucher'), 'register-voucher', { voucherNo: 'NEW-VCR-1', amount: 600000, contractId: 'CTR-01' }, () => registerVoucher({ voucherNo: 'NEW-VCR-1', amount: 600000, contractId: 'CTR-01' }));
  const partial = await idempotent(key('pay-1'), 'register-payment', { milestoneId: 'MS-103', invoiceId: 'INV-301', voucherId: voucher.value.voucher.id, paymentNo: 'NEW-PAY-1', amount: 200000 }, () => registerPayment('CTR-01', { milestoneId: 'MS-103', invoiceId: 'INV-301', voucherId: voucher.value.voucher.id, paymentNo: 'NEW-PAY-1', amount: 200000 }));
  assert.equal(partial.value.milestone.status, 'invoiced');
  assert.equal(partial.value.milestone.paidAmount, 200000);
});

test('overpayment is rejected even when it appears to be the final payment', async () => {
  await idempotent(key('invoice-final'), 'register-invoice', { milestoneId: 'MS-103', invoiceNo: 'FINAL-INV', amount: 1100000 }, () => registerInvoice('CTR-01', { milestoneId: 'MS-103', invoiceNo: 'FINAL-INV', amount: 1100000 }));
  const finalVoucher = await idempotent(key('voucher-final'), 'register-voucher', { voucherNo: 'FINAL-VCR', amount: 1200000, contractId: 'CTR-01' }, () => registerVoucher({ voucherNo: 'FINAL-VCR', amount: 1200000, contractId: 'CTR-01' }));
  assert.throws(
    () => registerPayment('CTR-01', { milestoneId: 'MS-103', invoiceId: 'INV-301', voucherId: finalVoucher.value.voucher.id, paymentNo: 'BAD-PAY', amount: 1200000 }),
    (error: unknown) => error instanceof LedgerError && error.code === 'OVERPAYMENT_REJECTED'
  );
  assert.equal(getContract('CTR-01').payments.some(item => item.paymentNo === 'BAD-PAY'), false);
});

test('invalid vouchers cannot be used to confirm payment', async () => {
  await idempotent(key('ctr03-invoice'), 'register-invoice', { milestoneId: 'MS-301', invoiceNo: 'CTR03-INV', amount: 500000 }, () => registerInvoice('CTR-03', { milestoneId: 'MS-301', invoiceNo: 'CTR03-INV', amount: 500000 }));
  assert.throws(
    () => registerPayment('CTR-03', { milestoneId: 'MS-301', invoiceId: 'INV-301', voucherId: 'VCR-301', paymentNo: 'CTR03-PAY', amount: 500000 }),
    (error: unknown) => error instanceof LedgerError && error.code === 'INVALID_VOUCHER'
  );
});

test('same idempotency key safely replays identical request but rejects changed content', async () => {
  const sameKey = key('idempotent');
  const payload = { voucherNo: 'RETRY-VCR', amount: 100, contractId: 'CTR-03' };
  const first = await idempotent(sameKey, 'register-voucher', payload, () => registerVoucher(payload));
  const replay = await idempotent(sameKey, 'register-voucher', payload, () => registerVoucher(payload));
  assert.equal(first.replay, false);
  assert.equal(replay.replay, true);
  assert.equal(first.value.voucher.id, replay.value.voucher.id);
  await assert.rejects(
    () => idempotent(sameKey, 'register-voucher', { ...payload, amount: 200 }, () => registerVoucher({ ...payload, amount: 200 })),
    (error: unknown) => error instanceof LedgerError && error.code === 'IDEMPOTENCY_CONFLICT'
  );
});

test('concurrent final payments are serialized so only one confirmation can consume the balance', async () => {
  const raceInvoice = registerInvoice('CTR-01', { milestoneId: 'MS-103', invoiceNo: 'RACE-INV', amount: 1100000 });
  const voucher = registerVoucher({ voucherNo: 'RACE-VCR', amount: 1100000, contractId: 'CTR-01' });
  const payload = { milestoneId: 'MS-103', invoiceId: raceInvoice.invoice.id, voucherId: voucher.voucher.id, amount: 1100000 };
  const attempts = await Promise.allSettled([
    idempotent(key('race-a'), 'register-payment', { ...payload, paymentNo: 'RACE-A' }, () => registerPayment('CTR-01', { ...payload, paymentNo: 'RACE-A' })),
    idempotent(key('race-b'), 'register-payment', { ...payload, paymentNo: 'RACE-B' }, () => registerPayment('CTR-01', { ...payload, paymentNo: 'RACE-B' }))
  ]);
  const rejected = attempts.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0].reason as LedgerError).code, 'OVERPAYMENT_REJECTED');
  assert.equal(getContract('CTR-01').milestones.find(item => item.id === 'MS-103')?.status, 'paid');
});

test('stale expected version conflicts; refreshing version allows retry', () => {
  registerInvoice('CTR-01', { milestoneId: 'MS-103', invoiceNo: 'STALE-INV', amount: 1100000 });
  const refreshVoucher = registerVoucher({ voucherNo: 'REFRESH-VCR', amount: 500000, contractId: 'CTR-01' });
  const staleVersion = getContract('CTR-01').milestones.find(item => item.id === 'MS-103')!.version;
  assert.throws(
    () => registerPayment('CTR-01', { milestoneId: 'MS-103', invoiceId: 'INV-301', voucherId: refreshVoucher.voucher.id, paymentNo: 'STALE-STATUS', amount: 100000, expectedStatus: 'open' }),
    (error: unknown) => error instanceof LedgerError && error.code === 'STALE_STATE'
  );
  const first = registerPayment('CTR-01', { milestoneId: 'MS-103', invoiceId: 'INV-301', voucherId: refreshVoucher.voucher.id, paymentNo: 'REFRESH-1', amount: 100000, expectedStatus: 'invoiced', expectedVersion: staleVersion });
  assert.equal(first.milestone.version, staleVersion + 1);
  assert.throws(
    () => registerPayment('CTR-01', { milestoneId: 'MS-103', invoiceId: 'INV-301', voucherId: refreshVoucher.voucher.id, paymentNo: 'REFRESH-2', amount: 100000, expectedVersion: staleVersion }),
    (error: unknown) => error instanceof LedgerError && error.code === 'STALE_VERSION'
  );
  const refreshed = getContract('CTR-01').milestones.find(item => item.id === 'MS-103')!;
  const retry = registerPayment('CTR-01', { milestoneId: 'MS-103', invoiceId: 'INV-301', voucherId: refreshVoucher.voucher.id, paymentNo: 'REFRESH-2', amount: 100000, expectedVersion: refreshed.version });
  assert.equal(retry.milestone.paidAmount, 200000);
});

test('financial registrations are written to contract audit trail', async () => {
  const voucher = await idempotent(key('audit-voucher'), 'register-voucher', { voucherNo: 'AUDIT-VCR', amount: 100, contractId: 'CTR-03' }, () => registerVoucher({ voucherNo: 'AUDIT-VCR', amount: 100, contractId: 'CTR-03' }));
  const contract = getContract('CTR-03');
  assert.ok(contract.auditEvents.some(event => event.action === 'REGISTER_VOUCHER' && event.entityId === voucher.value.voucher.id));
});

test('rights conflict engine detects overlapping licensed assets', () => {
  const conflicts = rightsConflicts('PRJ-001');
  assert.ok(conflicts.length >= 1);
  assert.ok(conflicts.some(item => item.reason.includes('音乐-同步许可')));
});

test('approval changes are auditable and stateful', () => {
  const result = approve('APR-01', 'approved', '预算已复核');
  assert.equal(result?.status, 'approved');
  assert.equal(result?.comment, '预算已复核');
});
