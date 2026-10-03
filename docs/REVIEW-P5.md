# spraybook 代码审查报告（P5 独立审查）

- 审查人：独立代码审查员（全新上下文，只读审查）
- 日期：2026-10-03
- 范围：`server/`（routes/services/db/migrations/backfill）、`js/`（计算器 + sync.js）、`ledger/js/`、`tests/`
- 用户问题：①是否屎山 ②数据流是否符合"现场计算→同步/导入→jobs→结算→账单→收款→分录"实际作业流程 ③脚本落库可行性/便携性 ④本地小 LLM 批量导入方向

## 0. 审查方法与实际运行记录

| 动作 | 命令 | 结果 |
|---|---|---|
| 服务端测试 | `cd server && node --test ../tests/server/` | **70/70 通过**（8.0s） |
| 前端测试 | `node --test tests/calc.test.js tests/sync.test.js tests/ledger-core.test.js` | **31/31 通过**（0.2s） |
| 导入 apply 原子性实测 | `node "D:/agent work/zcode/tmp-review/apply-atomicity-check.js"`（:memory: 库 + buildApp 真实路由 + fixture 植保收支明细.xlsx，毒化最后一行 name=null） | apply 失败前 **103 jobs / 103 bills / 254 journal_entries 已提交**，批次停留 `reviewing`；修复毒行重试 → `UNIQUE constraint failed: jobs.client_job_id`，**批次永久卡死** |
| 支出编辑分录实测 | `node tmp-review/payment-method-check.js` + `tmp-review/reversal-check.js`（:memory: 库直调 finance 服务） | 见 §2.3（微信 500 元支出编辑两次 → 现金 1001 净额 **−1000 元**、微信 1002 **+500 元**） |
| 结算撤回重开实测 | `node tmp-review/settlement-reopen-check2.js` | 确认300→撤回→改500→确认→撤回，账面残留 **6001 收入 200 元、1122 应收 −200 元**（应为 0） |
| 编辑后作废实测 | `node tmp-review/reversal-check2.js` | 收款编辑后作废 → **1122 应收净额残留 300 元**（账单已回 unpaid，账簿却仍挂应收） |
| CLI 入口排查 | `grep -rn "importExcel\|import/parse" scripts/` | **零命中**（无脱离 Express 的导入入口） |
| 硬编码路径排查 | `grep -rn "SPRAYBOOK_DATA_DIR" server --include="*.js"` | 仅 `server/index.js:21` 一处使用 |
| 未执行项 | `npm run db:reset`、`db/backfill-007.js`/`backfill-009.js` 对真库执行 | **未跑**（reset 会删真实 data/app.db；两 backfill 的幂等性由测试套件内 3 个用例覆盖，均通过） |

> 意外操作披露：审查中为验证构建脚本路径疑点执行了 `node scripts/build-standalone.js --check`，该脚本不支持 `--check`、直接重新生成了 `drone-spray-calculator-standalone.html`。已当即 `git checkout --` 恢复，`git status --porcelain` 确认工作区干净、零净变更。

---

## 一、屎山判定：**不是屎山，属于"局部欠账"**

### 1.1 总评

**总体健康，接近"小而清晰的工程"，不是屎山。** 依据：

- 服务端分层干净：routes（薄）/ services（业务）/ db（迁移+订正脚本）边界清楚，最大服务文件 602 行（`services/importExcel.js`），无超长函数（最长 `scanZone` 约 80 行、`applyJobRow` 约 105 行，均有分段注释）。
- 事务纪律好：所有多表写入都包 `db.transaction`（`services/jobs.js:212`、`services/finance.js:61,148,197`、`services/settlements.js:134,180`、`routes/masterdata.js:35` 等）；复式记账有借贷平衡硬断言（`services/journal.js:28-30` → UNBALANCED 500）。
- 留痕一致性好：edit_logs 覆盖 jobs/settlements/bills/receipts/payments/advances/manual_splits/journal_entries/masterdata/settings/raw_import_rows/import_batches 的全部 create/update/void/reopen（`services/audit.js:28-38` 单一出口，各服务统一调用）；软删除+红冲不物理删（`finance.js:403-455`、`journal.js:54-75`）。
- 金额一律整数分（`services/numbers.js:9-16` 唯一实现）、SQL 全参数绑定（`services/reports.js:140` 白名单桶表达式是唯一的受控拼串）、测试 101 个全绿且用真实 Excel fixture 全链路验证（`tests/server/import.test.js:39-44`）。
- 注释密度高且多为"为什么"而非"是什么"（如 `backfill-009.js:1-14` 把历史 bug R1-B1 写进头注释）。

