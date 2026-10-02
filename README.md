# FrameLedger · 影视制作预算与资产版权协同平台

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型影视制作团队，管理预算版本、成本预测、供应商发票/凭证/付款对账、资产版本、授权窗口冲突与审批审计。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5173，API 默认 `http://localhost:4104`。

## 业务能力

- 项目 / 季 / 交付日期与预算基线；计划、承诺、实际、预测成本四账合一
- 供应商合同里程碑发票、银行/付款凭证和付款流水明细
- 合同与项目汇总金额全部从明细实时计算，避免合同总额和节点状态脱节
- 节点保留 `open / invoiced / paid`：有发票为 `invoiced`，累计付款达到节点金额才为 `paid`
- 支持部分付款、多笔付款和节点级发票累计；超额发票、超额付款、合同超额和无效凭证会被拒绝
- `Idempotency-Key` 请求头（或请求体 `idempotencyKey`）支持安全重试；同键不同内容返回 `409 IDEMPOTENCY_CONFLICT`
- 内存领域队列串行化财务写入，配合节点 `expectedVersion` / `expectedStatus` 乐观锁处理并发扣减和旧状态冲突
- 控制台提供“刷新恢复”，从服务器明细重新拉取合同、节点版本和项目汇总
- 发票、凭证、付款、节点转付均写入合同审计事件
- 母版、预告、海报、音频、字幕等资产版本和 checksum 登记
- 地域、平台、有效期、版权标签冲突检测
- 预算 / 资产 / 交付审批队列和审计事件

## 对账 API

- `GET /api/contracts/:id/ledger`：合同节点、发票、凭证、付款与审计明细
- `POST /api/vouchers`：登记付款凭证，需要幂等键
- `POST /api/contracts/:id/invoices`：登记节点发票，需要幂等键，可传 `expectedVersion`
- `POST /api/contracts/:id/payments`：登记付款，需要发票、有效且余额充足的凭证和幂等键

关键错误码：`OVERPAYMENT_REJECTED`、`INVOICE_EXCEEDS_MILESTONE`、`INVALID_VOUCHER`、`VOUCHER_BALANCE_EXCEEDED`、`STALE_VERSION`、`STALE_STATE`、`IDEMPOTENCY_CONFLICT`。

当前使用内存数据，领域服务按模块设计；生产环境可替换为 PostgreSQL 事务、唯一索引、行级锁/版本号、对象存储凭证和外部银行台账。
