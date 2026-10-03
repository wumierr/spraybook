# HANDOFF-P5-PLAN — 图表 echarts 化 + 总表数据条 + 表格 Excel 化 + 单价口径修复(P5 实施方案)

日期:2026-10-03。前置:HANDOFF-P4(P4 已实施:总表/图表页/008 迁移已上线;P4-PLAN §2.3 的 `backfill-008.js` **未交付**,见 §7 残留)。本方案综合三份勘察(图表现状/表格接入点/价格口径),全部行号与数据均经本会话实读+实跑复核(§8 验证记录)。

## 修订记录

- **R1(2026-10-03,评审修订)**:评审返回 3 条 blockers + 9 条建议,逐条处理如下;每条判定均基于本会话复跑实测(命令与输出见 §8),未臆造,无一条被忽略。
  1. **[blocker·成立,采纳]B1 backfill-009 派生兜底分支单位错误**:原式 `COALESCE(raw, ROUND(fee/area)) * 100` 把已是**分/亩**的派生值再 ×100。本会话 sqlite 实跑演示:`ROUND(115000/50)*100 = 230000` 分 = **2300 元/亩**(恰是方案 §5.2 自己所举 J20260301-01 的派生口径);单位基准核实:`importExcel.js:495` `Math.round(Number(parsed.price_yuan) * 100)`(×100 只属于 raw 分支元→分)、`settlements.js` 全文 **0 处** unit_price_cents(grep 实测 exit 1)→ 计算器单结算行恒 NULL,兜底分支正是 §7.5 依赖的人群,且旧公式会让方案自带的 [500,10000] 分自检对任何无 raw 行必炸。§5.2 公式已改为分支分别取整:`COALESCE(ROUND(json_extract(...)*100), ROUND(fee/area))`,并补齐自检失败语义(§5.2)。
  2. **[blocker·成立,采纳]B2 warning 阈值自相矛盾**:§5.2 原写">0.5 元"却称 6 单。实测(只读拷贝复跑):diff>0.5 元 = **2 单**(J20260301-01 与 J20260204-03,各差 2.00 元);diff>0.05 元 = **6 单**(2.00/0.38/2.00/0.26/0.23/0.09),与 §8 的 >0.005 口径同集。§5.2 阈值改为 **>0.05 元**,M1 验收 5 的"6 单清单"保持成立。
  3. **[blocker·成立,采纳]B3 明细表 data-colw 无法被列宽机制覆盖**:`toggleDetailSlot`(`app.js:763-766`)点击后异步向 detail slot 插表(入口 `app.js:829/849/853`),doRender 尾部与 LedgerExtra.renderTab 尾部两个挂钩点都不会在明细展开后执行——存档列宽不回显而 th 拖拽手柄(CSS 类选择器)照常出现,状态自相矛盾。双管处理:①`toggleDetailSlot` 改 promise 感知,loader 完成后调 `applyColWidths()`(一处挂钩覆盖三入口);②按本会话逐表清点修正清单——地块明细 **8 列**(`app.js:113`)保留并依赖新挂钩;分家明细 **5-6 列**(`app.js:116`,第 6 列 canEditLines 条件渲染)、结算分项 **4 列**(`app.js:177`)、结算明细账单 **5 列**(`app.js:181`)本就低于"≥7 列才加"的自设门槛,移出 data-colw 清单(§4.1/§4.2)。
  4. **[建议·采纳]matchMedia change 回调加 `if (T)` 守卫**:`charts.js:13` `let T = null` 在首次 renderTab/handleAct 经 tools() 注入前为 null,用户未进过图表页就切系统主题会在回调里抛 TypeError;`disposeAll()` 是模块级注册表操作可无条件执行,`T.render()` 必须守卫(§2.2-3)。
  5. **[建议·采纳]拖拽中重绘兜底 + 省略号**:mouseup 写档后对当前表**重放一次** applyColWidths(拖拽中恰逢搜索防抖 250ms 重绘时,mousemove 更新的是已脱离 DOM 的旧 col,存档不丢但可视宽丢失);新增 `.lg-fixed td{overflow:hidden;text-overflow:ellipsis}` 防 fixed+nowrap 下拖窄列后长客户名/备注侵入邻列(§4.1/§4.2)。
  6. **[建议·采纳]data-colw 清单重列**:评审指出 §4.2 原清单行号/数量错乱(app.js:68,401,468,478,483 五个行号对"四表",且 :401 分成 5 列、:478 客户盈利 4 列违反 ≥7 列门槛)。本会话以 node 脚本逐表数 `<th>` 全量清点(app.js 18 张/charts.js 4 张/app-extra.js 5 张),≥7 列共 **14 张**重列,并补入漏掉的工单主表 7 列(`app.js:67`)与流水 7 列(`app.js:422`);C6 两表(charts.js:308=4 列/311=3 列)移出(§4.2)。
  7. **[建议·采纳]流式输入 CSS 限定 `.lg-fixed` 作用域**:原"96px/90px 改 100%"对无存档表同样生效,与 M3 验收 6"未拖过宽的表零回归"矛盾。改为:既有 96px/90px 基线**原样保留**,新增规则限定 `table.lg-fixed` 内输入流式;app.js:528/240 两处内联宽移除改 `class="lg-inp"` 以便作用域生效;M3 验收 6 措辞同步修正(§4.2/§6-M3)。
  8. **[建议·采纳]"4 处直调"表述统一为 5 处**(`app-extra.js:246,250,267,309,313`,实测全部经 `window.LedgerExtra.renderTab`);并注明 master 分支是 `renderMasterData().then(html => { $main.innerHTML = html; })`(`app-extra.js:409` 实读),import 分支同步 innerHTML+`loadImportBatches()`——apply 须挂在 renderTab 的返回链(Promise 完成后)而非函数尾部同步调(§4.1-3)。
  9. **[建议·采纳]backfill-009 备份完整性前置检查**:007 只 `copyFileSync` 主库文件,若执行时服务在写且 `-wal` 非空,.bak-009 不完整;009 增前置检查(wal 非 0 字节即中止,提示先停服务),并写明 [500,10000] 区间自检失败语义——移入事务内 commit 前执行,失败 throw→自动回滚→exitCode=1(§5.2)。
  10. **[建议·采纳]数据条周区间口径注明**:锚点在年内首个周一前(W00 窗口)时,前端"取本周一"会落到上一年 12 月,与服务端 `%W` 归桶(`reports.js:146`)错位;区间计算复刻 W00 规则(=当年 1 月 1 日..首个周一前一日)并加脚注(§3.1)。
  11. **[复核通过,无改动]** 评审对问②③⑤⑥的独立复测与本方案 §8 记录一致:零 CDN grep 0 命中、152 基线 61+91 全绿、echarts 插入位(index.html:38/39 之间)正确、UMD 挂 window.echarts 无模块加载器问题、修正 SQL 104/104 落 15.38–35 元/亩、ledger 不进 APK/Cloudflare 包、`data-theme="day"` 在 CSS 0 引用、`ORDER BY l2.id` 与 `kind='spray'` 防御成立、masterdata.test.js:51-71 不断言价格值。