### 1.2 欠账清单（按还款优先级）

**债 1（最高优先）：红冲引擎的"取第一条 active 分录"系统性缺陷。**
`reverseEntry` 刻意让原分录保持 `status='active'`（`services/journal.js:54`"原分录保持 active 不动"），但所有"找到要红冲的分录"的查询都用 `WHERE ref_type=? AND ref_id=? AND status='active' AND event_type=...` 后 `.get()` 取**第一条**（`services/finance.js:149-151`、`finance.js:198-200`、`finance.js:412-414`、`services/settlements.js:181-183`、`settlements.js:200-202`），没有 `ORDER BY id DESC`、也不排除已被红冲过的分录。单据一旦被**编辑过**（编辑=红冲旧+过新，会留下第二条 active 分录），后续的第二次编辑/作废就会红冲错对象。实测三组故障见 §2.3。这是账簿层的系统性 bug，不是屎山，但它是全库最该先还的债。
**fixNow**：是。

**债 2：前端巨石文件。**
`js/ui.js` 2889 行单个 `UI` 对象字面量、114 个方法（虽有小节横幅注释，仍是一整块）；`ledger/js/app.js` 1286 行（renderX 返回 HTML 字符串 + 事件委托 switch 一体）；`ledger/js/charts.js` 656 行。纯函数层（`core.js` 192 行、`calculator.js` 计算核心、`numbers.js`）拆得很好，欠的是渲染/交互层。不紧急——当前无并行多人开发，强拆反而制造回归风险。
**fixNow**：否。P6 动 UI 时顺手按"渲染函数/事件处理/状态"切分即可。

**债 3：双实现人工绑定（注释承认的漂移风险）。**
`routes/import.js:41-56` 的对账探针与 `services/importExcel.js:185-186` 的 `scanZone` 靠注释互相绑定（"⚠ 与 routes/import.js 的对账探针规则必须同步修改"）；表头定位逻辑在 `routes/import.js:57-82` 与 `importExcel.js:288-309` 各写一遍。支出/收入对部分已复用 `scanZone` 防漂移（`routes/import.js:102`），但应收/实收合计仍是镜像实现。历史上已因漂移出过 900 元假差异（注释自述）。
**fixNow**：是（小改：把"表头定位+sheetYear 探测"抽成 `importExcel.js` 导出函数，两处共用）。

**债 4：死代码与坏字节。**
- `services/numbers.js:22-46` `largestRemainder` 全库零调用（grep 仅命中定义与导出行）。
- `scripts/build-web.ps1:27` 路径字符串含**字面退格字节**（`cat -A` 实测 `scripts^Huild-standalone.js`，0x08）：应为 `scripts\build-standalone.js`，`\b` 被写成退格 → 该分支永远找不到文件，standalone 静默不重生成（`build-web.sh:21` 是对的）。后果已见：`dist/` 里的 standalone 比仓库根的旧 18KB，dist 整体过期（缺 `js/sync.js`、`app-extra.js`）。
- `ledger/js/app-extra.js:339` 的 `case 'imp-upload'` 处理器在页面里**没有任何触发元素**（见 §2.5）——半死代码。
**fixNow**：是（删 largestRemainder；修 ps1 字节；imp-upload 见 §2.5）。

**债 5：命名与文档性噪音。**
`services/reports.js:436` `jobBillJoinlessCounts` 名字与 `jobBillJoin`（398 行）形似实异（后者真 JOIN bills，前者根本不 JOIN），读代码极易误判口径；git 提交信息动辄数千字把设计文档塞进 commit message（如 `83c4e06`、`89fe811`），历史检索价值低。另有 `.server.pid`、`data/app.db.bak-007/009` 等运行产物已在 `.gitignore` 兜住，不入库，无碍。
**fixNow**：是（只改函数名/加注释，一行成本）。

