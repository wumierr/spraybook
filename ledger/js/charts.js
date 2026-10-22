/* ============================================================
   ledger/js/charts.js — 图表页 = 可拖拽 dashboard（P10-R3，HANDOFF-P10-PLAN §3）
   vendor：/ledger/vendor/echarts.min.js（P5-M2）+ /vendor/gridstack/gridstack-all.js
   与 gridstack.min.css（P10-R3，GridStack 12.6.0 MIT，本地文件零 CDN；
   index.html 在本文件前引入）。GridStack 缺失/初始化失败 → 卡片静态堆叠降级
   （无拖拽缩放，所有按钮与图表照常可用）。

   卡模型（纯函数在 core.js）：{ id, type: 'C1'..'C12', title, state: { gran, quick, from, to } }
     gran  = by-period 桶粒度（周/月/季/年，仅时间轴卡显示切换按钮）
     quick/from/to = R2 同款日期区间（dateRangeOf 交集口径；两日期都填快捷置灰）
   布局/卡状态持久化 localStorage 'lg-grid-v1'（grid.save() + 卡状态）；
   市县筛选 'lg-charts-county'（P10-R1 county 参数贯通全部图表端点，默认全部）。

   内核复用：option 纯函数构建器（buildTimeOption/buildBarOption/buildPieOption）
   + 挂载层（mountScope/mountOne/disposeAll，实例注册表 + ResizeObserver）。
   每卡独立加载：各自 fetch 自己的端点+区间+county（同 URL 单次渲染内去重），
   单卡失败写卡内错误提示不拖累其它卡；GridStack resizestop/dragstop 触发
   全部实例 resize（ResizeObserver 兜底）；innerHTML 重建前 disposeAll 防泄漏。
   交互：card-gran/card-quick/card-del/card-add/card-add-type 由 app.js handleAct
   switch 转发到本文件；卡日期 change 走 app.js change 委托（data-card-date）；
   月粒度柱/点点击仍走 ov-jump-month 跳总表当月。
   降级：window.echarts 缺失时容器显示提示，表格卡与口径脚注照常，不抛错。
   ============================================================ */