- **R2(2026-10-03,第三轮评审→自检修订)**:第三轮 ask 的 blockers/建议均为 `undefined`(结构化内容传递丢失,与 HANDOFF-P4-PLAN 修订记录 R2/R3 同况),按 P4 已确认的既定方式执行设计者自检,**未臆造任何评审意见**;若评审方后续补发具体条目,再逐条落盘。自检按四条标准过(断言 vs 代码/破坏现有功能风险/需求覆盖/硬约束),实际修正 3 点:
  1. **[实现陷阱]宽表 min-width 与可视宽算术不符**:若按原方案把 `lg-table--wide` min-width 提至 1600,与 `.lg-main` 1600 下的可视宽 **1542**px(=1600 − 32 main 左右 padding − 26 panel 边框+padding,实算)仍差 58px——≥1600 视口也恒有横向滚动,且 M3 验收 4 原"1440 宽屏幕无横向滚动"必然落空(1440 视口可视宽仅 **1382**,实算)。改为 **min-width 1520**(≤1542,≥1600 视口无滚动;`width:100%` 使列分布拉伸填满),验收措辞同步如实化:1440 视口保留按需横向滚动,窄屏以"拖列宽+记忆"为主要手段(§4.2/§6-M3)。
  2. **[断言/数字]「12 页签」与实况不符**:实测 `grep -c "data-tab=" ledger/index.html` = **13**(index.html:17-29,含总表与图表;任务文本写 12,以代码为准)。§1 硬约束与 M1 验收 6、M3 验收 5 统一改为 13 并注明差异来源。
  3. **[实现边界]disposeAll 调用点收紧**:§2.2-2 原"doRender 各分支入口"改为"doRender 开头一次 + renderTab 开头"——单一入口避免未来新增分支漏调;总表数据条的 mountMini 复用同一实例注册表,不另设第二套 dispose。
  其余断言复核通过:M2 验收"12 张卡"(C1..C10 + C11/C12)数字正确;M1 换显后 charts-render.test.js:95/120 依赖的原始键仍经 tooltip 的 `label(period)` 双写保留在 HTML 中;C9 表 11 列 colspan 与期间列显示 label 无耦合。

## 0. 用户反馈 → 方案章节映射

| # | 反馈原文(摘) | 章节 | 里程碑 |
|---|---|---|---|
| ① | 图表客户数显示 2026-w…,"不是给人看的信息" | §2.3 label 显示层映射(周→`W05(01-26)`、月→`1月`、季→`Q1`、年→`2026`;客户/地区/飞手图用姓名/地区名) | M1(服务端 label+前端换显)/M2(echarts 轴) |
| ② | 主数据最近作业显示"几千元一亩" | §5 单价口径修复(子查询 ÷100 + kind 过滤 + backfill-009 回填) | M1 |
| ③ | 表格无法调列宽、太窄,要和 Excel 看齐 | §4 表格 Excel 化(th 拖拽+localStorage 记忆+lg-main 放宽+输入适配) | M3 |
| ④ | 粒度按钮顺序不符合从小到大 | §2.2 GRANS 重排 周→月→季→年 | M1 |
| ⑤ | 图表美观牵强,为何不用 echarts 现成库 | §2 echarts 本地 vendor 化 + option 适配层重写 | M2 |
| ⑥ | 总表要直观数据条(当日/月/季/年收支、地区占比、客户数、飞手占比),图表页更详细 | §3 总表数据条 + by-range/by-region/by-operator 三新端点 + C11/C12 详细版 | M2 |

## 1. 硬约束与遵守声明

- **原生 JS 无构建**:echarts 以单个 `echarts.min.js` vendor 文件引入(`<script>` 标签),无打包器、无 import map、无模块化改造。
- **运行时零外部 CDN**:echarts 为本地文件(用户本轮明确要求放行);实施前后均以 `grep -rEn "https?://|cdn\." ledger/` 作守门检查(本会话实测 0 命中,见 §8)。echarts.min.js 内部的注释性 URL(license/sourcemap)不发起运行时请求,验收以 DevTools Network 面板"无外部请求"为准。
- **金额一律 `_cents`**:三个新端点与图表 option 全部以分计算,仅 formatter 层转元显示。
- **migration 只增不改**:P5 **零 schema 迁移**(三个新端点全部聚合既有表;backfill-009 是订正脚本不是迁移,且只写 NULL 列)。
- **页签不删不减、152 项测试基线不破坏**:页签实测 **13 个**(`grep -c "data-tab=" ledger/index.html` = 13,index.html:17-29;任务文本写 12,以代码为准,R2 自检条 2);测试基线本会话实测 server 61 + 前端 91 = **152 全绿**(`cd server && node --test ../tests/server/` → 61 pass;`node --test ../tests` → 91 pass)。M2 删除 6 个断言被清除 SVG 函数的前端用例并**以更多 option 纯函数用例补足**,总量只增不减(详见 §6 tradeoff)。

---

## 2. A — 图表页 echarts 本地化(反馈①④⑤,M2)

### 2.1 vendor 落库(下载时可用 CDN,运行时零 CDN)

- 新增 **`ledger/js/vendor/echarts.min.js`**:echarts **5.6.0** UMD min 包(本会话实测 `https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js` → 200,Content-Length **1,034,102 B**;备选 `https://registry.npmmirror.com/echarts/-/echarts-5.6.0.tgz` → 302 需 `-L` 跟随,解包 `package/dist/echarts.min.js`)。下载命令写入实施步骤:
  `curl -L -o ledger/js/vendor/echarts.min.js "https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js"`
  落库自检:文件体积 ≥1,000,000 B;头部含 `echarts` 与 Apache-2.0 license banner;浏览器 Console `window.echarts.version === '5.6.0'`。
  目录微调说明:ask 写 `ledger/vendor/`,本方案落 **`ledger/js/vendor/`**——与既有 `js/core.js` 相对路径体系及 index.html 脚本序一致,`/ledger` 整目录静态托管(`server/index.js:76`)零配置;语义不变。