### 1.3 最该先还的 3-5 笔债（结论）

1. 红冲检索缺陷（§1.2 债 1）——账簿正确性问题，实测有资损级表现。
2. 导入 apply 无事务（§3.2）——批量落库的原子性洞。
3. P4 半截子 purpose 双语义收尾（§2.2 第 1 条）。
4. 导入页上传入口死亡（§2.5）。
5. 死代码/坏字节清理（§1.2 债 4）。

---

## 二、数据流符合度：主干吻合实际作业流程，断层集中在"编辑/作废"与"导入收尾"

### 2.1 走查结论（现场计算→收钱→记账→对账）

主干**吻合**。逐环证据：

- **现场计算**：`js/calculator.js:429-461` 按农户聚合出 `result.settlement`（打药钱=默认单价×面积、药钱=补充套数×药价），`income = ΣsprayFee + 补贴`（`calculator.js:490`），全程本地不落库。
- **计算器同步**：`js/sync.js:63-78` 组 payload（client_job_id 幂等键 + 本地单号）、状态机 pending/syncing/failed/dead + 退避重试（`sync.js:157-238`），触发点在 `js/ui.js:2416,2433`；服务端 `services/jobs.js:183-236` 幂等收单（同 client_job_id 返回原单 :198-201）、撞号重生成 :204-225、物理量只读权界 :279-285。**"现场算完、晚上联网补传"的作业形态被正确支持。**
- **Excel 导入（历史账）**：`routes/import.js:26-139` 解析入 staging → 行级复核 → apply 全链路落库（`importExcel.js:472-576` 一行=party→job(settled)→settlement(confirmed)→bill→receipt→双分录），对账报告守恒校验（`routes/import.js:267-291`）。
- **jobs→结算→账单**：`services/settlements.js:31-80` 逐户快照生成结算、confirm 生成每户账单+分录（:125-171）、零金额不生成账单（:141-142）、撤回=红冲+账单作废+作业 reopened（:174-191）。与"先干活记账、确认后才成账单"的流程一致。
- **账单→收款**：单挂 + 按客户 FIFO（`services/finance.js:88-115`，余额自动转预收），预收抵扣/预支冲销有流水表（advance_usages）——"客户一把给钱、多的记预收"正是现场实况。
- **对账**：`/api/overview` 总表=原 Excel 视图（`services/overview.js:15-42`），报表以账簿为唯一事实来源（`services/reports.js:1-3`），导入侧有 staging↔原始列合计的 diff 报告。

### 2.2 断层清单

**（1）purpose 双语义——P4 修了一半，写入路径没改。** 迁移 008 加了 `jobs.purpose` 并声明"导入写列属订正脚本 backfill-008 / importExcel 落库修正"（`migrations/008_job_purpose.sql:7-8`），但 `services/importExcel.js:482-493` 依旧把 `parsed.purpose` 写进 **plant_type_name**（列清单 :482 第 9 列，`:488` 传值），全库**没有任何代码写 `jobs.purpose`**（grep 实证），只靠 `services/overview.js:18` 的 `COALESCE(j.purpose, j.plant_type_name)` 掩盖；`HANDOFF-P5-PLAN.md:168` 自认 backfill-008 未交付、purpose 0/104 非空。同一字段在 UI 里一处显示"机器："（`ledger/js/app.js:110`）、一处显示"目的"（`app.js:541`），语义漂移肉眼可见。
**fixNow**：是。importExcel.js 落库改写 purpose 列 + 存量订正小脚本 + 测试。

**（2）farmer_ref 双语义。** 001 设计是"计算器本地 farmerId（仅溯源）"（`migrations/001_init.sql:172,202`），计算器路径写 `st.farmerId`（`services/jobs.js:169`，形如 `farmer_default`），导入路径却写 `String(partyId)`（`services/importExcel.js:499,505`）——同一列两种键空间。下游 `reports.js:377-378`（partyBalance 用 `farmer_ref = String(partyId)` 匹配）与 `masterdata.js:146,154`（`'ref:' + p.id`）只对导入行生效，计算器行全靠 farmer_name 兜底匹配。当前能跑，但任何按 farmer_ref 关联的新代码都会踩坑。
**fixNow**：否（兼容成本大于收益）。建议在 001 注释处补一句真实约定：farmer_ref=导入侧 partyId / 计算器侧本地 id，新代码一律以 farmer_name+party 挂靠为准。

