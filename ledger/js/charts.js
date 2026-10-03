/* ============================================================
   ledger/js/charts.js — 图表页签（P5-M2 echarts 适配层，HANDOFF-P5-PLAN §2）
   vendor：/ledger/vendor/echarts.min.js（本地文件，零 CDN；index.html 在本文件前引入）。
   内核：option 纯函数构建器（buildTimeOption/buildBarOption/buildPieOption，node:test 可测）
   + 挂载层（mountScope/mountOne/disposeAll/mountMini，实例注册表 + ResizeObserver）。
   数据端点：/api/reports/by-period（双轴）、/reports/adjustments、/reports/cost-breakdown、
   /reports/by-customer?include_all=1、/api/overview、/reports/by-region、/reports/by-operator。
   交互：每卡 周/月/季/年（从小到大；data-act="gran-set"，粒度按图保存+按粒度缓存）；
   月粒度柱/点点击（chart.on('click')）走 ov-jump-month 同通道跳总表当月。
   本文件按钮的 act 不走 app-extra 前缀正则，由 app.js handleAct switch
   （gran-set / ov-jump-month）转发到 LedgerCharts.handleAct。
   降级：window.echarts 缺失（vendor 未加载 / node 测试）时容器显示提示，
   表格卡（C9/C10）与口径脚注照常，不抛错。
   ============================================================ */