- **`ledger/index.html`**:在 L38(api.js)与 L39(charts.js)之间插一行 `<script src="js/vendor/echarts.min.js"></script>`。echarts 依赖顺序:必须在 charts.js 之前(charts.js 运行时读 `window.echarts`)。
- 打包链(勘察"待确认"项,本会话已核实):`scripts/build-apk.ps1:66-71` 与 `scripts/build-web.ps1:38-61` 的复制清单均**不含 ledger/**(APK www 实测只有计算器文件,`dist/` 无 ledger 目录)→ echarts vendor **不进 APK/Cloudflare 包**,打包脚本零改动;ledger 仅经本机服务(`1-启动服务并打开网页.bat`/`scripts/serve.ps1`)分发,vendor 随 ledger 目录自动可用。`sw.js:59` 已放行 `/ledger` 路径(不进 SW 缓存),零改动。

### 2.2 charts.js 重写为 echarts option 适配层

保留:`renderTab(tab, $main)` / `handleAct(btn, T)` 对 app.js 的既有接口(导出签名不变,`charts.js:417-418`)、`chartCard` 卡片骨架(52-61)、`fmtAxisYuan/fmtAxisNum`(64-77,改作 axisLabel/tooltip formatter)、`state.gran` 五键与按粒度缓存(28-39)、C9/C10 表格(363-394)。重写渲染内核:

1. **纯函数 option 构建器(新增导出,node:test 可测,不碰 DOM/echarts)**:
   - `buildTimeOption({rows, bars, lines, labelOf, jumpable, colors, axisFmt})` → echarts option(xAxis category=人类 label;yAxis 数组:柱值域 + 每条折线自有 yAxis,对齐现 C1 利润/C7 双折线"自有值域"行为,`charts.js:127-148`);series 柱 0-2 条+折线 0-2 条;tooltip formatter 复用现 tip 文案;`axisLabel.interval=Math.ceil(n/12)-1` 对齐现抽稀行为(`charts.js:150-154`),`axisLabel:{hideOverlap:true}`。
   - `buildBarOption({items, colors, valFmt})` → 横向 bar(yAxis category=姓名/科目名,取代 `hBarSvg`,`charts.js:161-177`)。
   - `buildPieOption({items, colors, valFmt})` → 环图/饼图(C11 地区 / C12 飞手 / 总表数据条共用)。
   - 输入输出全是 JSON 可序列化对象,`tests/` 下无浏览器直接断言(轴 label 升序、tooltip 文案、formatter 输出、双值域 yAxis 数量)。
2. **实例管理与挂载(DOM 层)**:模块级 `const _charts = new Map()`;`mountCharts(scopeEl)` 遍历 scope 内 `[data-chart]` 容器,`echarts.init(el)` → `setOption` → 存 Map;`disposeAll()` 先于任何 `innerHTML` 重建调用——**doRender 开头统一调一次 + charts.js renderTab 开头**(R2 自检条 3:单一入口,避免未来新增分支漏调;总表数据条 mountMini 复用同一注册表),杜绝勘察指出的 doRender 全量重建泄漏(`app.js:657,671`)。`window.echarts` 缺失时(如 node 测试、vendor 加载失败)**优雅降级**:容器内显示"图表库未加载"+保留 C9/C10 表格,不抛错——这也是 charts 渲染测试在 node 的运行路径。
3. **主题读 CSS 变量 + 跟随暗色**:`chartTheme()` 经 `getComputedStyle(document.documentElement)` 解析 `--c1..--c4/--border/--muted/--text/--panel` 实际色值(echarts canvas 解析不了 `var(--c1)`,现 `charts.js:42` 的 CSS 变量直填只对 SVG 有效);模块级一次性注册 `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { disposeAll(); if (T) T.render(); })`——`if (T)` 守卫必须(R1 建议 4):`charts.js:13` `let T = null` 在首次 renderTab/handleAct 经 tools() 注入前为 null,用户未进过图表页就切系统主题会抛 TypeError;`disposeAll()` 为模块级注册表操作可无条件执行。主题是媒体查询而非 data-theme 切换(`ledger.css:20-26`,index.html:2 的 `data-theme="day"` 未参与 CSS),变量变更后重渲染即全部换色(页内缓存使重渲染廉价)。
4. **resize**:每容器一个 `ResizeObserver` 触发 `chart.resize()`(覆盖 `.lg-chart-grid` 1040px 断点变单列,`ledger.css:133`)+ `window.resize` 兜底;dispose 时 disconnect。
5. **行为对齐清单(防回归)**:x 轴最多 12 个 label(抽稀);周粒度空桶间隙与 W00 口径维持现服务端"只返回非空桶"语义(脚注文案不变,`charts.js:217`);月粒度柱/点点击跳总表改用 `chart.on('click', params => rows[params.dataIndex].period)` 发既有 `ov-jump-month` 通道(`app.js:975-978` → `charts.js:407-414`,**data 携带原始 period**,`/^\d{4}-\d{2}$/` 校验与总表月份键不受 label 显示影响);回收率 >100% 与红冲负尖峰 tooltip 文案保留(`charts.js:233,268` 脚注)。
6. **手绘 SVG 死代码清除**(M2 内执行):
   - `charts.js`:删 `timeChartSvg`(92-158)、`hBarSvg`(161-177)、`emptySvg`(83-85);
   - `core.js`:删 `coord`(155)、`scaleLinear`(158-161)、`niceTicks`(164-173)、`linePath`(176-184)、`barRects`(187-195)、`groupedBarRects`(199-215)、`hBarRects`(218-224)及导出表中的对应名字(`core.js:230`;`coord` 本就未导出);core.js 其余(fmtYuan/monthKeys/csv*/overviewRow 等)各页共用,**不动**;
   - `ledger/css/ledger.css`:`svg.lg-chart` 四条规则(122-125)随之删除;`.lg-chart-grid/--in/.lg-gran/.lg-chart-foot/.lg-chart-legend`(119-132)保留复用。
   - 同步删除 `tests/ledger-core.test.js:126-178` 的 6 个 SVG 几何用例(scaleLinear/niceTicks/linePath/barRects/groupedBarRects/hBarRects)。
   - `tests/server/charts-render.test.js` 的 SVG 断言(91:`<svg class="lg-chart"`、120:`'2026-W13'` 上屏)随内核更换**重写**为:option 构建器断言(轴 label=人类格式且升序、yAxis 数量、formatter)+ renderTab 在无 echarts 环境的降级冒烟(容器/脚注/口径标注/无 NaN)+ handleAct 既有断言(105-114 gran-set/ov-jump-month 不变,原样保留)。C1 收入合计=summary.income_cents 的同源对账断言(84-88)原样保留。

### 2.3 人类可读轴 label(反馈①,服务端 M1 生成、前端 M1 换显、M2 进 option)

- **服务端**(`server/services/reports.js`,M1):新增纯函数 `periodLabel(period, granularity, period_start)`;`byPeriod` 的 `pl[]`/`work[]` 与 `adjustments` 的 `rows[]` 每行**追加** `label` 字段(只增字段,`reports.test.js:184-198` 的字段存在性断言不受影响,period 原值不变——`ov-jump-month` 校验、C7/C9 两轴按 period 键拼接、`_periodCache` 粒度缓存均依赖原始 key):
  - 月 `2026-01` → `1月`;季 `2026-Q1` → `Q1`;年 `2026` → `2026`;周 `2026-W05` → `W05(01-26)`(取 period_start 的 MM-DD,恰为 ask 示例式样;W00 同法)。
  - 歧义说明:跨年数据下 `1月` 在单轴可能重复——tooltip 首行恒为 `${label}(${period})`(人类优先、原始键在括号内),C9 表格期间单元格 title 悬浮原始键;当前数据 2026-01..05 单年,不触发。