**（3）支出无挂靠。** `payments.job_id/payee_party_id` 列在（`001_init.sql:302-316`），但两条入口都不用：导入 `applyExpenseRow` 不写 job_id/payee（`importExcel.js:583-587`），记账 UI 支出表单也没有作业/收款方字段（`ledger/js/app.js:317-325`，`listPayments` 显示 job_no 却永远为空 `finance.js:466-470`）。原 Excel 里"支出挂某天作业"的信息只活在 note 文本里。报表 costBreakdown 只能按类别聚合、无法按作业归因（`reports.js:308-324` 两口径注释也承认）。
**fixNow**：否（产品决策：是否值得为历史账补挂靠）。新支出 UI 加"关联作业（可选）"下拉即可覆盖增量。

**（4）结算确认分录的应收借方行不带 party_id，导入路径带。** `settlements.js:157` 的 1122 借方行无 party_id，而 `importExcel.js:542` 的同名分录带——同一科目两种归属粒度，任何"按客户读应收科目分录"的报表都会因来源不同而漂移（现有 byCustomer 用的是 income 贷方行与 bills，暂未踩到）。
**fixNow**：是。1122 借方行逐分项拆行挂 party_id（与 6001/6002 行对齐）。

**（5）编辑/作废后的账簿残影（本节最重，实测）。** 复现于 :memory: 库直调服务层：
- `updatePayment` 丢支付方式：payments 表无 method 列（`001_init.sql:302-314`），编辑重过账时 `newMethod = method || 'cash'`（`finance.js:201-202`）→ 微信付款 500 元编辑一次后新分录贷方变 **1001 现金**（实测分录序列 `#3/payment/1001/credit`）。
- 二次编辑重复红冲原分录：`finance.js:198-200` 取到的一直是最老那条 active 分录 → 微信 500 支出编辑两次后 **现金 1001 净额 −1000 元、微信 1002 净额 +500 元**（正确应为微信 −500）。
- 编辑后作废留下幽灵分录：`finance.js:412-414` 同样取第一条 → 作废"编辑过的收款"后 **1122 应收净额残留 300 元**（账单已回 unpaid）。
- 结算撤回循环幻影：确认(300)→撤回→改分项 500→确认→再撤回 → **6001 收入残留 200 元、1122 残留 −200 元**（应为全 0；`settlements.js:181-183` 取错对象，`#4/reversal` 红冲的是 #1 而不是 #3）。
根因同 §1.2 债 1。这类错误不炸接口、只错账，恰恰破坏用户最关心的"对账"。
**fixNow**：是。

**（6）patchJob 更正后补贴丢失。** 初始 `income_cents` 含农机补贴（`jobs.js:97` + `calculator.js:490`），但行更正后的重算 `incomeCents = Σ(spray+pesticide)`（`jobs.js:315-320`）不含 `subsidy_cents` → 任何一笔行更正都会让含补贴作业的 income/profit 静默缩水。
**fixNow**：是（重算式加 `COALESCE(subsidy_cents,0)`，一行）。

**（7）导入收款方式硬编码。** `importExcel.js:553` receipt method 固定 `'other'`、`:564` 分录借方固定 1001 现金——历史 Excel 无渠道信息属合理近似，但意味着导入的 8.4 万实收全部计入"现金"科目，微信/支付宝对账天然对不平。note 有提示、可接受，需在 OPS 文档明示。
**fixNow**：否（等 LLM 导入方向一起做：parsed 契约里加可选 method 字段）。

**（8）计算器 address 恒空。** `sync.js:72` 固定 `address: null`，`jobs.address` 实际只服务导入旧数据；地址语义已由 parties.region/village/team 承担（003/006），列属于半废弃。
**fixNow**：否。

### 2.3 复现输出摘录（债 1 / 断层 5）

