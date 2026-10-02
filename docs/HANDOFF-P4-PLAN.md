# HANDOFF-P4-PLAN — 总表主界面 + 图表分析页（P4 实施方案）

日期:2026-10-02。前置:HANDOFF-P3(P3 已完成,测试全绿)。本方案综合四份调研(原表画像/前端盘点/指标盘点/结构审查),并经本会话代码实读 + 真库只读验证 + SQL 实测后落定。

## 0. 修订记录

- **R3(2026-10-02,第三轮评审)**:第三轮 ask 的 blockers/建议与第二轮相同均为空(`undefined`,结果传递丢失),按第二轮 escalation 确认的既定方式执行第三轮自检,未臆造评审意见。自检修正 3 点:
  1. [断言/引用]§3.4.1 customer_count 数据源引用校准:结算分项挂 `party_id` 发生在创建时 `settlements.js:52-65`(原误引 148-155——那是确认分录行的 party_id,两处均在,现一并注明),实读核实。
  2. [实现边界]§2.4 补客户过滤降级说明:`state.custFilter` 为全局单值、总表按 `customer_names` 精确匹配,当前库 104 单均单客户可用;未来一作业多客户时精确匹配滤不掉该行,记遗留不改 LIKE。
  3. [测试可行性]§5-M2-2 补超收造数方式:`createReceipt` 超额校验(finance.js:42-46)保持不变,测试经 freshDb 的 db 句柄直接 UPDATE bills 造数。
  复核通过项:`journal.js:54-74` reverseEntry 引用无误(实读);005 迁移 bills.settlement_id 可空属实(005:4 注释、:19 列定义,表重建);收款人 40/96 实测吻合(`SELECT COUNT(*) FROM receipts WHERE status='active' AND collector_name IS NOT NULL AND collector_name != ''` = 40,总数 96);R1/R2 各条修订维持不变。
- **R2(2026-10-02,第二轮评审)**:第二轮评审返回的结构化内容丢失(blockers/建议均为空),**本段为设计者自检修订**,未臆造任何评审意见。自检按四条标准逐项过(断言 vs 代码、破坏现有功能风险、四条需求、硬约束),实际修正 6 点:
  1. [断言/行号]表头识别行号校准:`importExcel.js:288-302` → **290-302**(循环起于 290、命中条件 296,grep 实测)。
  2. [断言/行号]applyJobRow 的 jobs INSERT 行号校准:原写"476-489 行 INSERT" → **482-493**(482 为 INSERT 行,476 为函数起点,grep 实测)。
  3. [断言/行号]导入 payable 行号校准:原写"importExcel.js:555-559" → **550**(`const payable = totalReceivable - (parsed.discount_cents || 0)`,grep 实测)。
  4. [markdown]修复 R1 引入的表格缺陷:6 个表格行单元格内未转义竖线(`j.purpose || j.plant_type_name`、`amount − |adjust|`、`(job|journal)` 等)会截断表格渲染,统一改写为 `COALESCE`/`ABS(adjust)`/`job/journal`;复检 7 个表格块每块管道数一致。
  5. [实现陷阱]「登记收款」复用两坑补进 §2.5/§6-M1:`bill-receive` 硬编码 `colspan="8"`(app.js:769)总表需按列数生成;`receiveForm` 预收下拉依赖 `state._advances`(app.js:284)而 doRender 仅 payments/advances 分支加载(571,574),overview 分支必须同载。已核实 app-extra.js 零使用 toolbarHtml/csv-export,panel 作用域修正不波及主数据/导入页。
  6. [实现陷阱/口径]§2.6 补编辑态渲染说明(renderOverview 按 `editMode('overview')` 输出输入、data-orig 走 esc 转义);§4.1 行 5 补 bills/总表抹零输入提示文案随 `ABS` 口径更新("正负均按优惠金额计")。
  其余断言复核通过(purpose 在 raw_json 非空恰 27 行,与 plant_type_name '清园' 27 行一致;`gran-set`/`ov-jump-month` 不落入 app-extra 前缀正则,进 app.js switch 即可;月 2026-01=27 行;canEdit/patchBill/logEdit 等引用行号无误),R1 的 10 条修订维持不变。**若评审方后续补发具体 blocker 条目,再逐条落盘。**
- **R1(2026-10-02,评审修订)**:
  1. **[blocker]修正 M1 验收实收数字**:§5-M1-3 原写"实收 84,216.00"与方案自测矛盾——`/api/overview` SQL 的 Σpaid=8,770,600 分=**87,706.00 元**(评审以同一 SQL 只读复跑确认)。84,216.00 是 P3 导入对账基线(源 Excel 口径),不是 bills.paid 合计,验收一律以 overview 端点 SQL 口径为准(「本会话验证记录」、§2.1、§5-M1-3 已同步修正)。
  2. **[blocker]补齐 payable 口径统一站点**:§4.1 行 5 原只列 core.js 与 reports.js 两处,实际 `amount+adjust` 还硬编码在 finance.js 五处(收款校验/置已清/FIFO 核销/编辑回写/作废回退)、settlements.js listBills、reports.js 另两处应收 SQL——漏改任一处,未来导入"未收款+抹零"行(adjust>0、unpaid)会出现前端显示 990、后端按 1010 收款核销的双语义 bug。§4.1 行 5 与 §6-M1 改动清单已补齐全部站点(共 10 处站点/11 个表达式;现库 unpaid/partial 且 adjust≠0 为 0 笔,补齐不改现值,本会话已实测)。
  3. **[blocker]修复总表双工具条 `#ftQ` 重复 id**:toolbarHtml 硬编码 `id="ftQ"`(app.js:526),搜索防抖判断与焦点恢复也按固定 id(app.js:624,631)——同页两条工具条即重复 DOM id 且焦点必跳面板 1。§2.4/§2.5/§6-M1 改为:搜索框 id 按页签唯一(`ftQ-{tab}`)、事件按前缀 `/^ftQ/` 匹配、焦点恢复用 `el.id`;总表支出面板用独立状态键 `ovpay`(不与支出页共享 `state.month/filter.payments`);csv 文件名支持按面板覆盖。
  4. **[blocker]'作物/目的'取值同步改**:工单详情原取 `j.plant_type_name`(app.js:110),008 落地后新导入行该列为空会恒显示"—";改为 `j.purpose || j.plant_type_name`(getJob 为 SELECT *,purpose 随行返回,jobs.js:258)。§4.1 行 3 与 §6-M1 已修正。
  5. [建议采纳]回收率删"双口径"承诺:§3.1/§3.4.2 明确 collection_rate 仅账单(billed)口径;cash 口径(按 receipts.occurred_at 另轴)记为遗留加分项。
  6. [建议采纳]§3.4.3 成本列名修正为真实列名:`fuel_expense_cents`/`battery_depreciation_cents`(001_init.sql:145-146)+ `labor/pesticide/equipment/misc_cost_cents`(007:13-16)。
  7. [建议采纳]客户列兜底与 SQL 骨架对齐:§2.1 SQL 改 `GROUP_CONCAT(DISTINCT COALESCE(p.name, b.farmer_name))`。
  8. [建议采纳]期初补录账单口径差脚注:主数据页期初补录可产生 `settlement_id IS NULL` 的 bills(import.js:215-235,当前库 0 行),不进总表行但进 summary 应收,§2.1 加脚注说明差口何时出现。
  9. [建议采纳]顺带修现存 bug:`Api.saveSettings` 调 `Api.put` 但 api.js 只定义 get/post/patch(api.js:26-28,71),主数据页"保存记账人"(app-extra.js:231)点击即 TypeError;服务端 `PUT /api/settings` 早已存在(masterdata.js:89)。M1 补 `put` 封装 + 回归测试。
  10. [建议采纳]M2 验收周桶文本改"W00..W20"(实测 2026-01-01 落 2026-W00 且有 2 行数据);adjustments 注明回收率可>100%(4 笔超收)。