(function () {
  'use strict';
  let T = null;              // app.js 注入的工具（esc/toast/render/Api/Core/state/switchNav）
  let keepCacheOnce = false; // gran-set 触发的重渲染走缓存；重新进入页签一律取新数

  /* echarts 实例注册表（总表数据条 mountMini 复用同一套，不另设第二注册表） */
  const _charts = new Map();    // el -> echarts instance
  const _observers = new Map(); // el -> ResizeObserver|null
  const FALLBACK_HTML = '<div class="lg-chart-fallback">图表库未加载（vendor/echarts.min.js 缺失或加载失败），表格数据不受影响</div>';

  function tools() { T = window.__ledgerTools; return T; }
  function st() {
    const s = tools().state;
    s.gran = s.gran || {};
    s._periodCache = s._periodCache || {};
    s._adjCache = s._adjCache || {};
    return s;
  }
  function esc(s) { return T.esc(s); }

  /* P5-M1 反馈④:粒度按钮从小到大 周→月→季→年(服务端 GRANULARITIES 白名单仅校验用,顺序无关) */
  const GRANS = [['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年']];
  const GRAN_TITLE = { week: '周', month: '月', quarter: '季', year: '年' };
  function gran(key) { return st().gran[key] || 'month'; }

  /* P5-M1 反馈①:人类可读期间标签(显示层;period 原始键仍用于跳转/拼接/缓存)。
     优先服务端 label 字段,缺失时前端按同规则兜底映射。 */
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

  async function loadPeriod(g) {
    const s = st();
    if (!s._periodCache[g]) s._periodCache[g] = await T.Api.get('/api/reports/by-period?granularity=' + g);
    return s._periodCache[g];
  }
  async function loadAdj(g) {
    const s = st();
    if (!s._adjCache[g]) s._adjCache[g] = await T.Api.get('/api/reports/adjustments?granularity=' + g);
    return s._adjCache[g];
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

  /* ---------- 卡片骨架 / 图例 / 粒度按钮 ---------- */
  const C1 = 'var(--c1)', C2 = 'var(--c2)', C3 = 'var(--c3)', C4 = 'var(--c4)';

  function chip(color, label) {
    return `<span class="chip" style="--chip:${color}">${esc(label)}</span>`;
  }
  function granBtns(key) {
    const g = gran(key);
    return `<div class="lg-gran">${GRANS.map(([v, t]) =>
      `<button class="lg-btn ${v === g ? 'primary' : ''}" data-act="gran-set" data-chart="${key}" data-gran="${v}">${t}</button>`).join('')}</div>`;
  }
  function chartCard({ title, granKey, legend, body, foot, extra }) {
    return `<div class="lg-panel lg-chart-card">
      <h2>${esc(title)}</h2>
      ${granKey ? granBtns(granKey) : ''}
      ${legend ? `<div class="lg-chart-legend">${legend}</div>` : ''}
      ${body}
      ${extra || ''}
      ${foot ? `<div class="lg-chart-foot">${foot}</div>` : ''}
    </div>`;
  }
  /** 图表容器：rows/items 为空给占位文案；echarts 缺失时挂载层写降级提示 */
  function chartBox(key, h, hasData) {
    return hasData
      ? `<div class="lg-chart-canvas" data-chart="${key}" style="height:${h}px"></div>`
      : '<div class="lg-chart-empty">暂无数据</div>';
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
  /** doRender 开头 / renderTab 开头统一调用（R2 自检条 3：单一入口防泄漏） */
  function disposeAll() {
    for (const chart of _charts.values()) { try { chart.dispose(); } catch (e) { /* 已释放 */ } }
    _charts.clear();
    for (const ro of _observers.values()) { try { if (ro) ro.disconnect(); } catch (e) { /* 忽略 */ } }
    _observers.clear();
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
    window.addEventListener('resize', () => {
      for (const c of _charts.values()) { try { if (!c.isDisposed()) c.resize(); } catch (e) { /* 忽略 */ } }
    });
  }

  /* ---------- 总表数据条小图（P5-M2 §3.2，app.js overview 分支调用） ---------- */
  function regionItems(region, theme) {
    return ((region && region.rows) || []).map(r => ({
      label: r.label, v: r.income_cents,
      color: r.label === '(未填)' ? theme.muted : null
    }));
  }
  function operatorItems(operator, theme) {
    const items = ((operator && operator.rows) || []).map(r => ({ label: r.operator, v: r.income_cents }));
    if (operator && operator.unrecorded && operator.unrecorded.income_cents > 0) {
      items.push({
        label: `未记录(${operator.unrecorded.jobs_count}单)`,
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

  /* ---------- 页签渲染 ---------- */
  async function renderTab(tab, $main) {
    const s = st();
    disposeAll(); // innerHTML 重建前先释放 echarts 实例（app.js doRender 开头也会调一次）
    if (!keepCacheOnce) { s._periodCache = {}; s._adjCache = {}; } // 进页签取新数，页内切粒度走缓存
    keepCacheOnce = false;
    const granKeys = ['pl', 'work', 'adj', 'unit', 'pct'];
    const granSet = [...new Set(granKeys.map(gran))];
    const [periods, adjs, cbJournal, cbJob, custsAll, ov, partiesAll, region, operator] = await Promise.all([
      Promise.all(granSet.map(loadPeriod)).then(list => Object.fromEntries(list.map(d => [d.granularity, d]))),
      Promise.all(granSet.map(loadAdj)).then(list => Object.fromEntries(list.map(d => [d.granularity, d]))),
      T.Api.get('/api/reports/cost-breakdown?source=journal'),
      T.Api.get('/api/reports/cost-breakdown?source=job'),
      T.Api.get('/api/reports/by-customer?include_all=1'),
      T.Api.overview(),
      T.Api.parties ? T.Api.parties() : Promise.resolve([]),
      T.Api.get('/api/reports/by-region'),
      T.Api.get('/api/reports/by-operator')
    ]);
    const theme = chartTheme();
    const ovRows = (ov && ov.rows) || [];
    const isMonth = key => gran(key) === 'month';
    const weekFoot = '周为周一始自然周（年内首个周一前的日子记 W00），无数据的周有空隙属预期，期间以 period_start/end 为准。';

    /* C1 盈亏（pl 轴） */
    const pl = periods[gran('pl')].pl;
    /* C2 作业量（work 轴） */
    const work = periods[gran('work')].work;
    /* C3/C4 应收实收（adjustments） */
    const adj = adjs[gran('adj')].rows;
    /* C7 亩均/客单 */
    const plU = periods[gran('unit')].pl;
    const wU = periods[gran('unit')].work;
    const wMap = new Map(wU.map(r => [r.period, r]));
    const unitRows = plU.map(p => {
      const w = wMap.get(p.period);
      return {
        period: p.period,
        label: p.label,
        perMu: w && w.area_mu > 0 ? Math.round(p.income_cents / w.area_mu) : null,
        perJob: w && w.jobs_count > 0 ? Math.round(p.income_cents / w.jobs_count) : null
      };
    });
    /* C9 环比总表 */
    const plP = periods[gran('pct')].pl;
    const wP = periods[gran('pct')].work;
    const wPMap = new Map(wP.map(r => [r.period, r]));
    const pctRows = plP.map(p => ({ ...p, jobs_count: (wPMap.get(p.period) || {}).jobs_count ?? null, jobs_pct: (wPMap.get(p.period) || {}).jobs_pct ?? null, area_mu: (wPMap.get(p.period) || {}).area_mu ?? null, area_pct: (wPMap.get(p.period) || {}).area_pct ?? null }));
    const pctTd = v => `<td class="num">${v == null ? '—' : (v > 0 ? '+' : '') + v + '%'}</td>`;

    /* C5 支出构成（账簿 5001-5007） */
    const c5Items = cbJournal.items.map(c => ({ label: `${c.code} ${c.name}`, v: c.cents, tip: `${c.code} ${c.name}：${yuan(c.cents)} 元` }));
    /* C6 客户 TOP10（include_all） */
    const top10 = [...custsAll].sort((a, b) => b.income_cents - a.income_cents).slice(0, 10);
    const debtors = [...custsAll].filter(c => c.receivable_cents > 0).sort((a, b) => b.receivable_cents - a.receivable_cents).slice(0, 5);
    const c6Items = top10.map(c => ({ label: c.name || '—', v: c.income_cents, tip: `${c.name || '—'}：收入 ${yuan(c.income_cents)} 元 · 欠款 ${yuan(c.receivable_cents)} 元 · 预收 ${yuan(c.prepaid_cents)} 元` }));
    /* C8 作业成本构成 */
    const c8Items = cbJob.items.map(c => ({ label: c.name, v: c.cents, color: theme.c2, tip: `${c.name}：${yuan(c.cents)} 元` }));
    const barH = items => Math.max(150, Math.min(340, items.length * 30 + 30));

    /* C11 地区收入占比 / C12 飞手收入占比（P5-M2 新增，更详细版） */
    const regionRows = (region && region.rows) || [];
    const opRowsAll = ((operator && operator.rows) || []);
    const un = (operator && operator.unrecorded) || { jobs_count: 0, income_cents: 0 };
    const c11 = chartCard({
      title: '地区收入占比（账单金额按客户主数据地区分桶）',
      body: `<div class="lg-chart-grid lg-chart-grid--in">
        ${chartBox('c11', 230, regionRows.length)}
        <table class="lg-table"><thead><tr><th>地区</th><th>单数</th><th>收入(元)</th><th>占比</th></tr></thead><tbody>${
          regionRows.length ? regionRows.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${r.jobs_count}</td><td class="num">${yuan(r.income_cents)}</td><td class="num">${r.share_pct == null ? '—' : r.share_pct + '%'}</td></tr>`).join('') : '<tr><td colspan="4">暂无数据</td></tr>'
        }</tbody></table>
      </div>`,
      foot: '收入=Σ账单金额（非 void），(未填) 桶=客户主数据未填区域、占比照实呈现（先在主数据补客户区域即消失）；「金桂村/金桂」疑似同村异写，village 级占比会拆分，数据问题用主数据编辑解决。'
    });
    const c12 = chartCard({
      title: '飞手收入占比（账单金额按作业人数均摊，纯展示口径）',
      body: `<div class="lg-chart-grid lg-chart-grid--in">
        ${chartBox('c12', 230, opRowsAll.length || un.income_cents > 0)}
        <table class="lg-table"><thead><tr><th>飞手</th><th>参与单数</th><th>均摊收入(元)</th><th>占比</th></tr></thead><tbody>${
          (opRowsAll.length || un.income_cents > 0)
            ? opRowsAll.map(r => `<tr><td>${esc(r.operator)}</td><td class="num">${r.jobs_count}</td><td class="num">${yuan(r.income_cents)}</td><td class="num">${r.share_pct == null ? '—' : r.share_pct + '%'}</td></tr>`).join('') +
              (un.income_cents > 0 ? `<tr><td class="lg-cust-on">未记录</td><td class="num">${un.jobs_count}</td><td class="num">${yuan(un.income_cents)}</td><td class="num">${un.share_pct == null ? '—' : un.share_pct + '%'}</td></tr>` : '')
            : '<tr><td colspan="4">暂无数据</td></tr>'
        }</tbody></table>
      </div>`,
      foot: `未记录=operator_names 为空的作业（灰色桶，导入历史多属此类）；多人单收入按单内人数均摊、每人计 1 单，不落库。`
    });

    /* 卡片 HTML（C1-C12） */
    const c1 = chartCard({
      title: `收入 / 支出 / 利润（${GRAN_TITLE[gran('pl')]}）`,
      granKey: 'pl',
      legend: chip(C1, '收入') + chip(C2, '支出') + chip(C3, '利润(折线,自有值域)'),
      body: chartBox('c1', 260, pl.length),
      foot: '账簿确认口径（按凭证 occurred_at 分桶）；红冲不回溯历史期间，冲销当月可能出现负尖峰；导入单利润=收入（成本快照为 0）。月粒度可点柱/点跳总表当月。'
    });
    const c2 = chartCard({
      title: `作业量：亩数 / 单数（${GRAN_TITLE[gran('work')]}）`,
      granKey: 'work',
      legend: chip(C1, '亩数') + chip(C3, '单数(折线)'),
      body: chartBox('c2', 260, work.length),
      extra: work.length ? `<div class="lg-chart-legend">客户数 ${work.map(r => `<span class="lg-tag">${esc(periodLabel(r))} · ${r.customer_count}</span>`).join(' ')}</div>` : '',
      foot: '作业执行口径（按 job_date 分桶）；客户数=结算分项挂客户去重数。' + weekFoot
    });
    const c3 = chartCard({
      title: '应收 / 实收 / 回收率',
      granKey: 'adj',
      legend: chip(C1, '应收(billed)') + chip(C2, '实收(collected)') + chip(C4, '回收率%(折线,自有值域)'),
      body: chartBox('c3', 260, adj.length),
      foot: '账单口径：按 bills.issued_at 分桶、非 void；回收率=实收/应收（分母 0 记 —）；存在超收月份可 >100%。' + weekFoot
    });
    const c4 = chartCard({
      title: '抹零（少收）与超收 专项',
      granKey: 'adj',
      legend: chip(C3, '抹零 Σ|adjust|') + chip(C2, '超收'),
      body: chartBox('c4', 260, adj.length),
      foot: '抹零=Σ|adjust|（导入正数抹零与手工负数抹零统一按优惠金额计）；超收=ΣMAX(0, paid−(amount−|adjust|))，手工收款路径仍禁止超收，此处只统计导入历史。'
    });
    const c5 = chartCard({
      title: '支出构成（账簿口径 5001-5007）',
      legend: chip(C1, '支出'),
      body: chartBox('c5', barH(c5Items), c5Items.length),
      foot: `合计 ${yuan(cbJournal.total_cents)} 元（付款凭证现金口径）。与「作业成本构成」为两种统计对象，不可相加。`
    });
    const c6 = chartCard({
      title: `客户 TOP10 收入 + 欠款/预收（客户总数 ${partiesAll.length}·启用）`,
      legend: chip(C1, '累计收入'),
      body: chartBox('c6', barH(c6Items), c6Items.length),
      extra: `<table class="lg-table"><thead><tr><th>客户</th><th>累计收入(元)</th><th>欠款(元)</th><th>预收余额(元)</th></tr></thead><tbody>${
        top10.map(c => `<tr><td>${esc(c.name || '—')}</td><td class="num">${yuan(c.income_cents)}</td><td class="num">${yuan(c.receivable_cents)}</td><td class="num">${yuan(c.prepaid_cents)}</td></tr>`).join('')
      }</tbody></table>
      ${debtors.length ? `<table class="lg-table" style="margin-top:8px"><thead><tr><th>欠款 TOP5</th><th>欠款(元)</th><th>预收余额(元)</th></tr></thead><tbody>${
        debtors.map(c => `<tr><td>${esc(c.name || '—')}</td><td class="num">${yuan(c.receivable_cents)}</td><td class="num">${yuan(c.prepaid_cents)}</td></tr>`).join('')
      }</tbody></table>` : ''}`,
      foot: 'include_all 口径：含期内无收入但有欠款/预收的客户（补零收入）。余额为时点值，不随粒度切换。'
    });
    const c7 = chartCard({
      title: `亩均收入 / 客单价（${GRAN_TITLE[gran('unit')]}，加分项）`,
      granKey: 'unit',
      legend: chip(C1, '亩均收入(元/亩)') + chip(C3, '客单价(元/单)'),
      body: chartBox('c7', 260, unitRows.length),
      foot: '两条折线各自归一化（非同一值域），看趋势与点值；=账簿收入 ÷ 作业轴亩数/单数（两轴按期间键拼接）。'
    });
    const c8 = chartCard({
      title: '作业成本构成（作业快照口径，加分项）',
      legend: chip(C2, '成本'),
      body: chartBox('c8', barH(c8Items), c8Items.length),
      foot: `${esc(cbJob.import_zero_note)} 合计 ${yuan(cbJob.total_cents)} 元，其中计算器单 ${yuan(cbJob.calculator_only_cents)} 元。与「支出构成」为两种统计对象（作业归属 vs 付款现金），不可相加。`
    });
    const c9 = `<div class="lg-panel lg-chart-card">
      <h2>环比增长总表（加分项）</h2>
      ${granBtns('pct')}
      <table class="lg-table"><thead><tr>
        <th>期间</th><th>收入(元)</th><th>环比</th><th>支出(元)</th><th>环比</th><th>利润(元)</th><th>环比</th><th>单数</th><th>环比</th><th>亩数</th><th>环比</th>
      </tr></thead><tbody>${pctRows.length ? pctRows.map(r => `<tr>
        <td title="${esc(r.period)}">${esc(periodLabel(r))}</td>
        <td class="num">${yuan(r.income_cents)}</td>${pctTd(r.income_pct)}
        <td class="num">${yuan(r.expense_cents)}</td>${pctTd(r.expense_pct)}
        <td class="num"><b>${yuan(r.profit_cents)}</b></td>${pctTd(r.profit_pct)}
        <td class="num">${r.jobs_count ?? '—'}</td>${pctTd(r.jobs_pct)}
        <td class="num">${r.area_mu ?? '—'}</td>${pctTd(r.area_pct)}
      </tr>`).join('') : '<tr><td colspan="11">暂无数据</td></tr>'}</tbody></table>
      <div class="lg-chart-foot">环比=对上一返回桶（首桶或上一桶为 0 时 —）；收入/支出/利润为账簿口径，单数/亩数为作业口径。</div>
    </div>`;
    const srcRows = topAgg(ovRows, r => [r.referral_name], r => r.amount_cents);
    const colRows = topAgg(ovRows, r => [r.collector_name], r => r.paid_cents);
    const opTopRows = topAgg(ovRows, r => parseOps(r.operator_names), r => r.amount_cents);
    const miniTable = (head, rows, centsLabel) => `<table class="lg-table"><thead><tr><th>${head}</th><th>单数</th><th>${centsLabel}(元)</th></tr></thead><tbody>${
      rows.length ? rows.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${r.count}</td><td class="num">${yuan(r.cents)}</td></tr>`).join('') : '<tr><td colspan="3">暂无</td></tr>'
    }</tbody></table>`;
    const c10 = `<div class="lg-panel lg-chart-card">
      <h2>业务来源 / 收款人 / 作业人员 排行（加分项，总表口径前端聚合）</h2>
      <div class="lg-chart-grid lg-chart-grid--in">
        ${miniTable('业务来源', srcRows, '应收')}
        ${miniTable('收款人', colRows, '实收')}
        ${miniTable('作业人员', opTopRows, '应收')}
      </div>
      <div class="lg-chart-foot">导入历史来源/收款人/人员多为空（显示为 — 的不计入）；金额按作业聚合（应收=Σ账单金额、实收=Σ账单已收）。</div>
    </div>`;

    $main.innerHTML = `<div class="lg-chart-grid">${c1}${c2}${c3}${c4}${c5}${c6}${c7}${c8}${c11}${c12}${c9}${c10}</div>`;

    /* 挂载 echarts（vendor 缺失时由 mountOne 写降级提示）；月粒度卡绑点击跳总表 */
    mountScope($main, {
      c1: {
        option: buildTimeOption({
          rows: pl,
          bars: [{ key: 'income_cents', name: '收入', color: theme.c1 }, { key: 'expense_cents', name: '支出', color: theme.c2 }],
          lines: [{ key: 'profit_cents', name: '利润', color: theme.c3, fmt: fmtAxisYuan }],
          colors: theme, yFmt: fmtAxisYuan,
          tip: r => `${periodLabel(r)}(${r.period})\n收入 ${yuan(r.income_cents)} 元\n支出 ${yuan(r.expense_cents)} 元\n利润 ${yuan(r.profit_cents)} 元\n收入环比 ${pctText(r.income_pct)} · 支出环比 ${pctText(r.expense_pct)}`
        }),
        onClick: isMonth('pl') ? rowClick(pl) : null
      },
      c2: {
        option: buildTimeOption({
          rows: work,
          bars: [{ key: 'area_mu', name: '亩数', color: theme.c1 }],
          lines: [{ key: 'jobs_count', name: '单数', color: theme.c3, fmt: fmtAxisNum }],
          colors: theme, yFmt: fmtAxisNum,
          tip: r => `${periodLabel(r)}(${r.period})\n单数 ${r.jobs_count}\n亩数 ${r.area_mu}\n客户数 ${r.customer_count}\n单数环比 ${pctText(r.jobs_pct)} · 亩数环比 ${pctText(r.area_pct)}`
        }),
        onClick: isMonth('work') ? rowClick(work) : null
      },
      c3: {
        option: buildTimeOption({
          rows: adj,
          bars: [{ key: 'billed_cents', name: '应收', color: theme.c1 }, { key: 'collected_cents', name: '实收', color: theme.c2 }],
          lines: [{ key: 'collection_rate', name: '回收率%', color: theme.c4, fmt: v => v + '%' }],
          colors: theme, yFmt: fmtAxisYuan,
          tip: r => `${periodLabel(r)}(${r.period})\n应收 ${yuan(r.billed_cents)} 元\n实收 ${yuan(r.collected_cents)} 元\n回收率 ${r.collection_rate == null ? '—' : r.collection_rate + '%'}\n未收 ${yuan(r.due_cents)} 元`
        }),
        onClick: isMonth('adj') ? rowClick(adj) : null
      },
      c4: {
        option: buildTimeOption({
          rows: adj,
          bars: [{ key: 'discount_cents', name: '抹零', color: theme.c3 }, { key: 'overpaid_cents', name: '超收', color: theme.c2 }],
          lines: [],
          colors: theme, yFmt: fmtAxisYuan,
          tip: r => `${periodLabel(r)}(${r.period})\n抹零 ${yuan(r.discount_cents)} 元\n超收 ${yuan(r.overpaid_cents)} 元\n未收 ${yuan(r.due_cents)} 元`
        }),
        onClick: isMonth('adj') ? rowClick(adj) : null
      },
      c5: { option: buildBarOption({ items: c5Items, colors: theme }) },
      c6: { option: buildBarOption({ items: c6Items, colors: theme }) },
      c7: {
        option: buildTimeOption({
          rows: unitRows,
          bars: [],
          lines: [
            { key: 'perMu', name: '亩均收入', color: theme.c1, fmt: fmtAxisYuan },
            { key: 'perJob', name: '客单价', color: theme.c3, fmt: fmtAxisYuan }
          ],
          colors: theme, yFmt: fmtAxisYuan,
          tip: r => `${periodLabel(r)}(${r.period})\n亩均 ${r.perMu == null ? '—' : yuan(r.perMu)} 元/亩\n客单价 ${r.perJob == null ? '—' : yuan(r.perJob)} 元/单`
        }),
        onClick: isMonth('unit') ? rowClick(unitRows) : null
      },
      c8: { option: buildBarOption({ items: c8Items, colors: theme }) },
      c11: { option: buildPieOption({ items: regionItems(region, theme), donut: true, colors: theme, valFmt: cents => `${yuan(cents)} 元` }) },
      c12: { option: buildPieOption({ items: operatorItems(operator, theme), donut: false, colors: theme, valFmt: cents => `${yuan(cents)} 元` }) }
    });
  }

  /* ---------- 动作（app.js handleAct switch 转发进来） ---------- */
  function handleAct(btn, tools) {
    T = tools;
    const act = btn.dataset.act;
    if (act === 'gran-set') {
      st().gran[btn.dataset.chart] = btn.dataset.gran;
      keepCacheOnce = true; // 粒度切换复用按粒度缓存（缺失的粒度仍会 fetch）
      T.render().catch(e => T.toast(e.message, true));
    } else if (act === 'ov-jump-month') {
      jumpMonth(btn.dataset.month);
    }
  }

  const api = { renderTab, handleAct, periodLabel, buildTimeOption, buildBarOption, buildPieOption, chartTheme, mountMini, mountScope, disposeAll };
  if (typeof window !== 'undefined') window.LedgerCharts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