```text
编辑1后: #1/payment/active/1002/credit … #2/reversal/1002/debit … #3/payment/1001/credit   ← 方式丢了
编辑2后: … #4/reversal/1002/debit（又红冲 #1）… #5/payment/1001/credit
现金余额(应只付500): [{"code":"1001","bal":-100000},{"code":"1002","bal":50000}]

confirm(300)→reopen→改500→confirm(500)→reopen 后 6001/1122 (应全 0):
[{"code":"1122","s":-20000},{"code":"6001","s":20000}]

作废后账单 paid=0 status=unpaid；应收1122净额=30000(应为0)
```

### 2.4 同类风险点（未单独实测，静态判定）

- `voidFinanceRecord` 的表名单数化 `table.replace(/s$/,'')`（`finance.js:413`）只在 receipts/payments/advances 白名单内安全，属脆弱写法。
- `routes/import.js:130-133` 用 SQL `LIKE '%needs_review":[%'` 过滤复核行而非 `json_extract`，格式变化即失效。
- `settleAdvance` 的分录把报销/还款统一借现金（`finance.js:355-365` 自注"P0 简化"）——已知近似，非新发现。

### 2.5 导入页上传入口死亡（新发现，影响导入主线）

`ledger/js/app-extra.js:339` 有完整的 `case 'imp-upload'`（读文件→base64→Api.importParse），但 `renderImport()` 的表单（`:12-19`）只有 `<input type="file" id="impFile">`，**没有** `data-act="imp-upload"` 按钮，也没有 change 监听（全 ledger 目录 grep 仅命中定义处两行）→ 目前 UI 无法上传新 Excel，只能靠历史批次或直接调 API。对"批量导入落库"这条主线是入口级断点。
**fixNow**：是。在文件选择框旁补 `<button class="lg-btn primary" data-act="imp-upload">解析并复核</button>`（一行 HTML）。

---

## 三、数据库脚本落库可行性便携性

### 3.1 迁移/种子：可重复性良好（实测通过）

- 顺序执行 + `schema_migrations` 记账 + 已应用跳过（`db/client.js:27-55`）；表重建类迁移用 `-- spraybook:no-tx` 裸执行规避 PRAGMA 事务限制（`client.js:41-47` + `005_settings_and_opening.sql`），机制正确。
- seed `INSERT OR IGNORE` 幂等（`db/client.js:57-60`），migration.test.js:50-58 实测通过；migrate 二跑幂等 migration.test.js:80-85 通过；`foreign_key_check` 零孤儿 migration.test.js:38-41 通过。
- 迁移文件"只增不改"纪律在（003 注释明确 001/002 不可改），007/008 全部 ALTER ADD COLUMN，向前兼容。

### 3.2 导入 apply 无事务——落库可行性最大缺口（实测）

`routes/import.js:183-212` 的 apply 把"全部 confirmed 行落正式表"放在**裸循环**里，而 `applyJobRow` 的注释写明"调用方事务内执行"（`importExcel.js:471`）——调用方并没有开事务。实测：毒化 1 行后，前 103 行的 jobs/bills/分录**已提交**，批次状态停留 reviewing；修复后重试撞 `client_job_id` UNIQUE **整批卡死**，只能手工修库。注意 bills/receipts/settlements 没有幂等键（单号靠 `nextBizNo` 计数现生成，`services/audit.js:18-25`），若毒行发生在"job 成功但 bill 失败"的中间态还会留下半张单。
**fixNow**：是。`const tx = db.transaction(() => { for (...) {...} }); tx();` 一处包裹 + 补"中途失败零残留、重试成功"测试用例。

### 3.3 路径便携性：数据目录环境变量只有半套

- `server/index.js:21` 支持 `SPRAYBOOK_DATA_DIR`，但 `db/reset.js:11-12`、`db/backup.js:14-16`、`db/backfill-007.js:122`、`db/backfill-009.js:185`、`db/renumber-import-jobs.js:11` 全部硬编码 `<repo>/data/app.db`（`__dirname` 相对，无绝对盘符，尚可移植）→ 一旦设了数据目录，**服务用一个库、运维脚本操作另一个库**。
- .bat/.ps1 启动脚本用 `%~dp0`/`$PSScriptRoot` 相对定位，便携（`1-启动服务并打开网页.bat` 实读）。
- `reset.js` 语义是"删库重建"且无确认提示（`reset.js:15-18` 直接 unlink），对单人本地工具可接受，但应只允许对"脚本自己解析出的那个库"生效。
**fixNow**：是。抽 `server/db/paths.js` 统一解析 DATA_DIR（env 优先），5 个脚本改为引用，半小时工作量。