**用户四条需求对应**:①工单排后 → §1;②总表主界面 → §2;③图表页 → §3;④结构/数据/前端全面审查 → §4。

**硬约束遵守**:原生 JS 无构建、零外部 CDN/库(图表内联 SVG 手绘);金额一律 `_cents`;编辑留痕只走既有 PATCH 端点+`logEdit`;migration 只增不改(008 仅 ADD COLUMN);不删除任何现有页签(11 → 13 个,原 11 个全部保留且功能不动);测试基线不破坏。

**本会话验证记录**(方案依据,均已实跑):
- 测试基线:`cd server && node --test ../tests/server/` → **49 通过 0 失败**;`node --test ../tests` → **71 通过 0 失败**(calc 48 + sync 16 + ledger-core 7);合计 **120 全绿**。
- 真库只读查询(`data/app.db`,better-sqlite3 readonly):jobs 104(全 `source='import'`、`settled`);结算主行 `unit_price_cents` **104/104 全 NULL**;`kind='extra'` 行 4;`plant_type_name` '清园' 27 / NULL 77;`referral_name` 40 行有值;`operator_names` 空 62;`payments` 56/56 无 job_id;**`bills.adjust_cents` 为正的有 9 笔共 +3080 分且全部 `status='paid'`(导入抹零正数语义),`unpaid/partial` 且 adjust≠0 的为 0 笔**;超收账单 4 笔(B-025/035/079/099);月份分布 2026-01..05;raw_json 含 `price_yuan` 的 104/104。
- overview 单 JOIN SQL 在真库实测:**104 行 / 4.3ms / 47.1KB**;Σamount=10,117,010 分=**101,170.10 元**(=jobs.income 合计)、Σpaid=8,770,600 分=**87,706.00 元**(=receipts 合计,bills 与 receipts 两表各自求和均为 8,770,600,本会话复跑确认)、Σdue=1,345,330 分=**13,453.30 元**、Σdiscount=3,080 分=**30.80 元**(=reports.js 应收口径合计,`server/services/reports.js:37-39`)——三平。
  **口径澄清**:P3 手账里的"实收 84,216"是**源 Excel 导入对账基线**,不是库内 `bills.paid` 合计;本方案所有合计/验收数字一律以 overview 端点 SQL 口径为准(评审以同一 SQL 只读复跑,结果一致)。
- 月/季/周/年四种 bucket SQL 在真库实测通过(month=`2026-01`、quarter=`2026-Q1`、week=`2026-W00`(W01..W20 亦有分布,2026-01-01 落 W00)、year=`2026`)。

---

## 1. 导航新顺序(需求①)

改动只涉及两处,零逻辑:`ledger/index.html:16-28` 按钮顺序 + `ledger/js/app.js:489` `state.tab` 初值。导航点击是通用 `data-tab` 委托(`app.js:596-602`),`switchNav` 按 key 匹配(`app.js:915-917`),跨页跳转(工单→结算 `app.js:727-729`)按 key 不受影响;前端测试全为纯函数测试,不测 DOM。

**新顺序表(11 → 13 键)**:

| 序 | 键(data-tab) | 名称 | 说明 |
|---|---|---|---|
| 1 | `overview` | **总表** | **新增,默认 active**(原 Excel 全数据通看主界面) |
| 2 | `settlements` | 结算 | 原位 |
| 3 | `bills` | 账单 | 原位 |
| 4 | `receipts` | 收款 | 原位 |
| 5 | `payments` | 支出 | 原位 |
| 6 | `advances` | 预收预支 | 原位 |
| 7 | `splits` | 分成 | 原位 |
| 8 | `charts` | **图表** | 新增(分析页,与报表相邻) |
| 9 | `reports` | 报表 | 后移 1 位 |
| 10 | `jobs` | 工单 | **后移至报表之后**(执行明细/钻取页,不再作首屏) |
| 11 | `master` | 主数据 | 原位(注意 key `master` 已被占用,总表用 `overview`,**不得复用**) |
| 12 | `import` | 导入 | 原位 |
| 13 | `journal` | 流水 | 原位 |

顺序理由:记账主流程(总表→结算→账单→收款→支出)保持原有相对次序不变,只把总表插到最前;分析页(图表/报表)相邻;工单作为"执行明细"下移;工具页(主数据/导入/流水)殿后。

---

## 2. 总表页规格(需求②,key=`overview`)

### 2.1 数据源 —— 采纳结构审查建议:新增单一聚合端点

**`GET /api/overview?from=&to=&status=&limit=`**(新文件 `server/services/overview.js` + 路由挂到 `server/routes/ledger.js`)。

采纳理由(结构审查 + 本会话复核):单 JOIN 真库实测 104 行/4.3ms/47KB;而前端拼 5 个既有列表端点 ≈158KB、要客户端重放 receipts→bill→settlement→job 三级映射,且 `listSettlements`/`listBills`(`server/services/settlements.js:228,240`)、`listReceipts/listPayments/listAdvances`(`server/services/finance.js:463,469,474,480`)均有 `LIMIT 500`、`byJob` 有 `LIMIT 200`(`server/services/reports.js:103`)的静默截断风险。行=**作业单**(与原 Excel 行粒度一致;账单字段按作业聚合)。

已实测的 SQL 骨架(输出字段即端点字段):