(function () {
  'use strict';
  let T = null;              // app.js 注入的工具（esc/toast/render/Api/Core/state/switchNav）
  let cards = [];            // 当前卡数组（渲染与动作共用的模块态；每次 renderTab 从存档/默认重建）
  let layout = null;         // 已保存布局（grid.save() 派生 [{id,x,y,w,h}]；null=全部自动）
  let county = '';           // 市县筛选（''=全部）
  let addOpen = false;       // 「添加图表」弹层开关（页内瞬态）
  let grid = null;           // 当前 GridStack 实例（静态降级时为 null）
  let isGridMode = false;    // 本次渲染是否网格模式（异步 loadCard 写容器时用）
  let $scope = null;         // 本次渲染的 $main（loadCard 查卡容器用，兼容渲染桩）
  let memo = null;           // 单次渲染内同 URL 去重（每卡独立加载但同参数只 fetch 一次）

  /* echarts 实例注册表（总表数据条 mountMini 复用同一套，不另设第二注册表） */
  const _charts = new Map();    // el -> echarts instance
  const _observers = new Map(); // el -> ResizeObserver|null
  const FALLBACK_HTML = '<div class="lg-chart-fallback">图表库未加载（vendor/echarts.min.js 缺失或加载失败），表格数据不受影响</div>';

  const GRID_KEY = 'lg-grid-v1';
  const COUNTY_KEY = 'lg-charts-county';

  function tools() { T = window.__ledgerTools; return T; }
  function esc(s) { return T.esc(s); }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 隐私模式丢弃 */ } }
  function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 人类可读期间标签（显示层；period 原始键仍用于跳转/拼接/tooltip 括号）。
      优先服务端 label 字段，缺失时前端按同规则兜底映射（P5-M1 同款）。 */
  function periodLabel(row) {
    if (row && row.label) return String(row.label);
    const p = row && row.period != null ? String(row.period) : '';
    let m;
    if ((m = /^\d{4}-(\d{2})$/.exec(p))) return `${Number(m[1])}月`;
    if ((m = /^\d{4}-Q(\d)$/.exec(p))) return `Q${m[1]}`;
    if (/^\d{4}$/.test(p)) return p;
    if ((m = /^\d{4}-W(\d{2})$/.exec(p))) {
      const ps = row && typeof row.period_start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.period_start)
        ? row.period_start.slice(5, 10) : null;
      return ps ? `W${m[1]}(${ps})` : `W${m[1]}`;
    }
    return p;
  }

  /* ---------- 卡类型目录（默认布局=现有 C1–C12 三列；gran=时间轴卡才有周/月/季/年桶粒度） ---------- */
  const weekFoot = '周为周一始自然周（年内首个周一前的日子记 W00），期间以 period_start/end 为准。';
  const CARD_TYPES = {
    C1: { name: '收入 / 支出 / 利润', gran: true, h: 8,
      foot: '账簿确认口径（按凭证 occurred_at 分桶）；红冲不回溯历史期间，冲销当月可能出现负尖峰；导入单利润=收入。月粒度可点柱/点跳总表当月。' },
    C2: { name: '作业量：亩数 / 单数', gran: true, h: 8,
      foot: '作业执行口径（按 job_date 分桶）；客户数=结算分项挂客户去重数（tooltip）。' + weekFoot },
    C3: { name: '应收 / 实收 / 回收率', gran: true, h: 8,
      foot: '账单口径：按 bills.issued_at 分桶、非 void；回收率=实收/应收（分母 0 记 —），存在超收月份可 >100%。' + weekFoot },
    C4: { name: '抹零（少收）与超收', gran: true, h: 8,
      foot: '抹零=Σ|adjust|（正负均按优惠金额计）；超收=ΣMAX(0, paid−(amount−|adjust|))，手工收款路径禁止超收，此处只统计导入历史。' },
    C5: { name: '支出构成（账簿 5001-5007）', h: 8,
      foot: '账簿口径=支出付款凭证（现金时点）。与「作业成本构成」为两种统计对象，不可相加；市筛选下未挂客户的支出凭证不归属任何市县（显示为空属预期）。' },
    C6: { name: '客户 TOP10 收入 + 欠款/预收', h: 10,
      foot: 'include_all 口径：含期内无收入但有欠款/预收的客户（补零收入）。余额为时点值，不随粒度切换。' },
    C7: { name: '亩均收入 / 客单价', gran: true, h: 8,
      foot: '两条折线各自值域（非同一值域），看趋势与点值；=账簿收入 ÷ 作业轴亩数/单数（两轴按期间键拼接）。' },
    C8: { name: '作业成本构成', h: 8,
      foot: '作业归属口径=结算时成本快照（007）；导入单成本=0 属预期。与「支出构成」为两种统计对象（作业归属 vs 付款现金），不可相加。' },
    C9: { name: '环比增长总表', gran: true, h: 10,
      foot: '环比=对上一返回桶（首桶或上一桶为 0 时 —）；收入/支出/利润为账簿口径，单数/亩数为作业口径。' },
    C10: { name: '来源 / 收款人 / 作业人员 排行', h: 9,
      foot: '总表口径前端聚合（应收=Σ账单金额、实收=Σ账单已收）；导入历史来源/收款人/人员多为空（显示为 — 的不计入）。' },
    C11: { name: '地区收入占比', h: 11,
      foot: '收入=Σ账单金额（非 void），按客户主数据地区分桶；未填写桶照实呈现（先在主数据补客户区域即消失）。' },
    C12: { name: '飞手收入占比', h: 11,
      foot: '账单金额按作业人数均摊、每人计 1 单，纯展示口径不落库；未填写=operator_names 为空的作业（灰色桶，导入历史多属此类）。' }
  };
  /* 默认布局 = 现有图表页视觉顺序（C1–C8、C11、C12、C9、C10 的三列排布） */
  const DEFAULT_TYPES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C11', 'C12', 'C9', 'C10'];
  const QUICK_TEXT = { total: '总', day: '日', week: '周', month: '月', quarter: '季', year: '年' };
  const GRANS = [['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年']];
  const GRAN_TITLE = { week: '周', month: '月', quarter: '季', year: '年' };

  /* ---------- 存档读写 ---------- */
  function loadSaved() {
    const raw = lsGet(GRID_KEY);
    if (raw == null) return null; // 无档=首次使用 → 默认布局
    return T.Core.parseGridSave(raw, Object.keys(CARD_TYPES)); // 坏档 → null → 默认布局
  }
  function defaultCards() {
    return DEFAULT_TYPES.map((type, i) => ({
      id: i + 1, type, title: CARD_TYPES[type].name, state: T.Core.parseCardState(null)
    }));
  }
  /** 读当前网格布局（GridStack save(true) 只取 id/x/y/w/h；无网格时沿用上次布局） */
  function readGridLayout() {
    if (!grid) return layout;
    try {
      return (grid.save(true) || []).map(it => ({
        id: Number(it.id), x: Number.isInteger(it.x) ? it.x : null, y: Number.isInteger(it.y) ? it.y : null,
        w: Number(it.w) || 1, h: Number(it.h) || 1
      }));
    } catch (e) { return layout; }
  }
  function persist() {
    layout = readGridLayout();
    lsSet(GRID_KEY, JSON.stringify({ v: 1, cards, layout: layout || [] }));
  }
  function persistCounty() { lsSet(COUNTY_KEY, county); }

  /* ---------- 生效区间 / 查询串（qs=api.js 同一实现：空参数整体省略，绝不拼 from=&to=） ---------- */
  function qstr(params) { return T.Api.qs(params); }
  function rangeParams(s) {
    const r = T.Core.dateRangeOf(s.quick, s.from, s.to, todayStr());
    return r ? { from: r.from, to: r.to } : {};
  }
  function countyParams() { return county ? { county } : {}; }
  /** 单次渲染内同 URL 去重：每卡独立加载，但同参数端点（如 C1/C2/C7/C9 同粒度）只 fetch 一次 */
  function fetchOnce(url) {
    if (!memo) memo = new Map();
    if (!memo.has(url)) {
      memo.set(url, T.Api.get(url).catch(e => { memo.delete(url); throw e; }));
    }
    return memo.get(url);
  }

  /* ---------- 主题：读 ledger.css 变量实际色值（echarts canvas 解析不了 var(--c1)） ---------- */
  function chartTheme() {
    const css = name => {
      try {
        if (typeof document === 'undefined') return '';
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      } catch (e) { return ''; }
    };
    return {
      c1: css('--c1') || '#0e7c66',
      c2: css('--c2') || '#c0392b',
      c3: css('--c3') || '#b7791f',
      c4: css('--c4') || '#4a6fa5',
      text: css('--text') || '#1c2733',
      muted: css('--muted') || '#6b7a89',
      border: css('--border') || '#dde3e9',
      panel: css('--panel') || '#ffffff'
    };
  }

  /* ---------- 轴值格式化（分 → 紧凑元文本） ---------- */
  function fmtAxisYuan(cents) {
    const yuan = (Number(cents) || 0) / 100;
    const abs = Math.abs(yuan);
    if (abs >= 10000) return (Math.round(yuan / 1000) / 10) + '万';
    if (abs >= 1000) return Math.round(yuan).toLocaleString('zh-CN');
    if (abs >= 1) return String(Math.round(yuan * 10) / 10);
    return String(Math.round(yuan * 100) / 100);
  }
  function fmtAxisNum(v) {
    if (v == null) return '0';
    const abs = Math.abs(v);
    if (abs >= 10000) return (Math.round(v / 1000) / 10) + '万';
    return String(abs >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  }

  /* ============================================================
     option 纯函数构建器（不碰 DOM / echarts 实例，node:test 可测；
     tooltip/label formatter 以函数入参形式传入，echarts 运行时调用）
     ============================================================ */

  /**
   * 时间轴组合图：柱 0-2 条（共用左值域）+ 折线 0-2 条（各条自有值域 yAxis）。
   * rows: 期行数组（period/label + 各 series key）；bars:[{key,name,color}]；lines:[{key,name,color,fmt}]
   * tip: (row)=>string（tooltip 首行 = `${label}(${period})`，原始键在括号内）
   * x 轴 label=人类可读 label（服务端 label 字段 / 前端 periodLabel 兜底），n>12 抽稀。
   */
  function buildTimeOption({ rows = [], bars = [], lines = [], colors = {}, yFmt = fmtAxisYuan, tip }) {
    const n = rows.length;
    const yAxes = [];
    const series = [];
    if (bars.length) {
      yAxes.push({
        type: 'value',
        axisLabel: { color: colors.muted, formatter: yFmt },
        splitLine: { lineStyle: { color: colors.border } },
        axisLine: { show: false }
      });
      for (const b of bars) {
        series.push({
          name: b.name, type: 'bar', yAxisIndex: 0, barMaxWidth: 26,
          data: rows.map(r => (r[b.key] == null ? 0 : Number(r[b.key]))),
          itemStyle: { color: b.color, borderRadius: [2, 2, 0, 0] }
        });
      }
    }
    for (const ln of lines) {
      yAxes.push({
        type: 'value', scale: true,
        axisLabel: { color: ln.color, formatter: ln.fmt || yFmt },
        splitLine: { show: false },
        axisLine: { show: false }
      });
      series.push({
        name: ln.name, type: 'line', yAxisIndex: yAxes.length - 1,
        data: rows.map(r => (r[ln.key] == null ? null : Number(r[ln.key]))),
        itemStyle: { color: ln.color }, lineStyle: { color: ln.color, width: 2 },
        symbol: 'circle', symbolSize: 6, connectNulls: false
      });
    }
    const tooltip = { trigger: 'axis', confine: true };
    if (tip) {
      tooltip.formatter = params => {
        const p0 = Array.isArray(params) ? params[0] : params;
        const row = rows[p0 && p0.dataIndex];
        return row ? tip(row) : '';
      };
    }
    return {
      animation: false,
      grid: { left: 8, right: 8, top: 20, bottom: 4, containLabel: true },
      tooltip,
      xAxis: {
        type: 'category', data: rows.map(r => periodLabel(r)),
        axisLabel: { color: colors.muted, interval: Math.max(0, Math.ceil(n / 12) - 1), hideOverlap: true },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false }
      },
      yAxis: yAxes.length ? yAxes : [{ type: 'value', axisLabel: { show: false }, splitLine: { show: false }, axisLine: { show: false } }],
      series
    };
  }

  /**
   * 横向条形（支出构成 / 客户 TOP / 成本构成）：
   * items:[{label,v,tip,color}]；yAxis category=名字（客户/科目名），值 label 在右。
   */
  function buildBarOption({ items = [], valFmt = fmtAxisYuan, colors = {}, color }) {
    return {
      animation: false,
      grid: { left: 8, right: 74, top: 6, bottom: 6, containLabel: true },
      tooltip: { trigger: 'item', confine: true, formatter: p => (items[p.dataIndex] && items[p.dataIndex].tip) || '' },
      xAxis: {
        type: 'value',
        axisLabel: { color: colors.muted, formatter: valFmt },
        splitLine: { lineStyle: { color: colors.border } },
        axisLine: { show: false }
      },
      yAxis: {
        type: 'category', data: items.map(it => String(it.label)), inverse: true,
        axisLabel: { color: colors.text, width: 108, overflow: 'truncate' },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false }
      },
      series: [{
        type: 'bar', barMaxWidth: 16,
        data: items.map(it => ({ value: it.v == null ? 0 : it.v, itemStyle: { color: it.color || color || colors.c1 } })),
        label: { show: true, position: 'right', color: colors.muted, formatter: p => valFmt(p.value) }
      }]
    };
  }

  /** 环图/饼图（C11 地区 / C12 飞手 / 总表数据条共用）：
      items:[{label,v,color?}]；(未填)/未记录 由调用方给灰色，其余按调色板轮转。 */
  const PIE_EXTRAS = ['#7e6bc4', '#4f9dd8', '#d89a4f', '#7cb35c', '#c96a9b', '#54b8ae'];
  function buildPieOption({ items = [], valFmt = fmtAxisYuan, donut = false, colors = {}, center = ['38%', '50%'] }) {
    const palette = [colors.c1, colors.c4, colors.c3, colors.c2].concat(PIE_EXTRAS);
    const opt = {
      animation: false,
      tooltip: { trigger: 'item', confine: true, formatter: p => `${p.name} ${valFmt(p.value)} 元（${p.percent}%）` },
      series: [{
        type: 'pie',
        radius: donut ? ['42%', '68%'] : '68%',
        center,
        avoidLabelOverlap: true,
        data: items.map((it, i) => ({
          name: String(it.label),
          value: it.v == null ? 0 : it.v,
          itemStyle: { color: it.color || palette[i % palette.length] }
        })),
        label: { show: false },
        labelLine: { show: false }
      }]
    };
    if (!items.length) {
      opt.title = { text: '暂无数据', left: 'center', top: 'middle', textStyle: { color: colors.muted, fontSize: 12, fontWeight: 'normal' } };
    } else if (items.length <= 6) {
      opt.legend = {
        orient: 'vertical', right: 2, top: 'middle', itemWidth: 10, itemHeight: 10,
        textStyle: { color: colors.muted, fontSize: 11 },
        formatter: name => (name.length > 9 ? name.slice(0, 9) + '…' : name)
      };
    }
    return opt;
  }

  /* ---------- 挂载层：实例注册表 / resize / 降级 ---------- */
  function watchResize(el, chart) {
    let ro = null;
    try {
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => { if (!chart.isDisposed()) chart.resize(); });
        ro.observe(el);
      }
    } catch (e) { ro = null; }
    _observers.set(el, ro);
  }
  function mountOne(el, def) {
    if (!el) return null;
    const E = (typeof window !== 'undefined') ? window.echarts : null;
    if (!E) { el.innerHTML = FALLBACK_HTML; return null; } // 降级：vendor 未加载
    let chart = _charts.get(el);
    if (!chart || chart.isDisposed()) {
      chart = E.init(el);
      _charts.set(el, chart);
      watchResize(el, chart);
    }
    chart.setOption(def.option, true);
    chart.off('click');
    if (def.onClick) chart.on('click', def.onClick);
    return chart;
  }
  function mountScope(scopeEl, defs) {
    if (!scopeEl || typeof scopeEl.querySelectorAll !== 'function') return;
    for (const key of Object.keys(defs || {})) {
      mountOne(scopeEl.querySelector(`[data-chart="${key}"]`), defs[key]);
    }
  }
  /** doRender 开头 / renderTab 开头统一调用（单一入口防泄漏；dashboard 重建前同此） */
  function disposeAll() {
    for (const chart of _charts.values()) { try { chart.dispose(); } catch (e) { /* 已释放 */ } }
    _charts.clear();
    for (const ro of _observers.values()) { try { if (ro) ro.disconnect(); } catch (e) { /* 忽略 */ } }
    _observers.clear();
  }
  /** GridStack resizestop/dragstop 后统一 resize（ResizeObserver 的显式兜底） */
  function resizeAll() {
    for (const c of _charts.values()) { try { if (!c.isDisposed()) c.resize(); } catch (e) { /* 忽略 */ } }
  }

  /* 主题切换（系统暗色）→ 重渲染全部换色；T 可能未注入（未进过图表页），必须守卫 */
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onTheme = () => {
        disposeAll();
        if (T && typeof T.render === 'function') T.render().catch(() => {});
      };
      if (mq.addEventListener) mq.addEventListener('change', onTheme);
      else if (mq.addListener) mq.addListener(onTheme);
    } catch (e) { /* 无 matchMedia 环境（node） */ }
  }
  /* 窗口缩放兜底（ResizeObserver 覆盖断点单列切换，此处兜老浏览器） */
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', resizeAll);
  }

  /* ---------- 总表数据条小图（P5-M2 §3.2，app.js overview 分支调用） ---------- */
  function regionItems(region, theme) {
    return ((region && region.rows) || []).map(r => ({
      label: r.label, v: r.income_cents,
      color: r.label === '未填写' ? theme.muted : null
    }));
  }
  function operatorItems(operator, theme) {
    const items = ((operator && operator.rows) || []).map(r => ({ label: r.operator, v: r.income_cents }));
    if (operator && operator.unrecorded && operator.unrecorded.income_cents > 0) {
      items.push({
        label: `未填写(${operator.unrecorded.jobs_count}单)`,
        v: operator.unrecorded.income_cents,
        color: theme.muted
      });
    }
    return items;
  }
  function mountMini(scopeEl, { region, operator } = {}) {
    if (!scopeEl || typeof scopeEl.querySelectorAll !== 'function') return;
    const theme = chartTheme();
    const yuanTxt = cents => `${T.Core.fmtYuan(cents)} 元`;
    mountScope(scopeEl, {
      'bar-region': {
        option: buildPieOption({
          items: regionItems(region, theme), donut: true, colors: theme,
          center: ['30%', '50%'], valFmt: yuanTxt
        })
      },
      'bar-operator': {
        option: buildPieOption({
          items: operatorItems(operator, theme), donut: false, colors: theme,
          center: ['30%', '50%'], valFmt: yuanTxt
        })
      }
    });
  }

  /* ---------- 跳总表当月（月粒度柱/点点击，raw period 通道不变） ---------- */
  function jumpMonth(m) {
    if (!/^\d{4}-\d{2}$/.test(m)) { T.toast('仅月粒度支持跳转总表', true); return; }
    T.state.month.overview = m;
    T.state.tab = 'overview';
    T.switchNav('overview');
    T.render().catch(e => T.toast(e.message, true));
  }
  function rowClick(rows) {
    return params => {
      const row = rows && rows[params && params.dataIndex];
      if (row && row.period) jumpMonth(String(row.period));
    };
  }

  /* ---------- 粒度行标签 / 环比文本 ---------- */
  function pctText(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v + '%'; }
  function yuan(cents) { return T.Core.fmtYuan(cents); }

  /* ---------- C10：overview 前端聚合排行 ---------- */
  function parseOps(raw) {
    try { return JSON.parse(raw || '[]'); } catch (e) { return []; }
  }
  function topAgg(rows, keysOf, centsOf, topN = 5) {
    const m = new Map();
    for (const r of rows) {
      for (const k of keysOf(r)) {
        if (!k) continue;
        const e = m.get(k) || { label: k, count: 0, cents: 0 };
        e.count += 1; e.cents += centsOf(r) || 0;
        m.set(k, e);
      }
    }
    return [...m.values()].sort((a, b) => b.cents - a.cents).slice(0, topN);
  }

  /* ============================================================
     dashboard 渲染
     ============================================================ */

  function cardById(id) { return cards.find(c => c.id === id) || null; }

  /** 图表容器（网格模式高度交给 flex 撑满卡体；静态模式给显式像素高度） */
  function canvasHtml(cardId, hPx, hasData) {
    if (!hasData) return '<div class="lg-chart-empty">暂无数据</div>';
    const h = isGridMode ? '100%' : `${hPx}px`;
    return `<div class="lg-chart-canvas" data-chart="c${cardId}" style="height:${h}"></div>`;
  }
  const barH = items => Math.max(150, Math.min(340, (items ? items.length : 0) * 30 + 30));

  /** 卡头控件：桶粒度行（时间轴卡）+ R2 同款快捷/两日期行（Core.barUiOf 单一口径置灰） */
  function cardCtrls(c) {
    const s = c.state;
    const ui = T.Core.barUiOf(s, todayStr());
    const granRow = CARD_TYPES[c.type] && CARD_TYPES[c.type].gran
      ? `<div class="lg-gran">${GRANS.map(([v, t]) =>
          `<button class="lg-btn ${s.gran === v ? 'primary' : ''}" data-act="card-gran" data-card="${c.id}" data-gran="${v}">${t}</button>`).join('')}</div>`
      : '';
    const quickBtns = T.Core.BAR_QUICKS.map(k =>
      `<button class="lg-btn ${ui.quick === k ? 'primary' : ''}" data-act="card-quick" data-card="${c.id}" data-quick="${k}"${ui.locked ? ' disabled title="两个日期都填时按所选区间统计；清空任一侧恢复快捷"' : ''}>${QUICK_TEXT[k]}</button>`).join('');
    return `${granRow}
      <div class="lg-gran">${quickBtns}</div>
      <span class="lg-bardates">
        <input type="date" data-card="${c.id}" data-card-date="from" value="${esc(s.from)}" title="老日期（起始；可空=不设限）" aria-label="卡${c.id}起始日期">
        <span>——</span>
        <input type="date" data-card="${c.id}" data-card-date="to" value="${esc(s.to)}" title="新日期（截止；可空=不设限）" aria-label="卡${c.id}截止日期">
      </span>`;
  }

  /** 卡片骨架（数据加载前渲染；body 由 loadCard 异步写回） */
  function cardShellHtml(c, gridMode) {
    const def = CARD_TYPES[c.type] || {};
    const panel = `<div class="lg-panel lg-chart-card" data-card-panel="${c.id}">
      <div class="lg-card-head">
        <h2 class="lg-card-title" title="${esc(c.type)}">${esc(c.title || def.name || c.type)}</h2>
        <button class="lg-btn lg-card-del" data-act="card-del" data-card="${c.id}" title="删除此图表卡（可用「添加图表」重新加入）">🗑</button>
      </div>
      <div class="lg-card-ctrls">${cardCtrls(c)}</div>
      <div class="lg-card-body" data-card-body="${c.id}"><div class="lg-chart-empty">加载中…</div></div>
      ${def.foot ? `<div class="lg-chart-foot">${def.foot}</div>` : ''}
    </div>`;
    if (!gridMode) return panel;
    const saved = (layout || []).find(l => l.id === c.id) || {};
    const w = Number.isInteger(saved.w) ? saved.w : 1;              // 存档 w（gridLayoutOf 已夹 1..列数）
    const h = Number.isInteger(saved.h) ? saved.h : (def.h || 8);   // 存档 h，无存档按卡型默认
    const pos = (Number.isInteger(saved.x) && Number.isInteger(saved.y)) ? ` gs-x="${saved.x}" gs-y="${saved.y}"` : '';
    return `<div class="grid-stack-item" gs-id="${c.id}" gs-w="${w}" gs-h="${h}"${pos}>
      <div class="grid-stack-item-content">${panel}</div></div>`;
  }

  /** 页顶工具条：市筛选下拉（P10-R1 county 参数）+ 添加图表弹层 */
  function toolbarHtml(partiesAll, hintOverride) {
    const set = new Set();
    for (const p of partiesAll || []) { if (p && p.county) set.add(String(p.county)); }
    if (county && !set.has(county)) set.add(county); // 筛选值失效时仍显示（防静默清空）
    const opts = [...set].sort().map(c =>
      `<option value="${esc(c)}"${c === county ? ' selected' : ''}>${esc(c)}</option>`).join('');
    const addLayer = addOpen
      ? `<div class="lg-add-layer">${Object.keys(CARD_TYPES).map(k =>
          `<button class="lg-btn" data-act="card-add-type" data-type="${k}">${k} ${esc(CARD_TYPES[k].name)}</button>`).join('')}</div>`
      : '';
    const hint = hintOverride || (isGridMode
      ? '拖拽卡片换位 · 拉右下角缩放 · 布局自动保存（lg-grid-v1）'
      : 'GridStack 未加载（vendor/gridstack/），已降级静态堆叠：无拖拽缩放，其余功能照常');
    return `<div class="lg-chart-tools">
      <label class="lg-ct-county">市
        <select id="chartCounty" title="按客户市县过滤本页所有图表卡（空=全部）">
          <option value="">全部</option>${opts}
        </select>
      </label>
      <span class="lg-ct-addwrap">
        <button class="lg-btn primary" data-act="card-add">➕ 添加图表</button>
        ${addLayer}
      </span>
      <span class="lg-ct-hint">${hint}</span>
    </div>`;
  }

  /* ---------- 每卡数据加载（独立 fetch + 独立错误边界） ---------- */
  async function cardData(c) {
    const s = c.state;
    const qp = { ...rangeParams(s), ...countyParams() };
    switch (c.type) {
      case 'C1': case 'C2': {
        const d = await fetchOnce('/api/reports/by-period' + qstr({ granularity: s.gran, ...qp }));
        return c.type === 'C1' ? d.pl : d.work;
      }
      case 'C7': case 'C9':
        return fetchOnce('/api/reports/by-period' + qstr({ granularity: s.gran, ...qp }));
      case 'C3': case 'C4': {
        const d = await fetchOnce('/api/reports/adjustments' + qstr({ granularity: s.gran, ...qp }));
        return d.rows;
      }
      case 'C5': return fetchOnce('/api/reports/cost-breakdown' + qstr({ source: 'journal', ...qp }));
      case 'C8': return fetchOnce('/api/reports/cost-breakdown' + qstr({ source: 'job', ...qp }));
      case 'C6': return fetchOnce('/api/reports/by-customer' + qstr({ include_all: 1, ...qp }));
      case 'C10': {
        const d = await fetchOnce('/api/overview' + qstr(qp));
        return d.rows || [];
      }
      case 'C11': return fetchOnce('/api/reports/by-region' + qstr({ level: 'region', ...qp }));
      case 'C12': return fetchOnce('/api/reports/by-operator' + qstr(qp));
      default: return null;
    }
  }

  /** 卡体内容：复用既有 option 构建器；data-chart 键按卡 id 唯一（同型卡可并存） */
  function cardRender(c, data) {
    if (!$scope) return;
    const body = $scope.querySelector(`[data-card-body="${c.id}"]`);
    if (!body) return;
    const theme = chartTheme();
    const isMonth = c.state.gran === 'month';
    const pctTd = v => `<td class="num">${v == null ? '—' : (v > 0 ? '+' : '') + v + '%'}</td>`;
    let html = '';
    let option = null, onClick = null;

    switch (c.type) {
      case 'C1': {
        const rows = data || [];
        html = canvasHtml(c.id, 260, rows.length);
        option = buildTimeOption({
          rows,
          bars: [{ key: 'income_cents', name: '收入', color: theme.c1 }, { key: 'expense_cents', name: '支出', color: theme.c2 }],
          lines: [{ key: 'profit_cents', name: '利润', color: theme.c3, fmt: fmtAxisYuan }],
          colors: theme, yFmt: fmtAxisYuan,
          tip: r => `${periodLabel(r)}(${r.period})\n收入 ${yuan(r.income_cents)} 元\n支出 ${yuan(r.expense_cents)} 元\n利润 ${yuan(r.profit_cents)} 元`
        });
        onClick = isMonth ? rowClick(rows) : null;
        break;
      }
      case 'C2': {
        const rows = data || [];
        html = canvasHtml(c.id, 260, rows.length);
        option = buildTimeOption({
          rows,
          bars: [{ key: 'area_mu', name: '亩数', color: theme.c1 }],
          lines: [{ key: 'jobs_count', name: '单数', color: theme.c3, fmt: fmtAxisNum }],
          colors: theme, yFmt: fmtAxisNum,
          tip: r => `${periodLabel(r)}(${r.period})\n单数 ${r.jobs_count}\n亩数 ${r.area_mu}\n客户数 ${r.customer_count}`
        });
        onClick = isMonth ? rowClick(rows) : null;
        break;
      }
      case 'C3': case 'C4': {
        const rows = data || [];
        html = canvasHtml(c.id, 260, rows.length);
        option = c.type === 'C3'
          ? buildTimeOption({
            rows,
            bars: [{ key: 'billed_cents', name: '应收', color: theme.c1 }, { key: 'collected_cents', name: '实收', color: theme.c2 }],
            lines: [{ key: 'collection_rate', name: '回收率%', color: theme.c4, fmt: v => v + '%' }],
            colors: theme, yFmt: fmtAxisYuan,
            tip: r => `${periodLabel(r)}(${r.period})\n应收 ${yuan(r.billed_cents)} 元\n实收 ${yuan(r.collected_cents)} 元\n回收率 ${r.collection_rate == null ? '—' : r.collection_rate + '%'}\n未收 ${yuan(r.due_cents)} 元`
          })
          : buildTimeOption({
            rows,
            bars: [{ key: 'discount_cents', name: '抹零', color: theme.c3 }, { key: 'overpaid_cents', name: '超收', color: theme.c2 }],
            lines: [],
            colors: theme, yFmt: fmtAxisYuan,
            tip: r => `${periodLabel(r)}(${r.period})\n抹零 ${yuan(r.discount_cents)} 元\n超收 ${yuan(r.overpaid_cents)} 元\n未收 ${yuan(r.due_cents)} 元`
          });
        onClick = isMonth ? rowClick(rows) : null;
        break;
      }
      case 'C5': {
        const d = data || { items: [], total_cents: 0 };
        const items = (d.items || []).map(x => ({ label: `${x.code} ${x.name}`, v: x.cents, tip: `${x.code} ${x.name}：${yuan(x.cents)} 元` }));
        html = `<div class="lg-chart-sub">合计 <b>${yuan(d.total_cents)}</b> 元</div>` + canvasHtml(c.id, barH(items), items.length);
        option = buildBarOption({ items, colors: theme });
        break;
      }
      case 'C6': {
        const list = [...(data || [])].sort((a, b) => b.income_cents - a.income_cents);
        const top10 = list.slice(0, 10);
        const debtors = list.filter(x => x.receivable_cents > 0).sort((a, b) => b.receivable_cents - a.receivable_cents).slice(0, 5);
        const items = top10.map(x => ({ label: x.name || '—', v: x.income_cents, tip: `${x.name || '—'}：收入 ${yuan(x.income_cents)} 元 · 欠款 ${yuan(x.receivable_cents)} 元 · 预收 ${yuan(x.prepaid_cents)} 元` }));
        html = canvasHtml(c.id, barH(items), items.length) +
          `<table class="lg-table" data-colw="charts-c6"><thead><tr><th>客户</th><th>累计收入(元)</th><th>欠款(元)</th><th>预收余额(元)</th></tr></thead><tbody>${
            top10.map(x => `<tr><td>${esc(x.name || '—')}</td><td class="num">${yuan(x.income_cents)}</td><td class="num">${yuan(x.receivable_cents)}</td><td class="num">${yuan(x.prepaid_cents)}</td></tr>`).join('')
          }</tbody></table>` +
          (debtors.length ? `<table class="lg-table" style="margin-top:8px" data-colw="charts-c6debt"><thead><tr><th>欠款 TOP5</th><th>欠款(元)</th><th>预收余额(元)</th></tr></thead><tbody>${
            debtors.map(x => `<tr><td>${esc(x.name || '—')}</td><td class="num">${yuan(x.receivable_cents)}</td><td class="num">${yuan(x.prepaid_cents)}</td></tr>`).join('')
          }</tbody></table>` : '');
        option = buildBarOption({ items, colors: theme });
        break;
      }
      case 'C7': {
        const plU = (data && data.pl) || [];
        const wMap = new Map(((data && data.work) || []).map(r => [r.period, r]));
        const rows = plU.map(p => {
          const w = wMap.get(p.period);
          return {
            period: p.period, label: p.label,
            perMu: w && w.area_mu > 0 ? Math.round(p.income_cents / w.area_mu) : null,
            perJob: w && w.jobs_count > 0 ? Math.round(p.income_cents / w.jobs_count) : null
          };
        });
        html = canvasHtml(c.id, 260, rows.length);
        option = buildTimeOption({
          rows, bars: [],
          lines: [
            { key: 'perMu', name: '亩均收入', color: theme.c1, fmt: fmtAxisYuan },
            { key: 'perJob', name: '客单价', color: theme.c3, fmt: fmtAxisYuan }
          ],
          colors: theme, yFmt: fmtAxisYuan,
          tip: r => `${periodLabel(r)}(${r.period})\n亩均 ${r.perMu == null ? '—' : yuan(r.perMu)} 元/亩\n客单价 ${r.perJob == null ? '—' : yuan(r.perJob)} 元/单`
        });
        onClick = isMonth ? rowClick(rows) : null;
        break;
      }
      case 'C8': {
        const d = data || { items: [], total_cents: 0, calculator_only_cents: 0, import_zero_note: '' };
        const items = (d.items || []).map(x => ({ label: x.name, v: x.cents, color: theme.c2, tip: `${x.name}：${yuan(x.cents)} 元` }));
        html = `<div class="lg-chart-sub">${esc(d.import_zero_note || '')} 合计 <b>${yuan(d.total_cents)}</b> 元，其中计算器单 ${yuan(d.calculator_only_cents)} 元</div>`
          + canvasHtml(c.id, barH(items), items.length);
        option = buildBarOption({ items, colors: theme });
        break;
      }
      case 'C9': {
        const plP = (data && data.pl) || [];
        const wPMap = new Map(((data && data.work) || []).map(r => [r.period, r]));
        const rows = plP.map(p => {
          const w = wPMap.get(p.period) || {};
          return { ...p, jobs_count: w.jobs_count ?? null, jobs_pct: w.jobs_pct ?? null, area_mu: w.area_mu ?? null, area_pct: w.area_pct ?? null };
        });
        html = `<table class="lg-table" data-colw="charts-c9"><thead><tr>
            <th>期间</th><th>收入(元)</th><th>环比</th><th>支出(元)</th><th>环比</th><th>利润(元)</th><th>环比</th><th>单数</th><th>环比</th><th>亩数</th><th>环比</th>
          </tr></thead><tbody>${rows.length ? rows.map(r => `<tr>
            <td title="${esc(r.period)}">${esc(periodLabel(r))}</td>
            <td class="num">${yuan(r.income_cents)}</td>${pctTd(r.income_pct)}
            <td class="num">${yuan(r.expense_cents)}</td>${pctTd(r.expense_pct)}
            <td class="num"><b>${yuan(r.profit_cents)}</b></td>${pctTd(r.profit_pct)}
            <td class="num">${r.jobs_count ?? '—'}</td>${pctTd(r.jobs_pct)}
            <td class="num">${r.area_mu ?? '—'}</td>${pctTd(r.area_pct)}
          </tr>`).join('') : '<tr><td colspan="11">暂无数据</td></tr>'}</tbody></table>`;
        break;
      }
      case 'C10': {
        const rows = data || [];
        const miniTable = (head, list, centsLabel, key) => `<table class="lg-table" data-colw="${key}"><thead><tr><th>${esc(head)}</th><th>单数</th><th>${esc(centsLabel)}(元)</th></tr></thead><tbody>${
          list.length ? list.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${r.count}</td><td class="num">${yuan(r.cents)}</td></tr>`).join('') : '<tr><td colspan="3">暂无</td></tr>'
        }</tbody></table>`;
        html = `<div class="lg-chart-grid lg-chart-grid--in">
          ${miniTable('业务来源', topAgg(rows, r => [r.referral_name], r => r.amount_cents), '应收', 'charts-c10-src')}
          ${miniTable('收款人', topAgg(rows, r => [r.collector_name], r => r.paid_cents), '实收', 'charts-c10-col')}
          ${miniTable('作业人员', topAgg(rows, r => parseOps(r.operator_names), r => r.amount_cents), '应收', 'charts-c10-op')}
        </div>`;
        break;
      }
      case 'C11': {
        const rows = (data && data.rows) || [];
        html = canvasHtml(c.id, 200, rows.length) +
          `<table class="lg-table" data-colw="charts-c11"><thead><tr><th>地区</th><th>单数</th><th>收入(元)</th><th>占比</th></tr></thead><tbody>${
            rows.length ? rows.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${r.jobs_count}</td><td class="num">${yuan(r.income_cents)}</td><td class="num">${r.share_pct == null ? '—' : r.share_pct + '%'}</td></tr>`).join('') : '<tr><td colspan="4">暂无数据</td></tr>'
          }</tbody></table>`;
        option = buildPieOption({ items: regionItems(data, theme), donut: true, colors: theme, valFmt: cents => `${yuan(cents)} 元` });
        break;
      }
      case 'C12': {
        const rows = (data && data.rows) || [];
        const un = (data && data.unrecorded) || { jobs_count: 0, income_cents: 0 };
        const hasData = rows.length || un.income_cents > 0;
        html = canvasHtml(c.id, 200, hasData) +
          `<table class="lg-table" data-colw="charts-c12"><thead><tr><th>飞手</th><th>参与单数</th><th>均摊收入(元)</th><th>占比</th></tr></thead><tbody>${
            hasData
              ? rows.map(r => `<tr><td>${esc(r.operator)}</td><td class="num">${r.jobs_count}</td><td class="num">${yuan(r.income_cents)}</td><td class="num">${r.share_pct == null ? '—' : r.share_pct + '%'}</td></tr>`).join('') +
                (un.income_cents > 0 ? `<tr><td class="lg-cust-on">未填写</td><td class="num">${un.jobs_count}</td><td class="num">${yuan(un.income_cents)}</td><td class="num">${un.share_pct == null ? '—' : un.share_pct + '%'}</td></tr>` : '')
              : '<tr><td colspan="4">暂无数据</td></tr>'
          }</tbody></table>`;
        option = buildPieOption({ items: operatorItems(data, theme), donut: false, colors: theme, valFmt: cents => `${yuan(cents)} 元` });
        break;
      }
      default:
        html = '<div class="lg-chart-empty">未知图表类型</div>';
    }

    body.innerHTML = html;
    if (option && html.includes('data-chart=')) { // 无数据卡无容器（暂无数据），不空挂载
      mountOne($scope.querySelector(`[data-chart="c${c.id}"]`), { option, onClick });
    }
  }

  async function loadCard(c) {
    try {
      const data = await cardData(c);
      cardRender(c, data);
    } catch (e) {
      if (!$scope) return;
      const body = $scope.querySelector(`[data-card-body="${c.id}"]`);
      if (body) body.innerHTML = `<div class="lg-chart-error">加载失败：${esc(e.message)}</div>`;
    }
  }

  /* ---------- GridStack / 静态降级 ---------- */
  function destroyGrid() {
    if (!grid) return;
    try { grid.destroy(); } catch (e) { /* 已拆 */ }
    grid = null;
  }
  function initGrid(wrapEl) {
    const G = (typeof window !== 'undefined') ? window.GridStack : null;
    if (!G || typeof G.init !== 'function') return false;
    try {
      grid = G.init({
        column: T.Core.GRID_COLUMNS, cellHeight: 46, margin: 7, float: true,
        animate: true
      }, wrapEl);
      grid.on('change', persist);        // 拖拽/缩放/增删 → 布局落盘（readGridLayout 取最新）
      grid.on('resizestop', resizeAll);  // 缩放结束显式 resize（ResizeObserver 兜底）
      grid.on('dragstop', resizeAll);
      return true;
    } catch (e) {
      grid = null;
      return false;
    }
  }

  /* ---------- 页签渲染 ---------- */
  async function renderTab(tab, $main) {
    tools();
    disposeAll();      // innerHTML 重建前先释放 echarts 实例（app.js doRender 开头也会调一次）
    destroyGrid();     // 旧 GridStack 实例监听器一并拆除
    memo = new Map();  // 每次进页签取新数（dashboard 无页内缓存，区间/市筛选组合太多）
    $scope = $main;

    const saved = loadSaved();
    cards = saved ? saved.cards : defaultCards(); // 坏档（null）回退默认布局；卡内坏 state 已被 parseCardState 规范化
    layout = (saved && saved.layout) || null;
    county = lsGet(COUNTY_KEY) || '';

    let partiesAll = [];
    try { partiesAll = (T.Api.parties ? await T.Api.parties() : []) || []; } catch (e) { /* 市下拉拉不到就用空集 */ }

    const gridMode = initGridAvailable();
    isGridMode = gridMode;
    const wrapCls = gridMode ? 'lg-grid grid-stack' : 'lg-chart-grid lg-grid-static';
    $main.innerHTML = `${toolbarHtml(partiesAll)}
      <div class="${wrapCls}" id="lgGridWrap">${cards.map(c => cardShellHtml(c, gridMode)).join('')}</div>
      <div class="lg-chart-foot">每卡独立加载：桶粒度（时间轴卡）与日期区间（两日期都填=按区间，快捷置灰）互不影响；市筛选只作用于本页。</div>`;

    // GridStack.init 在骨架落 DOM 后执行（init 会收编 .grid-stack-item 子元素）
    if (gridMode && !initGrid($main.querySelector('#lgGridWrap'))) {
      isGridMode = false;
      gridModeFallback();
    }

    await Promise.allSettled(cards.map(c => loadCard(c)));
  }

  /** GridStack 是否可用（只查存在性；init 失败在 renderTab 里降级） */
  function initGridAvailable() {
    const G = (typeof window !== 'undefined') ? window.GridStack : null;
    return !!(G && typeof G.init === 'function');
  }
  /** init 失败 → 重建为静态堆叠（无拖拽仍可用） */
  function gridModeFallback() {
    if (!$scope) return;
    $scope.innerHTML = `${toolbarHtml([], 'GridStack 初始化失败，已降级静态堆叠：无拖拽缩放，其余功能照常')}
      <div class="lg-chart-grid lg-grid-static" id="lgGridWrap">${cards.map(c => cardShellHtml(c, false)).join('')}</div>
      <div class="lg-chart-foot">每卡独立加载：桶粒度（时间轴卡）与日期区间（两日期都填=按区间，快捷置灰）互不影响；市筛选只作用于本页。</div>`;
  }

  /* ---------- 动作（app.js handleAct switch 转发进来） ---------- */
  function confirmOk(msg) {
    try {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(msg);
    } catch (e) { /* 桩环境放行 */ }
    return true;
  }
  function rerender() { T.render().catch(e => T.toast(e.message, true)); }

  function handleAct(btn, t) {
    T = t || tools();
    const act = btn.dataset.act;
    const id = Number(btn.dataset.card);
    if (act === 'card-gran') {
      const c = cardById(id);
      if (c && T.Core.CARD_GRANS.includes(btn.dataset.gran)) {
        c.state.gran = btn.dataset.gran;
        persist();
        rerender();
      }
    } else if (act === 'card-quick') {
      const c = cardById(id);
      if (!c) return;
      if (T.Core.barUiOf(c.state, todayStr()).locked) return; // 两日期都填=纯按区间，防御性拦截（R2 同款）
      if (T.Core.BAR_QUICKS.includes(btn.dataset.quick)) {
        c.state.quick = btn.dataset.quick;
        persist();
        rerender();
      }
    } else if (act === 'card-del') {
      if (!cards.some(c => c.id === id)) return;
      if (!confirmOk('删除该图表卡？（可从「➕ 添加图表」重新加入）')) return;
      cards = cards.filter(c => c.id !== id);
      if (layout) layout = layout.filter(l => l.id !== id);
      persist();
      rerender();
    } else if (act === 'card-add') {
      addOpen = !addOpen;
      rerender();
    } else if (act === 'card-add-type') {
      const type = btn.dataset.type;
      if (CARD_TYPES[type]) {
        cards.push({ id: T.Core.nextCardId(cards), type, title: CARD_TYPES[type].name, state: T.Core.parseCardState(null) });
        addOpen = false;
        persist();
        rerender();
      }
    } else if (act === 'ov-jump-month') {
      jumpMonth(btn.dataset.month);
    }
  }

  /** 卡日期控件 change（app.js change 委托转发）：清空=该边不设限，允许触发 */
  function handleCardDate(id, role, value) {
    const c = cardById(id);
    if (!c || (role !== 'from' && role !== 'to')) return;
    c.state[role] = value || '';
    persist();
    rerender();
  }

  /** 市筛选 change（app.js change 委托转发）：全部卡带 county 重取 */
  function handleCounty(value) {
    county = String(value || '');
    persistCounty();
    rerender();
  }

  const api = {
    renderTab, handleAct, handleCardDate, handleCounty, periodLabel,
    buildTimeOption, buildBarOption, buildPieOption, chartTheme,
    mountMini, mountScope, disposeAll, resizeAll, CARD_TYPES, DEFAULT_TYPES
  };
  if (typeof window !== 'undefined') window.LedgerCharts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
