import { useCallback, useEffect, useMemo, useState } from 'react';

type Project = { id: string; title: string; status: string; deliveryDate: string };
type Milestone = { id: string; name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid'; version: number; invoicedAmount: number; paidAmount: number; remainingAmount: number };
type Invoice = { id: string; milestoneId: string; invoiceNo: string; amount: number; issuedAt: string; paidAmount: number; remainingAmount: number };
type Voucher = { id: string; voucherNo: string; amount: number; status: 'valid' | 'void'; issuedAt: string; usedAmount: number; remainingAmount: number };
type Payment = { id: string; milestoneId: string; invoiceId: string; voucherId: string; paymentNo: string; amount: number; paidAt: string };
type Audit = { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string };
type Contract = { id: string; vendor: string; scope: string; ceiling: number; committed: number; invoiced: number; paid: number; remaining: number; milestones: Milestone[]; invoices: Invoice[]; vouchers: Voucher[]; payments: Payment[]; auditEvents: Audit[] };
type Summary = { planned: number; forecast: number; actual: number; variance: number; utilization: number; committed: number; contractExposure: number; contractCommitted: number; contractInvoiced: number; contractPaid: number; assetCount: number; pendingApprovals: number; highRiskLines: { subcategory: string; forecast: number; planned: number }[]; lines: { id: string; category: string; subcategory: string; planned: number; committed: number; forecast: number; actual: number; risk: string }[]; contracts: Contract[]; assets: { id: string; name: string; type: string; version: number; status: string; availableTo: string }[]; approvals: { id: string; title: string; status: string; approver: string }[]; project: Project };
type Conflict = { severity: string; assetA: string; assetB: string; reason: string };
type LedgerMode = 'invoice' | 'voucher' | 'payment';
type FormState = { contractId: string; milestoneId: string; invoiceId: string; voucherId: string; docNo: string; amount: string; date: string; actor: string; expectedVersion: string };

const money = (n: number) => `¥${(n / 10000).toFixed(1)}万`;
const api = '/api';
const today = () => new Date().toISOString().slice(0, 10);
const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `KEY-${Date.now()}-${Math.random()}`;
const emptyForm = (contractId = 'CTR-01'): FormState => ({ contractId, milestoneId: '', invoiceId: '', voucherId: '', docNo: '', amount: '', date: today(), actor: '财务操作员', expectedVersion: '' });

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `请求失败 (${response.status})`), { status: response.status, code: body.code, details: body.details });
  return body as T;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [tab, setTab] = useState<'overview' | 'budget' | 'reconcile' | 'rights'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<LedgerMode>('invoice');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formKey, setFormKey] = useState<string>(idempotencyKey());
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (id = 'PRJ-001') => {
    setLoading(true);
    setError('');
    try {
      const items = await request<Project[]>('/projects');
      const active = items.find(item => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, c] = await Promise.all([request<Summary>(`/projects/${active.id}/summary`), request<Conflict[]>(`/projects/${active.id}/rights-conflicts`)]);
      setProjects(items);
      setSelected(active.id);
      setSummary(s);
      setConflicts(c);
      setForm(current => ({ ...emptyForm(active.id), ...(current.contractId && s.contracts.some(contract => contract.id === current.contractId) ? { contractId: current.contractId } : {}) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const activeContract = useMemo(() => summary?.contracts.find(contract => contract.id === form.contractId) ?? summary?.contracts[0], [form.contractId, summary]);

  useEffect(() => {
    if (!activeContract) return;
    setForm(current => ({
      ...current,
      contractId: activeContract.id,
      milestoneId: current.milestoneId && activeContract.milestones.some(item => item.id === current.milestoneId) ? current.milestoneId : activeContract.milestones[0]?.id ?? '',
      invoiceId: current.invoiceId && activeContract.invoices.some(item => item.id === current.invoiceId) ? current.invoiceId : activeContract.invoices[0]?.id ?? '',
      voucherId: current.voucherId && activeContract.vouchers.some(item => item.id === current.voucherId) ? current.voucherId : activeContract.vouchers.find(item => item.status === 'valid')?.id ?? activeContract.vouchers[0]?.id ?? ''
    }));
  }, [activeContract?.id]);

  const approve = async (id: string) => {
    try {
      await request(`/approvals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved', comment: '在控制台完成复核' }) });
      setMessage('审批已通过，审计事件已写入');
      await load(selected);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '审批操作失败'); }
  };

  const update = (patch: Partial<FormState>) => setForm(current => ({ ...current, ...patch }));
  const refreshLedger = async () => {
    setError('');
    setMessage('已从明细重新汇总合同与项目金额');
    await load(selected);
    if (form.contractId) {
      const latest = await request<Contract>(`/contracts/${form.contractId}/ledger`);
      const milestone = latest.milestones.find(item => item.id === form.milestoneId) ?? latest.milestones[0];
      setForm(current => ({ ...current, contractId: latest.id, expectedVersion: milestone ? String(milestone.version) : '' }));
    }
  };

  const submitLedger = async () => {
    if (!activeContract) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    const amount = Math.round(Number(form.amount));
    if (!Number.isFinite(amount) || amount <= 0) { setError('请输入大于 0 的整数金额（元）'); setSubmitting(false); return; }
    try {
      if (mode === 'voucher') {
        await request('/vouchers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': formKey }, body: JSON.stringify({ idempotencyKey: formKey, voucherNo: form.docNo, amount, status: 'valid', issuedAt: form.date, contractId: form.contractId, actor: form.actor }) });
      } else if (mode === 'invoice') {
        await request(`/contracts/${activeContract.id}/invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': formKey }, body: JSON.stringify({ idempotencyKey: formKey, milestoneId: form.milestoneId, invoiceNo: form.docNo, amount, issuedAt: form.date, actor: form.actor, expectedVersion: form.expectedVersion ? Number(form.expectedVersion) : undefined }) });
      } else {
        await request(`/contracts/${activeContract.id}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': formKey }, body: JSON.stringify({ idempotencyKey: formKey, milestoneId: form.milestoneId, invoiceId: form.invoiceId, voucherId: form.voucherId, paymentNo: form.docNo, amount, paidAt: form.date, actor: form.actor, expectedVersion: form.expectedVersion ? Number(form.expectedVersion) : undefined }) });
      }
      setMessage('登记成功；节点状态、合同和项目汇总均由明细重新计算');
      setForm(current => ({ ...current, docNo: '', amount: '', expectedVersion: '' }));
      setFormKey(idempotencyKey());
      await load(selected);
    } catch (reason) {
      const err = reason as Error & { code?: string };
      if (err.code === 'STALE_VERSION' || err.code === 'STALE_STATE') setError(`${err.message}。请点击“刷新恢复”获取最新版本后重试。`);
      else setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const variancePct = useMemo(() => summary ? Math.round(summary.variance / summary.planned * 100) : 0, [summary]);
  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在通过 Vite API 代理连接本地制作服务</small></main>;
  if (!summary) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5173 和 API 4104 均已启动。</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  const selectedMilestone = activeContract?.milestones.find(item => item.id === form.milestoneId);
  const selectedInvoice = activeContract?.invoices.find(item => item.id === form.invoiceId);
  const selectedVoucher = activeContract?.vouchers.find(item => item.id === form.voucherId);

  return <main>
    <header><div><div className="eyebrow">STUDIO OPS / RIGHTS & FINANCE CONTROL</div><h1>FrameLedger <span>影视制作预算与资产版权协同</span></h1><p>将预算承诺、供应商发票、银行凭证、付款与资产版本串成可追溯、可重试、可审计的交付链路。</p></div><div className="header-actions"><select value={selected} onChange={e => { setSelected(e.target.value); void load(e.target.value); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select><span className="live"><i /> LIVE CONTROL</span></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}{error && <div className="toast error-toast" onClick={() => setError('')}>{error} ×</div>}
    <section className="kpis"><div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em></span></div><div><small>CONTRACT PAID</small><b>{money(summary.contractPaid)}</b><span>发票 {money(summary.contractInvoiced)} / 承诺 {money(summary.contractCommitted)}</span></div><div><small>ASSET REGISTER</small><b>{summary.assetCount}<em> 个</em></b><span>版本与交付状态纳管</span></div><div><small>RISK QUEUE</small><b>{summary.pendingApprovals + conflicts.length}<em> 项</em></b><span>{conflicts.length} 条版权冲突 / {summary.pendingApprovals} 个审批</span></div></section>
    <nav className="tabs"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>项目驾驶舱</button><button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>预算</button><button className={tab === 'reconcile' ? 'active' : ''} onClick={() => setTab('reconcile')}>发票付款对账</button><button className={tab === 'rights' ? 'active' : ''} onClick={() => setTab('rights')}>资产版权图谱</button><span>交付日 {summary.project.deliveryDate}</span></nav>

    {tab === 'overview' && <div className="grid"><section className="panel hero"><div className="panel-head"><div><div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div><h2>{summary.project.title}</h2></div><span className="badge amber">{summary.project.status.toUpperCase()}</span></div><div className="progress-label"><span>成本消耗 {Math.round(summary.utilization * 100)}%</span><b>{money(summary.actual)} / {money(summary.planned)}</b></div><div className="progress"><i style={{ width: `${Math.min(100, summary.utilization * 100)}%` }} /></div><div className="split"><div><small>合同已付</small><strong>{money(summary.contractPaid)}</strong></div><div><small>高风险预算项</small><strong className="bad">{summary.highRiskLines.length}</strong></div><div><small>版权冲突</small><strong className={conflicts.length ? 'bad' : ''}>{conflicts.length}</strong></div></div></section><section className="panel"><div className="panel-head"><h3>待审批队列</h3><span>{summary.approvals.filter(a => a.status === 'pending').length} PENDING</span></div>{summary.approvals.map(a => <div className="approval" key={a.id}><span className={`status ${a.status}`} /><div><b>{a.title}</b><small>{a.approver} · {a.id}</small></div>{a.status === 'pending' ? <button onClick={() => approve(a.id)}>通过</button> : <em>已完成</em>}</div>)}</section><section className="panel wide"><div className="panel-head"><h3>交付风险雷达</h3><span>基于版本、授权窗口与预算预测</span></div>{conflicts.length ? conflicts.map((c, i) => <div className="risk-row" key={i}><strong className={c.severity}>{c.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</strong><div><b>{c.assetA}</b><small>↔ {c.assetB} · {c.reason}</small></div></div>) : <div className="empty">当前项目未发现版权窗口冲突。</div>}</section></div>}

    {tab === 'budget' && <div className="grid"><section className="panel wide"><div className="panel-head"><h3>预算版本 V3 / 成本基线</h3><span>实际 + 承诺 + 预测</span></div><div className="table"><div className="tr th"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>{summary.lines.map(line => <div className="tr" key={line.id}><span><b>{line.category}</b><small>{line.subcategory}</small></span><span>{money(line.planned)}</span><span>{money(line.committed)}</span><span>{money(line.actual)}</span><span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span><span className={`risk ${line.risk}`}>{line.risk}</span></div>)}</div></section><section className="panel"><div className="panel-head"><h3>合同付款汇总</h3><button onClick={() => setTab('reconcile')}>进入对账</button></div>{summary.contracts.map(c => <div className="contract" key={c.id}><b>{c.vendor}</b><small>{c.scope}</small><div className="contract-bar"><i style={{ width: `${Math.round(c.paid / c.committed * 100)}%` }} /></div><span>{money(c.paid)} / {money(c.committed)}</span><em>{c.milestones.filter(m => m.status !== 'paid').length} 个待结点</em></div>)}</section></div>}

    {tab === 'reconcile' && <div className="grid ledger-grid"><section className="panel wide"><div className="panel-head"><div><h3>合同对账台账</h3><small>金额从发票、凭证、付款明细实时计算</small></div><button onClick={() => void refreshLedger()}>刷新恢复</button></div><div className="ledger-cards">{summary.contracts.map(contract => <article className={activeContract?.id === contract.id ? 'ledger-card active' : 'ledger-card'} key={contract.id} onClick={() => update({ contractId: contract.id })}><b>{contract.vendor}</b><div><span>节点承诺</span><strong>{money(contract.committed)}</strong></div><div><span>已开票</span><strong>{money(contract.invoiced)}</strong></div><div><span>已付款</span><strong>{money(contract.paid)}</strong></div><div><span>待付</span><strong>{money(contract.remaining)}</strong></div></article>)}</div></section>
      <section className="panel wide">{activeContract && <><div className="panel-head"><h3>{activeContract.vendor} · 节点确认</h3><span>{money(activeContract.paid)} / {money(activeContract.committed)}</span></div><div className="milestone-list">{activeContract.milestones.map(m => <div className="milestone-row" key={m.id}><div><b>{m.name}</b><small>{m.id} · 到期 {m.due} · v{m.version}</small></div><meter min={0} max={m.amount} value={m.paidAmount} /><div><span className={`pill ${m.status}`}>{m.status}</span><strong>{money(m.paidAmount)} / {money(m.amount)}</strong><small>开票 {money(m.invoicedAmount)} · 待付 {money(m.remainingAmount)}</small></div></div>)}</div></>}</section>
      <section className="panel register-panel"><div className="panel-head"><h3>登记凭证 / 发票 / 付款</h3><span>幂等安全重试</span></div><div className="mode-switch">{(['voucher', 'invoice', 'payment'] as LedgerMode[]).map(item => <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>{item === 'voucher' ? '凭证' : item === 'invoice' ? '发票' : '付款'}</button>)}</div><label>合同<select value={form.contractId} onChange={e => update({ contractId: e.target.value })}>{summary.contracts.map(contract => <option key={contract.id} value={contract.id}>{contract.vendor}</option>)}</select></label>{mode !== 'voucher' && <label>节点<select value={form.milestoneId} onChange={e => update({ milestoneId: e.target.value, expectedVersion: '' })}>{activeContract?.milestones.map(m => <option key={m.id} value={m.id}>{m.name} · {m.status} · v{m.version}</option>)}</select></label>}{mode === 'payment' && <><label>发票<select value={form.invoiceId} onChange={e => update({ invoiceId: e.target.value })}>{activeContract?.invoices.map(item => <option key={item.id} value={item.id}>{item.invoiceNo} · 余 {money(item.remainingAmount)}</option>)}</select></label><label>付款凭证<select value={form.voucherId} onChange={e => update({ voucherId: e.target.value })}>{activeContract?.vouchers.map(item => <option key={item.id} value={item.id}>{item.voucherNo} · {item.status} · 余 {money(item.remainingAmount)}</option>)}</select></label></>}<label>{mode === 'voucher' ? '凭证号' : mode === 'invoice' ? '发票号' : '付款单号'}<input value={form.docNo} onChange={e => update({ docNo: e.target.value })} placeholder="唯一业务单号" /></label><label>金额（元）<input value={form.amount} onChange={e => update({ amount: e.target.value })} inputMode="numeric" /></label><label>{mode === 'payment' ? '付款日期' : '开具日期'}<input type="date" value={form.date} onChange={e => update({ date: e.target.value })} /></label>{mode !== 'voucher' && <label>期望节点版本（乐观锁）<input value={form.expectedVersion || String(selectedMilestone?.version ?? '')} onChange={e => update({ expectedVersion: e.target.value })} /></label>}<label>操作人<input value={form.actor} onChange={e => update({ actor: e.target.value })} /></label><div className="idempotency"><small>幂等键</small><input value={formKey} onChange={e => setFormKey(e.target.value)} /><button type="button" onClick={() => setFormKey(idempotencyKey())}>换新</button></div>{selectedInvoice && mode === 'payment' && <p className="hint">发票剩余 {money(selectedInvoice.remainingAmount)}；凭证剩余 {money(selectedVoucher?.remainingAmount ?? 0)}。部分付款允许，累计达到节点金额才转 paid。</p>}<button className="primary" disabled={submitting} onClick={() => void submitLedger()}>{submitting ? '提交中…' : '提交登记'}</button></section>
      <section className="panel detail-panel"><div className="panel-head"><h3>凭证明细</h3><span>{activeContract?.vouchers.length ?? 0} 张</span></div>{activeContract?.vouchers.map(item => <div className="detail-row" key={item.id}><b>{item.voucherNo}</b><small>{item.id} · {item.issuedAt}</small><span className={`pill ${item.status === 'valid' ? 'approved' : 'rejected'}`}>{item.status}</span><strong>{money(item.usedAmount)} / {money(item.amount)}</strong></div>)}</section>
      <section className="panel wide"><div className="panel-head"><h3>发票与付款流水</h3><span>超额付款由节点、发票、凭证、合同四道余额拦截</span></div><div className="table ledger-table"><div className="tr th"><span>业务单</span><span>节点</span><span>类型</span><span>凭证</span><span>日期</span><span>金额</span></div>{activeContract?.invoices.map(item => <div className="tr" key={item.id}><span><b>{item.invoiceNo}</b><small>{item.id} · 已付 {money(item.paidAmount)}</small></span><span>{activeContract.milestones.find(m => m.id === item.milestoneId)?.name}</span><span className="pill review">invoice</span><span>—</span><span>{item.issuedAt}</span><span>{money(item.amount)}</span></div>)}{activeContract?.payments.map(item => <div className="tr" key={item.id}><span><b>{item.paymentNo}</b><small>{item.id}</small></span><span>{activeContract.milestones.find(m => m.id === item.milestoneId)?.name}</span><span className="pill approved">payment</span><span>{activeContract.vouchers.find(v => v.id === item.voucherId)?.voucherNo ?? item.voucherId}</span><span>{item.paidAt}</span><span>{money(item.amount)}</span></div>)}</div></section>
      <section className="panel wide"><div className="panel-head"><h3>合同审计</h3><span>最近事件</span></div>{activeContract?.auditEvents.slice(0, 8).map(event => <div className="audit-row" key={event.id}><strong>{event.action}</strong><div><b>{event.entity} · {event.entityId}</b><small>{event.actor} · {new Date(event.at).toLocaleString()}</small><p>{event.details}</p></div></div>)}</section>
    </div>}

    {tab === 'rights' && <div className="grid"><section className="panel wide"><div className="panel-head"><h3>资产版本登记</h3><span>{summary.assets.length} assets / checksum tracked</span></div><div className="table"><div className="tr th"><span>资产</span><span>版本</span><span>状态</span><span>授权截止</span></div>{summary.assets.map(a => <div className="tr" key={a.id}><span><b>{a.name}</b><small>{a.id} · {a.type}</small></span><span>v{a.version}</span><span className={`pill ${a.status}`}>{a.status}</span><span>{a.availableTo}</span></div>)}</div></section><section className="panel"><div className="panel-head"><h3>授权冲突</h3><span>{conflicts.length} detected</span></div>{conflicts.map((c, i) => <div className="conflict" key={i}><strong>{c.severity}</strong><b>{c.assetA}</b><small>{c.reason}</small></div>)}</section></div>}
    <footer>FrameLedger ledger baseline · 内存仓储 + 串行领域事务 + REST API · 可替换 PostgreSQL 唯一键、行锁和对象存储凭证</footer>
  </main>;
}