```sql
SELECT j.id, j.job_no, j.job_date, j.status AS job_status, j.source, j.job_type,
  j.total_area_mu, j.income_cents, j.note, j.referral_name, j.operator_names,
  COALESCE(j.purpose, j.plant_type_name) AS plant_label,        -- 008 新列,见 2.3
  GROUP_CONCAT(DISTINCT COALESCE(p.name, b.farmer_name)) AS customer_names,
  MAX(p.region) AS region, MAX(p.village) AS village, MAX(p.team) AS team,
  (SELECT l.unit_price_cents FROM job_settlement_lines l
    WHERE l.job_id=j.id AND l.kind='spray' AND l.unit_price_cents IS NOT NULL LIMIT 1) AS unit_price_cents,
  COALESCE(SUM(b.amount_cents),0) AS amount_cents,              -- 应收
  COALESCE(SUM(b.paid_cents),0) AS paid_cents,                  -- 实收
  COALESCE(SUM(CASE WHEN b.status='void' THEN 0 ELSE ABS(b.adjust_cents) END),0) AS discount_cents,
  COALESCE(SUM(CASE WHEN b.status IN ('unpaid','partial')
    THEN b.amount_cents - ABS(b.adjust_cents) - b.paid_cents ELSE 0 END),0) AS due_cents,
  GROUP_CONCAT(DISTINCT b.status) AS bill_statuses,
  COUNT(b.id) AS bill_count,
  (SELECT COALESCE(SUM(l2.spray_fee_cents),0) FROM job_settlement_lines l2
    WHERE l2.job_id=j.id AND l2.kind='extra') AS extra_cents,
  (SELECT r.collector_name FROM receipts r WHERE r.status='active' AND r.bill_id IN
    (SELECT b2.id FROM bills b2 WHERE b2.settlement_id=s.id AND b2.status!='void') LIMIT 1) AS collector_name
FROM jobs j
LEFT JOIN settlements s ON s.job_id=j.id AND s.status!='void'
LEFT JOIN bills b ON b.settlement_id=s.id AND b.status!='void'
LEFT JOIN parties p ON p.id=b.party_id
WHERE j.deleted_at IS NULL AND j.status!='void'   -- + 可选 from/to/status
GROUP BY j.id ORDER BY j.job_date DESC, j.id DESC LIMIT 2000
```

要点:`operator_names` 服务端 JSON.parse 成数组再返回(同 `getJob` 做法,`server/services/jobs.js:260`);响应附 `totals` 对象(服务端各列合计,供与前端 tfoot 对账自校验);实库 `bills` 无 `settlement_id IS NULL` 的行(实测 0 行);`limit` 上限 2000。

> **期初账单口径差脚注**:主数据页"期初补录"会插入 `settlement_id IS NULL` 的 bills(`server/routes/import.js:215-235`,kind='receivable' 分支,005 迁移后该列可空)。此类账单**不进总表行**(无作业可挂)但**计入 `summary.receivable`**(reports.js:37-39 只看 bills)——当前库 0 行、两口径一致;一旦用户开始期初补录,总表合计与报表应收将差出该部分。M1 在总表页脚注说明;若实际出现此类数据,再在总表页加"未挂作业账单"第三表(列为遗留加分项,不在本轮)。

### 2.2 列清单 —— 原 Excel 14 列逐列映射 + 增强列

原表标准区 14 列(2-12 月份同构,1 月份多"作业目的"一列;表头按列名识别 `server/services/importExcel.js:290-302`,条件在 296):

| # | 原 Excel 列 | 总表列(表头) | 库内数据源 | 缺口与处理 |
|---|---|---|---|---|
| 1 | 日期 | 日期 | `jobs.job_date` | 已有 |
| 2 | 姓名 | 客户 | `parties.name`(经 bills.party_id),兜底 `bills.farmer_name` | listJobs 未回(`server/services/jobs.js:246-251`),由 overview 端点返回;复用 `custCell` 点击过滤 |
| 3 | 客户地址 | 村·队 | `parties.region/village/team` | 同上;显示 `village·team`,悬浮 region |
| 4 | 客户亩数 | 亩数 | `jobs.total_area_mu` | 已有 |
| 5 | 价格亩/元 | 单价(元/亩) | 主结算行 `unit_price_cents`(kind='spray') | **104/104 全 NULL** → M1 回填脚本(§2.3) |
| 6 | 应收金额 | 应收(元) | `SUM(bills.amount_cents)` | 现"收入(元)"列实为 `jobs.income_cents`(含 extra);总表改账单口径,extra 以标签显示 |
| 7 | 实收金额 | 实收(元) | `SUM(bills.paid_cents)` | listJobs 未回 → 端点返回 |
| 8 | (原表无) | 未收(元) | `due_cents`(status 驱动,见下) | 增强 |
| 9 | (原表隐含) | 抹零(元) | `ABS(bills.adjust_cents)` | 增强;正负双语义统一,见 §4.1 |
| 10 | 业务来源 | 来源 | `jobs.referral_name` | 40/104 有值,余 '—' |
| 11 | 作业人员 | 人员 | `jobs.operator_names` | 62/104 空 → '—' |
| 12 | 收款人 | 收款人 | `receipts.collector_name` | 40/96 有值,余 '—' |
| 13 | 备注 | 备注 | `jobs.note` | 已有 |
| 14 | 支出项目/支出金额 | **同页第二表「支出流水」** | `payments`(category/amount_cents/occurred_at/note) | 支出与作业无外键关联(56/56 无 job_id),无法并为一行 → 独立表格,见 §2.5 |
| — | 作业目的(仅 1 月 sheet) | 目的 | `COALESCE(jobs.purpose, jobs.plant_type_name)` | 008 迁移 + 回填(§2.3);修复现 plant_type_name 双语义 |
| — | 地块数量 | **暂缺** | 导入即丢(`importExcel.js:313-324` get 列表无此项,仅进 raw_text) | **遗留待裁决**(§4.2 条 1),不解析原文回填 |

**增强列**:单号(`job_no`,兼容 J 前缀导入号与 YYYYMMDD-XXXX 计算器号)、状态(作业状态 tag + 账单状态 tag)、extra 标签(`另按 X 元/亩`,复用 `app.js:79` 样式)、操作(详情→展开工单详情 slot、未收账单行"登记收款"按钮复用 `bill-receive`)。

**未收差额口径**:`status IN ('unpaid','partial')` 才计 `amount − |adjust| − paid`,`paid/void` 记 0——与 reports.js 应收口径一致,且规避导入正数 adjust 的双语义陷阱(实测 unpaid/partial 中 adjust≠0 为 0 笔,两公式现值同)。