- **前端**(M1,echarts 化之前的最小换显):`charts.js` 新增 `periodLabel(row)`(优先 `row.label`,缺失时前端按同规则兜底映射),替换 7 处 `row.period` 直接上屏点中的 **3 处显示位**:x 轴标签(`charts.js:153`)、C2 客户数 tag(`:250`)、C9 表格期间单元格(`:369`);**5 处 tooltip(231/248/266/282/341)首行改为 `${label}(${period})`**——原始键仍在 HTML 中,`tests/server/charts-render.test.js:95,120` 的 `'2026-'`/`'2026-W13'` 断言**零改动通过**。`data-month`/`data-gran` 等逻辑属性一律保持原始 period。

### 2.4 粒度按钮顺序(反馈④,M1)

`charts.js:27` `GRANS = [['month','月'],['week','周'],['quarter','季'],['year','年']]` → **`[['week','周'],['month','月'],['quarter','季'],['year','年']]`**(从小到大)。`granBtns`(47-51)按数组序渲染,六张时间卡(C1/C2/C3/C4/C7/C9)全部生效;默认粒度仍 `month`(`charts.js:28`);`tests/server/charts-render.test.js:92-93` 断言按钮总数 6×4=24,重序不影响。服务端白名单 `GRANULARITIES`(`reports.js:138`)仅校验用,顺序不动。

### 2.5 新增图表卡(M2,反馈⑥"图表页更详细版")

- **C11 地区收入占比**:`/api/reports/by-region`(§3.2)→ `buildPieOption` 环图 + 明细小表(地区/单数/收入/占比);`(未填)` 桶灰色并脚注"先在主数据补客户区域";village 级脚注提示"金桂村/金桂 疑似同村异写,占比会拆分"。
- **C12 飞手收入占比**:`/api/reports/by-operator`(§3.3)→ 饼图 + 小表(飞手/参与单数/均摊收入/占比);`未记录` 桶(62/104)灰色 + 脚注。
- C6 客户卡头部补"客户总数 N(启用)"(`GET /api/parties` 长度,`ledger.js:90-95`,实测 71)。
- 图表页布局:`.lg-chart-grid` 两列网格继续用;C11/C12 与 C5/C6/C8 同列级,页尾接 C9/C10。

---

## 3. B — 总表顶部数据条(反馈⑥,M2)

### 3.1 收支卡(默认当日,可切日月周季年)

- 状态:`state.bar = { gran: 'day', anchor: '<今天 YYYY-MM-DD>' }`(app.js state,`app.js:583` 处声明)。
- UI(`renderOverview` 返回串顶部,插在 `app.js:535` `return` 之后、第一个 `.lg-panel` 之前):一行 KPI 卡 `.lg-kpis`(新 CSS)——**收入/支出/利润** 三数值卡 + **作业单数/亩数/客户数** 三小卡 + 粒度按钮组 `日|周|月|季|年`(顺序从小到大,与 ④ 统一;默认 `日`)+ 锚点日期 `<input type="date">`(默认今天,改日期即切"具体某日/某周边/某月"——满足"也可以这里直接更改具体日月季年")。
- 取数:切档/改锚点 → 前端按 gran 计算 `[from,to]`(月/季/年=自然区间;**周须复刻服务端 %W 口径 `reports.js:146`**——周一始,年内首个周一前的日子归 W00,锚点落在该窗口时区间=当年 1 月 1 日..首个周一前一日,并在档位条旁脚注说明;若简单"取本周一",该窗口会落到上一年 12 月,KPI 条区间与图表周桶错位[R1 建议 10 采纳])→ `GET /api/reports/by-range?from&to` → 重渲染。写入 doRender overview 分支的 `Promise.all`(`app.js:656`)追加三个请求:by-range、by-region、by-operator,与 overview/payments 并行。
- 客户总数卡:复用 `Api.parties()`(轻量 71 行)或 by-range 返回的期间客户数,两者都显示("本期 X · 总数 71")。

### 3.2 数据条两张小图

- 地区收入占比环图 + 飞手收入占比饼图:固定高度容器 `.lg-chart-canvas`(新 CSS,显式 px 高),数据来自 §3.1 并行请求,经 `LedgerCharts.mountMini(scopeEl, {region, operator})`(charts.js 新导出,内部复用 buildPieOption + disposeAll 注册表)。
- 图表页的更详细版=C11/C12(§2.5)。

### 3.3 新端点(全部只读聚合,零迁移;金额 `_cents`)

| 端点 | 服务(新) | 口径(本会话实测数据) |
|---|---|---|
| `GET /api/reports/by-range?from=&to=` | `reports.byRange` | 收入/支出/利润=journal 轴(occurred_at 区间,复用 summary 表达式 `reports.js:20-28`);jobs_count/area_mu/customer_count=jobs 轴(job_date 区间,客户数=结算分项 party 去重,同 `reports.js:204-213`)。返回 `{from,to,income_cents,expense_cents,profit_cents,jobs_count,area_mu,customer_count}`。**不扩** GRANULARITIES 白名单(不加 'day' 桶语义,区间参数更通用) |
| `GET /api/reports/by-region?level=region\|village&from=&to=` | `reports.byRegion` | jobs→settlements(非void)→bills(非void)→parties 按 `b.party_id` 关联(**实测 104/104 全挂通**,bills.party_id 空 0 行;settlement_items.party_id 与 farmer_name 兜底路径同样 104/104,不需要)。group=`COALESCE(NULLIF(TRIM(p.region),''),'(未填)')`(village 级则 `region·village`);行 `{label,jobs_count,income_cents(Σbills.amount),share_pct}` 按收入降序;**`(未填)` 桶必须返回**(实测 63 单/6,388,100 分=63,881 元,占比诚实呈现) |
| `GET /api/reports/by-operator?from=&to=` | `reports.byOperator` | jobs(operator_names 非空数组)JSON.parse 展开逐人聚合;**收入按单内人数均摊**(income_cents/n,纯展示口径,不落库);`{rows:[{operator,jobs_count,income_cents}], unrecorded:{jobs_count,income_cents}, note}`;实测未记录 **62/104**(operator_names='[]'),多人单存在(如 `["李凌琦","沈鹏"]`) |

路由挂载:`server/routes/ledger.js` 报表段(122-136 之后)追加 3 个 GET;`api.js` 加便捷封装 `barRange/byRegion/byOperator`。

---

## 4. C — 表格 Excel 化(反馈③,M3)

### 4.1 机制(最小侵入三件套,业务逻辑零改动)

