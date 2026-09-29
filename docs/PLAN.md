# spraybook 实施计划 v5（P0：M0–M5）

> 批准于 2026-09-29。本文件是执行依据；需求以 docs/requirements.md 为最高优先。
> 建表字段依据：docs/export-json-sample.json（真实 exportJSON+计算结果样本，脚本 scripts/dump-export-sample.cjs 生成）。

## 0. 总原则
一套 SQLite 五层、金额 INTEGER 存分（字段名 `_cents`，元→分 `Math.round(×100)`）、日期 TEXT ISO8601、外键显式 + 连接时 `PRAGMA foreign_keys=ON` + WAL + busy_timeout、migration 顺序编号只增不改、.db/node_modules 不进 git。单仓：根目录=计算器原样（不改核心计算逻辑），`server/`=Express+better-sqlite3（package.json 在此，根目录零配置），`ledger/`=记账后台（原生 JS 无构建），`data/app.db`=运行库（gitignored）。分支：`main`（集成）/`calculator-only`（计算器功能剥离线，老项目推送目标）/`feature/*`。

## 1. 关键规则（M1 写 SQL 前生效）
- **jobs 状态机**：`draft → completed → settled`；`settled → reopened（撤回确认）或 void（作废终态）`；`reopened → settled`；`completed → void`。reopened=可改金额/备注字段、改完重新结算；void=红冲已生成分录（等额反向、原分录不动）+bills/settlements 作废+jobs 标 void 保留记录；全程 edit_logs。
- **job_no**：`YYYYMMDD-XXXX`（4 位随机）计算器本地生成；服务端冲突重生成并在响应回传最终号，sync.js 回写队列+工单面板显示。
- **幂等重推**：同 client_job_id 重复请求返回原 job_no、不覆盖不重建；重算=新 UUID 新记录。
- **多农户舍入**：总额拆多分项用最大余数法（分摊到分、余数给大额项），Σ分项=总额，单测覆盖。
- **客户 upsert**：只建不改；匹配 name+phone（phone 空退化按 name）；parties 预留 address 列；source='calculator'/'ledger'/'import'。计算器本地 farmer/plot id 不入库，跨端业务键=姓名+电话。
- **edit_logs（审计表）**：table_name/record_id/action(create|update|void|reopen)/before_json/after_json/operator/created_at；operator P0 固定 'local'+TODO（M7 补设置页）。
- **测试隔离**：node:test、`:memory:`、beforeEach 跑 001+seed、统一 `tests/server/helpers/db.js`；HTTP 测试用 `app.listen(0)`+原生 fetch（不引 supertest）。
- **数据权威**：jobs 结构化快照字段为权威（结算只取结构化字段）；raw_json 仅追溯/扩展，不参与结算。
- **编辑权界**：ledger 只能更正金额类字段（打药费/药钱/adjust_cents/备注）；物理量（亩数/药量/水量/趟数）ledger 不可改——改错路径=计算器更正→重算→重传（新 UUID）→旧单 void。

## 2. 数据库五层 23 表（001_init.sql）
- **主数据**：parties、plots、chemicals（=用药类型库）、equipment（电池 cycles_count）、price_rules（最小版）。
- **作业执行**（计算器只写）：jobs（job_no、client_job_id UNIQUE、job_type spray/haul、status、快照字段：total_area_mu/drone_tank_l/spare_water_l/draw_reserve_l/plant 参数快照/actual_sets/charge_count/fuel_expense_cents/battery_depreciation_cents/total_water_l/total_trips/mix_batches/total_cost_cents/income_cents/profit_cents/note/operator_names TEXT/raw_json/weight_jin/haul_price_cents_per_jin/pickup_included）；job_plots（名称/亩数/农户/组号/水量/用量/已完成升数快照；吊运无数据）；flight_groups；job_settlement_lines（每农户快照；吊运为空）；job_battery_cycles。
- **结算财务**（记账只写）：settlements、settlement_items（未确认可改→bills 联动重算）、bills（unpaid/partial/paid/void+adjust_cents）、receipts（P0 挂单张 bill、支持部分收款；跨账单自动核销放 M6）、payments（油费/药费/维修/吃饭/设备/人工/其他，可关联 job）、advances（预收/预支双向+balance_cents）、advance_usages（抵扣/冲销流水）、manual_splits（手工分成登记，非分账引擎）。
- **复式记账**（记账只写）：accounts（seed ~15 科目）、journal_entries（event_type+ref_type/ref_id）、journal_lines（服务层断言借贷平衡）。
- **审计/导入**：edit_logs；import_batches、raw_import_rows（sheet_name/row_no/raw_text/parsed_json/status）。
- 索引：jobs(job_date/status)、job 子表外键、journal_lines(entry_id/account_id)、advances(party_id)、client_job_id UNIQUE。