### 2.3 数据订正与迁移(M1,全部"只增不改"+订正脚本)

1. **`server/db/migrations/008_job_purpose.sql`(新)**:仅 `ALTER TABLE jobs ADD COLUMN purpose TEXT;`(套 `007_cost_plots_lines.sql` 注释风格;装载机制 `server/db/client.js:26-52` 顺序执行只增不改)。
2. **`server/db/backfill-008.js`(新)**,仿 `backfill-007.js` 模式(自动备份 .db、事务、幂等、金额基线 sums_unchanged 硬断言):
   - 单价回填:从 `raw_json.raw.price_yuan` 回填 104 主结算行 `job_settlement_lines.unit_price_cents`(实库 104/104 raw_json 均含 price_yuan;金额分文不动,只填 NULL 列);
   - purpose 回填:从 `raw_json.raw.purpose` 回填 `jobs.purpose`(仅 1 月份 27 行有值);存量 `plant_type_name='清园'` 不动,展示层 COALESCE。
3. **`server/services/importExcel.js` 落库列修正**:applyJobRow 的 jobs INSERT(482-493,函数起于 476)增 `purpose` 列,`parsed.purpose` 写入新列、不再占用 `plant_type_name`(该列还给计算器的"作物"语义,`server/services/jobs.js:67-68` 不动);20 列上限(`importExcel.js:327,341`、`server/routes/import.js:102`)**不动**(见 §4.2 条 1)。

### 2.4 检索/分页/客户过滤 —— 复用现有管线 + 修 `#ftQ` 重复 id(评审 blocker 3)

复用:`toolbarHtml`(`app.js:519-532`,搜索框+导出按钮)+`monthStrip`(`app.js:494-499`,月分页)+`byMonth`(`app.js:500-504`)+`pipeFilters`(`app.js:508-517`,q 搜 job_no/customer_names/地址/referral/note)+`custCell`(`app.js:534-538`,客户名点击只看此客户)+`tfootHtml`(`app.js:543-547`,合计行)。

**必须先修的硬伤**:现工具条把搜索框 id 写死为 `ftQ`(app.js:526),输入防抖判断 `el.id !== 'ftQ'`(app.js:624)、渲染后焦点恢复 `document.getElementById('ftQ')`(app.js:631)——总表同页两条工具条即产生**重复 DOM id**(HTML 非法),且焦点永远跳回面板 1 的搜索框。前置小修(对单工具条页签零行为变化):

1. `toolbarHtml` 搜索框 id 改为按状态键唯一:`id="ftQ-${tab}"`(`tab` 即传入的状态键);
2. 输入监听改前缀匹配:`if (!/^ftQ/.test(el.id)) return;`(app.js:624);焦点恢复改 `document.getElementById(el.id)`(app.js:631,渲染前先存 `const inpId = el.id`);
3. `ftStatus/ftCategory` 下拉绑死 id 的同类问题(app.js:636-643)总表不涉及——总表**不加**状态/类别下拉,检索以搜索框+月分页+客户过滤为主(宽表场景下拉意义有限)。

**合计行**:主表 tfoot = 应收/实收/未收/抹零 四列合计 + 行数(void 不计,与账单页口径一致);支出表 tfoot = 支出合计。客户过滤沿用全局单值 `state.custFilter`(app.js:515,698-707),总表按 `customer_names` **精确匹配**——当前库 104 单均单客户(GROUP_CONCAT 单名)完全可用;未来计算器单出现一作业多客户时,精确匹配会滤不掉该行,属可接受降级(行仍在列表中),届时再改 LIKE 匹配(记遗留,不在本轮)。

**CSV 导出**:现 `case 'csv-export'` 只导 `#lgMain` 第一个表(`app.js:680`)。**小修**:改为 `btn.closest('.lg-panel').querySelector('table')`——总表两块面板各带工具条,主表/支出表各自导出;对单表页签行为不变(按钮与表格同面板)。文件名沿用 `spraybook-{tab}-{month}.csv`(`app.js:692`)。

### 2.5 总表页布局与第二表(支出流水)

- 面板 1「总表(原 Excel 全数据通看)」:工具条 + 月分页 + 宽表(`.lg-table--wide`,min-width 1280px,面板横向滚动 `ledger/css/ledger.css:44`)+ tfoot 合计。行尾隐藏 detail slot,「详情」按钮复用 `toggleDetailSlot + jobDetail`(`app.js:720-723`),展示原表自由流水区信息(raw_json 已入库,详情不重新解析原文)。
- 面板 2「支出流水(原表支出项目/金额列)」:复用支出页的渲染与过滤(`app.js:298-336` 精简版),搜索/月分页/合计/CSV 同管线。
- **面板 2 必须用独立状态键 `ovpay`**(评审 blocker 3 的第二半):`monthStrip('ovpay',…)`/`byMonth(rows,'occurred_at','ovpay')`/`pipeFilters(rows,'ovpay',…)`/`toolbarHtml('ovpay',…)`。`state.month`/`state.filter` 按 tab 键控(`app.js:489,494-517`),若面板 2 复用 `payments` 键,总表上切月会串改支出页的筛选。`ovpay` 只作状态键,**不加导航按钮**,导航渲染不受影响;客户过滤 `state.custFilter` 为全局单值(`app.js:515,698-707`),总表两表与账单/收款页共享该行为(P3 既有语义,保持)。
- **CSV 文件名**:现文件名取 `state.tab`(app.js:692),面板 2 导出会误名 `overview`;`csv-export` 增 `data-csvname` 覆盖(`a.download = \`spraybook-${btn.dataset.csvname || state.tab}-…\``),面板 2 传 `ovpay`。
- **「登记收款」复用的两个实现陷阱**(自检发现):①`bill-receive` 硬编码插入行 `colspan="8"`(app.js:769,按账单页 8 列写死)——总表约 17 列,直接复用会渲染错位,总表内该按钮需生成 `colspan=总表列数`;②`receiveForm` 的预收抵扣下拉依赖 `state._advances`(app.js:284),而 doRender 只在 payments/advances 分支加载它(app.js:571,574)——overview 分支必须同样 `state._advances = await Api.advances()`,否则下拉恒空。已核实 app-extra.js 不使用 toolbarHtml/csv-export(grep 零命中),panel 作用域修正不影响主数据/导入页。

### 2.6 行内编辑:字段 → 既有 PATCH 端点映射表(物理量不可改)

