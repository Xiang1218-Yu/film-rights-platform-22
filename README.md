# FrameLedger · 影视制作预算与资产版权协同平台

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型影视制作团队，演示预算版本、成本预测、合同里程碑、资产版本、授权窗口冲突与审批审计的协同闭环。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5175，API 默认 `http://localhost:4104`。

## 业务能力

- 项目 / 季 / 交付日期与预算基线；计划、承诺、实际、预测成本四账合一
- 供应商合同额度、付款里程碑与付款暴露额
- 合同对账台账：发票 / 付款 / 凭证登记，节点累计确认额达到金额才转 paid，合同与项目汇总全部由明细推导
- 对账写入具备幂等键重放、超额拒绝、凭证校验、乐观版本冲突与快照恢复，全程审计
- 母版、预告、海报、音频、字幕等资产版本和 checksum 登记
- 地域、平台、有效期、版权标签冲突检测
- 预算 / 资产 / 交付审批队列和审计事件
- React 控制台支持项目切换、预算表、风险雷达、审批操作和版权资产视图

当前使用内存数据，领域服务按模块设计，后续可替换 PostgreSQL、对象存储、工作流和版权方台账服务。

## 对账 API

- `GET /api/contracts/:id/ledger` 合同台账：节点开票 / 付款累计、推导状态、台账版本号与发票付款明细
- `POST /api/contracts/:id/invoices` 登记发票（`idempotencyKey` 必填，`expectedVersion` 乐观锁可选）
- `POST /api/contracts/:id/payments` 登记付款（附凭证：类型 / 编号 / 开具方 / 金额，凭证编号全局唯一）
- `GET /api/audit` 审计事件流

相同幂等键同内容重放返回原记录（`replayed: true`），同键换内容返回 409；超额付款、超开、无效或重复凭证均被拒绝并留痕。台账快照写入 `server/data/finance-ledger.json`（可用 `FINANCE_LEDGER_FILE` 覆盖），重启后明细、版本号与幂等注册表完整恢复。
