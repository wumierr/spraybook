/* ============================================================
   ledger/js/charts.js — 图表页签（P4-M2，HANDOFF-P4-PLAN §3）
   内联 SVG 手绘（零库/零 CDN）；纯几何函数在 core.js（可测）。
   数据端点：/api/reports/by-period（双轴）、/reports/adjustments、
   /reports/cost-breakdown、/reports/by-customer?include_all=1、/api/overview。
   交互：每卡 周/月/季/年（P5-M1 起从小到大；data-act="gran-set"，粒度按图保存+按粒度缓存）；
   月粒度柱/点 data-act="ov-jump-month" 跳总表当月。
   本文件按钮的 act 不走 app-extra 前缀正则，由 app.js handleAct switch
   （gran-set / ov-jump-month）转发到 LedgerCharts.handleAct。
   ============================================================ */
(function () {
  'use strict';
  let T = null;              // app.js 注入的工具（esc/toast/render/Api/Core/state/switchNav）
  let keepCacheOnce = false; // gran-set 触发的重渲染走缓存；重新进入页签一律取新数

  function tools() { T = window.__ledgerTools; return T; }
  function st() {
    const s = tools().state;
    s.gran = s.gran || {};
    s._periodCache = s._periodCache || {};
    s._adjCache = s._adjCache || {};
    return s;
  }
  function esc(s) { return T.esc(s); }
  function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  /* P5-M1 反馈④:粒度按钮从小到大 周→月→季→年(服务端 GRANULARITIES 白名单仅校验用,顺序无关) */
  const GRANS = [['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年']];
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
  function chartCard({ title, granKey, legend, svg, foot, extra }) {
    return `<div class="lg-panel lg-chart-card">
      <h2>${esc(title)}</h2>
      ${granKey ? granBtns(granKey) : ''}
      ${legend ? `<div class="lg-chart-legend">${legend}</div>` : ''}
      ${svg}
      ${extra || ''}
      ${foot ? `<div class="lg-chart-foot">${foot}</div>` : ''}
    </div>`;
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

  /* ---------- 时间轴组合图（柱 0-2 系列 + 折线 0-2 系列各自值域） ---------- */
  const W = 640, H = 240, PAD_L = 64, PAD_R = 12, PAD_T = 18, PAD_B = 30;
  const PLOT_W = W - PAD_L - PAD_R, PLOT_H = H - PAD_T - PAD_B;

  function emptySvg() {
    return `<svg class="lg-chart" viewBox="0 0 ${W} ${H}" role="img"><text x="${W / 2}" y="${H / 2}" text-anchor="middle">暂无数据</text></svg>`;
  }

  /**
   * rows: 期行数组（含 period）；bars:[{key,color}]；lines:[{key,color,fmt}]
   * jump: true 时柱/点包 data-act="ov-jump-month" data-month（调用方保证月粒度才传）
   * tip:  (row) => string 悬浮文本；yFmt: 左轴刻度格式化（无柱时不显示刻度文本）
   */
  function timeChartSvg({ rows, bars = [], lines = [], jump = false, tip, yFmt }) {
    if (!rows || !rows.length) return emptySvg();
    const n = rows.length;
    const slot = PLOT_W / n;
    const band = Math.min(slot * 0.72, 72);
    const gap = Math.min(6, band * 0.22);

    // 左轴（柱共用）：0..nice(max)
    let grid = '', barsSvg = '', baseY = PAD_T + PLOT_H;
    if (bars.length) {
      const maxBar = Math.max(...rows.map(r => Math.max(0, ...bars.map(b => Number(r[b.key]) || 0))));
      const t = T.Core.niceTicks(maxBar, 4);
      const y = T.Core.scaleLinear(0, t.max, PAD_T + PLOT_H, PAD_T);
      baseY = r2(y(0));
      grid = t.ticks.map(tick => {
        const yy = r2(y(tick));
        return `<line class="lg-chart-axis" x1="${PAD_L}" y1="${yy}" x2="${PAD_L + PLOT_W}" y2="${yy}"/>` +
          `<text x="${PAD_L - 6}" y="${yy + 3.5}" text-anchor="end">${esc(yFmt(tick))}</text>`;
      }).join('');
      const pts = rows.map((row, i) => ({
        cx: PAD_L + slot * (i + 0.5),
        values: bars.map(b => (row[b.key] == null ? 0 : Number(row[b.key])))
      }));
      const rects = T.Core.groupedBarRects(bars.length, pts, y, band, gap);
      barsSvg = rows.map((row, i) =>
        rects.filter(rc => rc.cx === pts[i].cx).map(rc =>
          `<g${jump ? ` data-act="ov-jump-month" data-month="${esc(row.period)}"` : ''} class="lg-hit">` +
          `<rect x="${rc.x}" y="${rc.y}" width="${rc.w}" height="${rc.h}" fill="${bars[rc.si].color}">` +
          `<title>${esc(tip(row))}</title></rect></g>`).join('')
      ).join('');
    } else {
      grid = `<line class="lg-chart-axis" x1="${PAD_L}" y1="${r2(baseY)}" x2="${PAD_L + PLOT_W}" y2="${r2(baseY)}"/>`;
    }

    // 折线：各系列自有值域（含 0；有负值时画 0 基线）
    const linesSvg = lines.map(line => {
      const vals = rows.map(r => (r[line.key] == null ? null : Number(r[line.key])));
      const nums = vals.filter(v => v != null);
      if (!nums.length) return '';
      const hi = T.Core.niceTicks(Math.max(0, ...nums), 3).max;
      const lo = T.Core.niceTicks(Math.max(0, -Math.min(0, ...nums)), 3).max;
      const yl = T.Core.scaleLinear(-lo, hi, baseY, PAD_T);
      const pts = rows.map((row, i) => ({
        x: r2(PAD_L + slot * (i + 0.5)),
        y: vals[i] == null ? null : r2(yl(vals[i])),
        row, v: vals[i]
      }));
      const d = T.Core.linePath(pts);
      const dots = pts.filter(p => p.y != null).map(p =>
        `<g${jump ? ` data-act="ov-jump-month" data-month="${esc(p.row.period)}"` : ''} class="lg-hit">` +
        `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${line.color}">` +
        `<title>${esc(tip(p.row))}</title></circle>` +
        (n <= 12 ? `<text x="${p.x}" y="${Math.max(PAD_T + 8, p.y - 7)}" text-anchor="middle" fill="${line.color}" style="font-size:10px">${esc(line.fmt(p.v))}</text>` : '') +
        `</g>`).join('');
      return (lo > 0 ? `<line class="lg-chart-axis" x1="${PAD_L}" y1="${r2(yl(0))}" x2="${PAD_L + PLOT_W}" y2="${r2(yl(0))}"/>` : '') +
        (d ? `<path d="${d}" fill="none" stroke="${line.color}" stroke-width="2"/>` : '') + dots;
    }).join('');

    // X 标签：最多 12 个，其余抽稀（P5-M1:显示用人类 label,跳转 data-month 仍用原始 period）
    const k = Math.ceil(n / 12);
    const xLabels = rows.map((row, i) => (i % k === 0
      ? `<text x="${r2(PAD_L + slot * (i + 0.5))}" y="${PAD_T + PLOT_H + 16}" text-anchor="middle">${esc(periodLabel(row))}</text>`
      : '')).join('');
    const yAxis = `<line class="lg-chart-axis" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + PLOT_H}"/>`;

    return `<svg class="lg-chart" viewBox="0 0 ${W} ${H}" role="img">${grid}${yAxis}${barsSvg}${linesSvg}${xLabels}</svg>`;
  }

  /* ---------- 横向条形（支出构成 / 客户 TOP / 成本构成） ---------- */
  function hBarSvg({ items, valFmt, padL = 128 }) {
    if (!items.length) return emptySvg();
    const max = Math.max(...items.map(i => Math.max(0, i.v || 0)));
    const bars = T.Core.hBarRects(items, max);
    const rowH = Math.min(28, Math.max(18, (H - 12) / items.length));
    const trackW = W - PAD_R - padL - 64;
    return `<svg class="lg-chart" viewBox="0 0 ${W} ${Math.max(H, items.length * rowH + 14)}" role="img">` +
      items.map((it, i) => {
        const yy = 8 + i * rowH;
        const w = r2(bars[i].wPct * trackW);
        const cy = yy + rowH / 2 + 4;
        return `<text x="${padL - 6}" y="${cy}" text-anchor="end">${esc(String(it.label).slice(0, 12))}</text>` +
          `<rect x="${padL}" y="${yy + 5}" width="${w}" height="${rowH - 9}" fill="${it.color || C1}" rx="2">` +
          `<title>${esc(it.tip)}</title></rect>` +
          `<text x="${padL + w + 6}" y="${cy}">${esc(valFmt(it.v))}</text>`;
      }).join('') + `</svg>`;
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
    if (!keepCacheOnce) { s._periodCache = {}; s._adjCache = {}; } // 进页签取新数，页内切粒度走缓存
    keepCacheOnce = false;
    const granKeys = ['pl', 'work', 'adj', 'unit', 'pct'];
    const granSet = [...new Set(granKeys.map(gran))];
    const [periods, adjs, cbJournal, cbJob, custsAll, ov] = await Promise.all([
      Promise.all(granSet.map(loadPeriod)).then(list => Object.fromEntries(list.map(d => [d.granularity, d]))),
      Promise.all(granSet.map(loadAdj)).then(list => Object.fromEntries(list.map(d => [d.granularity, d]))),
      T.Api.get('/api/reports/cost-breakdown?source=journal'),
      T.Api.get('/api/reports/cost-breakdown?source=job'),
      T.Api.get('/api/reports/by-customer?include_all=1'),
      T.Api.overview()
    ]);
    const ovRows = (ov && ov.rows) || [];
    const isMonth = key => gran(key) === 'month';
    const weekFoot = '周为周一始自然周（年内首个周一前的日子记 W00），无数据的周有空隙属预期，期间以 period_start/end 为准。';

    /* C1 盈亏（pl 轴） */
    const pl = periods[gran('pl')].pl;
    const c1 = chartCard({
      title: `收入 / 支出 / 利润（${{ month: '月', week: '周', quarter: '季', year: '年' }[gran('pl')]}）`,
      granKey: 'pl',
      legend: chip(C1, '收入') + chip(C2, '支出') + chip(C3, '利润(折线,自有值域)'),
      svg: timeChartSvg({
        rows: pl,
        bars: [{ key: 'income_cents', color: C1 }, { key: 'expense_cents', color: C2 }],
        lines: [{ key: 'profit_cents', color: C3, fmt: v => fmtAxisYuan(v) }],
        jump: isMonth('pl'),
        yFmt: fmtAxisYuan,
        tip: r => `${periodLabel(r)}(${r.period})\n收入 ${yuan(r.income_cents)} 元\n支出 ${yuan(r.expense_cents)} 元\n利润 ${yuan(r.profit_cents)} 元\n收入环比 ${pctText(r.income_pct)} · 支出环比 ${pctText(r.expense_pct)}`
      }),
      foot: '账簿确认口径（按凭证 occurred_at 分桶）；红冲不回溯历史期间，冲销当月可能出现负尖峰；导入单利润=收入（成本快照为 0）。月粒度可点柱/点跳总表当月。'
    });

    /* C2 作业量（work 轴） */
    const work = periods[gran('work')].work;
    const c2 = chartCard({
      title: `作业量：亩数 / 单数（${{ month: '月', week: '周', quarter: '季', year: '年' }[gran('work')]}）`,
      granKey: 'work',
      legend: chip(C1, '亩数') + chip(C3, '单数(折线)'),
      svg: timeChartSvg({
        rows: work,
        bars: [{ key: 'area_mu', color: C1 }],
        lines: [{ key: 'jobs_count', color: C3, fmt: v => fmtAxisNum(v) }],
        jump: isMonth('work'),
        yFmt: fmtAxisNum,
        tip: r => `${periodLabel(r)}(${r.period})\n单数 ${r.jobs_count}\n亩数 ${r.area_mu}\n客户数 ${r.customer_count}\n单数环比 ${pctText(r.jobs_pct)} · 亩数环比 ${pctText(r.area_pct)}`
      }),
      extra: work.length ? `<div class="lg-chart-legend">客户数 ${work.map(r => `<span class="lg-tag">${esc(periodLabel(r))} · ${r.customer_count}</span>`).join(' ')}</div>` : '',
      foot: '作业执行口径（按 job_date 分桶）；客户数=结算分项挂客户去重数。' + weekFoot
    });

    /* C3 应收/实收/回收率（adjustments） */
    const adj = adjs[gran('adj')].rows;
    const c3 = chartCard({
      title: '应收 / 实收 / 回收率',
      granKey: 'adj',
      legend: chip(C1, '应收(billed)') + chip(C2, '实收(collected)') + chip(C4, '回收率%(折线,自有值域)'),
      svg: timeChartSvg({
        rows: adj,
        bars: [{ key: 'billed_cents', color: C1 }, { key: 'collected_cents', color: C2 }],
        lines: [{ key: 'collection_rate', color: C4, fmt: v => v + '%' }],
        jump: isMonth('adj'),
        yFmt: fmtAxisYuan,
        tip: r => `${periodLabel(r)}(${r.period})\n应收 ${yuan(r.billed_cents)} 元\n实收 ${yuan(r.collected_cents)} 元\n回收率 ${r.collection_rate == null ? '—' : r.collection_rate + '%'}\n未收 ${yuan(r.due_cents)} 元`
      }),
      foot: '账单口径：按 bills.issued_at 分桶、非 void；回收率=实收/应收（分母 0 记 —）；存在超收月份可 >100%。' + weekFoot
    });

    /* C4 抹零与超收专项（adjustments） */
    const c4 = chartCard({
      title: '抹零（少收）与超收 专项',
      granKey: 'adj',
      legend: chip(C3, '抹零 Σ|adjust|') + chip(C2, '超收'),
      svg: timeChartSvg({
        rows: adj,
        bars: [{ key: 'discount_cents', color: C3 }, { key: 'overpaid_cents', color: C2 }],
        lines: [],
        jump: isMonth('adj'),
        yFmt: fmtAxisYuan,
        tip: r => `${periodLabel(r)}(${r.period})\n抹零 ${yuan(r.discount_cents)} 元\n超收 ${yuan(r.overpaid_cents)} 元\n未收 ${yuan(r.due_cents)} 元`
      }),
      foot: '抹零=Σ|adjust|（导入正数抹零与手工负数抹零统一按优惠金额计）；超收=ΣMAX(0, paid−(amount−|adjust|))，手工收款路径仍禁止超收，此处只统计导入历史。'
    });

    /* C5 支出构成（账簿 5001-5007） */
    const c5 = chartCard({
      title: '支出构成（账簿口径 5001-5007）',
      legend: chip(C1, '支出'),
      svg: hBarSvg({
        items: cbJournal.items.map(c => ({ label: `${c.code} ${c.name}`, v: c.cents, tip: `${c.code} ${c.name}：${yuan(c.cents)} 元` })),
        valFmt: fmtAxisYuan
      }),
      foot: `合计 ${yuan(cbJournal.total_cents)} 元（付款凭证现金口径）。与「作业成本构成」为两种统计对象，不可相加。`
    });

    /* C6 客户 TOP10（include_all） */
    const top10 = [...custsAll].sort((a, b) => b.income_cents - a.income_cents).slice(0, 10);
    const debtors = [...custsAll].filter(c => c.receivable_cents > 0).sort((a, b) => b.receivable_cents - a.receivable_cents).slice(0, 5);
    const c6 = chartCard({
      title: '客户 TOP10 收入 + 欠款/预收',
      legend: chip(C1, '累计收入'),
      svg: hBarSvg({
        items: top10.map(c => ({ label: c.name || '—', v: c.income_cents, tip: `${c.name || '—'}：收入 ${yuan(c.income_cents)} 元 · 欠款 ${yuan(c.receivable_cents)} 元 · 预收 ${yuan(c.prepaid_cents)} 元` })),
        valFmt: fmtAxisYuan
      }),
      extra: `<table class="lg-table"><thead><tr><th>客户</th><th>累计收入(元)</th><th>欠款(元)</th><th>预收余额(元)</th></tr></thead><tbody>${
        top10.map(c => `<tr><td>${esc(c.name || '—')}</td><td class="num">${yuan(c.income_cents)}</td><td class="num">${yuan(c.receivable_cents)}</td><td class="num">${yuan(c.prepaid_cents)}</td></tr>`).join('')
      }</tbody></table>
      ${debtors.length ? `<table class="lg-table" style="margin-top:8px"><thead><tr><th>欠款 TOP5</th><th>欠款(元)</th><th>预收余额(元)</th></tr></thead><tbody>${
        debtors.map(c => `<tr><td>${esc(c.name || '—')}</td><td class="num">${yuan(c.receivable_cents)}</td><td class="num">${yuan(c.prepaid_cents)}</td></tr>`).join('')
      }</tbody></table>` : ''}`,
      foot: 'include_all 口径：含期内无收入但有欠款/预收的客户（补零收入）。余额为时点值，不随粒度切换。'
    });

    /* C7 亩均收入 / 客单价（加分） */
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
    const c7 = chartCard({
      title: `亩均收入 / 客单价（${{ month: '月', week: '周', quarter: '季', year: '年' }[gran('unit')]}，加分项）`,
      granKey: 'unit',
      legend: chip(C1, '亩均收入(元/亩)') + chip(C3, '客单价(元/单)'),
      svg: timeChartSvg({
        rows: unitRows,
        bars: [],
        lines: [
          { key: 'perMu', color: C1, fmt: v => fmtAxisYuan(v) },
          { key: 'perJob', color: C3, fmt: v => fmtAxisYuan(v) }
        ],
        jump: isMonth('unit'),
        tip: r => `${periodLabel(r)}(${r.period})\n亩均 ${r.perMu == null ? '—' : yuan(r.perMu)} 元/亩\n客单价 ${r.perJob == null ? '—' : yuan(r.perJob)} 元/单`
      }),
      foot: '两条折线各自归一化（非同一值域），看趋势与点值；=账簿收入 ÷ 作业轴亩数/单数（两轴按期间键拼接）。'
    });

    /* C8 作业成本构成（加分） */
    const c8 = chartCard({
      title: '作业成本构成（作业快照口径，加分项）',
      legend: chip(C2, '成本'),
      svg: hBarSvg({
        items: cbJob.items.map(c => ({ label: c.name, v: c.cents, color: C2, tip: `${c.name}：${yuan(c.cents)} 元` })),
        valFmt: fmtAxisYuan
      }),
      foot: `${esc(cbJob.import_zero_note)} 合计 ${yuan(cbJob.total_cents)} 元，其中计算器单 ${yuan(cbJob.calculator_only_cents)} 元。与「支出构成」为两种统计对象（作业归属 vs 付款现金），不可相加。`
    });

    /* C9 环比增长总表（加分） */
    const plP = periods[gran('pct')].pl;
    const wP = periods[gran('pct')].work;
    const wPMap = new Map(wP.map(r => [r.period, r]));
    const pctRows = plP.map(p => ({ ...p, jobs_count: (wPMap.get(p.period) || {}).jobs_count ?? null, jobs_pct: (wPMap.get(p.period) || {}).jobs_pct ?? null, area_mu: (wPMap.get(p.period) || {}).area_mu ?? null, area_pct: (wPMap.get(p.period) || {}).area_pct ?? null }));
    const pctTd = v => `<td class="num">${v == null ? '—' : (v > 0 ? '+' : '') + v + '%'}</td>`;
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

    /* C10 来源 / 收款人 / 人员 排行（加分，overview 前端聚合） */
    const srcRows = topAgg(ovRows, r => [r.referral_name], r => r.amount_cents);
    const colRows = topAgg(ovRows, r => [r.collector_name], r => r.paid_cents);
    const opRows = topAgg(ovRows, r => parseOps(r.operator_names), r => r.amount_cents);
    const miniTable = (head, rows, centsLabel) => `<table class="lg-table"><thead><tr><th>${head}</th><th>单数</th><th>${centsLabel}(元)</th></tr></thead><tbody>${
      rows.length ? rows.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${r.count}</td><td class="num">${yuan(r.cents)}</td></tr>`).join('') : '<tr><td colspan="3">暂无</td></tr>'
    }</tbody></table>`;
    const c10 = `<div class="lg-panel lg-chart-card">
      <h2>业务来源 / 收款人 / 作业人员 排行（加分项，总表口径前端聚合）</h2>
      <div class="lg-chart-grid lg-chart-grid--in">
        ${miniTable('业务来源', srcRows, '应收')}
        ${miniTable('收款人', colRows, '实收')}
        ${miniTable('作业人员', opRows, '应收')}
      </div>
      <div class="lg-chart-foot">导入历史来源/收款人/人员多为空（显示为 — 的不计入）；金额按作业聚合（应收=Σ账单金额、实收=Σ账单已收）。</div>
    </div>`;

    $main.innerHTML = `<div class="lg-chart-grid">${c1}${c2}${c3}${c4}${c5}${c6}${c7}${c8}${c9}${c10}</div>`;
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
      const m = btn.dataset.month;
      if (!/^\d{4}-\d{2}$/.test(m)) { T.toast('仅月粒度支持跳转总表', true); return; }
      T.state.month.overview = m;
      T.state.tab = 'overview';
      T.switchNav('overview');
      T.render().catch(e => T.toast(e.message, true));
    }
  }

  if (typeof window !== 'undefined') window.LedgerCharts = { renderTab, handleAct };
  if (typeof module !== 'undefined' && module.exports) module.exports = { renderTab, handleAct };
})();