总表纳入 FAB 编辑模式:`editableTabs`(`app.js:905`)增 `'overview'`;编辑输入按行类型用**两个收集通道** `data-ekb`(账单行)/`data-ekp`(支出行),`saveEditMode`(`app.js:879-894`)对 `tab==='overview'` 分两次 `collectInputs('data-ekb'/'data-ekp')` 并按行类型路由(`collectInputs` 现有逻辑零改动,`app.js:645-658`)。

| 可编辑单元 | data-f | PATCH 端点 | 服务端白名单(已核) | 锁定条件 |
|---|---|---|---|---|
| 账单行·应收 | `amount_cents` | `PATCH /api/bills/:id`(`server/services/settlements.js:244-270`) | amount_cents / adjust_cents / note | `canEdit = status='unpaid' && paid==0`(`ledger/js/core.js:80`);已收行 🔒(悬浮"已有收款,请先撤回") |
| 账单行·抹零 | `adjust_cents` | 同上 | 同上 | 同上 |
| 账单行·备注 | `note` | 同上 | 同上 | 同上 |
| 支出行·类别 | `category`(select,500 CHECK 安全下拉) | `PATCH /api/payments/:id`(`server/services/finance.js:189-219`) | category / amount_cents / occurred_at / note / method / payee_party_id | 非 void |
| 支出行·金额 | `amount_cents` | 同上 | 同上(服务端红冲原分录+重登,留痕) | 非 void |
| 支出行·备注 | `note` | 同上 | 同上 | 非 void |

**不可编辑(锁定,展示但禁改)**:
- 作业备注、亩数等作业字段:104 单全 `settled`,`patchJob` 拒绝(`server/services/jobs.js:274-276`),且物理量字段服务端硬拒(`jobs.js:14-18,280-285`)→ 总表对 `jobs.*` 一律只读,悬浮提示"作业已结算,更正走工单详情/结算层";
- 多账单作业(未来计算器单可能 1 作业 N 账单):金额/抹零仅当 `bill_count===1` 时可直填,多账单 🔒 提示"请到账单页逐张修改"(当前库 104 单均 1:1,不受影响);
- 实收列不提供行内改(收款编辑走收款页 `PATCH /api/receipts/:id`,红冲语义重);预收预支不进总表(独立页签)。

所有编辑自动留痕:上述服务端函数内部均调 `logEdit`(settlements.js:266、finance.js:181/214),**不新增任何写路径**。编辑态渲染对齐既有模式:`renderOverview` 需按 `editMode('overview')` 条件输出输入框(非编辑态渲染纯文本,同 `renderBills` 的 `em` 分支,app.js:186-206);`data-orig` 含引号的文本沿用 `esc()` 转义(同 receipts 行 app.js:240)。

---

## 3. 图表页规格(需求③,key=`charts`,新文件 `ledger/js/charts.js`)

### 3.1 指标清单(采纳指标盘点目录,"必须"先行,"加分"逐卡可加)

| 卡 | 指标 | 类型 | 数据端点 | 分组 |
|---|---|---|---|---|
| C1 | 收入/支出/利润 时间序列(+环比%) | **分组柱状**(收入、支出)+ **折线**(利润) | `/api/reports/by-period` pl 轴 | 必须 |
| C2 | 作业量:单数/亩数/客户数 | **柱状**(亩数)+ **折线**(单数),客户数徽标行 | `/api/reports/by-period` work 轴 | 必须 |
| C3 | 应收/实收/回收率 | **分组柱状**(应收、实收)+ **折线**(回收率%) | `/api/reports/adjustments` | 必须 |
| C4 | 抹零(少收)与超收 专项 | **分组柱状**(两系列) | `/api/reports/adjustments` | 必须 |
| C5 | 支出构成(账簿 5001-5007) | **横向条形** | `/api/reports/summary`(已有,`reports.js:29-36`)或 `/cost-breakdown?source=journal` | 必须 |
| C6 | 客户 TOP10 收入 + 欠款/预收 | **横向条形** + 表格 | `/api/reports/by-customer?include_all=1` | 必须 |
| C7 | 亩均收入 / 客单价 | 折线 | by-period pl÷work(前端按期键拼) | 加分 |
| C8 | 作业成本构成(油/电池折旧/人工/药剂/设备/杂费) | 分组柱状,**标注"导入单成本=0,仅计算器单有值"** | `/api/reports/cost-breakdown?source=job` | 加分 |
| C9 | 环比增长总表(收入/支出/利润/单数/亩数 环比%) | 表格卡 | by-period 的 pct 字段 | 加分 |
| C10 | 业务来源/收款人/作业人员 排行 | 表格卡 | overview 数据前端聚合(零新端点) | 加分 |

**口径陷阱在页面上的处理**(采纳指标盘点):导入单 profit=income → C8 标注+按 source 分色;红冲不回溯 → 冲销月可能出现负尖峰,C1 脚注说明;应收/预收余额是时点值(`reports.js:37-45` 无日期参数)→ 只做数值卡/表格,**不画时间序列**;回收率(collection_rate)**仅账单(billed)口径**=collected/billed——"cash 口径"(区间收款现金流/账簿收入,按 `receipts.occurred_at` 另一条分桶轴)不在 M2 端点内,记为遗留加分项;另有超收时回收率可 >100%(现库 4 笔),图表脚注说明。

### 3.2 月/周/季/年切换交互

- 每张时间序列卡(C1-C4、C7)头部自带按钮组 `月|周|季|年`:`<button class="lg-btn" data-act="gran-set" data-chart="pl" data-gran="quarter">季</button>`,当前粒度高亮(`.primary`)。
- 状态:`state.gran[chartKey]`(默认 `'month'`)+ `state._periodCache[gran]` 按粒度缓存请求——C1/C2 共用一次 by-period 请求,C3/C4 共用一次 adjustments 请求,切粒度只在缓存缺失时 fetch。
- 动作 `gran-set` 写进 `app.js` 的 `handleAct` switch(`app.js:677` 起),**不碰** `app.js:676` 前缀正则(imp-/md-/op-/nc-/plot- 已被 app-extra 占用;`data-tab="master"` 冲突同样避开)。
- 加分交互:柱/点绑定 `data-act="ov-jump-month" data-month="2026-04"` → 点击设 `state.month.overview` 并 `switchNav('overview')` 跳总表当月,形成"图→表"闭环。

### 3.3 SVG 组件设计(纯函数,零依赖)

**纯函数放 `ledger/js/core.js`**(node:test 可测,不碰 DOM):
- `scaleLinear(d0,d1,r0,r1)` → 线性映射函数(域为 0 起步);
- `niceTicks(maxVal,n=4)` → 1/2/5×10^k 步进,返回 `{max, ticks[]}`(空数据返回零网格);
- `linePath(pts)` → `M x,y L x,y …` 字符串(缺值为 null 时断线);
- `barRects(pts, band, gap)` → `[{x,y,w,h}]`;
- `groupedBarRects(series[], pts, band)` → 每系列错位矩形;
- `hBarRects(items, maxVal)` → 横向条形。

