import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { approve, assets, auditEvents, budgetLines, contracts, createApproval, dashboard, projectSummary, projects, rightsConflicts } from './domain.js';
import { FinanceError, contractLedger, initFinancePersistence, registerInvoice, registerPayment } from './finance.js';

initFinancePersistence(process.env.FINANCE_LEDGER_FILE ?? new URL('../data/finance-ledger.json', import.meta.url).pathname);

const app = express(); app.use(express.json());
const handle = (fn: (req: Request<Record<string, string>>, res: Response) => void) => (req: Request<Record<string, string>>, res: Response, next: NextFunction) => { try { fn(req, res); } catch (error) { next(error); } };

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => { const result = projectSummary(req.params.id); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); });
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => { const summary = projectSummary(req.params.id); if (!summary.project) return res.status(404).json({ message: '项目不存在' }); res.json(summary.contracts); });
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));
app.post('/api/approvals', (req, res) => res.status(201).json(createApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => { const result = approve(req.params.id, req.body.status, req.body.comment); if (!result) return res.status(404).json({ message: '审批不存在' }); res.json(result); });

// 合同对账：发票 / 付款 / 凭证登记，状态与汇总全部由明细推导
app.get('/api/contracts/:id/ledger', handle((req, res) => res.json(contractLedger(req.params.id))));
app.post('/api/contracts/:id/invoices', handle((req, res) => { const result = registerInvoice({ ...req.body, contractId: req.params.id }); res.status(result.replayed ? 200 : 201).json(result); }));
app.post('/api/contracts/:id/payments', handle((req, res) => { const result = registerPayment({ ...req.body, contractId: req.params.id }); res.status(result.replayed ? 200 : 201).json(result); }));
app.get('/api/audit', (_req, res) => res.json(auditEvents));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof FinanceError) return res.status(error.status).json({ code: error.code, message: error.message });
  console.error(error);
  res.status(500).json({ message: '服务内部错误' });
});

const port = Number(process.env.PORT || 4104); app.listen(port, () => console.log(`film rights API listening on ${port}`));