1. **`ledger/js/core.js` 新增纯函数(node:test 可测)**:`colwKey(tableKey)`(`'lg-colw:'+key`)、`parseColw(json, thCount)`(JSON 解析+列数校验,结构变更/超长即返回 null 丢弃旧值防错位)、`clampColw(px)`(48–800px)。DOM 无关。
2. **`ledger/js/app.js` 新增自包含列宽模块(IIFE 内,约 60 行)**:
   - `applyColWidths()`:遍历 `#lgMain table[data-colw]`,从 `localStorage[colwKey]` 读 `{列序:px}`,把 `<colgroup>` 插为 table 第一个子元素,并为有存档的表加 `lg-fixed`(开 `table-layout:fixed` 让拖宽精确生效;无存档的表完全维持现状,零回归)。
   - **拖拽**:`$main` 上一条一次性委托 `mousedown`(与既有 click/input/change 委托同构,`app.js:715-747`;全量重绘与 app-extra 直调重绘都不会丢监听):命中 `th[data-colw]` 右缘热区 → **先把全表当前渲染宽度快照进 colgroup 并加 `lg-fixed`**(从第一次拖拽起体验即 Excel 化)→ document 挂 mousemove(实时改 col 宽,clampColw)/mouseup(全部列宽写 localStorage 并移除监听,**再对当前表重放一次 applyColWidths()**——拖拽中恰逢重绘(如搜索防抖 250ms)时 mousemove 更新的是已脱离 DOM 的旧 col,存档不丢但本次可视宽丢失,重放兜底[R1 建议 5 采纳]);双击热区=清除该表存档回默认。
   - **明细插槽挂钩(R1-B3)**:`toggleDetailSlot`(`app.js:763-766`)改 promise 感知——`const r = loader(); if (r && r.then) r.then(() => applyColWidths()); else applyColWidths();` 一处覆盖 job-detail/st-detail/st-edit 三个入口(`app.js:829,849,853`):这三处异步向 detail slot 插表,doRender 尾部与 renderTab 尾部两个既有挂钩点都不会在明细展开后执行,否则存档列宽不回显而 th 拖拽手柄(按 `th[data-colw]` 类选择器出现)照常显示,状态自相矛盾。
   - 接线:`doRender` 末尾(`app.js:685` refreshSummary 之前)调 `applyColWidths()`;模块挂 `window.LedgerColWidths={apply}`,`T`(app.js:773-774)增 `applyColWidths` 供 app-extra 调。
3. **`ledger/js/app-extra.js`**:`LedgerExtra.renderTab` 返回链上统一挂钩——doRender 旁路的 **5 处**直调重绘(`app-extra.js:246,250,267,309,313`,行内编辑,全部经 `window.LedgerExtra.renderTab`)。注意 master 分支是 `renderMasterData().then(html => { $main.innerHTML = html; })`(`app-extra.js:409`)、import 分支是同步 innerHTML+`return loadImportBatches()`(`app-extra.js:406-408`),函数尾部同步调 apply 会早于 innerHTML 赋值,故写成 `Promise.resolve(done).then(() => T.applyColWidths())` 挂在返回链上。`loadImportRows/loadImportBatches` 只换 `tbody.innerHTML`(`app-extra.js:44,80`),colgroup 在表级**不受影响**,零改动。

### 4.2 逐文件改动

| 文件 | 改动 |
|---|---|
| `ledger/css/ledger.css` | ①`.lg-main max-width:1200px` → **1600px**(:48,勘察:总表可视宽仅 ≈1144px 是"太窄"根因);②`table.lg-table--wide min-width:1280px` → **1520px**(:115,R2 自检条 1:1600 下可视宽实算 1542=1600−32−26,min-width 1600 会在 ≥1600 视口仍留 58px 滚动,1520 恰≤1542 使 ≥1600 视口无滚动,列分布由 `width:100%` 拉伸兜底);③新增 `.lg-fixed{table-layout:fixed}`、`.lg-fixed td{overflow:hidden;text-overflow:ellipsis}`(fixed+nowrap 下拖窄列防长文本侵入邻列[R1 建议 5])、`th[data-colw]{position:relative}`、`.lg-colw-h`(th 右缘 8px 热区手柄,cursor:col-resize)、`.lg-kpis/.lg-kpi/.lg-chart-canvas`(M2 一起加);④**流式输入限定 `.lg-fixed` 作用域**(R1 建议 7):新增 `table.lg-fixed input[type=number], table.lg-fixed .lg-detail input, table.lg-fixed input.lg-inp { width:100%; min-width:0 }`;既有 `.lg-table--wide input[type=number]{width:96px}`(:116)与 `.lg-detail input{width:90px}`(:79)**原样保留**作非 fixed 基线——无存档表(不开 fixed)零回归 |
| `ledger/js/app.js` | L528 总表备注内联 `style="width:110px"` 与 L240 收款经手人 `style="width:70px"` 移除内联宽,改 `class="lg-inp"`(宽度交给 `.lg-fixed` 作用域规则,内联样式优先级最高、会压过作用域规则,必须摘除);新增列宽模块+applyColWidths 接线+toggleDetailSlot 挂钩(§4.1) |
| 各 renderX | ≥7 列的表 `<table>` 标签加 `data-colw="键"`(纯字符串改动;清单经本会话 node 逐表数 `<th>` 全量清点修正[R1 建议 6],共 **14 张**):`ov-main`(17 列,`app.js:539`)、`ov-pay`(7,`app.js:575`)、`bills`(8,`app.js:221`)、`receipts`(8,`app.js:271`)、`payments`(7,`app.js:331`)、`advances`(8,`app.js:374`)、`journal`(7,`app.js:422`)、工单主表(7,`app.js:67`)、`job-plots` 地块明细(8,`app.js:113`,**唯一进清单的明细表**——列数固定 8,依赖 toggleDetailSlot 挂钩回显)、`st-main` 结算主表(9,`app.js:149`)、报表·按作业盈利(7,`app.js:483`)、`charts-c9`(11 列,`charts.js:366`)、`master-parties`(9,`app-extra.js:168`)、`import-rows`(9,`app-extra.js:35`)。**明确不加**(≤6 列,清点实测):分成(5,`app.js:401`)、报表总览(4,`app.js:468`)、支出分类(2,`app.js:473`)、客户盈利(4,`app.js:478`)、分家明细(5-6,`app.js:116`,第 6 列 canEditLines 条件渲染、列数不稳)、结算分项(4,`app.js:177`)、结算明细账单(5,`app.js:181`)、C6 两表(4/3,`charts.js:308,311`)、C10 mini(3,`charts.js:383`)、导入批次(5,`app-extra.js:22`)、地块档案(5,`app-extra.js:181`)、化学品(5,`app-extra.js:187`) |
| `ledger/js/core.js` | §4.1-1 三个纯函数 + 导出 |
| `tests/ledger-core.test.js` | 增 parseColw 校验(列数不匹配丢弃/越界 clamp/坏 JSON)/clampColw 边界 |

