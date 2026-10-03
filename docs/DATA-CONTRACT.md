# DATA-CONTRACT — 数据契约(版本 2026-10-04)

面向:未来本地小 LLM 批量导入的开发底稿、第三方对接、排查数据问题。**金额一律整数分(_cents),日期 ISO8601 文本。**

## 1. localStorage 键(计算器端,离线全量本地)

| 键 | 内容 |
|---|---|
| `drone_spray_state_v2` | 计算器全部输入状态(plant/field/costs/income/timing/haul*/workOrder) |
| `drone_spray_farmers_v1` | 农户档案(id/name/phone/pricePerMu/plotTemplate/enabled) |
| `drone_spray_types_v1` | 用药类型库(builtin 标内置) |
| `drone_spray_history_v2` | 最近 20 次计算记录 |
| `drone_spray_cloud_v1` | 主数据读反哺缓存(parties/chemicals/欠款,来自 /api/bootstrap,5 分钟刷新) |
| `drone_spray_server_v1` | **同步配置** `{base_url, enabled}`(P6-M1 起有 UI:顶栏 ☁️) |
| `drone_spray_sync_v1` | 同步队列 `{queue:[{client_job_id, job_no, payload, attempts, status: pending/syncing/failed/dead}]}`;探测门=GET /api/health 4s 超时,离线不累加 attempts;5xx/网络错退避 1/5/30 分钟,10 次转 dead;done 移出,上限 50 |

## 2. 计算器导出作业包(schema 2.1,P6-M1)

入口:计算器顶栏 📤 → **⬇ 下载作业包**(完整,不受勾选影响)/ 复制(受勾选影响)。

```jsonc
{
  "type": "drone-spray-config",     // 固定标识
  "version": "2.0",                 // 计算器自身导入兼容版本
  "schemaVersion": "2.1",           // ★记账端认这个:2.1=含 result 可导入;2.0/缺失=拒绝
  "mode": "spray | haul",
  "exportedAt": "ISO 时间",
  "client_job_id": "uuid",          // 幂等键;缺失时记账端自动生成(paste- 前缀)
  "plant": {...}, "field": {...},   // 作业参数/地块(snapshot,原样入 raw_json)
  "costs": {...}, "income": {...},  // income.pricePerMu = 每亩收费(元),服务端落到结算行 unit_price_cents
  "timing": {...},
  "haulField/haulCosts/haulIncome": {...},  // 吊运模式
  "workOrder": { "note": "...", "actualSets": ... },
  "farmers": [...], "types": [...], "batteries": { "list": [...] },
  "result": {                        // ★计算结果快照(2.1 必含;服务端消费金额与明细)
    "plots": [{ "id","name","area","farmerId","groupId","water","flightMin","pesticideRaw","pesticideRounded" }],
    "groups": [...], "totalTrips": .., "totalWater": ..,
    "costBreakdown": { "cycle","fuel","labor","pesticide","equipment","other" },
    "totalCost": .., "income": .., "profit": ..,
    "settlement": [{ "farmerId","farmerName","area","sprayFee","usedSets","selfSets","supplementSets","pesticideFee","included" }],
    "timing": { "batteryCycles": [...] }
  }
}
```

**导入端点**:`POST /api/jobs`(同源或跨域均可;幂等按 client_job_id,重复返回原单 `duplicated:true`)。ledger 导入页"粘贴计算器作业包"即此协议。校验逻辑:`ledger/js/core.js calculatorJobPayload`(纯函数,有测试)。

## 3. 服务端作业→账面流水(导入后发生什么)

```
POST /api/jobs ──► jobs(status=completed) + job_plots + flight_groups
                   + job_settlement_lines(主行 unit_price=income.pricePerMu)
                   + job_battery_cycles + parties upsert(只建不改)
工单页"生成结算" ──► settlements(draft) + settlement_items
"确认" ──► bills(每分项一张) + 分录:借 1122 应收 / 贷 6001 作业收入 + 6002 药收入;jobs→settled
收款 ──► receipts + 分录:借 1001-1004 现金/微信/支付宝/银行 / 贷 1122;账单 paid_cents 联动
按客户收款 ──► FIFO 核销最早未清账单,余款转预收(advances 1123)
"撤回确认" ──► 红冲原分录(reversal_of 指向)+ 账单作废 + 作业回可编辑
```

硬规则:物理量(亩数/水量/趟数/用药)只读,改错=计算器重传新单+旧单 void;edit_logs 全程留痕;借贷必须平衡(service 层断言 UNBALANCED)。

## 4. Excel 历史导入管线(本地小 LLM 的对照样板)

`POST /api/import/parse(base64)` → raw_import_rows(staging,每行 parsed_json+needs_review)→ 行级确认/拒绝/改数(PATCH /api/import/rows/:id,**服务端已支持改 parsed**)→ `POST /api/import/batches/:id/apply`(整体单事务,毒行=零残留可重试)→ 对账守恒(GET .../reconciliation,与解析器同源 scanZone,改规则必须两边同步)。

**LLM 化缺口(路线图,见 docs/REVIEW-P5.md §4)**:确定性校验层(apply 信任 parsed_json,毒行靠约束炸出)、schema 化 LLM 输出契约、置信度字段、自然键幂等(现仅整文件 hash)、复核改数 UI。

## 5. 金额科目速查

1001 现金/1002 微信/1003 支付宝/1004 银行/1122 应收/1123 预收/1221 预支付款/4103 期初权益/5001 油费/5002 维修/5003 餐费/5004 人工/5005 设备/5006 药费/5007 分成。6001 作业收入/6002 药品收入。