**渲染层 `ledger/js/charts.js`**(纯字符串拼 SVG,无 Canvas、无库):
- `chartCard({id,title,granBtns,legend,svg,footnote})` 卡片骨架;`.lg-chart-grid` 响应式两列;
- `<svg class="lg-chart" viewBox="0 0 640 240" role="img">`:坐标轴/网格线用 `var(--border)`、文字 `var(--muted)`、系列色 `var(--c1..--c4)`(CSS 变量 `:root` 与暗色 `@media` **两处都补**,否则暗色失色,`ledger/css/ledger.css:4-21`);
- 悬浮提示用原生 `<title>`(如 `<title>2026-04
收入 1,234.00 元</title>`),零 JS 依赖;
- 图例为 HTML chips(`.lg-chart-legend`),色块引用同一组变量。

### 3.4 数据端点设计(新 3 个,`server/services/reports.js` + 路由 `server/routes/ledger.js`)

1. **`GET /api/reports/by-period?granularity=month|week|quarter|year&from=&to=`**
   一次返回双轴,避免账簿(确认时点)/作业(job_date)混轴:
   - `pl[]`(按 `e.occurred_at` 分桶,`reports.js:59-71` 同构):`{period, period_start, period_end, income_cents, expense_cents, profit_cents, income_pct, expense_pct, profit_pct}`;
   - `work[]`(按 `j.job_date` 分桶,过滤同 `reports.js:104`):`{period, jobs_count, area_mu, customer_count, jobs_pct, area_pct}`;customer_count 取 `COUNT(DISTINCT party_id)`,数据源为 settlement_items 挂 party(创建时 `settlements.js:52-65`,确认分录行同样挂 `party_id`,`settlements.js:148-155`);
   - bucket SQL(已实测):月 `strftime('%Y-%m',x)`;季 `printf('%d-Q%d',CAST(strftime('%Y',x) AS INT),(CAST(strftime('%m',x) AS INT)+2)/3)`;年 `strftime('%Y',x)`;周 `printf('%d-W%02d',CAST(strftime('%Y',x) AS INT),CAST(strftime('%W',x) AS INT))`(周一始,含 W00;响应附 period_start/end=MIN/MAX 日期);`granularity` 白名单校验(ApiError VALIDATION);环比在服务端 JS 按相邻桶计算(首桶 null)。
2. **`GET /api/reports/adjustments?from=&to=&granularity=`**(独立端点,不并入 summary)
   按 `bills.issued_at` 分桶、非 void:`{period, billed_cents, collected_cents, discount_cents, overpaid_cents, due_cents, collection_rate}` + `totals`;抹零=Σ`ABS(adjust_cents)`(双语义统一,§4.1);超收=Σ`MAX(0, paid − (amount − |adjust|))`(现有 4 笔;手工收款路径仍禁止超收 `finance.js:42-46`,本端点只统计不放开);collection_rate=collected/billed,**仅 billed 单一口径**(分母 0 记 null;存在超收时可 >100%,响应附说明字段,不做 cash 第二分桶轴——记遗留加分项)。
3. **`GET /api/reports/cost-breakdown?source=job|journal&from=&to=`**
   - `source=job`:SUM jobs 快照六列——`fuel_expense_cents`、`battery_depreciation_cents`(001_init.sql:145-146)+ `labor_cost_cents`、`pesticide_cost_cents`、`equipment_cost_cents`、`misc_cost_cents`(007:13-16;**没有 fuel_cost_cents 这一列,速记会直接 SQL 报错**),响应含 `import_zero_note` 与 calculator-only 子合计(导入单全 0 会让图虚低);
   - `source=journal`:5001-5007 科目分组(同 `reports.js:29-36`);响应标注两口径不可相加(作业归属 vs 付款现金)。
4. **`GET /api/reports/by-customer` 增参 `include_all=1`**(默认关闭,零回归):parties LEFT JOIN 收入聚合,补齐"期内无收入但有欠款/预收"的客户(`reports.js:83` 现仅 WHERE party_id IS NOT NULL 的收入行)。

---

## 4. 结构审查结论的处理

### 4.1 本轮修(M1,端点/脚本/口径可解)

| 问题 | 处理 |
|---|---|
| listJobs 不回姓名/地址/单价/实收/作业人员/来源 | 不改 listJobs,由 `/api/overview` 一次性返回(避免双端点漂移) |
| 主行单价 104/104 NULL(落库先于 007) | `backfill-008.js` 从 raw_json 回填(现行代码 `importExcel.js:494-499` 已会写,只补历史) |
| plant_type_name 双语义(清园 27 行 vs 计算器作物) | 008 加 `jobs.purpose` + 回填 + 导入写新列;展示层取值统一 `COALESCE(purpose, plant_type_name)`:总表端点用 SQL `COALESCE(j.purpose, j.plant_type_name)`,工单详情(现取 `j.plant_type_name`,`app.js:110`)改 `j.purpose 或 j.plant_type_name(COALESCE)`(getJob 为 `SELECT *`,008 后 purpose 随行返回,`jobs.js:258`),标签"机器:"同步改"作物/目的"——**只改标签不改取值,008 后新导入行会恒显示"—"** |
| 计算器带电话农户将新建重复档案(`parties.js:8-17` phone 精确相等才匹配,导入 71 户无电话) | `findPartyByNamePhone` 加"电话不中→按名单一命中回退"(只建不改原则不变);防止计算器同步上线即翻倍 |
| adjust 正负双语义(导入正=抹零 9 笔 vs 手工负=抹零,`amount+adjust` 口径使账单页这 9 行多显示 1 元幽灵应收) | **不做数据订正**;统一口径改为 `payable = amount − ABS(adjust)`,**必须改齐全部硬编码站点**(漏改任一处,未来导入"未收款+抹零"行即出现前端显示 990、后端按 1010 收款/核销/置已清的双语义 bug)。全部站点清单(本会话逐一 grep+实读核实):`ledger/js/core.js:39-41`(billPayable/billUnpaid,UI 显示);`server/services/finance.js:42-46`(收款超额校验)、`:71-73`(收款后置 paid 判据)、`:95-102`(按客户 FIFO 核销额,含 :102 行内 paid 判定)、`:160-162`(编辑收款回写)、`:440-442`(作废收款回退);`server/services/settlements.js:238`(listBills 的 payable_cents);`server/services/reports.js:37-39`(summary 应收)、`:87`(byCustomer 应收)、`:120-122`(partyBalance 应收)。统一实现:服务端收敛为一个 SQL 片段/JS 帮助函数 `payable = amount_cents - ABS(adjust_cents)`,前端沿用 core.js 帮助函数;导入路径已是 `payable = 应收 − 抹零`(`importExcel.js:550`),无需改。现库 unpaid/partial 且 adjust≠0 为 **0 笔**(实测),补齐全部站点不改任何现值;新增测试覆盖 adjust>0 的 unpaid 行收款/核销/显示三处一致;账单页/总表抹零输入的悬浮提示文案同步改为"抹零/优惠(正负均按优惠金额计)" |
| csv-export 只导首表 | `btn.closest('.lg-panel')` 作用域修正(`app.js:680`) |
| 总表前端拼装 5 端点/LIMIT 截断 | 单一 `/api/overview`(§2.1) |