## 3. API 契约
见 docs/api.md。统一返回体 `{ok,data,error}`；CORS `Access-Control-Allow-Origin:*`（file:// 双击打开的计算器才能同步）；静态服务白名单=计算器根文件+`/ledger`，排除 server/、data/、tests/、docs/、scripts/。

## 4. 离线同步状态机
见 docs/sync-design.md。

## 5. 里程碑
- **M0 ✅ 复制建仓**：spraybook 建仓（main+calculator-only 推送 GitHub）、老项目归档（README 说明+脚本改指 calculator-only+dry-run 验证）、spraybook 脚本改指 main+移除旧部署 workflows、回归 44 全绿、文档+样本入库。
- **M1 库层**：server/package.json（express、better-sqlite3）、001_init.sql（逐项对样本）、seed、`npm run db:reset`、迁移测试、部署路径回归（build-web 产物干净、APK www 显式清单；**行动项：CloudBase CNB 流水线改部署 dist/，切换前不整仓重推**）。
- **M2 API**：POST/GET/PATCH /api/jobs、GET /api/health、CORS、静态白名单、docs/api.md 全契约；测试覆盖写入/幂等/元→分/最大余数法/状态机拒绝/白名单拒绝。
- **M3 计算器适配**（不改核心计算逻辑=药量/水量/趟数/电池/分家算法；允许 js/sync.js、SW 缓存策略、UI 同步入口）：按状态机实现同步；payload=Storage.exportJSON+UI._lastResult（纯函数 vm 测试）；复制工单 handler 后入队+"同步"按钮+在线自动 flush；sw.js 对 /api、/ledger 放行+CACHE_VERSION 递增；重跑 build-standalone；新 UI 遵守 v4.5 窄屏约束（360px 无横向溢出）。
- **M4 记账消费（Excel 式编辑）**：ledger 骨架，数据层/渲染层分离（纯函数 node:test）。工单列表查看/编辑/作废；结算页可编辑表格；账单页确认后只读；撤回确认+二次确认；settlements 生成（打药从 job_settlement_lines，吊运直接由 job 金额生成）/confirm（生成 bills+自动分录+jobs.status=settled）/reopen（红冲+jobs.status=reopened+bills 作废）/void；全程 edit_logs。
- **M5 收支预支**：收款（部分收款/预收抵扣）、支出、预收预支+advance_usages、manual_splits；每笔编辑+作废（不删记录、生成反向分录）；每笔自动分录、余额校验。
- **P0 验收交付三件**：①可运行闭环（工单→结算→账单→收款，含编辑/撤回/作废/红冲）；②docs/OPS.md 部署运维一页纸；③P0 验收文档注明 **"P0 ≠ 可上线，上线需 M5.5+M6–M9"**。

## 6. 编辑边界表（前端所有编辑走 API+edit_logs 留痕）

| 数据 | 何时可改 | 改完动作 | 留痕 |
|---|---|---|---|
| jobs 金额/备注字段 | 未 settled 或 reopened | 重算合计 | 是 |
| jobs 物理量 | 不可（计算器更正重传，旧单 void） | — | — |
| settlement_items | 未确认 | bills 联动重算 | 是 |
| bills 金额 | 未收款 | 无 | 是 |
| bills 已收款后 | 只能撤回确认 | 红冲+重生成 | 是 |
| receipts/payments/advances | 任何时候 | 编辑或作废；作废=反向分录 | 是 |