### 3.4 备份策略：可用，缺"落库前自动备份"

- `db/backup.js` 用 better-sqlite3 在线 backup API（WAL 一致性安全，`backup.js:29-33`），保留 30 份（:35-42），同日重跑覆盖同名文件（stamp 只到日，:26-27）——可接受但无同日多版本。
- backfill-007/009 自带"先备份再动库"（`backfill-007.js:124-127`；009 更完善，WAL 非空时改走在线备份 `backfill-009.js:190-195`），且有金额基线前后断言+事务内区间自检（`backfill-009.js:48-63`）——**这是全库最规范的订正脚本范式**。
- 缺口：**导入 apply（对真库最危险的操作）反而没有前置备份钩子**，也不强制先 `db:backup`。
- `renumber-import-jobs.js:16-27` 无备份、直接改 raw_json，属已运行完的一次性脚本，建议归档或加只处理 `IMP-%` 之外的护栏注释。

### 3.5 CLI 导入入口：不存在

- 排查 `scripts/` 目录零引用 `importExcel`/`import/parse`；唯一通道是起 Express 后 `POST /api/import/parse`（base64，`routes/import.js:26`）。想批量落库必须：起服务 → 开浏览器 → 上传 → 逐行点确认 → 点落库。复核阶段也没有 CLI（PATCH 端点可 curl 但无封装）。
- "一键落库脚本"缺口清单：① `import`（Excel→staging，可离线跑）② `review`（列出 needs_review 行/按规则自动确认）③ `apply`（事务落库+前置备份+对账报告打印）④ `--from-json`（直接吃结构化行，见第四节）⑤ 上述四步共用 `db/paths.js` 与 backup 前置。
**fixNow**：否（先修 3.2 原子性，CLI 随第四节路线图一起落）。

---

## 四、本地小 LLM 批量导入方向：底子好，缺五块契约板

### 4.1 现有 staging 管线对 LLM 的适配度

**底子好**：`raw_import_rows(batch_id, sheet_name, row_no, raw_text, parsed_json, status)`（`001_init.sql:436-451`）本质就是"原文 + 结构化解析 + 复核状态"三件套；`parsed_json = {kind, parsed, needs_review:[{code,detail}]}`（`importExcel.js:434`）已接近 LLM 输出槽位；确定性解析器把疑难行标 `needs_review` 而不是硬猜（`importExcel.js:11`"只做确定性解析"原则正确）；对账报告以原始列合计为基线（`routes/import.js:45-107`）是防幻觉的天然护栏；文件 hash 防重复上传（`routes/import.js:31-34`）；落库只吃 confirmed 行（`routes/import.js:189`）。

**缺的契约（按必要性排序）**：

1. **确定性校验层**：apply 直接信任 `parsed_json` 字段（`routes/import.js:194-204` 只查了金额非零），日期格式/金额区间/必填项都不校验——本次毒行实测（name=null 炸库）正说明缺这一层。LLM 输出是不可信输入，必须在 apply 前过一道与 UI 无关的校验器（复用 backfill-009 的单价区间 [500,10000] 分、`assertSafeDate` 的日期正则、`Number.isInteger` 金额）。
2. **schema 化的 LLM 输出格式**：`parsed_json` 形状目前是隐式契约（只有 `importExcel.js:414-433` 一处拼装可读出）。需要一页 JSON Schema + 一个 `validateParsedRow()` 导出函数，LLM 只被允许产出"与 staging 行同构"的对象——本地小模型靠 schema + few-shot 才能稳定。
3. **置信度字段**：`needs_review` 是离散 code 无量化置信度。LLM 流水线应在 parsed_json 里加 `llm_confidence`（0-1）与 `llm_model`，配策略：confidence ≥ 阈值且无 needs_review 才允许 `imp-confirm-all` 式批量确认，其余必须人工。**不要**让低置信度行静默落库。
4. **幂等/去重**：现在唯一去重是整文件字节 hash（`routes/import.js:33`）。LLM 重新 OCR/转写后 hash 必然不同 → 同一张表导两遍=双倍收入。需要自然键去重：`(name, date, receivable_cents, sheet, row_no)` 在 parse 阶段对历史 applied 批次做指纹比对，命中即标 needs_review('duplicate-suspect')。
5. **复核 UI 联动**：服务端支持行内改数（PATCH `parsed` 合并 + 人工编辑即视为澄清，`routes/import.js:160-169`），但 UI 只有确认/拒绝两个按钮（`app-extra.js:56-81`），needs_review 行只能看着 raw_text 盲确认。LLM 流程里人工复核是最后防线，必须能改数再确认；外加 confirmation 阈值列与按 code 过滤。
6. **（前置）apply 原子性**：见 §3.2——LLM 批量导入放大批次行数，无事务的部分落库在 200 行批次下几乎必然遇到。

