# spraybook API 契约（v1，M2 定死、M4 照建）

- Base URL：`http://<记账机IP>:8080/api`（端口随 server 配置）
- 统一返回体：成功 `{ "ok": true, "data": ... }`；失败 `{ "ok": false, "error": { "code": "...", "message": "..." } }`
- CORS：`Access-Control-Allow-Origin: *`（file:// 打开的计算器 Origin 为 null，必须放行）
- 金额一律 INTEGER 分（`*_cents`）；日期一律 ISO8601 TEXT
- 认证：P0 无（仅局域网）；上云后加口令（M9+）

## 1. 健康检查

`GET /api/health` → `{ ok:true, data:{ name:"spraybook", version, db:"ok", time } }`

## 2. 作业执行层（计算器写，记账读）

### POST /api/jobs —— 计算器上报一次作业（幂等）
请求体：
```json
{
  "client_job_id": "uuid-v4",
  "job_no": "20260929-A1B2",
  "job_type": "spray | haul",
  "job_date": "2026-09-29",
  "address": "可选",
  "operator_names": ["张三"],
  "note": "可选",
  "snapshot": { ...exportJSON 解析对象（docs/export-json-sample.json 的 export 部分） },
  "result": { ...计算结果对象（同文件 result 部分） }
}
```
处理：事务内写 jobs + job_plots + flight_groups + job_settlement_lines + job_battery_cycles；金额元→分；农户按 name+phone upsert 进 parties（只建不改，source='calculator'）。
- `client_job_id` 已存在 → 返回原单 `{ ok:true, data:{ job, duplicated:true } }`，不覆盖不重建
- `job_no` 冲突 → 服务端重生成，响应 `data.job.job_no` 为最终号
- 吊运：无 job_plots/job_settlement_lines（settlement 直接由 job 金额生成）

### GET /api/jobs?status=&date=&from=&to=
返回 jobs 列表（含 job_settlement_lines 摘要），按 job_date desc。

### GET /api/jobs/:id —— 详情（含全部子表 + raw_json）

### PATCH /api/jobs/:id —— 金额/备注更正（编辑权界）
- 可改白名单（仅金额类+备注）：`note`、job_settlement_lines 的 `spray_fee_cents / pesticide_fee_cents`、`adjust_cents` 相关字段
- 拒绝物理量字段（total_area_mu/actual_sets/total_water_l/total_trips 等）→ 400 `PHYSICAL_FIELD_READONLY`，message:"请在计算器更正后重新同步（新单），本单作废"
- 状态机拒绝：settled/void → 400 `INVALID_STATE`
- 成功 → 重算 jobs 合计字段 + edit_logs

## 3. 结算财务层（M4/M5 实现）

### POST /api/settlements —— 从 job 生成结算
`{ job_id }` → settlements + settlement_items（打药：来自 job_settlement_lines；吊运：单行来自 job 金额）；jobs 需为 completed/reopened 状态，否则 400。
返回 settlement 全文（含 items）。

### PATCH /api/settlements/:id —— 未确认可改 items
`{ items:[{ id, spray_fee_cents, pesticide_fee_cents, ... }] }` → 重算总额，bills 联动重算（若 bills 已生成）。已确认 → 400。

### POST /api/settlements/:id/confirm —— 确认结算
生成 bills（每农户一张）+ 自动复式分录 + jobs.status='settled'。返回 bills 与 journal entry。

### POST /api/settlements/:id/reopen —— 撤回确认
红冲原分录（等额反向、原分录不动）+ bills 作废 + jobs.status='reopened'。edit_logs 记录。

### POST /api/settlements/:id/void —— 作废
同 reopen 的红冲+作废，终态不重开。

### bills
`GET /api/bills?status=&party_id=`；`PATCH /api/bills/:id`（未收款可改 amount_cents/adjust_cents；已收款 → 400 提示走撤回）。

### receipts / payments / advances（M5）
- `POST /api/receipts` `{ bill_id, party_id, amount_cents, method, occurred_at, from_advance_id? }`（部分收款=同 bill 多笔；预收抵扣带 from_advance_id 并扣减 advance 余额、写 advance_usages）
- `POST /api/payments` `{ category: fuel|chemical|repair|meal|equipment|labor|other, payee_party_id?, job_id?, amount_cents, occurred_at, note }`
- `POST /api/advances` `{ party_id, direction: prepaid_by_customer|advance_to_worker, amount_cents, occurred_at, note }`
- `PATCH /:id`、`POST /:id/void`（作废=反向分录，不删记录）——receipts/payments/advances 均支持
- `POST /api/splits` manual_splits 手工分成登记

## 4. 复式记账

`GET /api/journal?from=&to=&ref_type=&ref_id=` → journal_entries + lines（借/贷分列、附科目名）；每条 entry 服务层断言 `SUM(debit)=SUM(credit)`。
科目 seed（约 15 个）：1001 现金 / 1002 微信 / 1003 支付宝 / 1004 银行 / 1122 应收账款 / 1123 预收账款 / 1221 其他应收-员工预支 / 5001 主营成本-药 / 5002 主营成本-油费 / 5003 主营成本-维修 / 5004 主营成本-餐费 / 5005 主营成本-设备 / 5006 主营成本-人工 / 6001 主营收入-作业 / 6002 主营收入-药 / 4103 期初权益。

## 5. 查询/报表（M6+）

`GET /api/reports/profit?by=job|customer|month`；`GET /api/parties/:id/balance`（欠款/预收余额）。属后续批次，契约届时补充。

## 6. 错误码

| code | HTTP | 含义 |
|---|---|---|
| VALIDATION | 400 | 字段校验失败（含 missing/类型/金额负数） |
| DUPLICATE | 200 | client_job_id 重复（按幂等成功处理，duplicated:true） |
| PHYSICAL_FIELD_READONLY | 400 | 试图改物理量字段 |
| INVALID_STATE | 400 | 状态机不允许的操作 |
| NOT_FOUND | 404 | 资源不存在 |
| UNBALANCED | 500 | 分录借贷不平（不应出现，出现即 bug） |
