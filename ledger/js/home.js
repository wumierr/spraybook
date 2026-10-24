/* ============================================================
   ledger/js/home.js — B1 复合首页（记账主场默认页）
   三区：①钱况 KPI（双行值：本月大数字+全期小字；B6 升级 GridStack
        dashboard，本文件先出数据正确的简版）
        ②待办区（催收/待确认/待复核/待同步，彩色数字卡，点击跳对应页）
        ③当月明细平铺网格（作业行+支出行同屏混排按日期序，支出灰底；
          15 列对齐 U5 历史表语义=总表 17 列去备注/操作）
   数据全部来自现成端点（overview from/to + payments + summary + 列表数），
   零新端点；全局搜索在 app.js 头部（回车跳「作业明细」注入 q）。
   工具注入：window.__ledgerTools（app.js:1018），charts.js 同款。
   动作前缀 hm-（P3 教训：漏接委托正则=按钮静默无效）。
   ============================================================ */
(function () {
  'use strict';
  const Core = window.LedgerCore;
  let T = null;
  function tools() { T = window.__ledgerTools; return T; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ---------- 月份工具（当月明细网格的区间） ---------- */
  function todayYm() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function monthRange(ym) {
    const [y, m] = String(ym || todayYm()).split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const p = n => String(n).padStart(2, '0');
    return { from: `${y}-${p(m)}-01`, to: `${y}-${p(m)}-${p(last)}`, label: `${y}年${m}月` };
  }
  function monthShift(ym, delta) {
    const [y, m] = String(ym).split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /* ---------- 区①：钱况 KPI 双行值（本月大数字·全期小字；应收余额恒全期） ---------- */
  function kpiCards(sumMonth, sumAll, todoSync) {
    const card = (label, big, bigSub, sub) =>
      `<div class="lg-kpi-card"><div class="lg-kpi-label">${esc(label)}</div>
        <div class="lg-kpi-big">${big}</div><div class="lg-kpi-sub">${bigSub}</div>
        <div class="lg-kpi-sub">${sub}</div></div>`;
    return `<div class="lg-home-kpis">
      ${card('应收余额（全期）', Core.fmtYuan(sumAll.receivable_cents),
        `本月收入 ${Core.fmtYuan(sumMonth.income_cents)}`,
        `已收累计 ${Core.fmtYuan(sumAll.received_cents)}`)}
      ${card('本月收入', Core.fmtYuan(sumMonth.income_cents), '',
        `全期 ${Core.fmtYuan(sumAll.income_cents)}`)}
      ${card('本月支出', Core.fmtYuan(sumMonth.expense_cents), '',
        `全期 ${Core.fmtYuan(sumAll.expense_cents)}`)}
      ${card('预收余额（全期）', Core.fmtYuan(sumAll.prepaid_cents),
        `预支余额 ${Core.fmtYuan(sumAll.advance_to_worker_cents || 0)}`,
        `待结算作业 ${todoSync} 单`)}
    </div>`;
  }

  /* ---------- B6：钱况 GridStack 超小 dashboard（lg-home-grid-v1） ----------
     每卡一网格项：拖拽换位/删卡（重置恢复）/标题双击改名；GridStack 缺失或
     init 失败 → 静态堆叠降级（charts 页同款模式）；坏档整包回退默认。
     图表卡走 LedgerCharts.mountOne（复用实例注册表+ResizeObserver，不另起图表栈）。 */
  const HOME_GRID_KEY = 'lg-home-grid-v1';
  const HOME_CARD_DEFS = [
    { id: 'kpi', title: '钱况 KPI（双行值）', w: 3, h: 5 },
    { id: 'trend', title: '收支逐月趋势（全期）', w: 2, h: 8 },
    { id: 'debt', title: '欠款 TOP5 客户', w: 1, h: 8 }
  ];
  function homeGridDefault() {
    return { v: 1, cards: HOME_CARD_DEFS.map(c => c.id), titles: {}, layout: null };
  }
  /** 存档解析走 Core.parseHomeGridSave（core.js 纯函数，可单测；坏档→null→默认） */
  function parseHomeGridSave(raw) {
    return Core.parseHomeGridSave(raw, HOME_CARD_DEFS.map(c => c.id));
  }
  function loadHomeGrid() {
    let raw = null;
    try { raw = window.localStorage.getItem(HOME_GRID_KEY); } catch (e) { raw = null; }
    return parseHomeGridSave(raw) || homeGridDefault();
  }
  function saveHomeGrid(save) {
    try { window.localStorage.setItem(HOME_GRID_KEY, JSON.stringify(save)); } catch (e) { /* 隐私模式丢弃 */ }
  }
  let homeGrid = null; // GridStack 实例（进入首页 init；重进先 destroy）

  function cardTitle(def, titles) {
    return titles[def.id] || def.title;
  }
  function homeGridShell(save, gridMode) {
    const byId = new Map(HOME_CARD_DEFS.map(c => [c.id, c]));
    const items = save.cards.map(id => {
      const def = byId.get(id);
      const gs = gridMode ? `gs-w="${def.w}" gs-h="${def.h}"` : '';
      return `<div class="grid-stack-item" data-hcard="${id}" ${gs}>
        <div class="lg-hcard">
          <div class="lg-hcard-head">
            <span class="lg-hcard-title" data-hcard-title="${id}" title="双击改名">${esc(cardTitle(def, save.titles))}</span>
            <button class="lg-btn" data-act="hm-card-del" data-hcard="${id}" title="删除此卡（重置可恢复）">🗑</button>
          </div>
          <div class="lg-hcard-body" data-hbody="${id}"><div class="lg-hcard-loading">加载中…</div></div>
        </div>
      </div>`;
    }).join('');
    return `<div class="lg-panel">
      <h2>钱况 Dashboard${gridMode ? '（拖拽换位 · 标题双击改名 · 🗑 删卡）' : '（静态堆叠——GridStack 不可用，功能照常）'}</h2>
      <div class="${gridMode ? 'lg-grid grid-stack' : 'lg-chart-grid lg-grid-static'}" id="lgHomeGridWrap">${items}</div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="lg-btn" data-act="hm-grid-reset">↺ 重置默认布局（恢复删掉的卡）</button>
      </div>
    </div>`;
  }

  /** echarts option 简版构建（结构版固定双色；走 mountOne 注册表）
      B7 主题三态：暗色判定走 core.resolveTheme（lg-theme 显式档覆盖系统偏好） */
  function darkMode() {
    let saved = null;
    try { saved = window.localStorage.getItem(Core.THEME_KEY); } catch (e) { /* 忽略 */ }
    let sysDark = false;
    try { sysDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches; }
    catch (e) { /* 无 matchMedia 环境（node） */ }
    return Core.resolveTheme(saved, sysDark) === 'dark';
  }
  function trendOption(rows) {
    const dark = darkMode();
    const txt = dark ? '#8fa1b3' : '#6b7a89';
    const periods = rows.map(r => r.period);
    return {
      grid: { left: 56, right: 12, top: 30, bottom: 24 },
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { color: txt, fontSize: 11 } },
      xAxis: { type: 'category', data: periods, axisLabel: { color: txt, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: txt, fontSize: 10, formatter: v => (v / 10000).toFixed(0) + '万' } },
      series: [
        { name: '收入', type: 'line', smooth: true, data: rows.map(r => r.income_cents), itemStyle: { color: dark ? '#2fbf9a' : '#0e7c66' } },
        { name: '支出', type: 'line', smooth: true, data: rows.map(r => r.expense_cents), itemStyle: { color: dark ? '#e07b6a' : '#c0392b' } }
      ]
    };
  }
  function debtOption(rows) {
    const dark = darkMode();
    const txt = dark ? '#8fa1b3' : '#6b7a89';
    return {
      grid: { left: 80, right: 40, top: 8, bottom: 24 },
      tooltip: {},
      xAxis: { type: 'value', axisLabel: { color: txt, fontSize: 10 } },
      yAxis: { type: 'category', data: rows.map(r => r.name).reverse(), axisLabel: { color: txt, fontSize: 11 } },
      series: [{ type: 'bar', data: rows.map(r => r.receivable_cents).reverse(), itemStyle: { color: dark ? '#e07b6a' : '#c0392b' }, label: { show: true, position: 'right', color: txt, fontSize: 10, formatter: p => Core.fmtYuan(p.value) } }]
    };
  }

  /** 每卡独立加载（单卡失败卡内提示，不拖累其它卡） */
  async function loadHomeCard(id, ctx) {
    const body = document.querySelector(`[data-hbody="${id}"]`);
    if (!body) return;
    try {
      if (id === 'kpi') {
        body.innerHTML = kpiCards(ctx.sumMonth, ctx.sumAll, ctx.syncPending);
      } else if (id === 'trend') {
        const data = await T.Api.get('/api/reports/by-period' + T.Api.qs({ granularity: 'month' }));
        body.innerHTML = '<div class="lg-hchart" data-hchart="trend"></div>';
        const el = body.querySelector('[data-hchart="trend"]');
        // 双轴结构（pl=账簿轴 occurred_at / work=作业轴 job_date，两轴不可相加）——
        // 钱况趋势看资金口径，取 pl 轴（直接数组：[{period, income_cents, expense_cents…}]）
        const rows = (data && Array.isArray(data.pl)) ? data.pl : [];
        if (window.LedgerCharts) window.LedgerCharts.mountOne(el, { option: trendOption(rows) });
      } else if (id === 'debt') {
        const data = await T.Api.get('/api/reports/by-customer' + T.Api.qs({ include_all: '1' }));
        const rows = (data || []).filter(r => (r.receivable_cents || 0) > 0)
          .sort((a, b) => b.receivable_cents - a.receivable_cents).slice(0, 5);
        body.innerHTML = rows.length
          ? '<div class="lg-hchart" data-hchart="debt"></div>'
          : '<div class="lg-hcard-loading">当前没有未清应收 🎉</div>';
        const el = body.querySelector('[data-hchart="debt"]');
        if (el && window.LedgerCharts) window.LedgerCharts.mountOne(el, { option: debtOption(rows) });
      }
    } catch (e) {
      body.innerHTML = `<div class="lg-hcard-loading">此卡加载失败：${esc(e.message)}</div>`;
    }
  }

  /** 渲染钱况 dashboard（GridStack 可用=可拖拽；缺失=静态堆叠降级） */
  function renderMoneyPanel(ctx) {
    const save = loadHomeGrid();
    const G = (typeof window !== 'undefined') ? window.GridStack : null;
    const gridMode = !!(G && typeof G.init === 'function');
    const html = homeGridShell(save, gridMode);
    if (gridMode) {
      try {
        if (homeGrid) { homeGrid.destroy(false); homeGrid = null; }
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        const panel = wrap.firstElementChild;
        // 骨架进 DOM 后 init（init 收编 .grid-stack-item）；存档布局恢复
        setTimeout(() => {
          const target = document.getElementById('lgHomeGridWrap');
          if (!target) return;
          // v12 签名 init(options, container)——与 charts.js initGrid 同序（批3 遗留：原参数倒置致 init 静默失败、卡全叠放）
          homeGrid = G.init({ column: 3, cellHeight: 46, float: true, margin: 6 }, target);
          if (save.layout && save.layout.length) {
            try { homeGrid.load(save.layout.map(l => ({ ...l, el: target.querySelector(`[data-hcard="${l.id}"]`) }))); } catch (e) { /* 布局坏=用默认 auto */ }
          }
          homeGrid.on('change', () => {
            const cur = loadHomeGrid();
            try { cur.layout = homeGrid.save(true).map(s => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h })); saveHomeGrid(cur); } catch (e) { /* 忽略 */ }
            if (window.LedgerCharts && window.LedgerCharts.resizeAll) window.LedgerCharts.resizeAll();
          });
        }, 0);
        return panel.outerHTML;
      } catch (e) { /* init 失败 → 降级 */ }
    }
    return html;
  }

  /* ---------- 区②：待办区（四卡，点=跳页；B2 起催收卡=账龄 aging 口径） ---------- */
  function todoCards(todos) {
    const card = (t) => `<button class="lg-todo-card ${t.cls}" data-act="hm-todo" data-goto="${t.goto}" data-filter="${esc(t.filter || '')}">
        <span class="lg-todo-num">${t.num}</span><span class="lg-todo-label">${esc(t.label)}</span>
        <span class="lg-todo-sub">${esc(t.sub)}</span></button>`;
    return `<div class="lg-panel"><h2>待办</h2><div class="lg-home-todos">${todos.map(card).join('')}</div></div>`;
  }
  /** 催收卡文案（B2）：总额+N 户；90+ 桶有量时明示最老风险 */
  function collectionTodo(agingData) {
    if (!agingData || !agingData.total || agingData.total.due_cents <= 0) {
      return { cls: '', num: '0.00', label: '该催的款', sub: '没有未清应收（点击看账单）', goto: 'bills' };
    }
    const old = agingData.buckets.find(b => b.bucket === '90+');
    const oldWarn = old && old.due_cents > 0 ? `，其中 90 天以上 ${Core.fmtYuan(old.due_cents)}` : '';
    return {
      cls: 'red', num: Core.fmtYuan(agingData.total.due_cents),
      label: `该催的款（${agingData.total.parties} 户）`,
      sub: `${agingData.total.bills} 张未清${oldWarn}（点击按未收过滤）`,
      goto: 'bills', filter: 'unpaid'
    };
  }

  /* ---------- 区③：当月明细平铺网格（作业+支出混排，支出灰底） ---------- */
  const GRID_COLS = 15;
  function gridHtml(ov, paysAll, ym) {
    const { from, to, label } = monthRange(ym);
    // 作业行（overview 端点按区间取；Core.overviewRow 与总表同源映射）
    const jobs = (ov.rows || []).map(r0 => {
      const r = Core.overviewRow(r0);
      return {
        _sort: r.job_date || '', _pay: false,
        cells: [
          esc(r.job_no), esc(r.job_date || '—'), esc(r.customer_names || '—'), esc(r.addr || '—'),
          r.areaMu ?? '—', r.unitPriceYuan, esc(r.plantLabel || '—'),
          Core.fmtYuan(r0.amount_cents), Core.fmtYuan(r0.paid_cents), Core.fmtYuan(r0.due_cents),
          Core.fmtYuan(r0.discount_cents), esc(r.referral || '—'),
          esc((r.operators || []).join('、') || '—'), esc(r.collector || '—'),
          esc(r.statusText || '')
        ]
      };
    });
    // 支出行（payments 全量取回，前端滤当月；灰底行）
    const ymPrefix = String(ym);
    const pays = (paysAll || []).filter(p => String(p.occurred_at || '').slice(0, 7) === ymPrefix)
      .map(p => ({
        _sort: p.occurred_at || '', _pay: true,
        cells: [
          esc(p.payment_no), esc(String(p.occurred_at || '').slice(0, 10)), esc(p.payee_name || '—'), '—',
          '—', '—', esc(Core.MAPS.PAYMENT_CATEGORY[p.category] || p.category || '—'),
          Core.fmtYuan(p.amount_cents), '—', '—', '—', '—', '—', '—',
          p.status === 'void' ? '已作废' : '支出'
        ]
      }));
    const merged = [...jobs, ...pays].sort((a, b) => String(b._sort).localeCompare(String(a._sort)));
    const body = merged.map(r =>
      `<tr class="${r._pay ? 'lg-row-pay' : ''}">${r.cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    const jobAmount = (ov.rows || []).reduce((a, r) => a + (r.amount_cents || 0), 0);
    const jobPaid = (ov.rows || []).reduce((a, r) => a + (r.paid_cents || 0), 0);
    const paySum = (paysAll || []).filter(p => String(p.occurred_at || '').slice(0, 7) === ymPrefix && p.status !== 'void')
      .reduce((a, p) => a + (p.amount_cents || 0), 0);
    return `<div class="lg-panel">
      <h2>${esc(label)}明细（作业与支出同屏，支出灰底；当月区间 ${from}..${to}）</h2>
      <div style="margin-bottom:8px;display:flex;gap:4px;align-items:center">
        <button class="lg-btn" data-act="hm-month" data-ym="${monthShift(ym, -1)}">‹ 上月</button>
        <b>${esc(label)}</b>
        <button class="lg-btn" data-act="hm-month" data-ym="${monthShift(ym, 1)}">下月 ›</button>
        <button class="lg-btn" data-act="hm-month" data-ym="">回到本月</button>
        <button class="lg-btn" data-act="hm-goto-overview">到「作业明细」看全期/搜索 →</button>
      </div>
      <table class="lg-table lg-table--wide" data-colw="home-grid"><thead><tr>
        <th>单号</th><th>日期</th><th>客户</th><th>村·队</th><th>亩数</th><th>单价(元/亩)</th><th>目的</th>
        <th>金额/应收(元)</th><th>实收(元)</th><th>未收(元)</th><th>抹零(元)</th><th>来源</th><th>人员</th><th>收款人</th><th>状态</th>
      </tr></thead>
      <tbody>${body || `<tr><td colspan="${GRID_COLS}">本月暂无作业与支出</td></tr>`}</tbody>
      <tfoot><tr><td colspan="7">合计 ${merged.length} 行</td>
        <td class="num"><b>应收</b><br>${Core.fmtYuan(jobAmount)}</td>
        <td class="num"><b>实收</b><br>${Core.fmtYuan(jobPaid)}</td>
        <td class="num"><b>支出</b><br>${Core.fmtYuan(paySum)}</td>
        <td colspan="5"></td></tr></tfoot></table>
    </div>`;
  }

  /* ---------- 渲染入口（app.js 注册表调用） ---------- */
  async function renderTab($main) {
    tools();
    const ym = T.state.month.home || todayYm();
    const { from, to } = monthRange(ym);
    // 全部现成端点并行；任何一块失败不拖垮整页（首页是聚合页，单块降级提示）
    const [sumMonthR, sumAllR, ovR, paysR, stsR, batchesR, jobsR, agingR] = await Promise.allSettled([
      T.Api.summary(`?from=${from}&to=${to}`),
      T.Api.summary(),
      T.Api.overview(`?from=${from}&to=${to}`),
      T.Api.payments(),
      T.Api.settlements(),
      T.Api.importBatches(),
      T.Api.jobs(),
      T.Api.aging ? T.Api.aging() : Promise.resolve(null) // B2 催收卡数据源；旧服务端无此端点时降级
    ]);
    const val = (r, fb) => (r.status === 'fulfilled' ? r.value : fb);
    const sumMonth = val(sumMonthR, { income_cents: 0, expense_cents: 0, receivable_cents: 0, received_cents: 0, prepaid_cents: 0 });
    const sumAll = val(sumAllR, sumMonth);
    const ov = val(ovR, { rows: [] });
    const pays = val(paysR, []);
    const sts = val(stsR, []);
    const batches = val(batchesR, []);
    const jobs = val(jobsR, []);
    const agingData = val(agingR, null);

    // 待办四卡数据（B2：催收卡=账龄口径 总额+N 户+90+ 警示；aging 不可用回退 summary 应收）
    const toConfirm = sts.filter(s => s.status === 'draft').length;
    const reviewing = batches.filter(b => b.status === 'reviewing').length;
    const syncPending = jobs.filter(j => j.status === 'draft' || j.status === 'completed').length;
    const collectTodo = agingData
      ? collectionTodo(agingData)
      : { cls: 'red', num: Core.fmtYuan(sumAll.receivable_cents || 0), label: '该催的款', sub: '未清应收（账龄服务不可用，按汇总口径）', goto: 'bills', filter: 'unpaid' };
    const todos = [
      collectTodo,
      { cls: 'amber', num: String(toConfirm), label: '待确认结算', sub: '草稿结算单，确认后才记账', goto: 'settlements' },
      { cls: 'blue', num: String(reviewing), label: '待复核批次', sub: '导入/LLM 解析待人工复核', goto: 'review' },
      { cls: 'amber', num: String(syncPending), label: '待结算作业', sub: '已上报未生成结算的工单', goto: 'jobs' }
    ];
    $main.innerHTML = renderMoneyPanel({ sumMonth, sumAll, syncPending })
      + todoCards(todos)
      + gridHtml(ov, pays, ym);
    T.applyColWidths();
    // B6：每卡独立加载（GridStack init 在 renderMoneyPanel 的 setTimeout 里收编骨架）
    const ctx = { sumMonth, sumAll, syncPending };
    const save = loadHomeGrid();
    for (const id of save.cards) loadHomeCard(id, ctx);
  }

  /* ---------- 动作（app.js handleAct 委托 hm- 前缀转发至此） ---------- */
  function handleAct(btn, t) {
    tools();
    const act = btn.dataset.act;
    if (act === 'hm-todo') {
      const goto = btn.dataset.goto;
      const filter = btn.dataset.filter;
      if (filter) T.state.filter[goto] = { ...(T.state.filter[goto] || {}), status: filter };
      T.state.tab = goto;
      T.switchNav(goto);
      T.render().catch(e => T.toast(e.message, true));
      return;
    }
    if (act === 'hm-month') {
      T.state.month.home = btn.dataset.ym || todayYm();
      T.render().catch(e => T.toast(e.message, true));
      return;
    }
    if (act === 'hm-card-del') {
      // B6：删卡（存档 cards 移除；重置可恢复）
      const id = btn.dataset.hcard;
      const cur = loadHomeGrid();
      cur.cards = cur.cards.filter(c => c !== id);
      saveHomeGrid(cur);
      T.render().catch(e => T.toast(e.message, true));
      return;
    }
    if (act === 'hm-grid-reset') {
      // B6：重置默认布局（清存档）
      try { window.localStorage.removeItem(HOME_GRID_KEY); } catch (e) { /* 忽略 */ }
      T.render().catch(e => T.toast(e.message, true));
      return;
    }
    if (act === 'hm-goto-overview') {
      T.state.tab = 'overview';
      T.switchNav('overview');
      T.render().catch(e => T.toast(e.message, true));
    }
  }

  if (typeof window !== 'undefined') window.LedgerHome = { renderTab, handleAct };
})();