### 4.3 明确不动(已源码核实 colgroup 无影响)

CSV 导出的 `tr.children` 遍历(`app.js:791`——col 元素不是 tr 子元素)、`bill-edit` 的 `row$.children[3]/[4]` 索引(`app.js:885`)、`bill-receive` 的 colspan 取 `thead tr`.children.length(`app.js:877`)、`collectInputs` 的 data-ekb/ekp/ek 通道(`app.js:749-762`)、tfoot colspan(`app.js:637-641`)。**Excel 化边界**:本轮交付列宽调节+记忆+页面加宽+输入适配;不做公式/排序/单元格选区(超范围,记遗留)。

---

## 5. D — 单价口径修复(反馈②,M1)

### 5.1 bootstrap 子查询修正(`server/routes/masterdata.js:128-134`)

现值(实读):`(SELECT l2.spray_fee_cents / l2.area_mu FROM job_settlement_lines l2 WHERE l2.job_id = j.id AND l2.area_mu > 0 LIMIT 1) AS price_yuan`——分/亩冒充元/亩,前端 `app-extra.js:105` 直接 `.toFixed(1)+'元/亩'` 上屏。替换为:

```sql
(SELECT COALESCE(l2.unit_price_cents, l2.spray_fee_cents / l2.area_mu) / 100.0
   FROM job_settlement_lines l2
  WHERE l2.job_id = j.id AND l2.kind = 'spray' AND l2.area_mu > 0
  ORDER BY l2.id LIMIT 1) AS price_yuan
```

三处修正:÷100.0 恢复元/亩;`kind='spray'` 排除 extra 行(extra 行 area 恒 NULL 当前不触发,防未来污染);`ORDER BY l2.id` 使 LIMIT 1 确定性(当前每作业仅 1 条带面积 spray 行,实测无行为差,属防御)。`COALESCE` 优先回填后的精确单价;计算器来源作业不写 unit_price_cents(`services/jobs.js:165` INSERT 无此列),自动落到 spray_fee/area。前端 `app-extra.js:105` **不改**(SQL 层修单位,避免两处 ÷100)。别名保留 `price_yuan`(名字从此名副其实)。`tests/server/masterdata.test.js:51-71` 只断言 `last_job` 存在,不断言价格值,零改动通过。

### 5.2 `server/db/backfill-009.js`(新,照 backfill-007.js 骨架)

- 编号说明:P4-PLAN §2.3 预留的 `backfill-008.js` **未交付**(`server/db/` 实测只有 backfill-007.js;jobs.purpose 实测 0/104 非空),ask 指名 backfill-009,**沿用 009**;purpose 回填记 P4 残留(§7)。
- 流程:①入口备份 `fs.copyFileSync(data/app.db → data/app.db.bak-009)`(已存在不覆盖,`backfill-007.js:122-127` 同款),**前置检查(R1 建议 9)**:`data/app.db-wal` 存在且非 0 字节即中止(exitCode=1,提示先运行 3-停止服务.bat)——007 只拷主库文件,WAL 非空时 .bak-009 不完整、恢复即丢数据;实施时可升级为 `VACUUM INTO` 或 better-sqlite3 `db.backup()` 在线备份(二选一,实施时定);②`initDb` 自动迁移;③事务内 UPDATE,两表同改(007 即两表同改的先例),**值按分支分别取整——两分支单位基准不同(R1-B1 修正)**:
  - `job_settlement_lines`:`WHERE kind='spray' AND unit_price_cents IS NULL`,值=`COALESCE(ROUND(json_extract(j.raw_json,'$.raw.price_yuan')*100), ROUND(l.spray_fee_cents/l.area_mu))`(经 settlements.job_id 关联)——raw 分支是**元**,×100 变分(与落库侧 `importExcel.js:495` `Math.round(Number(parsed.price_yuan) * 100)` 同基准);派生分支 `spray_fee_cents/area_mu` **本身就是分/亩(unit_price_cents 的目标单位),不得再 ×100**。本会话 sqlite 实跑演示:旧式 `ROUND(115000/50)*100 = 230000` 分 = **2300 元/亩**(放大 100 倍,恰是本方案所举 J20260301-01 的 fee=115000/area=50);修正式 raw=25 → 2500 分 = 25 元/亩、raw=NULL → 2300 分 = 23 元/亩。该分支当前在真库休眠(实测 104/104 作业全 `source='import'` 且 raw 覆盖 104/104),但 `settlements.js` 全文 **0 处** unit_price_cents(grep 实测)——计算器单结算行恒 NULL,兜底分支正是 §7.5 人群;且方案自带的 [500,10000] 分自检与旧公式直接矛盾(任何无 raw 行必炸);
  - `settlement_items`:同规则(经 settlement_id→settlements.job_id 关联)。实测现状:spray 行两表各 104/104 全 NULL;extra 行 4+4 已填(2500/2500/3000/3000)不动;回填源 `$.raw.price_yuan` 覆盖 **104/104**,分布 {30元:63, 25:33, 20:5, 35:2, 15:1} 全部合理。
- **金额断言**:回填前后各跑一次 `snapshotSums` 扩展版——007 的 9 个金额键(jobs income/cost/profit、bills amount/paid、receipts、payments、line_spray、journal_debit,`backfill-007.js:104-117`)必须分文不变,`unit_price_cents` 合计键**只记录不参与相等断言**(它就是要变的值),另断言"变更仅发生在先前为 NULL 的 spray 行"。**失败语义(R1 建议 9)**:[500,10000] 分区间自检在事务内 UPDATE 之后、commit 之前执行,失败即 throw → 事务自动回滚 → exitCode=1(库保持原状);金额基线断言在 commit 后执行,不一致 → exitCode=1 并指向备份(007:132-135 同款)。
- **warnings**:对 raw 单价与派生单价差 **>0.05 元**的作业出 warning 人工复核(R1-B2:与 §8 的 >0.005 口径同集;>0.5 元实测只有 2 单,会使 M1 验收 5 的"6 单清单"落空)——本会话按 >0.05 复跑恰 **6 单**,差值逐单:J20260301-01(raw 25 vs 派生 23.00,差 2.00;fee=115000/area=50)、J20260204-03(30 vs 32.00,差 2.00)、J20260305-02(15 vs 15.38,差 0.38)、J20260319-01(25 vs 25.26,差 0.26)、J20260401-01(30 vs 30.23,差 0.23)、J20260508-01(25 vs 25.09,差 0.09);成因=金额按未取整面积计算,以 raw 为权威。
- **幂等与自检**:`WHERE unit_price_cents IS NULL` 保证重跑 0 行;附自检:回填后断言全部 spray 行 unit_price_cents ∈ [500,10000] 分(5–100 元/亩;实测修正后 104 行全落 15–35 元)。
- 新导入路径已写 unit_price_cents(`importExcel.js:497-521` 实读确认),无需改;计算器来源靠 COALESCE 兜底。