### 4.2 记录为遗留(本轮明确不动)

1. **地块数量列**(2-12 月 c5/1 月 c6)导入即丢——语义待用户裁决;纳入需放宽 20 列上限(`importExcel.js:327,341` 与 `import.js:102` 三处双向绑定)且会动对账口径,不裁决不动。
2. **c21-c23 越界区往来款**(李凌琦预支/补回/大疆4e 等 8 格)未导入——同上,同上限,待裁决。
3. `job_settlement_lines/settlement_items ADD party_id` 迁移——**暂缓**:总表按户聚合走 `bills.party_id` 已够,108 行 farmer_ref 现全为 partyId 字符串,等计算器单进来再统一。
4. 支出不挂作业(56/56 无 job_id;journal 536/744 无 job_id)→ 作业实付成本聚合覆盖率≈0——引导用户后续用既有 `PATCH /api/payments/:id` 补挂,视图 `v_job_cost` 待数据补录后再建。
5. 导入单 total_cost=0、profit=income——M2 图表仅标注,不回填成本(无凭据)。
6. 手工收款禁超收(`finance.js:42-46`)与导入 4 笔超收并存——保持严格校验,图表只统计。
7. 红冲不回溯历史期间(`journal.js:54-74`)——冲销月尖峰以脚注说明,不做按原始日期归期选项。
8. 应收/预收余额为时点值——不画时序,只做数值卡。
9. operator_names 62 空、收款人 40/96、method 恒 'other'——导入历史无法补,展示 '—';1 月"业务来源=沈鹏"等脏填已在导入复核清单,不改代码。
10. 回收率 cash 口径(区间收款现金流/账簿收入,按 receipts.occurred_at 另轴)与总表"未挂作业账单"第三表——均为遗留加分项,待期初补录等真实需求出现再做。
11. P3 遗留延续:公网登录口令、CNB 流水线、chemicals 只读、移动端不做。

---

## 5. 里程碑与验收清单

### P4-M1:导航重排 + 总表端点 + 总表页(+服务端测试)

改动:§1 导航两处;§2 全部(overview 端点、总表页、008 迁移、backfill-008、upsert 回退、payable 口径 10 站点、csv-export 作用域、详情标签与取值、ftQ 唯一 id、Api.put 修复)。

**验收清单**:
1. `cd server && node --test ../tests/server/` 全绿(49 + 新增,预期 ≥57);`node --test tests` 全绿(71 + billPayable 新例)。
2. 导航 13 键:总表第一且默认 active;原 11 页签逐一回归可用(含**主数据页"保存记账人"可保存成功**——修 `Api.put` 缺失后回归,app-extra.js:231);工单→结算跨页跳转(`app.js:727-729`)仍正常。
3. 总表(真库):104 行;tfoot 合计 = 应收 101,170.10 / 实收 **87,706.00** / 未收 13,453.30 / 抹零 30.80(均为 overview SQL 口径,Σpaid=8,770,600 分;**勿用 P3 手账的 84,216——那是源 Excel 对账基线**),且与 `totals` 一致;搜索"叶正燕"行数与账单页一致;月 2026-01 = 27 行;客户点击过滤生效;单价列 104 行非空;**两条搜索框(总表/支出流水)各自独立输入、焦点不互跳、无重复 id**;面板 2 切月不影响支出页筛选(`ovpay` 键隔离)。
4. 行内编辑(FAB):未收账单行改金额/抹零保存成功且 `edit_log` 留痕;已收行 🔒;支出行改类别/金额后流水页出现红冲+新分录;**页面无任何物理量输入框**;编辑后恢复测试数据。
5. payable 口径统一回归:账单页 9 笔导入已清账单(B20261001-002/003/004/005/007 等,adjust>0)"应收"列显示 = 实收(如 640.00),不再多 1 元;总表未收合计 = 账单页未收合计 = summary.receivable = 13,453.30;对 1 笔造数 adjust>0 且 unpaid 的账单,登记收款至 payable 即转已清(前后端口径一致,测试断言)。
6. CSV:主表/支出表两按钮各导各表(文件名分别 `overview`/`ovpay`),Excel 直开(BOM)。
7. 迁移:`schema_migrations` 含 008;`jobs` 有 purpose 列;backfill-008 输出报告显示金额基线分文不变 + 自动备份存在。
8. `GET /api/overview` 无 from/to 返回全量 ≤2000 行;加 `from=2026-04-01&to=2026-04-30` 返回 28 行;工单详情行"作物/目的"对 1 月导入行显示"清园"、对无目的行显示"—"。

### P4-M2:报表时间分组端点 + 图表页(+测试)

改动:§3 全部(by-period / adjustments / cost-breakdown / by-customer include_all 四端点、charts.js、core.js SVG 纯函数、CSS 图表变量)。

**验收清单**:
1. 两条测试命令全绿(server 49+M1 新增+M2 新增)。
2. reports 测试覆盖:by-period 四粒度 bucket 键(2026-01 / 2026-Q1 / 2026-W00 / 2026)、adjustments 正负 adjust 双语义与超收(造 1 笔 paid>payable——`createReceipt` 的超额校验保持不变,测试经 freshDb 的 db 句柄直接 UPDATE bills 造数)、cost-breakdown 两口径不可相加断言、by-customer include_all 补零收入客户。
3. 图表页:每卡 月/周/季/年 即点即换(月=2026-01..05 五柱;季=Q1/Q2;年=单柱;周=**W00..W20** 有空隙属预期——实测 2026-01-01 落 2026-W00 且有 2 行数据,以 period_start/end 说明);C1 各期 income 之和 = `/api/reports/summary.income_cents`(程序内断言或页面校验);C8 显示"导入单成本=0"标注;C3 回收率存在超收月份可 >100%,脚注说明。
4. 暗色模式(`prefers-color-scheme: dark`)图表配色正常;DevTools Network 仅本机请求、零外部资源(硬约束)。
5. 旧报表页四张表不回归;点柱跳总表当月(加分项)可用。

