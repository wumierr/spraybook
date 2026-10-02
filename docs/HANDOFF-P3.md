# HANDOFF-P3 — 数据补全(地块/杂费/成本构成)+ 账单前端舒适性重构

日期:2026-10-02。前置:HANDOFF-P2(P2 已完成,main @ fe7aee3)。用户裁决:**电脑为主(不做移动端)**、**允许订正历史伪行(金额分文不动)**、**建地块档案**。

## 1. 审查结论(本轮行动依据)

### 数据输入输出(计算器→库)
1. 计算器的杂费(miscCost)/人工/药剂/设备成本构成、农机补贴(subsidy)只躺在 `raw_json.result.costBreakdown` 与 `snapshot.income.subsidy`,`jobs` 表只有 total_cost 黑箱 → **007 补 5 列**(`labor/pesticide/equipment/misc_cost_cents` + `subsidy_cents`),服务端 `jobRowFromPayload` 直接从 costBreakdown 落位;总额三列(income/total_cost/profit)从未动。
2. 导入"另按 N 元/亩"额外收入伪装成结算行(farmer_name 塞文本) → **007 加 `kind`('spray'/'extra') + `unit_price_cents`**,新数据结构化落库,存量 8 行(4 结算行+4 分项行)由 `db/backfill-007.js` 订正,金额分文不动(sums_unchanged 硬校验,备份 `data/app.db.bak-007`)。
3. 地块:job_plots 快照一直在库但前端不展示、无跨作业档案 → **job_plots.plot_id 关联主数据 plots(按名匹配)** + 主数据页地块档案 panel + 工单详情地块明细表。计算器同步的作业今后自动按名关联。
4. 小修:createReceipt 支持 collector_name(前端收款表单已加);bootstrap 下发 operator(settings.operator,计算器同步 operator_names 从此非空,零改动生效);GET /api/parties 与 PATCH 白名单补 region。

### 前端完备性(逐页签核实后的缺口→全部落地)
- 检索:全站无搜索/筛选 → **每页签检索工具条**(搜索防抖保焦点 + 账单状态 + 支出类别筛选)+ **客户名点击"只看此客户"**(跨账单/收款/预收预支)。
- 汇总:无合计行 → 七页签 tfoot 合计(当前月份+筛选口径,void 不计)。
- 导出:无 → **每页签导出 CSV**(BOM+转义,Excel 直开;当前口径)。
- 明细:收款"核销 N 张"可点开 allocations 明细+余额转预收;报表页补**按作业**panel(接口早已有);工单详情补成本构成/地块明细/电池明细/extra 行"另按 X 元/亩"标签。
- 编辑:假编辑修复(bills 未收行金额/调整直填、已收行🔒锁定;advances 备注直填);支出类别编辑改下拉(修 CHECK 500 隐患);主数据客户编辑 prompt 链退役→行内直填;新增**新增客户**与**地块档案**入口。

## 2. 顺手修掉的重大 bug(审查中发现)
| bug | 影响 | 修复 |
|---|---|---|
| `collectInputs` 读 `dataset.field` 但直填输入用 `data-f` | **P2 以来表格编辑保存全部发 `{undefined:…}`,从未真正生效**(toast 虚报成功) | 读 `dataset.field \|\| dataset.f`(app.js) |
| renderJobs/renderBills 月分页后二次 `Core.xxxRow()` | 工单规模/收入列、账单客户/金额列全显示"—" | 去掉二次映射,映射行保留原始 cents |
| 事件分发正则不认识 `nc-`/`plot-` | 新增客户/地块按钮静默无效 | 正则补全 |
| bills 编辑输入 value 带千分位("2,000.00") | type=number 清空 value,未编辑行被误判变更(靠 COALESCE 无损) | 输入用 `(cents/100).toFixed(2)` |
| app-extra 重复定义 loadImportBatches/Rows、`d.batchId` 笔误 | 导入上传后行列表不刷新 | 删重复+修笔误 |
| render 并发竞态(切页签+搜索) | 旧渲染晚写覆盖新结果 | render 串行化门(renderChain) |
| app-extra 给未声明变量赋值(parties=[]) | strict 模式 ReferenceError | 移除,收款页每次重拉 parties |

## 3. 数据订正报告(backfill-007 真库)
- 伪行订正:job_settlement_lines 4 行 + settlement_items 4 行 → kind='extra' + unit_price_cents(2500/2500/3000/3000)+ 干净姓名;残留伪行 0。
- jobs 构成列:0 行(真库 104 单全为导入来源,无 costBreakdown;计算器同步真实作业时自动落列)。
- 金额基线:jobs_income/jobs_cost/jobs_profit/bill_amount/bill_paid/receipt/payment/line_spray/journal_debit 回填前后**分文不变**(脚本内置断言,不符即回滚)。
- 对账三平不变:应收 97,680.10 / 实收 84,216 / 支出 38,421。

## 4. 验证
- 测试:计算器 44 + 前端 core 7 + 服务端 49 = **全绿**(新增:007 迁移/构成落列/extra 结构化/backfill/bootstrap operator/csv 转义)。
- 浏览器实测(真库 @3777):搜索联动合计(104 行 101,170.10 → 搜索后 1 行)、客户过滤(叶正燕 5 行)、未收筛选(8 行 13,103.30)、类别筛选(油费 25 行 9,193.00)、extra 标签(J20260421-01 张志军 另按 25.00 元/亩)、行内编辑保存(region/电话/账单金额 1900/支出备注,均落库并留痕后恢复)、CSV 导出(26 行)。
- 测试数据已清理(测试客户/地块停用,金额恢复)。

## 5. 遗留(低优先级)
- 公网部署前加登录口令;CNB 流水线切 dist/。
- 主数据 chemicals 仍只读(编辑走计算器端)。
- 报表"按作业"是快照口径(导入单成本=0),页面已标注。
- 导入 review 页剩 7 行待用户确认(2 日期/2 空地址/4 非常见人名/1 无姓名收入对);P20261001-052 金额 17065 建议自查。
- 移动端:按用户裁决不做;若未来要,先做账单/收款两页的只读+登记精简视图。