### 5.3 修复后效果(实测口径)

修正 SQL 在真库拷贝验证:buggy 子查询 **104/104** 作业 >100(其中 103 个落 2000–5000 分/亩)→ 修正后 **104/104 落 15–35 元/亩、>100 元/亩 0 个**;主数据"最近作业"列显示 15.0/20.0/25.0/30.0/35.0 元/亩。

---

## 6. 里程碑切分(顺序实现,各自可独立发布)

### P5-M1 快修包 = D + 粒度按钮顺序 + 端点 label(反馈②④①的服务端与最小前端部分)

**改动清单**:`masterdata.js:130-131` 子查询替换(§5.1);`server/db/backfill-009.js` 新建+真库执行(§5.2);`reports.js` 增 `periodLabel` 纯函数并在 byPeriod pl[]/work[] 与 adjustments rows[] 追加 `label`(§2.3);`charts.js` GRANS 重排(§2.4)+ `periodLabel` 前端映射与 3 处显示位换显/5 处 tooltip 首行(§2.3);`tests/server/reports.test.js` 增 label 断言;`tests/server/masterdata.test.js` 增 last_job.price_yuan 合理区间断言;`tests/server/backfill-009.test.js` 新建(fixture 库仿 `tests/server/backfill.test.js`:freshDb 造 NULL 单价行+raw_json price_yuan → 断言回填值/金额基线不变/幂等重跑 0 行/区间自检/warning)。

**验收清单**:
1. 两条测试命令全绿:`cd server && node --test ../tests/server/`(61+新增)与 `node --test tests`(91,前端零改动通过——charts-render 的 `'2026-'`/`'2026-W13'` 断言依赖 tooltip 原始键,已核实不破)。
2. 主数据页"最近作业"列:各客户显示 15.0–35.0 元/亩,**无任何 >100 元/亩 值**(对照修复前 104/104 >100)。
3. 图表页粒度按钮每卡均为 `周|月|季|年` 序;点击切换/默认月/缓存行为不变。
4. 图表 x 轴与 C2 客户数 tag、C9 期间列显示 `1月/W05(01-26)/Q1/2026`;月粒度点柱仍正确跳总表当月(raw period 通道)。
5. backfill-009 报告:`lines_fixed=104, items_fixed=104, warnings` 含 6 单清单、`sums_unchanged=true`、备份 `data/app.db.bak-009` 存在;重跑输出 0 行变更。
6. 13 个页签逐一过一遍无回归(总表/图表/主数据为重点;任务文本写"12 页签",实测 index.html:17-29 为 13 个,R2 自检条 2)。

### P5-M2 图表重做 = A + B(反馈①⑤⑥完整版)

**改动清单**:echarts vendor 落库+index.html 引一行(§2.1);`charts.js` 内核重写(option 纯函数构建器/mount/disposeAll/theme/resize/降级,C1-C10 换 option、C11/C12 新增、`mountMini` 供总表,§2.2/2.5);`core.js` 删 7 个 SVG 死函数+导出;`ledger.css` 删 svg.lg-chart 规则、增 `.lg-chart-canvas/.lg-kpis/.lg-kpi`;`reports.js` 增 `byRange/byRegion/byOperator`,`ledger.js` 挂 3 路由,`api.js` 增封装;`app.js` overview 分支 Promise.all 追加三请求+数据条 DOM+mountMini、doRender 入口 disposeAll;测试:`tests/ledger-core.test.js` 删 6 个 SVG 用例、增 periodLabel/option 用例,`tests/server/charts-render.test.js` 重写为 option+降级冒烟(handleAct/对账断言保留),`tests/server/reports.test.js` 增 by-range/by-region/by-operator 用例(含均摊、未记录计数、(未填)桶、village 级)。

**验收清单**:
1. 两条测试命令全绿,总项目数 ≥152(删 6 增 N,N≥6,见 tradeoff)。
2. 图表页 12 张卡全部 echarts canvas 渲染;暗色模式切换即时换色;窗口缩放/断点单列切换图表 resize 无截断;月粒度点柱跳总表;周粒度空桶间隙与 W00 脚注保留;C8 导入零成本/两口径不可相加/回收率脚注齐全。
3. **零 CDN 硬验收**:DevTools Network 面板除本机 origin 外零请求;`grep -rEn "https?://|cdn\." ledger/ --include="*.js" --include="*.html" --include="*.css"` 除 vendor 文件内部注释外零新增命中(守门检查,写入实施步骤)。
4. 总表顶部数据条:默认当日收支(与 `/api/reports/summary?from=&to=` 同区间对账一致);切周/月/季/年与改锚点日期即刷新;地区环图含灰色 `(未填)` 桶(63,881.00 元/63 单,tooltip 注明"主数据补区域后消失");客户数卡=本期作业客户+总数 71;飞手饼图标注 `未记录 62/104`。
5. echarts vendor 加载失败(改坏文件名模拟)时页面不白屏:容器提示+表格卡可用(node 测试同路径)。
6. `node --test` 通过 = option 纯函数(轴 label 升序/人类格式、双 yAxis、formatter)无需浏览器即被断言。

### P5-M3 表格 Excel 化 = C(反馈③)

**改动清单**:§4.2 逐文件表(css:3 处尺寸调整+`.lg-fixed` 作用域新增类,96px/90px 基线保留;app.js 列宽模块+toggleDetailSlot 挂钩+两处内联宽改 `lg-inp` class;app-extra.js renderTab 返回链挂 apply;各 renderX 的 data-colw 属性——14 张清单;core.js 三纯函数;ledger-core.test.js 增列宽纯函数用例)。

**验收清单**:
1. 两条测试命令全绿(前端 +parseColw/clampColw 用例)。
2. 总表 17 列:th 右缘出现拖拽手柄,拖宽即时生效;刷新页面/切页签/搜索重渲染/月切换后列宽保持;不同表(`ov-main` vs `ov-pay` vs `charts-c9`)记忆互不串;双击手柄恢复默认;把列拖到 48px 下限不破版;拖窄列后长客户名/备注省略号截断、不侵入邻列(fixed+ellipsis)。
3. 旁路渲染列宽不丢:主数据页行内编辑(经 LedgerExtra.renderTab 直调重绘,5 处入口)后列宽仍在;导入页 tbody 局部刷新列宽仍在;**工单详情「地块明细」展开后存档列宽回显、可拖拽并记忆**(toggleDetailSlot 挂钩,R1-B3),收起再展开仍回显。
4. **≥1600 视口总表无横向滚动**(可视宽实算 1542 ≥ min-width 1520);1440 视口可视宽 1382 < 1520,保留按需横向滚动——窄屏以"拖列宽+存档记忆"为主要手段(实算见 R2 自检条 1);拖过宽(有 `.lg-fixed`)的表编辑态输入框随列宽伸缩,不再撑破列。
5. 回归专项:CSV 导出内容与列序不变;bill-edit 直填保存成功;总表"登记收款"表单展开正常;工单/结算明细展开正常;13 个页签全过。
6. **未拖过宽的表(无 localStorage 存档、无 `.lg-fixed`)渲染与 P5-M2 完全一致,含编辑态输入宽度**(流式输入规则限定 `.lg-fixed` 作用域,96px/90px 基线对无存档表原样生效——R1 建议 7 修订,消除原表述与输入框改流的矛盾)。

