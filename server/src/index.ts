import express from 'express';
import type { Request, Response } from 'express';
import {
  approve,
  createApproval,
  dashboard,
  getContract,
  idempotent,
  LedgerError,
  listAssets,
  listBudgetLines,
  listContracts,
  listProjects,
  projectSummary,
  registerInvoice,
  registerPayment,
  registerVoucher,
  rightsConflicts
} from './domain.js';

const app = express();
app.use(express.json());

function sendError(res: Response, error: unknown) {
  if (error instanceof LedgerError) return res.status(error.status).json({ message: error.message, code: error.code, details: error.details });
  console.error(error);
  return res.status(500).json({ message: '服务处理失败', code: 'INTERNAL_ERROR' });
}
function idempotencyKey(req: Request) { return req.header('Idempotency-Key') || req.body?.idempotencyKey; }

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(listProjects()));
app.get('/api/projects/:id/summary', (req, res) => { const result = projectSummary(req.params.id); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); });
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
app.get('/api/projects/:id/assets', (req, res) => res.json(listAssets(req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => res.json(listContracts(req.params.id)));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(listBudgetLines(req.params.projectId)));
app.get('/api/contracts/:id/ledger', (req, res) => {
  try { res.json(getContract(req.params.id)); } catch (error) { sendError(res, error); }
});
app.post('/api/vouchers', async (req, res) => {
  try {
    const { idempotencyKey: _unused, ...payload } = req.body ?? {};
    const result = await idempotent(idempotencyKey(req), 'register-voucher', payload, () => registerVoucher(payload));
    res.setHeader('Idempotency-Key', result.key); res.setHeader('Idempotent-Replay', String(result.replay));
    res.status(result.status).json(result.value);
  } catch (error) { sendError(res, error); }
});
app.post('/api/contracts/:id/invoices', async (req, res) => {
  try {
    const { idempotencyKey: _unused, ...payload } = req.body ?? {};
    const result = await idempotent(idempotencyKey(req), 'register-invoice', payload, () => registerInvoice(req.params.id, payload));
    res.setHeader('Idempotency-Key', result.key); res.setHeader('Idempotent-Replay', String(result.replay));
    res.status(result.status).json(result.value);
  } catch (error) { sendError(res, error); }
});
app.post('/api/contracts/:id/payments', async (req, res) => {
  try {
    const { idempotencyKey: _unused, ...payload } = req.body ?? {};
    const result = await idempotent(idempotencyKey(req), 'register-payment', payload, () => registerPayment(req.params.id, payload));
    res.setHeader('Idempotency-Key', result.key); res.setHeader('Idempotent-Replay', String(result.replay));
    res.status(result.status).json(result.value);
  } catch (error) { sendError(res, error); }
});
app.post('/api/approvals', (req, res) => res.status(201).json(createApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => { const result = approve(req.params.id, req.body.status, req.body.comment); if (!result) return res.status(404).json({ message: '审批不存在' }); res.json(result); });
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));

const port = Number(process.env.PORT || 4104);
app.listen(port, () => console.log(`film rights API listening on ${port}`));