### 4.2 风险

- **幻觉金额**：护栏=raw_text 永久留存 + 对账 diff（`routes/import.js:267-291`）+ needs_review 门槛。现有设计已把"金额永远可回溯到原文"做对了，方向保持即可。
- **重复落库**：hash 去重对 LLM 流水线失效（4.1-4）；client_job_id 天然幂等仅保护计算器路径，导入的 `import-{batch}-{row}` 键只在同批次内有意义。
- **半截落库**：§3.2 实测，事务修复前禁止扩大批次规模。
- **schema 漂移**：新月份 Excel 改列名时，确定性解析器会静默 skip（`importExcel.js:302`），LLM 版本若直接映射会更隐蔽——保留"解析统计数 vs 原始行数"的 sanity check（parse 端点已返回 stats，UI 应显性告警 skipped 异常高）。

### 4.3 务实路线图（先做地基，不过度设计）

1. **第 1 步（本轮可修，半天）**：apply 包事务 + 行级确定性校验器（date/金额/姓名/单价区间）+ 复核行支持改数（复用现成 PATCH）+ 补 `imp-upload` 按钮。完成后导入主线才配得上"批量"二字。
2. **第 2 步（1-2 天）**：`server/cli/import.js`（`--file` 解析入 staging、`--review` 列表、`--apply` 事务落库+前置 db:backup+对账打印），复用 `parseWorkbook/applyJobRow/applyExpenseRow`，不起 Express。这是"一键落库"的本体，也是 LLM 流水线的执行端。
3. **第 3 步（2-3 天）**：冻结 `parsed_json` JSON Schema + `validateParsedRow` + `llm_confidence/llm_model` 字段 + 自然键去重指纹；对账报告增加"LLM 批 vs 确定性解析批"双跑对比模式（同一 Excel 两边各解析一遍，diff=LLM 学坏的信号）。
4. **第 4 步（再评估）**：本地小 LLM 的职责**只限定在"把杂乱文本映射成 staging 行"**（OCR/转写/列识别/类别归一），金额与日期的最终落库永远走 确定性校验 + 人工确认 + 对账守恒 三道闸。不要让 LLM 直接生成凭证分录（分录由 applyJobRow 的固定会计规则生成，这条边界不要破）。
5. **不做**：流式导入、多用户并发、云端同步、向量化检索——当前单人本地场景纯属过度设计。

---

## 附：结论速览

| 维度 | 结论 |
|---|---|
| 屎山判定 | **不是屎山，局部欠账**。服务端结构/事务/留痕/测试均健康；欠账=红冲检索系统性缺陷、前端巨石文件、双实现绑定、死代码与坏字节 |
| 数据流符合度 | 主干与"现场算钱→收钱→记账→对账"吻合；断层=purpose 半截子、farmer_ref 双语义、支出无挂靠、编辑/作废账簿残影（实测）、导入上传入口死亡 |
| 落库可行性便携性 | 迁移/种子/备份可重复且实测通过；apply 无事务（实测部分落库+卡死）、DATA_DIR 半套支持、无 CLI 导入入口为三大缺口 |
| 本地小 LLM 方向 | staging 管线是正确底座；缺确定性校验层、输出 schema、置信度、自然键幂等、复核改数 UI 五块板；LLM 只做映射不做记账，金额落库三道闸不破 |