---

## 7. 风险与遗留

1. **vendor 体积** ~1.0MB:`/ledger` static `maxAge:0`(`server/index.js:76`)但有 ETag/304 重验证,局域网/本机可接受;不做服务端改动。
2. **月 label 跨年歧义**:`1月` 在跨年单轴可重复;tooltip 恒带原始键 `(2026-01)`;出现跨年数据时再升级为 `'YY年M月'`(记遗留,不预设)。
3. **地区数据质量**:37/71 客户 region 为空(63/104 单落 `(未填)` 桶)、village 存在"金桂村/金桂"异写会拆分占比——**数据问题用主数据编辑解决**,代码不做归一(不改数据);图表面板脚注引导补录。
4. **P4 残留(不在 P5 范围,建议 P4 补课)**:`backfill-008.js` 未交付→jobs.purpose 0/104 未回填(008 迁移本身已应用,新导入已写 purpose,`importExcel.js:488`);P4-PLAN §6-M1 计划的 `tests/server/p4-backfill.test.js` 同未交付。P5 的 backfill-009 只做单价,不顺带扩权。
5. **计算器来源作业单价**:无 raw price 亦无 unit_price_cents,bootstrap 走 spray_fee/area 派生兜底(实测 fixture 路径值合理);此类作业将来多农户时取首行(ORDER BY l2.id),记已知口径。
6. **Excel 化边界**:不做公式/排序/选区;`table-layout:fixed` 仅对有存档的表启用。
7. 打包链(勘察待确认项)已核实关闭:ledger 及 vendor 不进 APK/Cloudflare 包(§2.1),部署脚本零改动。

## 8. 本会话验证记录(方案依据,均已实跑)

- 测试基线:`cd server && node --test ../tests/server/` → **61 pass / 0 fail**;`node --test ../tests` → **91 pass / 0 fail**(前端);合计 **152 全绿**,与任务给定一致。
- 源码实读核对了三份勘察的全部关键行号(charts.js 27/47-51/64-77/92-158/150-154/161-177/205/250/369/400-415/417-418;core.js 155-224/230;app.js 489/491-548/535/651-687/715/724-747/782-805/874-885/996-1028;app-extra.js 105/246-313;index.html 37-41;ledger.css 48-53/79/115-116/119-133;masterdata.js 128-134;reports.js 138-149/163-225/234-270;overview.js 15-42/65-81;backfill-007.js 26-81/104-137;server/index.js 76-77;api.js 全文),与勘察一致;仅两处校准:ledger 静态托管实际在 `server/index.js:76-77`(勘察写 73-74),app.js:526 的 `ftQ` 已被 P4 改为 `ftQ-${tab}`(app.js:620),P4 断言依然成立。
- 零 CDN 复核(本会话实测):`grep -rEn "https?://|cdn\." ledger/` → **0 命中(exit 1)**;`sw.js:59` 放行 `/ledger`、ASSETS(L12)仅计算器文件。
- 打包链:`grep -ril ledger *.bat deploy scripts androidapp` → 命中 `1-启动服务并打开网页.bat`/`2-打开网页.bat`/`启动spraybook服务.bat`/`scripts/serve.ps1`;`scripts/build-apk.ps1:66-71`、`scripts/build-web.ps1:38-61` 复制清单不含 ledger;`test -d dist/ledger` → NO;`androidapp/app/src/main/assets/www/` 实测无 ledger → **ledger 不进 APK/Cloudflare 产物**。
- 真库探测(`cp data/app.db{-wal,} %TEMP%/spraybook-p5-probe/` + better-sqlite3 readonly,原库未写):jobs 104;`job_settlement_lines kind='spray'` 104 行 unit_price_cents **104 NULL**,extra 4 行已填 2500/2500/3000/3000;`settlement_items kind='spray'` 104 行 unit_price **104 NULL**;buggy 子查询 **104/104 >100 分/亩**(103 个落 2000-5000);修正 SQL(COALESCE unit_price/派生,÷100)**104/104 落 15-35 元/亩、>100 为 0**;`$.raw.price_yuan` 覆盖 104/104(30:63, 25:33, 20:5, 35:2, 15:1);raw vs 派生差 >0.005 元恰 **6 单**(J20260301-01 25vs23 最大);operator_names `'[]'` **62/104**,存在多人单 `["李凌琦","沈鹏"]`;客户 71(region 通安 21/彰冠 13/空 37);by-region 关联覆盖 bills.party_id / settlement_items.party_id / farmer_name 三路均 **104/104**,`(未填)` 桶=63 单/6,388,100 分;bills.amount 合计 10,117,010 分(与 P4 基线一致);schema_migrations 001–008 全应用;`server/db/` 无 backfill-008.js、jobs.purpose 0/104 非空(P4 残留证据)。
- echarts 下载可用性:`curl -sI https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js` → **200,Content-Length 1,034,102**;`curl -sI https://registry.npmmirror.com/echarts/-/echarts-5.6.0.tgz` → 302(镜像重定向,下载需 `-L`)。下载动作属 M2 实施步骤,本轮未落库。
- R1 评审复跑(同会话,均只读):①better-sqlite3 只读拷贝跑表达式——`ROUND(115000/50)` = 2300(分/亩),旧式 `ROUND(fee/area)*100` = 230000 分 = 2300 元/亩,修正式 `COALESCE(ROUND(raw*100), ROUND(fee/area))` raw=25 → 2500 分、raw=NULL → 2300 分;②warning 阈值——diff>0.5 元 = **2 单**(J20260301-01/J20260204-03 各 2.00 元),>0.05 元 = **6 单**(另 +0.38/0.26/0.23/0.09),与 >0.005 同集;③`grep -c unit_price_cents server/services/settlements.js` → **0 命中(exit 1)**,jobs 按 source 实测 104 全 'import';④`importExcel.js:495` 实读 `Math.round(Number(parsed.price_yuan) * 100)`(×100 仅属 raw 分支);⑤全表清点(node 脚本逐 `<table class="lg-table">` 数 `<th>`):app.js 18 张/charts.js 4 张/app-extra.js 5 张,≥7 列 14 张——§4.2 清单据此重列;⑥`toggleDetailSlot`(app.js:763-766)及三入口(app.js:829,849,853)、`LedgerExtra.renderTab` 两分支(app-extra.js:406-409,master 为 `renderMasterData().then(html=>…)`)、`charts.js:13` `let T = null` 均实读核实。