---

## 6. 文件级改动清单与新增测试

### M1

| 文件 | 改动 |
|---|---|
| `ledger/index.html` | 导航重排(§1 顺序表,总表按钮第一+active) |
| `ledger/js/app.js` | `state.tab` 初值 `'overview'`(489);doRender 增 `tab==='overview'` 分支(557-585 链尾,async,并加载 `state._advances`,同 571-575 款式);新增 `renderOverview()`(主表+支出表,复用 toolbar/monthStrip/pipeFilters/custCell/tfoot,编辑态按 `editMode('overview')` 渲染输入);`saveEditMode` 增 overview 分支(data-ekb→Api.patchBill,data-ekp→Api.editPayment,879-894);`editableTabs` 增 `'overview'`(905);csv-export 改 panel 作用域(680)+ `data-csvname` 文件名覆盖(692);**搜索框 id 唯一化**:toolbarHtml 生成 `id="ftQ-${tab}"`(526)、输入监听改 `/^ftQ/` 前缀(624)、焦点恢复改 `document.getElementById(el.id)`(631);`bill-receive` 插入行 colspan 改按所在表列数生成(769 现硬编码 8);jobDetail"机器:"→"作物/目的"且取值改 `j.purpose 或 j.plant_type_name(COALESCE)`(110) |
| `ledger/js/core.js` | `billPayable/billUnpaid` 改 `amount − ABS(adjust)` 口径(39-41);新增 `overviewRow(row)` 纯格式化函数(日期/客户/地址/金额列派生,供测试) |
| `ledger/js/api.js` | 补 `put: (p, b) => request('PUT', p, b)`(修现存 bug:`saveSettings` 调 `Api.put` 未定义,api.js:71;服务端 `PUT /api/settings` 已存在 masterdata.js:89) |
| `server/services/overview.js` | **新**:`listOverview(db,{from,to,status,limit})`,§2.1 SQL + totals + operator_names 解析 |
| `server/routes/ledger.js` | 增 `GET /overview` |
| `server/services/finance.js` | payable 口径统一 5 处:`:42-46`(收款超额校验)、`:71-73`(置 paid 判据)、`:95-102`(FIFO 核销额含 :102 paid 判定)、`:160-162`(编辑收款回写)、`:440-442`(作废回退)——统一 `amount_cents - ABS(adjust_cents)` |
| `server/services/settlements.js` | payable 口径统一 1 处:`:238`(listBills payable_cents) |
| `server/services/reports.js` | 应收口径统一 3 处:`:37-39`(summary)、`:87`(byCustomer)、`:120-122`(partyBalance) |
| `server/db/migrations/008_job_purpose.sql` | **新**:仅 `ALTER TABLE jobs ADD COLUMN purpose TEXT` |
| `server/db/backfill-008.js` | **新**:单价回填(104 主行)+ purpose 回填,备份/幂等/基线断言(仿 backfill-007.js) |
| `server/services/importExcel.js` | applyJobRow INSERT 增 purpose 列(476-489),plant_type_name 不再写目的;20 列上限不动 |
| `server/services/parties.js` | `findPartyByNamePhone` 电话不中→按名单一命中回退(8-17) |
| `tests/server/overview.test.js` | **新**:行数/合计三平/due 口径/status 过滤/单账单行 bill_count=1/PATCH 联动(bills+payments 经总表字段名);**payable 口径一致性**:造 1 笔 adjust>0 且 unpaid 的账单,断言 overview due、listBills payable、登记收款至 payable 转已清三处一致 |
| `tests/server/p4-backfill.test.js` | **新**:fixture 库跑 backfill-008 → 单价 104 行非空、purpose 27 行、金额 sums 分文不变、幂等重跑 |
| `tests/server/edit-finance.test.js` | 增 1-2 例:adjust>0 未清账单的收款超额校验/FIFO 核销/作废回退在 `amount−ABS(adjust)` 口径下行为一致 |
| `tests/server/masterdata.test.js` | 增 2 例:同名带电话回退匹配(命中不新建/多名同名不回退) |
| `tests/ledger-core.test.js` | 增:billPayable 正 adjust(导入抹零)情形、overviewRow 格式化 |
| `tests/ledger-api.test.js` | **新**:node 下 require api.js 断言 `Api.put/saveSettings` 为函数(回归 Api.put 缺失 bug) |

### M2

| 文件 | 改动 |
|---|---|
| `server/services/reports.js` | 新 `byPeriod`(双轴+四粒度+环比)、`adjustments`(抹零/超收/回收率)、`costBreakdown`(job/journal);byCustomer 增 `include_all`;应收 SQL 统一 `amount−ABS(adjust)`(37-39) |
| `server/routes/ledger.js` | 增 `GET /reports/by-period`、`/reports/adjustments`、`/reports/cost-breakdown`;by-customer 透传 include_all |
| `ledger/js/charts.js` | **新**:`renderTab($main)`、卡片/图例/坐标轴 SVG 组装、`state.gran`+按粒度缓存、gran-set 与 ov-jump-month 处理 |
| `ledger/index.html` | 增图表按钮(data-tab="charts",第 8 位)+ `<script src="js/charts.js">`(在 app.js 之前) |
| `ledger/js/app.js` | doRender 增 `tab==='charts'` 分支(调 `window.LedgerCharts.renderTab`);handleAct switch 增 `gran-set`、`ov-jump-month`(不碰 676 正则) |
| `ledger/js/core.js` | 增 SVG 纯函数:`scaleLinear / niceTicks / linePath / barRects / groupedBarRects / hBarRects` |
| `ledger/css/ledger.css` | `:root`+暗色两处增 `--c1..--c4`;新 `.lg-chart-grid/.lg-chart/.lg-chart-axis/.lg-chart-legend/.lg-gran`;`.lg-table--wide`;密集数字列 `.lg-table input[type=number]{width:84px}` |
| `tests/server/reports.test.js` | 增 4-6 例:四粒度 bucket、adjustments 正负 adjust 双语义+超收、cost-breakdown、by-customer include_all |
| `tests/ledger-core.test.js` | 增:niceTicks 步进、linePath 断线、barRects/groupedBarRects 几何 |

**新增测试合计预估**:服务端 +11~14(→60~63),前端 core +6~8(→77~79)+ ledger-api 1 例;全程保持既有 120 项零改动通过(仅增补,不改旧断言)。