前端编辑原则：直接改走 API 不跳后端；类 Excel 网格（工单列表/结算明细/账单明细）；改完自动重算——未确认=分项→总额；已确认/撤回后=分项→总额→红冲原分录→重生成；已确认/已收款只读。

## 7. 全程约束
计算器只写作业执行层；记账不改作业执行数据（更正走编辑权界）；跨层只经 API；金额一律 _cents；所有编辑写 edit_logs；migration 只增不改；每里程碑一个 feature 分支合入 main、提交前跑 calc.test.js+server 测试。

## 8. 后续批次（P0 验收后）
- **M5.5 上线衔接**：只导"未清账"为期初（未收欠款→期初应收；未用预收/未冲销预支→advances）；期初凭证借贷平衡、标 opening=true；定切换日 T（T 前旧 Excel 归档备查、T 后新系统）+逐户对账。
- **M6**：盈利报表（按作业/客户/月）+欠款/预收余额+跨账单自动核销。
- **M7**：主数据后台 CRUD + GET /api/bootstrap 计算器读反哺（财务服务器权威、主数据现场优先）+ operator 设置页。
- **M8**：历史 Excel 导入——规则解析（正则+列映射模板）为主、LLM 兜底可插拔（默认本地 Ollama 可配云端 key）；staging→人工复核→正式表；保留 sheet/行号/原文；重复检测。**解析要点见 §8（真实样本画像）。**

## 8. 历史 Excel 导入解析要点（源自 植保收支明细.xlsx 全量画像 2026-09-29）

**样本结构**：12 个月度 sheet（1月份…12月份），r1 标题、r2 表头、r3+ 数据；约 106 作业行 + 37 支出行（其中 **35 笔支出写在作业行右侧区域 = 同行双记录**），960 全空模板行需跳过。

**已定规则**：
1. **客户地址拆村/队**（用户明确要求）：`彰冠红拉12队 → village=彰冠红拉, team=12`；`通安金桂村 → village=通安金桂村, team=null`。规则=尾部 `(\d+)队`（含全角/空格变体如"红拉12 队"）截出 team，余量归 village；`已结算`（合计行标记）、人名（胡昌奎）、残缺（红拉/大发）→ 进复核不落库。
2. **parties 匹配键**（导入无电话）：name + village + team；003 已扩展唯一索引。
3. **支出识别**：扫 9–17 列找"类型词 + 右侧 1–3 列内数值"；类型词脏（加油/吃饭/工作灯\*2/电磁阀/地勤费/买烟/图传流量）→ 映射枚举 category（fuel/meal/equipment/repair/other），**原文进 note**；"应转李凌琦"等非金额 → 复核。
4. **日期**：`2026.1.14` / `5.5`（无年→按 sheet 名月份补 2026）/ Excel 日期对象；**2016/2056 等脏年份 → 复核**；"已结算"行整行是合计，跳过。
5. **应收/实收**：以原表数字为准不重算（应收≠亩×价 6 笔）；实收<应收 16 笔 → 抹零进 bills.adjust_cents、未收部分为欠款；"16家算11家"类备注 → 复核。
6. **业务来源 → jobs.referral_name**（003）；**收款人 → receipts.collector_name**（003）；作业人员合并名"李凌琦唐爽沈鹏" → 切分为 operator_names。
7. **作业目的**（仅 1 月 sheet 有，清园×27）→ jobs.plant_type_name 快照。
8. **对账基线**（独立重算，导入结果必须对平或出差异清单人工确认）：作业约 104–106 笔（边界行 2 笔待口径确认）、应收 97,680.10、实收 81,896.00、差额 15,784.10（未收/抹零）、支出 37 笔 11,452.00。
9. staging 行必带 sheet_name/row_no/raw_text（raw_import_rows 已支持）。
- **M9**：收尾（bat 菜单加"启动一体化服务"、README/docs、公网部署重规划、APK 回归）。
