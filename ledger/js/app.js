/* ============================================================
   ledger/js/app.js — 渲染与交互层（DOM 专用；纯函数在 core.js）
   原则：所有编辑走 API + edit_logs；确认后只读；撤回/作废二次确认。
   ============================================================ */
(function () {
  'use strict';
  const Core = window.LedgerCore;
  const Api = window.LedgerApi;
  const $main = document.getElementById('lgMain');
  const $toast = document.getElementById('lgToast');
  let parties = [];

  /* ---------- 基础 ---------- */
  function toast(msg, isErr) {
    $toast.textContent = msg;
    $toast.classList.toggle('err', !!isErr);
    $toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { $toast.hidden = true; }, 2600);
  }
  async function run(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      await render();
      return r;
    } catch (e) {
      toast(e.message, true);
      return undefined;
    }
  }
  function confirmThen(msg, fn) {
    if (window.confirm(msg + '\n（确认后将在账簿留痕）')) return run(fn);
    return Promise.resolve();
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function tag(text, cls) {
    // B3 四色语义：绿=已到手/完成（ok）、琥珀=待办（warn）、红=异常/欠款（err）、蓝=待复核（info）
    const c = cls || (text === '已收清' || text === '已确认' || text === '已结算' ? 'ok'
      : (text === '未收' || text === '待确认' || text === '待结算' || text === '已重开' ? 'warn'
      : (text === '已作废' ? 'err' : '')));
    return `<span class="lg-tag ${c}">${esc(text)}</span>`;
  }
  function actions(...btns) { return btns.filter(Boolean).join(' '); }

  /* ---------- B3 工序步骤条（工单→结算→账单→收款；结构版，视觉打磨=批4） ----------
     当前步高亮、已完成打绿✓；完成信号按当页数据更新（state._steps 缓存，
     每页渲染自己那步的信号，其余步沿用缓存——零额外请求）。块可点跳转。 */
  const STEP_DEFS = [
    { key: 'jobs', tab: 'jobs', label: '① 工单' },
    { key: 'settlements', tab: 'settlements', label: '② 结算' },
    { key: 'bills', tab: 'bills', label: '③ 账单' },
    { key: 'receipts', tab: 'receipts', label: '④ 收款' }
  ];
  function stepsHtml(current) {
    const sig = state._steps || (state._steps = {});
    return `<div class="lg-steps">${STEP_DEFS.map(s => {
      const cls = s.key === current ? 'cur' : (sig[s.key] ? 'done' : '');
      return `<button class="lg-step ${cls}" data-act="goto-tab" data-tab="${s.tab}" title="${sig[s.key] ? '已完成 ✓' : '去这一步'}">${s.label}${sig[s.key] && s.key !== current ? ' ✓' : ''}</button>`;
    }).join('<span class="lg-step-arrow">→</span>')}</div>`;
  }

  /* ---------- 页签：工单 ---------- */
  function renderJobs(jobsAll) {
    const rowsAll = jobsAll.map(j => ({
      ...Core.jobRow(j), _month: (j.job_date || '').slice(0, 7), _note: j.note || '', _income: j.income_cents
    }));
    state._steps = state._steps || {};
    state._steps.jobs = rowsAll.length > 0; // B3 步骤条信号：已有工单=步①完成
    const rows = pipeFilters(byMonth(rowsAll, '_month', 'jobs'), 'jobs', { q: ['job_no', '_note'] });
    const body = rows.map(r => `<tr>
        <td>${esc(r.job_no)}</td><td>${esc(r.job_date)}</td><td>${esc(r.type)}</td>
        <td>${tag(r.statusText)}</td><td>${esc(r.primary)}</td>
        <td class="num">${r.incomeYuan}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="job-detail" data-id="${r.id}">详情/更正</button>`,
          r.canSettle ? `<button class="lg-btn primary" data-act="job-settle" data-id="${r.id}">生成结算</button>` : '',
          r.canVoid ? `<button class="lg-btn danger" data-act="job-void" data-id="${r.id}" data-no="${esc(r.job_no)}">作废</button>` : ''
        )}</td>
      </tr><tr hidden><td colspan="7" class="lg-detail-slot" data-slot="${r.id}"></td></tr>`).join('');
    return `${stepsHtml('jobs')}<div class="lg-panel">
      <h2>现场工单（计算器上报，只读执行数据；金额可更正）</h2>
      ${toolbarHtml('jobs', { searchPh: '单号/备注' })}
      ${monthStrip('jobs', rowsAll, '_month')}
      <table class="lg-table" data-colw="jobs"><thead><tr>
        <th>单号</th><th>日期</th><th>类型</th><th>状态</th><th>规模</th><th>收入(元)</th><th>操作</th>
      </tr></thead><tbody>${body || `<tr><td colspan="7">${Core.emptyState('🛩️', '暂无工单——计算器作业后点「同步到账本」，或导入记账文本',
        [{ act: 'goto-tab', tab: 'review', label: '去导入', icon: '📥', title: 'LLM 文本 / 作业包 / Excel' }], { cell: true })}</td></tr>`}</tbody>
      ${tfootHtml(5, rows, [['收入', sumCents(rows, '_income')]], 1)}</table>
    </div>`;
  }

  async function jobDetail(slot, id) {
    const j = await Api.job(id);
    const r = Core.jobRow(j);
    const lines = (j.settlement_lines || []).map(l => `
      <tr>
        <td>${esc(l.farmer_name)}${l.kind === 'extra' ? ` <span class="lg-tag warn">另按 ${Core.fmtYuan(l.unit_price_cents)} 元/亩</span>` : ''}</td>
        <td class="num">${Core.fmtYuan(l.spray_fee_cents)}</td>
        <td>${l.used_sets != null ? Number(l.used_sets).toFixed(2) : '—'} 套（自备 ${l.self_sets || 0}）</td>
        <td class="num">${Core.fmtYuan(l.pesticide_fee_cents)}</td>
        <td>${l.included ? '包药' : '不包药'}</td>
        ${r.canEditLines ? (l.kind === 'extra'
          ? `<td><input data-line="${l.id}" data-field="spray_fee_cents" value="${(l.spray_fee_cents || 0) / 100}" type="number" step="0.01" min="0" title="金额(元)"></td>`
          : `<td>
          <input data-line="${l.id}" data-field="spray_fee_cents" value="${(l.spray_fee_cents || 0) / 100}" type="number" step="0.01" min="0" title="打药费(元)">
          <input data-line="${l.id}" data-field="pesticide_fee_cents" value="${(l.pesticide_fee_cents || 0) / 100}" type="number" step="0.01" min="0" title="药钱(元)">
        </td>`) : '<td></td>'}
      </tr>`).join('');
    // 成本构成快照（007，仅计算器来源单有值）。B3：电池折旧列语义=元/次充电费率，
    // 明细处标注口径并换算合计（charge_count=充电次数）。
    const batteryTotal = (j.battery_depreciation_cents != null && j.charge_count != null)
      ? `（${j.charge_count} 次 ≈ ${Core.fmtYuan(j.battery_depreciation_cents * j.charge_count)}）` : '';
    const parts = [
      ['油费', j.fuel_expense_cents], [`电池折旧(元/次)${batteryTotal}`, j.battery_depreciation_cents],
      ['人工', j.labor_cost_cents], ['药剂', j.pesticide_cost_cents],
      ['设备分摊', j.equipment_cost_cents], ['杂费', j.misc_cost_cents]
    ].filter(([, v]) => v != null)
      .map(([k, v]) => `${k} ${Core.fmtYuan(v)}`).join(' · ');
    const subsidyText = j.subsidy_cents != null ? ` · 含农机补贴 ${Core.fmtYuan(j.subsidy_cents)}` : '';
    // 地块明细（P3：数据已在库，露出来）
    const plotRows = (j.plots || []).map(p => `<tr>
        <td>${esc(p.plot_name)}</td><td>${esc(p.farmer_name || '—')}</td><td>${p.group_no ?? '—'}</td>
        <td class="num">${p.area_mu ?? '—'}</td><td class="num">${p.water_l ?? '—'}</td>
        <td class="num">${p.flight_min != null ? Number(p.flight_min).toFixed(1) : '—'}</td>
        <td class="num">${p.pesticide_sets != null ? Number(p.pesticide_sets).toFixed(2) : '—'}</td>
        <td class="num">${p.completed_l ?? '—'}</td>
      </tr>`).join('');
    const batteryText = (j.battery_cycles || []).map(b => `${esc(b.battery_name)} × ${b.count}`).join(' · ');
    slot.innerHTML = `
      <div class="lg-detail">
        <div>备注：${esc(j.note || '—')}　·　机器：${esc(j.plant_type_name || '—')}　·　亩数 ${j.total_area_mu ?? '—'}　·　水量 ${j.total_water_l ?? '—'}L　·　趟数 ${j.total_trips ?? '—'}　·　充电 ${j.charge_count ?? '—'} 次${batteryText ? '　·　电池：' + batteryText : ''}</div>
        <div style="margin-top:8px">
          <button class="lg-btn primary" data-act="job-card" data-id="${j.id}" title="生成客户分享用结算卡图片（只含圈地面积口径）">📤 生成结算卡</button>
        </div>
        ${parts ? `<div>成本构成：${parts}　→　合计 <b>${Core.fmtYuan(j.total_cost_cents)}</b>${subsidyText}</div>` : ''}
        ${plotRows ? `<h2 style="margin-top:8px">地块明细</h2>
        <table class="lg-table" data-colw="job-plots"><thead><tr><th>地块</th><th>农户</th><th>组</th><th>面积(亩)</th><th>水量(L)</th><th>飞行(分)</th><th>用药(套)</th><th>完成(L)</th></tr></thead>
        <tbody>${plotRows}</tbody></table>` : ''}
        <h2 style="margin-top:8px">分家明细</h2>
        <table class="lg-table" data-colw="job-lines"><thead><tr><th>农户</th><th>打药费</th><th>用量</th><th>药钱</th><th>口径</th>${r.canEditLines ? '<th>更正(元) 打药费/药钱</th>' : ''}</tr></thead>
        <tbody>${lines || '<tr><td colspan="6">无分家明细（吊运）</td></tr>'}</tbody></table>
        ${r.canEditLines ? `<div style="margin-top:8px">
          <label>备注更正 <input id="jobNoteInput" value="${esc(j.note || '')}"></label>
          <button class="lg-btn primary" data-act="job-save-lines" data-id="${j.id}">保存更正</button>
        </div>` : ''}
      </div>`;
  }

  /* ---------- 页签：结算 ---------- */
  function renderSettlements(listAll) {
    const rowsAll = listAll.map(s0 => ({
      ...Core.settlementRow(s0), _total: s0.total_receivable_cents, _paid: s0.paid_cents,
      _spray: s0.total_spray_fee_cents, _pesticide: s0.total_pesticide_fee_cents
    }));
    state._steps = state._steps || {};
    state._steps.settlements = rowsAll.some(s => s.status === 'confirmed'); // B3：有已确认结算=步②完成
    const list = pipeFilters(byMonth(rowsAll, 'job_date', 'settlements'), 'settlements', { q: ['settlement_no', 'job_no'] });
    const rows = list.map(s => `<tr>
        <td>${esc(s.settlement_no)}</td><td>${esc(s.job_no)}</td><td>${esc(s.job_date)}</td>
        <td>${tag(s.statusText)}</td>
        <td class="num">${s.sprayYuan}</td><td class="num">${s.pesticideYuan}</td>
        <td class="num"><b>${s.totalYuan}</b></td><td class="num">${s.paidYuan}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="st-detail" data-id="${s.id}">分项/账单</button>`,
          s.canEdit ? `<button class="lg-btn" data-act="st-edit" data-id="${s.id}">编辑分项</button>` : '',
          s.canConfirm ? `<button class="lg-btn primary" data-act="st-confirm" data-id="${s.id}" data-no="${esc(s.settlement_no)}">确认</button>` : '',
          s.canReopen ? `<button class="lg-btn" data-act="st-reopen" data-id="${s.id}" data-no="${esc(s.settlement_no)}">撤回确认</button>` : '',
          s.canVoid ? `<button class="lg-btn danger" data-act="st-void" data-id="${s.id}" data-no="${esc(s.settlement_no)}" data-confirmed="${s.status === 'confirmed' ? 1 : 0}">作废</button>` : ''
        )}</td>
      </tr><tr hidden><td colspan="9" class="lg-detail-slot" data-slot="st${s.id}"></td></tr>`).join('');
    return `${stepsHtml('settlements')}<div class="lg-panel">
      <h2>结算单（确认后生成账单与分录；撤回=红冲重开）</h2>
      ${toolbarHtml('settlements', { statusMap: Core.MAPS.SETTLEMENT_STATUS, searchPh: '结算号/作业单号' })}
      ${monthStrip('settlements', listAll, 'job_date')}
      <table class="lg-table" data-colw="st-main"><thead><tr>
        <th>结算号</th><th>作业单</th><th>日期</th><th>状态</th>
        <th>作业费(元)</th><th>药费(元)</th><th>应收合计</th><th>已收</th><th>操作</th>
      </tr></thead><tbody>${rows || `<tr><td colspan="9">${Core.emptyState('🧾', '暂无结算单——在工单页对已完成作业「生成结算」并确认，才会出账单与分录',
        [{ act: 'goto-tab', tab: 'jobs', label: '去工单页', icon: '🛩️' }], { cell: true })}</td></tr>`}</tbody>
      ${tfootHtml(4, list, [['作业费', sumCents(list, '_spray')], ['药费', sumCents(list, '_pesticide')], ['应收', sumCents(list, '_total')], ['已收', sumCents(list, '_paid')]], 1)}</table>
    </div>`;
  }

  async function settlementDetail(slot, id, editable) {
    const s = await Api.settlement(id);
    const items = s.items.map(it => editable ? `
      <tr>
        <td>${esc(it.farmer_name)}</td>
        <td><input data-item="${it.id}" data-field="spray_fee_cents" value="${((it.spray_fee_cents || 0) / 100).toFixed(2)}" type="number" step="0.01" min="0"></td>
        <td><input data-item="${it.id}" data-field="pesticide_fee_cents" value="${((it.pesticide_fee_cents || 0) / 100).toFixed(2)}" type="number" step="0.01" min="0"></td>
        <td>${it.included ? '包药' : '不包药'}</td>
      </tr>` : `
      <tr><td>${esc(it.farmer_name)}</td>
        <td class="num">${Core.fmtYuan(it.spray_fee_cents)}</td>
        <td class="num">${Core.fmtYuan(it.pesticide_fee_cents)}</td>
        <td>${it.included ? '包药' : '不包药'}</td></tr>`).join('');
    const bills = s.bills.map(b => {
      const r = Core.billRow(b);
      return `<tr><td>${esc(r.bill_no)}</td><td>${esc(r.party)}</td><td>${tag(r.statusText)}</td>
        <td class="num">${r.payableYuan}</td><td class="num">${r.paidYuan}</td></tr>`;
    }).join('');
    slot.innerHTML = `
      <div class="lg-detail">
        <table class="lg-table" data-colw="st-items"><thead><tr><th>农户</th><th>作业费(元)</th><th>药钱(元)</th><th>口径</th></tr></thead>
          <tbody>${items || '<tr><td colspan="4">无分项</td></tr>'}</tbody></table>
        ${editable ? `<button class="lg-btn primary" data-act="st-save-items" data-id="${s.id}" style="margin-top:8px">保存分项</button>` : ''}
        ${s.bills.length ? `<h2 style="margin-top:12px">账单</h2>
        <table class="lg-table" data-colw="st-bills"><thead><tr><th>账单号</th><th>客户</th><th>状态</th><th>应收</th><th>已收</th></tr></thead><tbody>${bills}</tbody></table>` : ''}
      </div>`;
  }

  /* ---------- 页签：账单 ---------- */
  function renderBills(billsAll) {
    const em = editMode('bills');
    const rowsAll = billsAll.map(b0 => ({
      ...Core.billRow(b0), _month: String(b0.issued_at || '').slice(0, 7),
      _amount: b0.amount_cents, _adjust: b0.adjust_cents, _payable: Core.billPayable(b0), _paid: b0.paid_cents
    }));
    state._steps = state._steps || {};
    state._steps.bills = billsAll.some(b => b.status && b.status !== 'void'); // B3：有非作废账单=步③完成
    const list = pipeFilters(byMonth(rowsAll, '_month', 'bills'), 'bills', { q: ['bill_no', 'party'], party: 'party' });
    state._bulkSel = state._bulkSel || new Set(); // B4 批量已收勾选（重绘保留；离开页面不清，回来仍在）
    const rows = list.map(b => {
      // 编辑模式：未收款行金额/调整直填；已收款行锁定（服务端 patchBill 拒绝已收款改单）
      // 注意：type=number 的 value 必须是不带千分位的纯数字，否则浏览器清空 value 误判变更
      const editable = b.canEdit;
      const amountCell = em
        ? (editable
          ? `<input data-ek="${b.id}" data-f="amount_cents" type="number" step="0.01" min="0" value="${(b._amount / 100).toFixed(2)}" data-orig="${(b._amount / 100).toFixed(2)}">`
          : `<span title="已有收款，不可改金额（先撤回结算）">🔒 ${b.amountYuan}</span>`)
        : b.amountYuan;
      const adjustCell = em
        ? (editable
          ? `<input data-ek="${b.id}" data-f="adjust_cents" type="number" step="0.01" value="${((b._adjust || 0) / 100).toFixed(2)}" data-orig="${((b._adjust || 0) / 100).toFixed(2)}">`
          : b.adjustYuan)
        : b.adjustYuan;
      // B4 批量已收：未清账单行首勾选（编辑态隐藏避免与输入框焦点打架）
      const checkCell = (!em && b.canReceive)
        ? `<input type="checkbox" class="lg-bulk-check" data-bulk="${b.id}" ${state._bulkSel.has(b.id) ? 'checked' : ''} title="勾选加入批量已收">`
        : '';
      return `<tr>
        <td>${checkCell}</td>
        <td>${esc(b.bill_no)}</td>${custCell(b.party)}<td>${tag(b.statusText)}</td>
        <td class="num">${amountCell}</td><td class="num">${adjustCell}</td>
        <td class="num"><b>${b.payableYuan}</b></td><td class="num">${b.paidYuan}</td>
        <td>${actions(
          b.canReceive ? `<button class="lg-btn primary" data-act="bill-receive" data-id="${b.id}" data-party="${b.party_id || ''}" data-unpaid="${b.unpaidCents}">登记收款</button>` : '',
          b.canEdit && !em ? `<button class="lg-btn" data-act="bill-edit" data-id="${b.id}">改金额/抹零</button>` : '',
          `<button class="lg-btn" data-act="usage-view" data-bill-id="${b.id}" data-bill-no="${esc(b.bill_no)}" title="本账单所属作业的用药明细">💊 用药</button>`
        )}</td>
      </tr>`;
    }).join('');
    return `${stepsHtml('bills')}<div class="lg-panel">
      <h2>账单（确认后只读；未收可改金额/抹零；收款在「收款」页或下方按钮）</h2>
      ${toolbarHtml('bills', { statusMap: Core.MAPS.BILL_STATUS, searchPh: '客户名/账单号' })}
      ${monthStrip('bills', rowsAll, '_month')}
      <table class="lg-table" data-colw="bills"><thead><tr>
        <th><input type="checkbox" id="lgBulkAll" title="全选当前列表的未收账单"></th><th>账单号</th><th>客户</th><th>状态</th><th>金额</th><th>调整</th><th>应收</th><th>已收</th><th>操作</th>
      </tr></thead><tbody>${rows || `<tr><td colspan="9">${Core.emptyState('🧾', '暂无账单——结算确认后自动生成；期初旧账走「主数据→期初补录」',
        [{ act: 'goto-tab', tab: 'settlements', label: '去看结算', icon: '🧾' }], { cell: true })}</td></tr>`}</tbody>
      ${tfootHtml(4, list, [['金额', sumCents(list, '_amount')], ['调整', sumCents(list, '_adjust')], ['应收', sumCents(list, '_payable')], ['已收', sumCents(list, '_paid')]], 1)}</table>
    </div>
    ${bulkBarHtml(list)}`;
  }

  /** B4 批量已收浮动条：勾选 N 张未收账单后出现；逐张走既有 createReceipt 挂单通路（零新端点） */
  function bulkBarHtml(list) {
    const sel = list.filter(b => state._bulkSel.has(b.id));
    if (!sel.length) return '';
    const total = sel.reduce((a, b) => a + (b.unpaidCents || 0), 0);
    return `<div class="lg-bulk-bar" id="lgBulkBar">
      已勾选 <b>${sel.length}</b> 张 · 合计未收 <b>${Core.fmtYuan(total)}</b>
      <button class="lg-btn primary" data-act="bill-bulk-receive">✔ 批量已收（按未收金额全额收款）</button>
      <button class="lg-btn" data-act="bill-bulk-clear">清空勾选</button>
    </div>`;
  }

  /* ---------- 页签：收款 ---------- */
  function renderReceipts(listAll) {
    const rowsAll = listAll.map(r0 => ({ ...r0, _amount: r0.amount_cents }));
    state._steps = state._steps || {};
    state._steps.receipts = listAll.some(r => r.status === 'active'); // B3：有有效收款=步④完成
    const list = pipeFilters(byMonth(rowsAll, 'occurred_at', 'receipts'), 'receipts',
      { q: ['receipt_no', 'party_name', 'note'], party: 'party_name' });
    const rows = list.map(r0 => {
      const adv = r0.from_advance_id ? ' · 预收抵扣' : '';
      const alloc = parseAlloc(r0.allocations);
      const allocBtn = alloc.length
        ? `<button class="lg-btn" data-act="rc-alloc" data-id="${r0.id}" data-alloc="${esc(JSON.stringify(alloc))}" data-amount="${r0.amount_cents}">核销 ${alloc.length} 张</button>`
        : '';
      const noteCell = editMode('receipts')
        ? `<input data-ek="${r0.id}" data-f="note" value="${esc(r0.note || '')}" data-orig="${esc(r0.note || '')}" placeholder="备注"> <input data-ek="${r0.id}" data-f="collector_name" value="${esc(r0.collector_name || '')}" data-orig="${esc(r0.collector_name || '')}" placeholder="经手人" class="lg-inp--sm">`
        : `${esc(r0.note || '')}${r0.collector_name ? `<span class="lg-tag">经手:${esc(r0.collector_name)}</span>` : ''}`;
      return `<tr>
        <td>${esc(r0.receipt_no)}</td>${custCell(r0.party_name || '—')}
        <td class="num">${editMode('receipts') ? `<input data-ek="${r0.id}" data-f="amount_cents" type="number" step="0.01" value="${(r0.amount_cents / 100).toFixed(2)}" data-orig="${(r0.amount_cents / 100).toFixed(2)}">` : `<b>${Core.fmtYuan(r0.amount_cents)}</b>`}</td>
        <td>${editMode('receipts') ? `<input data-ek="${r0.id}" data-f="method" value="${esc(r0.method)}" data-orig="${esc(r0.method)}">` : esc(Core.MAPS.METHOD[r0.method] || r0.method)}${adv}${allocBtn ? ' ' + allocBtn : ''}</td>
        <td>${esc(r0.bill_no || (alloc.length ? '按客户核销' : '—'))}</td><td>${(r0.occurred_at || '').slice(0, 10)}</td>
        <td>${noteCell}</td>
        <td>${r0.status === 'void' ? tag('已作废', 'err') : actions(
          `<button class="lg-btn danger" data-act="rc-void" data-id="${r0.id}" data-no="${esc(r0.receipt_no)}">作废</button>`
        )}</td>
      </tr>`;
    }).join('');
    const liveRows = list.filter(r => r.status !== 'void');
    const custOpts = parties.filter(p => p.type === 'customer')
      .map(p => `<option value="${p.id}">${esc(p.name)}${p.village ? '（' + esc(p.village) + (p.team ? p.team + '队' : '') + '）' : ''}</option>`).join('');
    return `${stepsHtml('receipts')}<div class="lg-panel">
      <h2>快速录入（Tab 走字段 · 回车落库 · 焦点回到日期格）</h2>
      <div class="lg-quickbar" id="lgQuickRc">
        <input id="qrcDate" type="date" value="${todayStr()}" title="收款日期（B5/N-9：可补记昨日）">
        <input id="qrcParty" list="qrcPartyList" placeholder="客户（输入筛选，回车登记）" autocomplete="off">
        <datalist id="qrcPartyList">${parties.filter(p => p.type === 'customer').map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>
        <input id="qrcAmount" type="number" step="0.01" min="0.01" placeholder="金额(元)">
        <select id="qrcMethod"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="bank">银行</option></select>
        <input id="qrcNote" placeholder="备注（选填）">
        <button class="lg-btn" data-act="rc-mix-open" title="按客户收款且可改每张账单的核销分配（FIFO 预案可编辑）">🔀 混合核销</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>按客户收款（一笔钱自动按最早未清账单核销，余额转预收）</h2>
      <div class="lg-form">
        <label>客户<select id="rcCust">${custOpts}</select></label>
        <label>金额(元)<input id="rcCustAmount" type="number" step="0.01" min="0.01"></label>
        <label>方式<select id="rcCustMethod"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="bank">银行</option></select></label>
        <label>日期<input id="rcCustDate" type="date" value="${todayStr()}" title="B5/N-9：补记历史日期"></label>
        <label>经手人<input id="rcCustCollector" placeholder="默认记账人"></label>
        <label>备注<input id="rcCustNote" placeholder="选填"></label>
        <button class="lg-btn primary" data-act="rc-cust-save">按客户收款</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>收款记录（作废=反向分录+账单回退）</h2>
      ${toolbarHtml('receipts', { searchPh: '客户名/单号/备注' })}
      ${monthStrip('receipts', listAll, 'occurred_at')}
      <table class="lg-table" data-colw="receipts"><thead><tr>
        <th>单号</th><th>客户</th><th>金额(元)</th><th>方式</th><th>账单</th><th>日期</th><th>备注/经手人</th><th>操作</th>
      </tr></thead><tbody>${rows || `<tr><td colspan="8">${Core.emptyState('💰', '暂无收款——账单页点「登记收款」，或在上方表单按客户收款（自动 FIFO 核销）',
        [{ act: 'goto-tab', tab: 'bills', label: '去账单页', icon: '🧾' }], { cell: true })}</td></tr>`}</tbody>
      ${tfootHtml(2, liveRows, [['实收', sumCents(liveRows, '_amount')]], 5)}</table>
    </div>`;
  }
  function parseAlloc(json) {
    try { return json ? (JSON.parse(json).items || []) : []; } catch (e) { return []; }
  }

  function receiveForm(billId, partyId, unpaidCents) {
    const opts = parties.filter(p => p.type === 'customer')
      .map(p => `<option value="${p.id}" ${p.id === partyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const advOpts = (state._advances || []).filter(a => a.direction === 'prepaid_by_customer' && a.status === 'open' && a.balance_cents > 0)
      .map(a => `<option value="${a.id}">${esc(a.party_name || a.id)}（余 ${Core.fmtYuan(a.balance_cents)}）</option>`).join('');
    return `<div class="lg-detail">
      <div class="lg-form">
        <label>金额(元)<input id="rcAmount" type="number" step="0.01" min="0.01" value="${(unpaidCents / 100).toFixed(2)}"></label>
        <label>方式<select id="rcMethod"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="bank">银行</option></select></label>
        <label>日期<input id="rcDate" type="date" value="${todayStr()}" title="B5/N-9：补记历史日期"></label>
        <label>经手人<input id="rcCollector" placeholder="选填"></label>
        <label>预收抵扣(可选)<select id="rcAdvance"><option value="">不用预收</option>${advOpts}</select></label>
        <label>备注<input id="rcNote" placeholder="选填"></label>
        <button class="lg-btn primary" data-act="rc-save" data-bill="${billId}" data-party="${partyId || ''}">确认收款</button>
      </div></div>`;
  }

  /* ---------- 页签：支出 ---------- */
  async function renderPayments(listAll) { // C3 起含作业 datalist 预取（async）
    const catOpts = Object.entries(Core.MAPS.PAYMENT_CATEGORY)
      .map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    const advOpts = (state._advances || []).filter(a => a.direction === 'advance_to_worker' && a.status !== 'void' && a.balance_cents > 0)
      .map(a => `<option value="${a.id}">${esc(a.party_name || a.id)}（余 ${Core.fmtYuan(a.balance_cents)}）</option>`).join('');
    const rowsAll = listAll.map(p0 => ({ ...p0, _amount: p0.amount_cents, _cat: Core.MAPS.PAYMENT_CATEGORY[p0.category] || p0.category }));
    const list = pipeFilters(byMonth(rowsAll, 'occurred_at', 'payments'), 'payments',
      { q: ['payment_no', 'payee_name', 'note', '_cat'], category: true });
    const rows = list.map(p0 => `<tr>
        <td>${esc(p0.payment_no)}</td><td>${editMode('payments') ? `<select data-ek="${p0.id}" data-f="category" data-orig="${esc(p0.category)}">${catOpts.replace(`value="${p0.category}"`, `value="${p0.category}" selected`)}</select>` : esc(p0._cat)}</td>
        <td class="num">${editMode('payments') ? `<input data-ek="${p0.id}" data-f="amount_cents" type="number" step="0.01" value="${(p0.amount_cents / 100).toFixed(2)}" data-orig="${(p0.amount_cents / 100).toFixed(2)}">` : `<b>${Core.fmtYuan(p0.amount_cents)}</b>`}</td>
        <td>${esc(p0.payee_name || '—')}</td><td>${(p0.occurred_at || '').slice(0, 10)}</td>
        <td>${editMode('payments') ? `<input data-ek="${p0.id}" data-f="note" value="${esc(p0.note || '')}" data-orig="${esc(p0.note || '')}">` : esc(p0.note || '')}</td>
        <td>${p0.status === 'void' ? tag('已作废', 'err') : actions(
          `<button class="lg-btn danger" data-act="pm-void" data-id="${p0.id}" data-no="${esc(p0.payment_no)}">作废</button>`
        )}</td>
      </tr>`).join('');
    const liveRows = list.filter(r => r.status !== 'void');
    // C3：支出挂作业（payments.job_id 起用）——近期作业单号 datalist（输入单号关联，成本归集到作业）
    let recentJobs = state._jobsRecent || [];
    try { recentJobs = state._jobsRecent = await Api.jobs(); } catch (e) { /* 用旧缓存 */ }
    const jobOpts = (recentJobs || []).filter(j => j.status !== 'void')
      .slice(0, 100).map(j => `<option value="${esc(j.job_no)}">${esc(j.job_no)} ${esc(j.plant_type_name || j.job_type || '')} ${(j.job_date || '').slice(5)}</option>`).join('');
    return `<div class="lg-panel">
      <h2>登记支出（油费/药费/维修/吃饭/设备/人工）</h2>
      <div class="lg-form">
        <label>类别<select id="pmCategory">${catOpts}</select></label>
        <label>金额(元)<input id="pmAmount" type="number" step="0.01" min="0.01"></label>
        <label>支付方式<select id="pmMethod"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option></select></label>
        <label>日期<input id="pmDate" type="date" value="${todayStr()}" title="B5/N-9：补记历史日期"></label>
        <label>关联作业<input id="pmJob" list="pmJobList" placeholder="选填：单号关联" autocomplete="off"><datalist id="pmJobList">${jobOpts}</datalist></label>
        <label>从预支付款<select id="pmAdvance"><option value="">不使用</option>${advOpts}</select></label>
        <label>备注*<input id="pmNote" placeholder="必填：如 中石化加油站"></label>
        <button class="lg-btn primary" data-act="pm-save">登记</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>支出记录（作废=反向分录）</h2>
      ${toolbarHtml('payments', { category: true, searchPh: '收款方/单号/备注' })}
      ${monthStrip('payments', listAll, 'occurred_at')}
      <table class="lg-table" data-colw="payments"><thead><tr>
        <th>单号</th><th>类别</th><th>金额(元)</th><th>收款方</th><th>日期</th><th>备注</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无支出</td></tr>'}</tbody>
      ${tfootHtml(2, liveRows, [['支出', sumCents(liveRows, '_amount')]], 4)}</table>
    </div>`;
  }

  /* ---------- 页签：预收预支 ---------- */
  function renderAdvances(listAll) {
    const opts = parties.map(p => `<option value="${p.id}">${esc(p.name)}（${esc(Core.MAPS.PARTY_TYPE[p.type] || p.type)}）</option>`).join('');
    const rowsAll = listAll.map(a0 => ({
      ...a0, _amount: a0.amount_cents, _balance: a0.balance_cents,
      _note: a0.note || ''
    }));
    const list = pipeFilters(byMonth(rowsAll, 'occurred_at', 'advances'), 'advances',
      { q: ['advance_no', 'party_name', 'note'], party: 'party_name' });
    const rows = list.map(a0 => `<tr>
        <td>${esc(a0.advance_no)}</td>${custCell(a0.party_name || '—')}
        <td>${tag(Core.MAPS.ADVANCE_DIRECTION[a0.direction] || a0.direction)}</td>
        <td class="num">${Core.fmtYuan(a0.amount_cents)}</td>
        <td class="num"><b>${Core.fmtYuan(a0.balance_cents)}</b></td>
        <td>${(a0.occurred_at || '').slice(0, 10)}</td>
        <td>${editMode('advances') ? `<input data-ek="${a0.id}" data-f="note" value="${esc(a0._note)}" data-orig="${esc(a0._note)}">` : esc(a0._note)}</td>
        <td>${a0.status === 'void' ? tag('已作废', 'err') : actions(
          a0.direction === 'advance_to_worker' ? `<button class="lg-btn" data-act="adv-settle" data-id="${a0.id}" data-no="${esc(a0.advance_no)}" data-balance="${a0.balance_cents}">冲销</button>` : '',
          `<button class="lg-btn danger" data-act="adv-void" data-id="${a0.id}" data-no="${esc(a0.advance_no)}">作废</button>`
        )}</td>
      </tr>`).join('');
    const liveRows = list.filter(r => r.status !== 'void');
    return `<div class="lg-panel">
      <h2>登记预收 / 预支</h2>
      <div class="lg-form">
        <label>对象<select id="advParty">${opts}</select></label>
        <label>类型<select id="advDirection"><option value="prepaid_by_customer">客户预收</option><option value="advance_to_worker">员工预支</option></select></label>
        <label>金额(元)<input id="advAmount" type="number" step="0.01" min="0.01"></label>
        <label>日期<input id="advDate" type="date" value="${todayStr()}" title="B5/N-9：补记历史日期"></label>
        <label>备注<input id="advNote" placeholder="选填"></label>
        <button class="lg-btn primary" data-act="adv-save">登记</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>预收/预支台账（余额=可用；预收抵账在收款页选"预收抵扣"；编辑模式可改备注）</h2>
      ${toolbarHtml('advances', { searchPh: '对象/单号/备注' })}
      ${monthStrip('advances', listAll, 'occurred_at')}
      <table class="lg-table" data-colw="advances"><thead><tr>
        <th>单号</th><th>对象</th><th>类型</th><th>金额</th><th>余额</th><th>日期</th><th>备注</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="8">暂无</td></tr>'}</tbody>
      ${tfootHtml(3, liveRows, [['金额', sumCents(liveRows, '_amount')], ['余额', sumCents(liveRows, '_balance')]], 3)}</table>
    </div>`;
  }

  /* ---------- 页签：分成 ---------- */
  function renderSplits(list) {
    const opts = parties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const rows = list.map(s0 => `<tr>
        <td>${esc(s0.party_name || '—')}</td>
        <td class="num"><b>${Core.fmtYuan(s0.amount_cents)}</b></td>
        <td>${esc(s0.job_no || '—')}</td><td>${(s0.occurred_at || '').slice(0, 10)}</td>
        <td>${esc(s0.note || '')}</td>
      </tr>`).join('');
    return `<div class="lg-panel">
      <h2>手工分成登记（简单记账，非分账引擎）</h2>
      <div class="lg-form">
        <label>分给<select id="spParty">${opts}</select></label>
        <label>金额(元)<input id="spAmount" type="number" step="0.01" min="0.01"></label>
        <label>备注<input id="spNote" placeholder="如：秋季苹果季分成"></label>
        <button class="lg-btn primary" data-act="sp-save">登记</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>分成记录</h2>
      <table class="lg-table" data-colw="splits"><thead><tr><th>对象</th><th>金额(元)</th><th>作业</th><th>日期</th><th>备注</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">暂无</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 页签：流水 ---------- */
  function renderJournal(entriesAll) {
    const rowsAll = entriesAll.map(e0 => ({ ...Core.journalRow(e0), _month: (e0.occurred_at || '').slice(0, 10) }));
    const list = pipeFilters(rowsAll, 'journal', { q: ['entry_no', 'event', 'memo'] });
    const rows = list.map(e => {
      const lineHtml = arr => arr.map(l => `${esc(l.text)} <span class="num">${l.yuan}</span>`).join('<br>') || '—';
      return `<tr>
        <td>${esc(e.entry_no)}</td><td>${esc(e.occurred)}</td><td>${esc(e.event)}</td><td>${esc(e.memo)}</td>
        <td>${lineHtml(e.debit)}</td><td>${lineHtml(e.credit)}</td>
        <td class="num ${e.balanced ? 'lg-balance' : 'lg-balance bad'}">${e.balanced ? '✓' : '✗'} ${e.totalYuan}</td>
      </tr>`;
    }).join('');
    return `<div class="lg-panel">
      <h2>复式流水（借贷必须平衡；红冲凭证 event=reversal）</h2>
      ${toolbarHtml('journal', { searchPh: '凭证号/事件/摘要' })}
      ${monthStrip('journal', rowsAll, '_month')}
      <table class="lg-table" data-colw="journal"><thead><tr>
        <th>凭证号</th><th>日期</th><th>事件</th><th>摘要</th><th>借方</th><th>贷方</th><th>平衡/金额</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无凭证</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 页签：报表 ---------- */
  async function renderReports() {
    const s = await Api.get('/api/reports/summary');
    const months = await Api.get('/api/reports/by-month');
    const custs = await Api.get('/api/reports/by-customer');
    const byJob = await Api.get('/api/reports/by-job');
    const monthRows = months.map(m => `<tr>
        <td>${esc(m.month)}</td>
        <td class="num">${Core.fmtYuan(m.income_cents)}</td>
        <td class="num">${Core.fmtYuan(m.expense_cents)}</td>
        <td class="num"><b>${Core.fmtYuan(m.profit_cents)}</b></td>
      </tr>`).join('');
    const expRows = s.expense_by_category.map(c => `<tr><td>${esc(c.code)} ${esc(c.name)}</td><td class="num">${Core.fmtYuan(c.cents)}</td></tr>`).join('');
    const custRows = custs.map(c => `<tr>
        <td>${esc(c.name || '—')}</td>
        <td class="num">${Core.fmtYuan(c.income_cents)}</td>
        <td class="num">${Core.fmtYuan(c.receivable_cents)}</td>
        <td class="num">${Core.fmtYuan(c.prepaid_cents)}</td>
      </tr>`).join('');
    const jobRows = byJob.map(j => `<tr>
        <td>${esc(j.job_no)}</td><td>${esc((j.job_date || '').slice(0, 10))}</td>
        <td>${j.job_type === 'haul' ? '吊运' : '打药'}${j.source === 'import' ? '（导入）' : ''}</td>
        <td class="num">${j.job_type === 'haul' ? (j.weight_jin ?? '—') : (j.total_area_mu ?? '—')}</td>
        <td class="num">${Core.fmtYuan(j.income_cents)}</td>
        <td class="num">${Core.fmtYuan(j.total_cost_cents)}</td>
        <td class="num"><b>${Core.fmtYuan(j.profit_cents)}</b></td>
      </tr>`).join('');
    return `<div class="lg-panel">
      <h2>总览</h2>
      <table class="lg-table"><tbody>
        <tr><td>收入(确认口径)</td><td class="num"><b>${Core.fmtYuan(s.income_cents)}</b></td>
            <td>支出</td><td class="num"><b>${Core.fmtYuan(s.expense_cents)}</b></td></tr>
        <tr><td>利润</td><td class="num"><b>${Core.fmtYuan(s.profit_cents)}</b></td>
            <td>应收余额</td><td class="num">${Core.fmtYuan(s.receivable_cents)}</td></tr>
        <tr><td>客户预收余额</td><td class="num">${Core.fmtYuan(s.prepaid_cents)}</td>
            <td>员工预支余额</td><td class="num">${Core.fmtYuan(s.advance_to_worker_cents)}</td></tr>
      </tbody></table>
    </div>
    <div class="lg-panel">
      <h2>月度盈亏（确认口径）</h2>
      <table class="lg-table" data-colw="rep-month"><thead><tr><th>月份</th><th>收入(元)</th><th>支出(元)</th><th>利润(元)</th></tr></thead>
      <tbody>${monthRows || '<tr><td colspan="4">暂无</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>支出分类</h2>
      <table class="lg-table" data-colw="rep-expense"><thead><tr><th>科目</th><th>金额(元)</th></tr></thead>
      <tbody>${expRows || '<tr><td colspan="2">暂无</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>客户盈利与余额</h2>
      <table class="lg-table" data-colw="rep-customer"><thead><tr><th>客户</th><th>累计收入(元)</th><th>欠款(元)</th><th>预收余额(元)</th></tr></thead>
      <tbody>${custRows || '<tr><td colspan="4">暂无</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>按作业盈利（作业快照口径：导入单成本未含药/油现金支出，显示 0）</h2>
      <table class="lg-table" data-colw="rep-jobprofit"><thead><tr><th>作业单</th><th>日期</th><th>类型</th><th>规模</th><th>收入(元)</th><th>成本(元)</th><th>利润(元)</th></tr></thead>
      <tbody>${jobRows || '<tr><td colspan="7">暂无</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 页签：总表（P4-M1，行=作业单；编辑走既有 PATCH 端点映射） ---------- */
  const OV_COLS = 17; // 单号/日期/客户/村队/亩数/单价/目的/应收/实收/未收/抹零/来源/人员/收款人/状态/备注/操作

  function renderOverview(data, paymentsAll, barData) {
    const em = editMode('overview');
    const rowsAll = data.rows.map(r0 => ({
      ...Core.overviewRow(r0),
      _amount: r0.amount_cents, _paid: r0.paid_cents, _due: r0.due_cents, _disc: r0.discount_cents
    }));
    const list = pipeFilters(byMonth(rowsAll, 'job_date', 'overview'), 'overview',
      { q: ['job_no', 'customer_names', 'addr', 'referral', 'note', 'plantLabel'], party: 'customer_names' });
    const rows = list.map(r => {
      // 编辑模式：单账单且未收直填（走 PATCH /api/bills/:id）；已收/多账单/无账单锁定
      const lockTip = r.billCount > 1 ? '多账单作业，请到账单页逐张修改'
        : r.billCount === 1 ? '已有收款，请先撤回对应结算' : '未生成账单（作业未结算或零金额）';
      const amountCell = em
        ? (r.canEditBill
          ? `<input data-ekb="${r.billId}" data-f="amount_cents" type="number" step="0.01" min="0" value="${(r._amount / 100).toFixed(2)}" data-orig="${(r._amount / 100).toFixed(2)}" title="账单金额(元)">`
          : `<span title="${lockTip}">🔒 ${Core.fmtYuan(r._amount)}</span>`)
        : (r.billCount === 0 && r.jobIncomeCents > 0
          // P6-M2(F2)：未结算作业显示计算器快照收入，避免"明明算了钱总表却是 0"
          ? `<span class="lg-tag" title="计算器快照收入；结算确认后转为账单口径">快照 ${Core.fmtYuan(r.jobIncomeCents)}（未入账）</span>`
          : Core.fmtYuan(r._amount));
      const adjustCell = em
        ? (r.canEditBill
          ? `<input data-ekb="${r.billId}" data-f="adjust_cents" type="number" step="0.01" value="${((r.billAdjust || 0) / 100).toFixed(2)}" data-orig="${((r.billAdjust || 0) / 100).toFixed(2)}" title="账单抹零/优惠(元，正负均按优惠金额计)">`
          : `<span title="${lockTip}">🔒 ${Core.fmtYuan(r._disc)}</span>`)
        : Core.fmtYuan(r._disc);
      return `<tr>
        <td>${esc(r.job_no)}</td><td>${esc(r.job_date)}</td>
        ${custCell(r.customer_names)}
        <td title="${esc(r.region)}">${esc(r.addr)}</td>
        <td class="num">${r.areaMu ?? '—'}</td>
        <td class="num">${r.unitPriceYuan}</td>
        <td>${esc(r.plantLabel || '—')}${r.extraCents > 0 ? ` <span class="lg-tag warn" title="导入行「另按N元/亩」额外收入">另收 ${Core.fmtYuan(r.extraCents)}</span>` : ''}</td>
        <td class="num">${amountCell}</td>
        <td class="num">${Core.fmtYuan(r._paid)}</td>
        <td class="num">${Core.fmtYuan(r._due)}</td>
        <td class="num">${adjustCell}</td>
        <td>${esc(r.referral || '—')}</td>
        <td>${esc((r.operators || []).join('、') || '—')}</td>
        <td>${esc(r.collector || '—')}</td>
        <td>${tag(r.statusText)}${r.billStatuses.map(s => ` ${tag(Core.MAPS.BILL_STATUS[s] || s)}`).join('')}</td>
        <td>${esc(r.note || '—')}${em && r.canEditBill ? `<br><input data-ekb="${r.billId}" data-f="note" value="${esc(r.billNote || '')}" data-orig="${esc(r.billNote || '')}" placeholder="账单备注" title="账单备注（可改）；上方为作业备注（只读，更正走工单详情）" class="lg-inp">` : ''}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="job-detail" data-id="${r.id}">详情</button>`,
          r.canReceive ? `<button class="lg-btn primary" data-act="bill-receive" data-id="${r.billId}" data-party="${r.billPartyId || ''}" data-unpaid="${r._due}">登记收款</button>` : ''
        )}</td>
      </tr><tr hidden><td colspan="${OV_COLS}" class="lg-detail-slot" data-slot="${r.id}"></td></tr>`;
    }).join('');
    return `${barData ? renderKpiBar(barData.barUi, barData.kpi, barData.region, barData.operator) : ''}
    <div class="lg-panel">
      <h2>总表（原 Excel 全数据通看；行=作业单，账单字段按作业聚合）</h2>
      ${toolbarHtml('overview', { searchPh: '单号/客户/村队/来源/备注' })}
      ${monthStrip('overview', rowsAll, 'job_date')}
      <table class="lg-table lg-table--wide" data-colw="ov-main"><thead><tr>
        <th>单号</th><th>日期</th><th>客户</th><th>村·队</th><th>亩数</th><th>单价(元/亩)</th><th>目的</th>
        <th>应收(元)</th><th>实收(元)</th><th>未收(元)</th><th>抹零(元)</th>
        <th>来源</th><th>人员</th><th>收款人</th><th>状态</th><th>备注</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="17">暂无作业</td></tr>'}</tbody>
      ${tfootHtml(7, list, [['应收', sumCents(list, '_amount')], ['实收', sumCents(list, '_paid')], ['未收', sumCents(list, '_due')], ['抹零', sumCents(list, '_disc')]], 6)}</table>
      <div style="color:var(--muted);font-size:12px;margin-top:6px">注：主数据「期初补录」生成的未挂作业账单不进总表行，但计入报表应收。作业字段（亩数/作业备注等）为执行层快照，只读。</div>
    </div>
    ${renderOverviewPayments(paymentsAll)}`;
  }

  /** 总表·面板2：支出流水（原表支出项目/金额列；独立状态键 ovpay，不与支出页互串） */
  function renderOverviewPayments(listAll) {
    const em = editMode('overview');
    const catOpts = Object.entries(Core.MAPS.PAYMENT_CATEGORY)
      .map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    const rowsAll = listAll.map(p0 => ({ ...p0, _amount: p0.amount_cents, _cat: Core.MAPS.PAYMENT_CATEGORY[p0.category] || p0.category }));
    const list = pipeFilters(byMonth(rowsAll, 'occurred_at', 'ovpay'), 'ovpay',
      { q: ['payment_no', 'payee_name', 'note', '_cat'], category: true, party: 'payee_name' });
    const rows = list.map(p0 => {
      const live = p0.status !== 'void';
      return `<tr>
        <td>${esc(p0.payment_no)}</td>
        <td>${em && live ? `<select data-ekp="${p0.id}" data-f="category" data-orig="${esc(p0.category)}">${catOpts.replace(`value="${p0.category}"`, `value="${p0.category}" selected`)}</select>` : esc(p0._cat)}</td>
        <td class="num">${em && live ? `<input data-ekp="${p0.id}" data-f="amount_cents" type="number" step="0.01" value="${(p0.amount_cents / 100).toFixed(2)}" data-orig="${(p0.amount_cents / 100).toFixed(2)}">` : `<b>${Core.fmtYuan(p0.amount_cents)}</b>`}</td>
        ${custCell(p0.payee_name || '')}
        <td>${(p0.occurred_at || '').slice(0, 10)}</td>
        <td>${em && live ? `<input data-ekp="${p0.id}" data-f="note" value="${esc(p0.note || '')}" data-orig="${esc(p0.note || '')}">` : esc(p0.note || '')}</td>
        <td>${live ? '' : tag('已作废', 'err')}</td>
      </tr>`;
    }).join('');
    const liveRows = list.filter(r => r.status !== 'void');
    return `<div class="lg-panel">
      <h2>支出流水（原表支出项目/金额列；登记与作废在「支出」页）</h2>
      ${toolbarHtml('ovpay', { category: true, searchPh: '收款方/单号/备注', csvname: 'ovpay' })}
      ${monthStrip('ovpay', listAll, 'occurred_at')}
      <table class="lg-table" data-colw="ov-pay"><thead><tr>
        <th>单号</th><th>类别</th><th>金额(元)</th><th>收款方</th><th>日期</th><th>备注</th><th>状态</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无支出</td></tr>'}</tbody>
      ${tfootHtml(2, liveRows, [['支出', sumCents(liveRows, '_amount')]], 4)}</table>
    </div>`;
  }

  /* ---------- 总表顶部数据条（P5-M2 §3；P10-R2 改两日期+快捷档，区间口径在 core.dateRangeOf） ---------- */
  function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 数据条状态持久化（P10-R2）：localStorage 'lg-bar-v1'，坏档整包回退默认（total=全期）——
      与列宽（Core.parseColw）/市筛选（app-extra lg-md-county）同款存取模式 */
  const BAR_KEY = 'lg-bar-v1';
  function loadBarState() {
    return Core.parseBarState(lsGet(BAR_KEY)) || { quick: 'total', from: '', to: '' };
  }
  function persistBar() { lsSet(BAR_KEY, JSON.stringify(state.bar)); }

  /** 生效区间展示文案：null=全期；单边空=该边不设限 */
  function barRangeLabel(range) {
    if (!range || (!range.from && !range.to)) return '全期';
    return `${range.from || '起'}..${range.to || '今'}`;
  }

  /** KPI 数据条 DOM（收支三卡 + 单数/亩数/客户数 + 老日期——新日期 + 总/日/周/月/季/年快捷 + 两张小图）。
      区间口径全部来自 Core.barUiOf 纯函数（置灰/生效区间共用一条测试口径） */
  function renderKpiBar(barUi, kpi, region, operator) {
    const QUICK_TEXT = { total: '总', day: '日', week: '周', month: '月', quarter: '季', year: '年' };
    const btns = Core.BAR_QUICKS.map(k =>
      `<button class="lg-btn ${barUi.quick === k ? 'primary' : ''}" data-act="bar-quick" data-quick="${k}"${barUi.locked ? ' disabled title="两个日期都填时按所选区间统计；清空任一侧恢复快捷"' : ''}>${QUICK_TEXT[k]}</button>`).join('');
    const fmt = c => Core.fmtYuan(c);
    const pCount = (parties || []).length;
    const un = operator && operator.unrecorded;
    const rangeNote = barRangeLabel(barUi.range);
    return `<div class="lg-kpis" id="lgKpiBar">
      <div class="lg-kpi"><span class="lg-kpi-label">收入(元)</span><b class="lg-kpi-num">${fmt(kpi.income_cents)}</b><span class="lg-kpi-sub">${esc(rangeNote)}</span></div>
      <div class="lg-kpi"><span class="lg-kpi-label">支出(元)</span><b class="lg-kpi-num">${fmt(kpi.expense_cents)}</b><span class="lg-kpi-sub">${esc(rangeNote)}</span></div>
      <div class="lg-kpi"><span class="lg-kpi-label">利润(元)</span><b class="lg-kpi-num ${kpi.profit_cents < 0 ? 'bad' : ''}">${fmt(kpi.profit_cents)}</b><span class="lg-kpi-sub">收入/支出=账簿确认口径</span></div>
      <div class="lg-kpi"><span class="lg-kpi-label">作业单数</span><b class="lg-kpi-num">${kpi.jobs_count}</b><span class="lg-kpi-sub">亩数 ${kpi.area_mu ?? '—'}（作业口径）</span></div>
      <div class="lg-kpi"><span class="lg-kpi-label">客户数</span><b class="lg-kpi-num">${kpi.customer_count}</b><span class="lg-kpi-sub">本期作业客户 · 总数 ${pCount}（启用）</span></div>
      <div class="lg-kpi lg-kpi--ctrl"><span class="lg-kpi-label">区间（老日期 —— 新日期；快捷按今天算）</span>
        <div class="lg-gran">${btns}</div>
        <span class="lg-bardates">
          <input type="date" id="barFrom" value="${esc(barUi.from)}" title="老日期（起始；可空=不设限）">
          <span>——</span>
          <input type="date" id="barTo" value="${esc(barUi.to)}" title="新日期（截止；可空=不设限）">
        </span>
      </div>
      <div class="lg-kpi lg-kpi--chart"><span class="lg-kpi-label">地区收入占比${(region && region.rows || []).some(r => r.label === '(未填)') ? '（含未填）' : ''}</span><div class="lg-chart-canvas" data-chart="bar-region"></div></div>
      <div class="lg-kpi lg-kpi--chart"><span class="lg-kpi-label">飞手收入占比${un && un.income_cents > 0 ? `（未记录 ${un.jobs_count} 单）` : ''}</span><div class="lg-chart-canvas" data-chart="bar-operator"></div></div>
    </div>`;
  }

  /* ---------- 渲染调度 ---------- */
  const state = { tab: 'home', _advances: [], month: {}, editMode: {}, filter: {}, custFilter: null, bar: loadBarState() };

  function editMode(tab) { return !!state.editMode[tab]; }

  /** 月份切换条 */
  function monthStrip(tab, rows, field) {
    const months = Core.monthKeys(rows, field);
    const cur = state.month[tab] || 'all';
    const chip = (m, label) => `<button class="lg-btn ${cur === m ? 'primary' : ''}" data-act="month-set" data-tab="${tab}" data-month="${m}">${label}</button>`;
    return `<div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:4px">${chip('all', '全部')}${months.map(m => chip(m, m)).join('')}</div>`;
  }
  function byMonth(rows, field, tab) {
    const m = state.month[tab];
    if (!m || m === 'all') return rows;
    return rows.filter(r => String((r[field] || '')).slice(0, 7) === m);
  }

  /* ---------- 检索工具条 / 客户过滤 / 合计（P3） ---------- */
  /** 过滤管线：搜索（q 列名数组）→ 状态 → 类别 → 只看此客户；在映射后行上执行 */
  function pipeFilters(rows, tab, opts = {}) {
    const f = state.filter[tab] || {};
    let out = rows;
    const q = (f.q || '').trim().toLowerCase();
    if (q && opts.q) out = out.filter(r => opts.q.some(k => String(r[k] ?? '').toLowerCase().includes(q)));
    if (f.status) out = out.filter(r => (r.status || '') === f.status);
    if (f.category) out = out.filter(r => (r.category || '') === f.category);
    if (state.custFilter && opts.party) out = out.filter(r => String(r[opts.party] || '') === state.custFilter);
    return out;
  }
  /** 检索工具条（搜索框 + 状态/类别筛选 + 客户过滤徽标） */
  function toolbarHtml(tab, { statusMap = null, category = false, searchPh = '客户名/单号/备注', csvname = null } = {}) {
    const f = state.filter[tab] = state.filter[tab] || {};
    const statusOpts = statusMap ? Object.entries(statusMap).map(([v, t]) =>
      `<option value="${v}" ${f.status === v ? 'selected' : ''}>${esc(t)}</option>`).join('') : '';
    const catOpts = category ? Object.entries(Core.MAPS.PAYMENT_CATEGORY).map(([v, t]) =>
      `<option value="${v}" ${f.category === v ? 'selected' : ''}>${esc(t)}</option>`).join('') : '';
    return `<div class="lg-toolbar">
      <input id="ftQ-${tab}" data-tab="${tab}" class="lg-search" value="${esc(f.q || '')}" placeholder="🔍 ${esc(searchPh)}">
      ${statusMap ? `<select id="ftStatus" data-tab="${tab}"><option value="">全部状态</option>${statusOpts}</select>` : ''}
      ${category ? `<select id="ftCategory" data-tab="${tab}"><option value="">全部类别</option>${catOpts}</select>` : ''}
      ${state.custFilter ? `<span class="lg-tag warn">只看：${esc(state.custFilter)} <button class="lg-btn" data-act="cust-filter-clear">×</button></span>` : ''}
      <button class="lg-btn" data-act="csv-export" ${csvname ? `data-csvname="${esc(csvname)}"` : ''} title="导出当前面板（月份+筛选口径）为 CSV（已做公式注入防护）">⬇ 导出CSV</button>
      <!-- C2：U5 版式 Excel 导出（服务端 exceljs 真值单元格；按总表数据条区间） -->
      <button class="lg-btn" data-act="export-xlsx" title="按 U5 月度表版式导出 Excel（当前数据条区间；可再导入回读）">⬇ 导出Excel</button>
    </div>`;
  }
  /** 可点击的客户名（点=只看此客户；再次点同名的取消） */
  function custCell(name) {
    if (!name) return '<td>—</td>';
    const active = state.custFilter === String(name);
    return `<td class="lg-cust ${active ? 'lg-cust-on' : ''}" data-act="cust-filter" data-name="${esc(name)}" title="点击只看此客户">${esc(name)}${active ? ' ▾' : ''}</td>`;
  }
  function sumCents(rows, key) {
    return rows.reduce((a, r) => a + (r[key] || 0), 0);
  }
  /** 合计行：leadSpan 补齐金额列左侧，cells=[(label, 合计分)]，tailSpan 补右侧 */
  function tfootHtml(leadSpan, rows, cells, tailSpan) {
    if (!rows.length) return '';
    const cellHtml = cells.map(([label, cents]) => `<td class="num"><b>${esc(label)}</b><br>${Core.fmtYuan(cents)}</td>`).join('');
    return `<tfoot><tr><td colspan="${leadSpan}">合计 ${rows.length} 行</td>${cellHtml}${tailSpan ? `<td colspan="${tailSpan}"></td>` : ''}</tr></tfoot>`;
  }

  /** 渲染串行化门：连续触发（切页签+搜索防抖）时按序执行，避免旧渲染晚写覆盖新状态 */
  let renderChain = Promise.resolve();
  let lastRenderedTab = null; // B7 切页淡入：仅页签变化时播 120ms 淡入（搜索/保存等重绘不闪）
  function render() {
    const p = renderChain.then(() => doRender());
    renderChain = p.catch(() => {});
    return p;
  }

  async function doRender() {
    // P5-M2：innerHTML 重建前统一释放 echarts 实例（charts.js renderTab 开头另有一次，双保险）
    if (window.LedgerCharts && window.LedgerCharts.disposeAll) window.LedgerCharts.disposeAll();
    // P10-R4：旧页签值映射——health/import 一律落「审核」页（体检整体并入；不白屏不丢页）
    if (state.tab === 'health' || state.tab === 'import') state.tab = 'review';
    const tab = state.tab;
    // B1：tab 注册表（原 13+ 分支 if-else 链；加页签从改三处变一处——
    // 渲染器统一签名 async ($main)=>，await 后走统一收尾）
    const renderer = TAB_RENDERERS[tab];
    if (renderer) await renderer($main);
    applyColWidths(); // P5-M3：全量重绘后统一恢复列宽（含明细插槽外各表的手柄注入）
    restoreOpenSlots(); // B5：明细展开态记忆恢复（修"任何操作后明细合拢"）
    refreshSummary();
    updateFab();
    // E9（P7-R4）：列表达到服务端截断上限时给出可感知提示（替代静默截断）
    if (window.__lgHasMore) {
      toast('注意：列表已达服务端单次返回上限，更早数据未显示（可用搜索/月份缩小范围）');
      window.__lgHasMore = false;
    }
    // B7 切页淡入：页签变化才播 120ms 淡入（重排动画需先强制回流再挂类）
    if (lastRenderedTab !== tab) {
      lastRenderedTab = tab;
      $main.classList.remove('lg-fade');
      void $main.offsetWidth;
      $main.classList.add('lg-fade');
    }
  }

  /* ---------- B1：tab 注册表（每项 async ($main)=>；doRender 统一 await+收尾） ---------- */
  const TAB_RENDERERS = {
    home: ($m) => window.LedgerHome.renderTab($m),
    overview: async () => {
      // 预收下拉依赖 state._advances（同 payments 分支）；支出面板块复用 payments 列表
      state._advances = await Api.advances();
      // P10-R2 数据条：生效区间走 core.barUiOf/dateRangeOf 纯函数——
      // 两日期都填=纯按 [from,to]（快捷置灰）；空/只填一边=快捷区间交集（空边不设限）；
      // null=全期（API 侧空参数省略，服务端不过滤）
      const barUi = Core.barUiOf(state.bar, todayStr());
      const rf = (barUi.range && barUi.range.from) || '', rt = (barUi.range && barUi.range.to) || '';
      const [data, pays, kpi, region, operator] = await Promise.all([
        Api.overview(), Api.payments(),
        Api.barRange(rf, rt),
        Api.byRegion('region', rf, rt),
        Api.byOperator(rf, rt)
      ]);
      $main.innerHTML = renderOverview(data, pays, { barUi, kpi, region, operator });
      // 数据条两张小图（地区环图 + 飞手饼图；复用 charts.js 实例注册表；vendor 缺失时内部降级提示）
      if (window.LedgerCharts && window.LedgerCharts.mountMini) {
        window.LedgerCharts.mountMini(document.getElementById('lgKpiBar'), { region, operator });
      }
    },
    jobs: async () => { $main.innerHTML = renderJobs(await Api.jobs()); },
    settlements: async () => { $main.innerHTML = renderSettlements(await Api.settlements()); },
    bills: async () => { $main.innerHTML = renderBills(await Api.bills()); },
    receipts: async () => {
      try { parties = await Api.parties(); } catch (e) { /* 拉不到就用旧缓存 */ }
      $main.innerHTML = renderReceipts(await Api.receipts());
    },
    reports: async () => { $main.innerHTML = await renderReports(); },
    charts: ($m) => window.LedgerCharts.renderTab('charts', $m),
    payments: async () => {
      state._advances = await Api.advances();
      $main.innerHTML = await renderPayments(await Api.payments()); // C3 起含作业 datalist 预取
    },
    advances: async () => {
      state._advances = await Api.advances();
      $main.innerHTML = renderAdvances(state._advances);
    },
    splits: async () => { $main.innerHTML = renderSplits(await Api.splits()); },
    journal: async () => { $main.innerHTML = renderJournal(await Api.journal()); },
    review: ($m) => window.LedgerExtra.renderTab('review', $m),
    master: ($m) => window.LedgerExtra.renderTab('master', $m)
  };

  async function refreshSummary() {
    try {
      const s = await Api.summary();
      document.getElementById('lgSummary').textContent =
        `应收 ${Core.fmtYuan(s.receivable_cents)} · 已收 ${Core.fmtYuan(s.received_cents)} · 支出 ${Core.fmtYuan(s.expense_cents)} · 预收余 ${Core.fmtYuan(s.prepaid_cents)}`;
    } catch (e) { /* 顶部汇总失败不打扰 */ }
    updateNavBadges(); // B3：导航徽标（账单未收数红标 / 审核待复核数蓝标），失败静默
  }

  /** B3 待办徽标：导航按钮右上角圆形数字（.lg-badge 三色：红=欠款/蓝=待复核） */
  function setNavBadge(tab, n, cls) {
    const btn = document.querySelector(`#lgNav button[data-tab="${tab}"]`);
    if (!btn) return;
    let el = btn.querySelector('.lg-badge');
    if (n > 0) {
      if (!el) { el = document.createElement('span'); el.className = 'lg-badge'; btn.appendChild(el); }
      el.className = 'lg-badge ' + (cls || '');
      el.textContent = String(n);
    } else if (el) el.remove();
  }
  async function updateNavBadges() {
    if (!Api.aging) return; // 旧服务端无 aging 端点（E0 前部署）：跳过不报错
    try {
      const [aging, batches] = await Promise.all([Api.aging(), Api.importBatches()]);
      setNavBadge('bills', (aging.total && aging.total.bills) || 0, 'red');
      setNavBadge('review', (batches || []).filter(b => b.status === 'reviewing').length, 'blue');
    } catch (e) { /* 徽标失败不打扰 */ }
  }

  /* ---------- 列宽拖拽与记忆（P5-M3 表格 Excel 化；纯函数在 core.js：colwKey/parseColw/clampColw） ----------
     applyColWidths 在每次全量重绘后统一恢复：doRender 尾部 / toggleDetailSlot 明细插槽挂钩 /
     LedgerExtra.renderTab 返回链（app-extra 直调重绘的旁路）。有存档的表才插 colgroup+lg-fixed
     （table-layout:fixed），无存档表零改动；拖拽是 $main 上一条 mousedown 委托（与既有
     click/input/change 委托同构，全量重绘与 app-extra 直调重绘都不会丢监听），手柄上
     preventDefault+stopPropagation，与点击过滤/排序、handleAct 委托互不干扰。 */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 隐私模式丢弃 */ } }
  /** 本表的 colgroup：只找直接子级（querySelector 会误命中嵌套明细表的 colgroup） */
  function findColgroup(table) {
    for (const el of table.children) { if (el.tagName === 'COLGROUP') return el; }
    return null;
  }
  /** 本表表头首行单元格（table.tHead 只认本表直接子级 thead，嵌套明细表不受影响） */
  function headCells(table) {
    const row = table.tHead && table.tHead.rows[0];
    return row ? [...row.cells] : [];
  }
  function cleanupCols(table) {
    table.classList.remove('lg-fixed');
    const cg = findColgroup(table);
    if (cg) cg.remove();
  }
  /** 给表头每个 th 注入右缘拖拽手柄（幂等；所有 data-colw 表都有手柄，无存档也能拖） */
  function ensureColwHandles(table) {
    for (const th of headCells(table)) {
      if (th.querySelector(':scope > .lg-colw-h')) continue;
      const h = document.createElement('span');
      h.className = 'lg-colw-h';
      h.title = '拖动调列宽；双击=该列按内容自适应';
      th.appendChild(h);
    }
  }
  /** 列宽统一恢复：有有效存档的表插 colgroup + lg-fixed；无存档表清临时快照回默认渲染（幂等） */
  function applyColWidths() {
    const tab = state.tab;
    document.querySelectorAll('#lgMain table[data-colw]').forEach(table => {
      ensureColwHandles(table);
      const key = table.dataset.colw;
      const ths = headCells(table);
      cleanupCols(table);
      if (!key || !ths.length) return;
      let stored = null;
      try { stored = Core.parseColw(lsGet(Core.colwKey(tab, key)), ths.length); } catch (e) { stored = null; }
      if (!stored || !stored.length) return; // 无存档：保持默认渲染（未拖过的表零回归）
      if (stored.length < ths.length) {
        // 短存档补齐：缺省列取当前渲染宽（fixed 化前量一次，避免存档越拖越丢列）
        stored = stored.concat(ths.slice(stored.length).map(th => Math.round(th.getBoundingClientRect().width)));
      }
      const cg = document.createElement('colgroup');
      for (const w of stored) {
        const col = document.createElement('col');
        col.style.width = Core.clampColw(w) + 'px';
        cg.appendChild(col);
      }
      table.insertBefore(cg, table.firstChild);
      table.classList.add('lg-fixed');
    });
  }
  /** 拖拽起步快照：把当前渲染宽固化进 colgroup 并开 fixed（从第一次拖拽起即 Excel 化体验） */
  function snapshotCols(table) {
    const cg = findColgroup(table);
    if (cg) return [...cg.children].map(col => parseFloat(col.style.width) || 0);
    const widths = headCells(table).map(th => Math.round(th.getBoundingClientRect().width));
    const ng = document.createElement('colgroup');
    for (const w of widths) {
      const col = document.createElement('col');
      col.style.width = w + 'px';
      ng.appendChild(col);
    }
    table.insertBefore(ng, table.firstChild);
    table.classList.add('lg-fixed');
    return widths;
  }
  let colwDrag = null;
  function onColwMove(e) {
    const d = colwDrag;
    if (!d) return;
    try {
      const dx = e.clientX - d.startX;
      if (dx !== 0) d.moved = true;
      const table = document.querySelector(`#lgMain table[data-colw="${d.key}"]`);
      if (!table) return;
      // 拖拽中恰逢重绘（搜索防抖 250ms 等）时旧 col 已脱离 DOM：重查当前表，无快照则按当前渲染宽重建
      let cg = findColgroup(table);
      if (!cg && dx !== 0) { d.widths = snapshotCols(table); cg = findColgroup(table); }
      const w = Core.clampColw(d.startW + dx);
      d.widths[d.idx] = w;
      if (cg && cg.children[d.idx]) cg.children[d.idx].style.width = w + 'px';
    } catch (err) { /* 拖拽容错：丢一帧不中断 */ }
  }
  function onColwUp() {
    document.removeEventListener('mousemove', onColwMove);
    document.removeEventListener('mouseup', onColwUp);
    const d = colwDrag;
    colwDrag = null;
    if (!d) return;
    if (d.moved) lsSet(Core.colwKey(d.tab, d.key), JSON.stringify(d.widths.map(w => Core.clampColw(w))));
    applyColWidths(); // 存档回显；未拖动时清临时快照（或恢复原存档）
  }
  $main.addEventListener('mousedown', e => {
    const h = e.target.closest('.lg-colw-h');
    if (!h) return;
    const th = h.closest('th');
    const table = th && th.closest('table[data-colw]');
    if (!table || !table.dataset.colw) return;
    const idx = headCells(table).indexOf(th);
    if (idx < 0) return;
    e.preventDefault();  // 防拖拽选中文本
    e.stopPropagation(); // 不进既有 click/input/change 委托链
    const widths = snapshotCols(table);
    colwDrag = { tab: state.tab, key: table.dataset.colw, idx, widths, startX: e.clientX, startW: widths[idx] || 0, moved: false };
    document.addEventListener('mousemove', onColwMove);
    document.addEventListener('mouseup', onColwUp);
  });
  $main.addEventListener('dblclick', e => {
    // B6 首页 dashboard 卡标题双击改名（存 lg-home-grid-v1.titles）
    const title = e.target.closest('.lg-hcard-title');
    if (title) {
      const id = title.dataset.hcardTitle;
      const v = window.prompt('卡标题改为：', title.textContent.trim());
      if (v == null) return;
      let save = null;
      try { save = JSON.parse(window.localStorage.getItem('lg-home-grid-v1') || 'null'); } catch (err) { save = null; }
      save = save || { v: 1, cards: ['kpi', 'trend', 'debt'], titles: {}, layout: null };
      save.titles = save.titles || {};
      const name = v.trim().slice(0, 30);
      if (name) save.titles[id] = name; else delete save.titles[id];
      try { window.localStorage.setItem('lg-home-grid-v1', JSON.stringify(save)); } catch (err) { /* 忽略 */ }
      render().catch(() => {});
      return;
    }
    const h = e.target.closest('.lg-colw-h');
    if (!h) return;
    const table = h.closest('table[data-colw]');
    if (!table || !table.dataset.colw) return;
    const idx = headCells(table).indexOf(h.closest('th'));
    if (idx < 0) return;
    autoFitTable(table, idx); // B7：双击手柄=该列按内容自适应（替代旧「清存档回默认」）
    applyColWidths();
  });
  window.LedgerColWidths = { apply: applyColWidths };

  /* ---------- B7 列宽按内容自适应（手柄双击=该列 / 顶栏 ⇔=本页全部表） ----------
     测量法：临时把表切到 auto 布局 + width:max-content（同步改同步还原，不产生可见
     重排），逐列取跨列安全的最宽实格 offsetWidth（colspan 会在 cells 下标里占位，
     必须按视觉列游标走，跨列格不计入单列宽）。测完经 clampColw 入存档，回显交给
     applyColWidths（colgroup+lg-fixed 同一条管线，与拖拽记忆同源）。 */
  function measureColWidths(table) {
    const cg = findColgroup(table);
    const savedW = cg ? [...cg.children].map(c => c.style.width) : null;
    if (cg) [...cg.children].forEach(c => { c.style.width = 'auto'; }); // col 宽在 auto 布局是最小值，须先解除再量
    const prevCss = table.style.cssText;
    table.style.tableLayout = 'auto';
    table.style.width = 'max-content';
    table.style.minWidth = '0';
    const widths = headCells(table).map((_, i) => {
      let w = 0;
      for (const tr of table.rows) {
        let vis = 0;
        for (const cell of tr.cells) {
          if (vis > i) break;
          if (vis === i && cell.colSpan === 1) w = Math.max(w, cell.offsetWidth);
          vis += cell.colSpan;
        }
      }
      return w;
    });
    table.style.cssText = prevCss;
    if (cg) [...cg.children].forEach((c, j) => { c.style.width = savedW[j]; });
    return widths;
  }
  /** 自适应并入存档：idx 缺省=全列按内容；否则只改该列，其余列保持现渲染宽 */
  function autoFitTable(table, idx) {
    const key = table.dataset.colw;
    if (!key || !headCells(table).length) return;
    const measured = measureColWidths(table);
    const widths = snapshotCols(table);
    if (idx == null) {
      for (let i = 0; i < widths.length; i++) widths[i] = measured[i] || widths[i];
    } else if (measured[idx] > 0) {
      widths[idx] = measured[idx];
    }
    lsSet(Core.colwKey(state.tab, key), JSON.stringify(widths.map(w => Core.clampColw(w))));
  }

  /* ---------- 事件委托 ---------- */
  document.getElementById('lgNav').addEventListener('click', e => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    document.querySelectorAll('#lgNav button').forEach(b => b.classList.toggle('active', b === btn));
    state.tab = btn.dataset.tab;
    render().catch(err => toast(err.message, true));
  });

  /* ---------- B1 全局搜索（头部输入框；/ 聚焦；回车跳「作业明细」注入 q） ---------- */
  const $gSearch = document.getElementById('lgGlobalSearch');
  if ($gSearch) {
    $gSearch.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const q = ($gSearch.value || '').trim();
      if (!q) { toast('输入要搜的内容（单号/客户/村队/备注…）'); return; }
      state.filter.overview = { ...(state.filter.overview || {}), q };
      state.tab = 'overview';
      document.querySelectorAll('#lgNav button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'overview'));
      render().catch(err => toast(err.message, true));
    });
  }
  // `/` 全局聚焦搜索框（输入类控件内不抢键——正在打字的人不该被劫持）；
  // B5 键盘流：Esc 取消编辑态 / Ctrl+Enter 保存 / ↑↓ 表格行间移动 / Enter 展开行首动作；
  // 收款页快速录入条内 Enter=落库（qrcQuickSave，焦点回日期格）
  document.addEventListener('keydown', e => {
    const t = e.target;
    const tag = t && t.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !inField) {
      if (!$gSearch) return;
      e.preventDefault();
      $gSearch.focus();
      $gSearch.select();
      return;
    }
    // B5：快速录入条内回车=落库（Tab 自然走字段）
    if (e.key === 'Enter' && t && t.closest && t.closest('#lgQuickRc')) {
      e.preventDefault();
      qrcQuickSave();
      return;
    }
    // B5：Esc 取消编辑态（任何输入态下）
    if (e.key === 'Escape' && state.editMode[state.tab]) {
      state.editMode[state.tab] = false;
      render().catch(() => {});
      return;
    }
    // B5：Ctrl+Enter 编辑态保存
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && state.editMode[state.tab]) {
      e.preventDefault();
      saveEditMode(state.tab);
      return;
    }
    // B5：↑↓ 在表格行间移动焦点（roving focus）；Enter=触发行首动作按钮
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !inField) {
      const rows = [...document.querySelectorAll('#lgMain .lg-table tbody tr')].filter(r => !r.hidden && r.style.display !== 'none');
      if (rows.length < 2) return;
      const cur = document.activeElement && document.activeElement.closest && document.activeElement.closest('#lgMain .lg-table tbody tr');
      let idx = cur ? rows.indexOf(cur) : -1;
      idx = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (idx < 0) idx = 0;
      e.preventDefault();
      rows[idx].setAttribute('tabindex', '-1');
      rows[idx].focus();
      return;
    }
    if (e.key === 'Enter' && t && t.tagName === 'TR' && t.closest('#lgMain .lg-table tbody')) {
      const btn = t.querySelector('button[data-act]');
      if (btn) { e.preventDefault(); btn.click(); }
    }
  });

  /** B5 收款页快速录入条落库：客户名精确匹配档案 → 按客户 FIFO 收款；成功后清格、焦点回日期 */
  async function qrcQuickSave() {
    const $ = id => document.getElementById(id);
    const name = ($('qrcParty').value || '').trim();
    const amount = Core.yuanInputToCents($('qrcAmount').value);
    if (!name) { toast('先填客户（输入筛选后回车）', true); $('qrcParty').focus(); return; }
    if (!needAmount(amount)) { $('qrcAmount').focus(); return; }
    const party = parties.find(p => p.type === 'customer' && p.name === name);
    if (!party) { toast(`没有找到客户「${name}」——先到主数据建档或用下拉选择`, true); $('qrcParty').focus(); return; }
    try {
      await run(() => Api.createReceipt({
        party_id: party.id,
        amount_cents: amount,
        method: $('qrcMethod').value,
        occurred_at: $('qrcDate').value || undefined,
        note: $('qrcNote').value || undefined
      }));
      toast(`已登记：${name} ${Core.fmtYuan(amount)}`);
      $('qrcAmount').value = '';
      $('qrcNote').value = '';
      $('qrcDate').focus(); // 焦点回第一格（连续录入）
    } catch (err) { toast(err.message, true); }
  }

  document.addEventListener('click', e => {
    const fb = e.target.closest('[data-fab]');
    if (!fb) return;
    const tab = state.tab;
    // P10-R4：导入 FAB（独立 #lgImportFab，与编辑/保存/取消语义不混用）→ LedgerExtra 弹窗
    if (fb.dataset.fab === 'import') {
      if (window.LedgerExtra) window.LedgerExtra.handleAct({ dataset: { act: 'fab-open' } }, T);
      return;
    }
    if (fb.dataset.fab === 'edit') { state.editMode[tab] = true; render().catch(() => {}); }
    else if (fb.dataset.fab === 'cancel') { state.editMode[tab] = false; render().catch(() => {}); }
    else if (fb.dataset.fab === 'save') { saveEditMode(tab); }
  });

  // P10-R4：FAB 弹窗挂在 body（不在 #lgMain 内，重绘不丢）——文档级委托进同一 handleAct
  // 通道（fab-/imp- 等前缀由委托正则放行）；作用域限定弹窗内，与 #lgMain 委托互不重复触发
  document.addEventListener('click', e => {
    if (!e.target || typeof e.target.closest !== 'function') return;
    const mbtn = e.target.closest('#lgImportModal [data-act]');
    if (mbtn) handleAct(mbtn);
  });

  $main.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (btn) { handleAct(btn); return; }
    const slotBtn = e.target.closest('td[data-slot]');
    if (slotBtn && slotBtn.textContent.trim() === '') slotBtn.closest('tr').remove();
  });

  /* 检索工具条：搜索防抖（保持焦点与光标）。搜索框 id 按状态键唯一（ftQ-{tab}，
     总表页同屏两条工具条），故按 /^ftQ/ 前缀匹配、焦点恢复用 el.id */
  let searchTimer = null;
  $main.addEventListener('input', e => {
    const el = e.target;
    if (!/^ftQ/.test(el.id)) return;
    const inpId = el.id;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const tab = el.dataset.tab;
      state.filter[tab] = state.filter[tab] || {};
      state.filter[tab].q = el.value;
      render().then(() => {
        const inp = document.getElementById(inpId);
        if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      }).catch(() => {});
    }, 250);
  });
  /** D4 设置区二维码配置状态（上传/清除后就地刷新，不整页重绘丢表单） */
  function refreshQrState() {
    const QRS = window.LedgerSettlementCard && window.LedgerSettlementCard.QRS;
    if (!QRS) return;
    const pay = document.getElementById('qrPayState');
    const acct = document.getElementById('qrAcctState');
    if (pay) pay.textContent = QRS.get(QRS.PAY_KEY) ? '已配置' : '未配置';
    if (acct) acct.textContent = QRS.get(QRS.ACCT_KEY) ? '已配置' : '未配置';
  }

  $main.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'qrPayFile' || el.id === 'qrAcctFile') {
      // D4 设置区二维码上传：读图→规范化（≤480px PNG dataURL）→ localStorage（QRS 统一存取）
      const QRS = window.LedgerSettlementCard && window.LedgerSettlementCard.QRS;
      const file = el.files && el.files[0];
      el.value = ''; // 允许下次重选同一文件
      if (!QRS || !file) return;
      QRS.normalize(file).then(du => {
        if (!du) { toast('不是可读的图片文件', true); return; }
        if (!QRS.set(el.id === 'qrPayFile' ? QRS.PAY_KEY : QRS.ACCT_KEY, du)) {
          toast('保存失败（存储空间不足或隐私模式）', true);
          return;
        }
        toast('二维码已保存，生成结算卡时显示在右下角');
        refreshQrState();
      }).catch(() => toast('读图失败', true));
      return;
    }
    if (el.classList && el.classList.contains('lg-bulk-check')) {
      // B4 批量已收：行勾选进 Set（重绘由 Set 恢复；浮动条随重绘更新）
      const bid = Number(el.dataset.bulk);
      if (el.checked) state._bulkSel.add(bid); else state._bulkSel.delete(bid);
      render().catch(err => toast(err.message, true));
      return;
    }
    if (el.id === 'lgBulkAll') {
      // B4 全选：按当前列表 DOM（勾选框可见=未收账单）批量入/出 Set
      document.querySelectorAll('.lg-bulk-check').forEach(c => {
        const bid = Number(c.dataset.bulk);
        if (el.checked) state._bulkSel.add(bid); else state._bulkSel.delete(bid);
      });
      render().catch(err => toast(err.message, true));
      return;
    }
    if (el.dataset.cardDate) {
      // P10-R3 图表卡日期：老/新日期任一改动即重算该卡区间（清空=该边不设限，允许触发）
      if (window.LedgerCharts) window.LedgerCharts.handleCardDate(Number(el.dataset.card), el.dataset.cardDate, el.value);
      return;
    }
    if (el.id === 'chartCounty') {
      // P10-R3 图表页市筛选（P10-R1 county 参数贯通图表端点；默认全部）
      if (window.LedgerCharts) window.LedgerCharts.handleCounty(el.value);
      return;
    }
    if (el.id === 'barFrom' || el.id === 'barTo') {
      // P10-R2 数据条：老/新日期任一改动即按交集口径重算（清空=该边不设限，允许触发；
      // 两日期都填后快捷按钮由 renderKpiBar 置灰——Core.barUiOf.locked 单一口径）
      state.bar[el.id === 'barFrom' ? 'from' : 'to'] = el.value || '';
      persistBar();
      render().catch(err => toast(err.message, true));
      return;
    }
    if (el.id !== 'ftStatus' && el.id !== 'ftCategory') return;
    const tab = el.dataset.tab;
    state.filter[tab] = state.filter[tab] || {};
    state.filter[tab][el.id === 'ftStatus' ? 'status' : 'category'] = el.value;
    render().catch(err => toast(err.message, true));
  });

  function collectInputs(attr) {
    const map = new Map();
    document.querySelectorAll(`[${attr}]`).forEach(inp => {
      const id = inp.getAttribute(attr);
      if (!map.has(id)) map.set(id, {});
      if (inp.dataset.orig !== undefined && inp.dataset.orig === inp.value) return;
      const f = inp.dataset.field || inp.dataset.f; // 行内明细用 data-field，页签直填用 data-f
      map.get(id)[f] = f.endsWith('_cents') ? Core.yuanInputToCents(inp.value) : inp.value;
    });
    for (const [id, fields] of map) {
      if (!Object.keys(fields).length) map.delete(id);
    }
    return map;
  }
  function toggleDetailSlot(slot, loader) {
    const tr = slot.closest('tr');
    tr.hidden = !tr.hidden;
    // B5 展开态记忆：state.openSlots 记 'job:12'/'st:3'——任何操作重绘后自动恢复展开
    const key = openSlotKeyOf(slot);
    if (key) { if (!tr.hidden) state.openSlots.add(key); else state.openSlots.delete(key); }
    if (!tr.hidden && slot.innerHTML === '') {
      // P5-M3：明细插槽异步向 slot 插表（job-detail/st-detail/st-edit 三入口），
      // doRender 尾部与 renderTab 返回链都不会在明细展开后执行，loader 完成后单独恢复列宽
      const r = loader();
      if (r && typeof r.then === 'function') r.then(() => applyColWidths());
      else applyColWidths();
    }
  }
  /** slot 元素 → 记忆键（data-slot 形态：job=纯数字 / 结算=st数字） */
  function openSlotKeyOf(slot) {
    const v = slot && slot.dataset && slot.dataset.slot;
    if (!v) return null;
    return /^st\d+$/.test(v) ? `st:${v.slice(2)}` : `job:${v}`;
  }
  /** B5：重绘后恢复展开的明细（loader 按键前缀重建；行已不在当前过滤视图则清记忆） */
  function restoreOpenSlots() {
    state.openSlots = state.openSlots || new Set();
    for (const key of [...state.openSlots]) {
      const m = /^(job|st):(\d+)$/.exec(key);
      if (!m) { state.openSlots.delete(key); continue; }
      const sel = m[1] === 'job' ? m[2] : 'st' + m[2];
      const slot = document.querySelector(`td[data-slot="${sel}"]`);
      if (!slot) { state.openSlots.delete(key); continue; }
      const tr = slot.closest('tr');
      if (tr && tr.hidden) {
        tr.hidden = false;
        if (slot.innerHTML === '') {
          const p = m[1] === 'job' ? jobDetail(slot, Number(m[2])) : settlementDetail(slot, Number(m[2]));
          Promise.resolve(p).then(() => applyColWidths()).catch(() => {});
        }
      }
    }
  }
  function needAmount(v) {
    if (v == null || isNaN(v) || v <= 0) { toast('金额非法', true); return false; }
    return true;
  }

  const T = { run, toast, confirmThen, needAmount, collectInputs, esc, tag, actions, Core, Api, state, switchNav, render, applyColWidths };
  window.__ledgerTools = T; // app-extra.js 的工具注入源（P2-4 拆分）

  async function handleAct(btn) { // C3 起含异步动作（usage-view/rc-mix）；委托为 fire-and-forget
    const act = btn.dataset.act;
    const id = Number(btn.dataset.id);
    // 审核/主数据页签与导入 FAB 弹窗的处理在 app-extra.js（P2-4 拆分；P9-R2 增 dh- 体检动作前缀，
    // P10-R4 增 fab- 弹窗动作前缀，P10-R5 增 lr- LLM 审查动作前缀，md- 合并弹窗复用既有 md- 前缀；
    // B1 增 hm- 首页动作前缀——漏加前缀=按钮静默无效，P3 教训；D4 增 qr- 结算卡二维码前缀）
    if (window.LedgerExtra && /^(imp-|md-|op-|nc-|plot-|dh-|fab-|lr-|qr-)/.test(act)) return window.LedgerExtra.handleAct(btn, T);
    if (window.LedgerHome && /^hm-/.test(act)) return window.LedgerHome.handleAct(btn, T);
    switch (act) {
      case 'csv-export': {
        // 导出「按钮所在面板」的第一张表（月份+筛选口径；编辑态取输入值；展开明细与隐藏 slot 不导）。
        // 总表页两块面板各带工具条，主表/支出流水各自导出；单表页签行为不变（按钮与表格同面板）。
        const panel = btn.closest('.lg-panel');
        const table = panel ? panel.querySelector('table') : document.querySelector('#lgMain table');
        if (!table) { toast('当前页无表格可导出', true); break; }
        const lines = [...table.querySelectorAll('tr')]
          .filter(tr => !tr.hidden && !tr.closest('tr[hidden]'))
          .filter(tr => !tr.querySelector('.lg-detail'))
          .map(tr => Core.csvRow([...tr.children].map(td => {
            const inp = td.querySelector('input,select');
            return inp ? inp.value : td.textContent.replace(/\s+/g, ' ').trim();
          })));
        const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        // data-csvname 供同页第二块面板覆盖文件名与月份键（如支出流水=ovpay）
        const csvName = btn.dataset.csvname || state.tab;
        a.download = `spraybook-${csvName}-${state.month[csvName] || state.month[state.tab] || 'all'}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast(`已导出 ${Math.max(lines.length - 1, 0)} 行 CSV`);
        break;
      }
      case 'export-xlsx': {
        // C2：U5 月度表版式 Excel 导出（服务端 /api/export/monthly；区间=总表数据条生效区间）
        const ui = Core.barUiOf(state.bar, todayStr());
        const rf = (ui.range && ui.range.from) || '', rt = (ui.range && ui.range.to) || '';
        const qsParts = [rf && 'from=' + encodeURIComponent(rf), rt && 'to=' + encodeURIComponent(rt)].filter(Boolean);
        window.open('/api/export/monthly' + (qsParts.length ? '?' + qsParts.join('&') : ''), '_blank');
        toast(`已请求 Excel 导出（区间 ${rf || '起'}..${rt || '今'}，按月分表）`);
        break;
      }
      case 'cust-filter': {
        const name = btn.dataset.name;
        state.custFilter = state.custFilter === name ? null : name; // 再点同名的取消
        render().catch(err => toast(err.message, true));
        break;
      }
      case 'cust-filter-clear':
        state.custFilter = null;
        render().catch(err => toast(err.message, true));
        break;
      case 'rc-alloc': {
        const tr$ = btn.closest('tr');
        const existing = tr$.nextElementSibling;
        if (existing && existing.dataset && existing.dataset.allocFor === String(id)) { existing.remove(); break; }
        const items = JSON.parse(btn.dataset.alloc || '[]');
        const used = items.reduce((a, i) => a + (i.amount_cents || 0), 0);
        const rem = Number(btn.dataset.amount || 0) - used;
        tr$.insertAdjacentHTML('afterend', `<tr data-alloc-for="${id}"><td colspan="8"><div class="lg-detail">核销明细：${
          items.map(i => `${esc(i.bill_no)} ${Core.fmtYuan(i.amount_cents)} 元`).join(' · ')
        }${rem > 0 ? ` · 余额转预收 ${Core.fmtYuan(rem)} 元` : ''}</div></td></tr>`);
        break;
      }
      case 'job-detail':
        toggleDetailSlot(document.querySelector(`td[data-slot="${id}"]`), () =>
          jobDetail(document.querySelector(`td[data-slot="${id}"]`), id).catch(err => toast(err.message, true)));
        break;
      case 'job-card':
        // D4 结算卡：重取工单（含 settlement_lines/plots 圈地快照）→ 纯前端 Canvas 弹窗
        Api.job(id).then(j => {
          if (!window.LedgerSettlementCard) { toast('结算卡组件未加载', true); return; }
          return window.LedgerSettlementCard.open(j);
        }).catch(err => toast(err.message, true));
        break;
      case 'job-settle':
        run(async () => {
          await Api.createSettlement(id);
          state.tab = 'settlements';
          switchNav('settlements');
        }, '结算单已生成（已确认后生成账单与分录）');
        break;
      case 'job-void':
        confirmThen(`确定作废作业 ${btn.dataset.no}？作废后不可结算。`, () => Api.voidJob(id));
        break;
      case 'job-save-lines': {
        const lines = [...collectInputs('data-line').entries()].map(([lid, v]) => ({ id: Number(lid), ...v }));
        const noteEl = document.getElementById('jobNoteInput');
        run(() => Api.patch(`/api/jobs/${id}`, { lines, note: noteEl ? noteEl.value : undefined }), '更正已保存并重算合计');
        break;
      }
      case 'st-detail':
        toggleDetailSlot(document.querySelector(`td[data-slot="st${id}"]`), () =>
          settlementDetail(document.querySelector(`td[data-slot="st${id}"]`), id, false).catch(err => toast(err.message, true)));
        break;
      case 'st-edit':
        toggleDetailSlot(document.querySelector(`td[data-slot="st${id}"]`), () =>
          settlementDetail(document.querySelector(`td[data-slot="st${id}"]`), id, true).catch(err => toast(err.message, true)));
        break;
      case 'st-save-items': {
        const items = [...collectInputs('data-item').entries()].map(([iid, v]) => ({ id: Number(iid), ...v }));
        run(() => Api.updateItems(id, items), '分项已保存');
        break;
      }
      case 'st-confirm':
        confirmThen(`确认结算 ${btn.dataset.no}？将生成账单与记账分录。`, () => Api.confirm(id));
        break;
      case 'st-reopen':
        confirmThen(`撤回结算 ${btn.dataset.no}？原分录将红冲、账单作废、作业回到可编辑。`, () => Api.reopen(id));
        break;
      case 'st-void': {
        const msg = btn.dataset.confirmed === '1'
          ? `作废已确认结算 ${btn.dataset.no}？将红冲分录并把作业置为作废（终态）。`
          : `作废草稿结算 ${btn.dataset.no}？`;
        confirmThen(msg, () => Api.voidSettlement(id));
        break;
      }
      case 'bill-receive': {
        const tr$ = btn.closest('tr');
        // 插入行 colspan 按所在表列数生成（账单页 8 列；总表宽表按自身列数）
        const colspan = tr$.closest('table').querySelector('thead tr').children.length;
        tr$.insertAdjacentHTML('afterend',
          `<tr><td colspan="${colspan}">${receiveForm(id, Number(btn.dataset.party) || null, Number(btn.dataset.unpaid))}</td></tr>`);
        btn.disabled = true;
        break;
      }
      case 'bill-edit': {
        // B4 范式收敛：单格「改金额/抹零」并入 FAB 编辑态——点单格=开编辑态并聚焦该格
        state.editMode.bills = true;
        render().then(() => {
          const inp = document.querySelector(`input[data-ek="${id}"][data-f="amount_cents"]`);
          if (inp) { inp.focus(); inp.select(); }
        }).catch(() => {});
        break;
      }
      case 'bill-bulk-clear': {
        // B4 清空批量已收勾选
        state._bulkSel = new Set();
        render().catch(() => {});
        break;
      }
      case 'bill-bulk-receive': {
        // B4 批量已收：逐张走既有 createReceipt 挂单通路（金额=未收全额，现金口径）；
        // 单张失败不中断整批（B0 守卫与服务端校验逐张生效），结束汇总
        const sel = [...state._bulkSel];
        if (!sel.length) return toast('先勾选要收款的账单', true);
        confirmThen(`批量已收 ${sel.length} 张账单（按各自未收金额全额收款，现金口径）？`, async () => {
          const all = await Api.bills();
          const byId = new Map((all || []).map(b => [b.id, b]));
          let ok = 0; const fails = [];
          for (const bid of sel) {
            try {
              const bill = byId.get(bid);
              if (!bill) throw new Error('账单不存在');
              const unpaid = bill.amount_cents + bill.adjust_cents - bill.paid_cents;
              if (!(unpaid > 0)) throw new Error('已无未收金额');
              await Api.createReceipt({ bill_id: bid, party_id: bill.party_id, amount_cents: unpaid, method: 'cash' });
              ok++;
            } catch (err2) { fails.push(`#${bid}: ${err2.message}`); }
            state._bulkSel.delete(bid);
          }
          if (fails.length) toast(`批量收款：成功 ${ok} 张，失败 ${fails.length} 张（${fails.slice(0, 2).join('；')}）`, true);
          else if (ok) toast(`批量收款完成：${ok} 张`);
          return ok;
        });
        break;
      }
      case 'rc-cust-save': {
        const amount = Core.yuanInputToCents(document.getElementById('rcCustAmount').value);
        if (!needAmount(amount)) return;
        run(() => Api.createReceipt({
          party_id: Number(document.getElementById('rcCust').value),
          amount_cents: amount,
          method: document.getElementById('rcCustMethod').value,
          occurred_at: (document.getElementById('rcCustDate') || {}).value || undefined, // B5/N-9：补记历史日期
          collector_name: document.getElementById('rcCustCollector').value || undefined,
          note: document.getElementById('rcCustNote').value || undefined
        }), '按客户收款已登记（FIFO 核销，余额转预收）');
        break;
      }
      case 'rc-save': {
        const form = btn.closest('.lg-detail');
        const amount = Core.yuanInputToCents(form.querySelector('#rcAmount').value);
        if (!needAmount(amount)) return;
        const advId = form.querySelector('#rcAdvance').value;
        run(() => Api.createReceipt({
          bill_id: Number(btn.dataset.bill),
          party_id: Number(btn.dataset.party) || undefined,
          amount_cents: amount,
          method: form.querySelector('#rcMethod').value,
          occurred_at: (form.querySelector('#rcDate') || {}).value || undefined, // B5/N-9：补记历史日期
          collector_name: form.querySelector('#rcCollector').value || undefined,
          from_advance_id: advId ? Number(advId) : undefined,
          note: form.querySelector('#rcNote').value || undefined
        }), '收款已登记');
        break;
      }
      case 'rc-void':
        confirmThen(`作废收款 ${btn.dataset.no}？将生成反向分录并回退账单。`, () => Api.voidFinance('receipts', id));
        break;
      case 'pm-save': {
        const amount = Core.yuanInputToCents(document.getElementById('pmAmount').value);
        if (!needAmount(amount)) return;
        // C3：手工支出备注必填（记录质量；导入通路不受影响——服务端不强制）
        const pmNote = (document.getElementById('pmNote').value || '').trim();
        if (!pmNote) return toast('备注必填（写清用途，如：中石化加油站）', true);
        const advId = document.getElementById('pmAdvance').value;
        // C3：关联作业（单号→id；空=不挂）
        let jobId;
        const jobNo = (document.getElementById('pmJob').value || '').trim();
        if (jobNo) {
          const j = (state._jobsRecent || []).find(x => x.job_no === jobNo);
          if (!j) return toast(`未找到作业 ${jobNo}（单号需与工单页一致）`, true);
          jobId = j.id;
        }
        run(() => Api.createPayment({
          category: document.getElementById('pmCategory').value,
          amount_cents: amount,
          method: document.getElementById('pmMethod').value,
          occurred_at: (document.getElementById('pmDate') || {}).value || undefined, // B5/N-9：补记历史日期
          job_id: jobId, // C3：支出挂作业（payments.job_id 起用）
          from_advance_id: advId ? Number(advId) : undefined,
          note: pmNote
        }), '支出已登记');
        break;
      }
      case 'pm-void':
        confirmThen(`作废支出 ${btn.dataset.no}？将生成反向分录。`, () => Api.voidFinance('payments', id));
        break;
      case 'adv-save': {
        const amount = Core.yuanInputToCents(document.getElementById('advAmount').value);
        if (!needAmount(amount)) return;
        run(() => Api.createAdvance({
          party_id: Number(document.getElementById('advParty').value),
          direction: document.getElementById('advDirection').value,
          amount_cents: amount,
          occurred_at: (document.getElementById('advDate') || {}).value || undefined, // B5/N-9：补记历史日期
          note: document.getElementById('advNote').value || undefined
        }), '已登记');
        break;
      }
      case 'adv-settle': {
        const v = window.prompt(`冲销 ${btn.dataset.no}（余额 ${Core.fmtYuan(Number(btn.dataset.balance))} 元），输入金额(元)：`);
        if (v == null) return;
        const amount = Core.yuanInputToCents(v);
        if (!needAmount(amount)) return;
        run(() => Api.settleAdvance(id, { amount_cents: amount, ref_type: 'manual', note: '还款冲销' }), '冲销完成');
        break;
      }
      case 'adv-void':
        confirmThen(`作废预收/预支 ${btn.dataset.no}？`, () => Api.voidFinance('advances', id));
        break;
      case 'month-set':
        state.month[btn.dataset.tab] = btn.dataset.month;
        render().catch(err => toast(err.message, true));
        break;
      case 'goto-tab': {
        // B3 通用跳页（步骤条/空状态直达动作）
        const to = btn.dataset.tab;
        if (!to) break;
        state.tab = to;
        document.querySelectorAll('#lgNav button').forEach(b => b.classList.toggle('active', b.dataset.tab === to));
        render().catch(err => toast(err.message, true));
        break;
      }
      case 'modal-close': {
        const m = document.getElementById('lgModal');
        if (m) m.remove();
        break;
      }
      case 'usage-view': {
        // C3 用药史弹层：data-party-id=客户档案（主数据行）/ data-bill-id=账单所属作业（账单行）；
        // 库存联动列 M2 未做显'—'（计划注记）
        const q = btn.dataset.billId ? { bill_id: btn.dataset.billId } : { party_id: btn.dataset.partyId };
        const title = btn.dataset.billId ? `账单用药明细（${btn.dataset.billNo || '#' + btn.dataset.billId}）`
          : `用药史：${btn.dataset.partyName || ''}`;
        try {
          const rows = await Api.usageHistory(q);
          showModal(`<h2>${esc(title)}</h2>
            <table class="lg-table"><thead><tr>
              <th>日期</th><th>药型</th><th>亩数</th><th>单价(元/亩)</th><th>用药(套)</th><th>自备(套)</th><th>药钱</th><th>口径</th><th>库存联动</th>
            </tr></thead><tbody>${(rows || []).map(r => `<tr>
              <td>${esc((r.job_date || '').slice(0, 10))}</td><td>${esc(r.drug || '—')}</td>
              <td class="num">${r.area_mu ?? '—'}</td><td class="num">${r.unit_price_yuan ?? '—'}</td>
              <td class="num">${r.used_sets ?? '—'}</td><td class="num">${r.self_sets ?? '—'}</td>
              <td class="num">${r.pesticide_fee_cents ? Core.fmtYuan(r.pesticide_fee_cents) : '—'}</td>
              <td>${r.included ? '包药' : '不包药'}</td><td>—</td>
            </tr>`).join('') || `<tr><td colspan="9">${Core.emptyState('💊', '暂无用药记录', [], { cell: true })}</td></tr>`}</tbody></table>`);
        } catch (e) { toast(e.message, true); }
        break;
      }
      case 'rc-mix-open': {
        // C3 混合核销弹层：选客户+金额 → FIFO 预案可改（每行金额输入，可移除），提交带 allocations
        const custOpts = parties.filter(p => p.type === 'customer').map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
        showModal(`<h2>混合核销（按客户收款，可改 FIFO 预案）</h2>
          <div class="lg-form">
            <label>客户<select id="mixParty">${custOpts}</select></label>
            <label>收款金额(元)<input id="mixAmount" type="number" step="0.01" min="0.01"></label>
            <label>方式<select id="mixMethod"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="bank">银行</option></select></label>
            <button class="lg-btn" data-act="rc-mix-prefill">生成/刷新 FIFO 预案</button>
          </div>
          <div id="mixPlan"></div>
          <div class="lg-form" style="margin-top:8px">
            <button class="lg-btn primary" data-act="rc-mix-save">✔ 按预案收款</button>
          </div>`);
        break;
      }
      case 'rc-mix-prefill': {
        // FIFO 预案：拉未清账单贪心分配到当前金额（每行可改/移除；余额自动转预收）
        const pid = Number((document.getElementById('mixParty') || {}).value);
        const amount = Core.yuanInputToCents((document.getElementById('mixAmount') || {}).value);
        if (!pid) return toast('先选客户', true);
        if (!needAmount(amount)) return;
        try {
          const bills = (await Api.bills()).filter(b => b.party_id === pid && (b.status === 'unpaid' || b.status === 'partial'));
          let remaining = amount;
          const rows = bills.map(b => {
            const unpaid = b.amount_cents + b.adjust_cents - b.paid_cents;
            const use = Math.min(unpaid, remaining);
            remaining -= use;
            return `<tr>
              <td>${esc(b.bill_no)}</td>
              <td class="num">${Core.fmtYuan(b.amount_cents + b.adjust_cents)}</td>
              <td class="num">${Core.fmtYuan(unpaid)}</td>
              <td class="num"><input data-mixbill="${b.id}" type="number" step="0.01" min="0" value="${(use / 100).toFixed(2)}" style="width:90px"></td>
              <td><button class="lg-btn" data-act="rc-mix-drop" title="本行分配清零">✕</button></td>
            </tr>`;
          }).join('');
          const plan = document.getElementById('mixPlan');
          if (plan) plan.innerHTML = `<table class="lg-table"><thead><tr>
              <th>账单</th><th>应付</th><th>未收</th><th>本笔分配(元)</th><th></th>
            </tr></thead><tbody>${rows || '<tr><td colspan="5">该客户暂无未清账单（全额将转预收）</td></tr>'}</tbody></table>
            ${remaining > 0 ? `<div class="lg-tag warn">余 ${Core.fmtYuan(remaining)} 将转预收</div>` : ''}`;
        } catch (e) { toast(e.message, true); }
        break;
      }
      case 'rc-mix-drop': {
        const inp = btn.closest('tr').querySelector('input[data-mixbill]');
        if (inp) inp.value = '0';
        break;
      }
      case 'rc-mix-save': {
        const pid = Number((document.getElementById('mixParty') || {}).value);
        const amount = Core.yuanInputToCents((document.getElementById('mixAmount') || {}).value);
        if (!needAmount(amount)) return;
        const allocs = [...document.querySelectorAll('input[data-mixbill]')]
          .map(el => ({ bill_id: Number(el.dataset.mixbill), amount_cents: Core.yuanInputToCents(el.value) }))
          .filter(a => a.amount_cents != null && a.amount_cents > 0);
        run(() => Api.createReceipt({
          party_id: pid, amount_cents: amount,
          method: (document.getElementById('mixMethod') || {}).value || 'cash',
          allocations: allocs.length ? allocs : undefined, // 空=纯 FIFO；有=混合核销（服务端校验）
          note: '混合核销（收款页弹层）'
        }), '混合核销已登记').then(ok => { if (ok !== undefined) { const m = document.getElementById('lgModal'); if (m) m.remove(); } });
        break;
      }
      case 'onboard-replay':
        // B3 设置区「重看引导」
        if (window.LedgerOnboard) window.LedgerOnboard.show();
        break;
      case 'bar-quick':
        // P10-R2 数据条快捷档：总/日/周/月/季/年（基于今天的本日/本周/本月/本季/本年，总=全期；
        // 生效区间=快捷区间与已填日期取交集）。两日期都填时按钮置灰不会触发，防御性再拦一道
        if (Core.barUiOf(state.bar, todayStr()).locked) break;
        state.bar.quick = btn.dataset.quick;
        persistBar();
        render().catch(err => toast(err.message, true));
        break;
      case 'card-gran':
      case 'card-quick':
      case 'card-del':
      case 'card-add':
      case 'card-add-type':
      case 'ov-jump-month':
        // 图表 dashboard（P10-R3）：卡桶粒度/日期快捷/删除/添加弹层与月跳转，处理在 ledger/js/charts.js
        if (window.LedgerCharts) window.LedgerCharts.handleAct(btn, T);
        break;
      case 'sp-save': {
        const amount = Core.yuanInputToCents(document.getElementById('spAmount').value);
        if (!needAmount(amount)) return;
        run(() => Api.createSplit({
          party_id: Number(document.getElementById('spParty').value),
          amount_cents: amount,
          note: document.getElementById('spNote').value || undefined
        }), '分成已登记');
        break;
      }
    }
  }

  /** 编辑模式保存：按页收集变更并逐行 PATCH（仅变更行）。
      总表（P4-M1）同屏两类行：账单行走 data-ekb→PATCH /api/bills/:id，
      支出行走 data-ekp→PATCH /api/payments/:id（分通道避免两类 id 撞键） */
  async function saveEditMode(tab) {
    if (tab === 'overview') {
      const billChanges = collectInputs('data-ekb');
      const payChanges = collectInputs('data-ekp');
      if (!billChanges.size && !payChanges.size) { state.editMode[tab] = false; render().catch(() => {}); return; }
      let ok = 0;
      for (const [rowId, fields] of billChanges) {
        try { await Api.patchBill(Number(rowId), fields); ok++; }
        catch (e) { toast(`账单行 ${rowId} 保存失败：${e.message}`, true); }
      }
      for (const [rowId, fields] of payChanges) {
        try { await Api.editPayment(Number(rowId), fields); ok++; }
        catch (e) { toast(`支出行 ${rowId} 保存失败：${e.message}`, true); }
      }
      toast(`已保存 ${ok} 行`);
      state.editMode[tab] = false;
      return;
    }
    const changes = collectInputs('data-ek');
    if (!changes.size) { state.editMode[tab] = false; render().catch(() => {}); return; }
    let ok = 0;
    for (const [rowId, fields] of changes) {
      try {
        if (tab === 'bills') await Api.patchBill(Number(rowId), fields);
        else if (tab === 'receipts') await Api.editReceipt(Number(rowId), fields);
        else if (tab === 'payments') await Api.editPayment(Number(rowId), fields);
        else if (tab === 'advances') await Api.editAdvanceNote(Number(rowId), fields);
        ok++;
      } catch (e) { toast(`行 ${rowId} 保存失败：${e.message}`, true); }
    }
    toast(`已保存 ${ok} 行`);
    state.editMode[tab] = false;
    // P6-M2(F4)：保存成功也必须重绘，否则停留在"幽灵编辑态"（editMode 已 false 但 DOM 仍是输入框）
    await render();
  }

  /** 右下角浮动总编辑按钮（position:fixed，跟随滚动） */
  function updateFab() {
    // B4 编辑态可感知：body.lg-editing（浅黄底输入）+ 顶部细条 #lgEditbar
    //（body 级元素不随 #lgMain 重绘丢；非编辑页签一律清除）
    const editing = !!state.editMode[state.tab];
    document.body.classList.toggle('lg-editing', editing);
    let bar = document.getElementById('lgEditbar');
    if (editing) {
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'lgEditbar';
        document.body.insertBefore(bar, document.body.firstChild);
      }
      bar.textContent = '✏️ 正在编辑本页 · 改完点右下角「💾 保存全部」生效（取消=放弃全部改动）';
    } else if (bar) bar.remove();
    // P10-R4：#lgImportFab 导入 FAB（D2 裁决）——所有页签常显，独立元素独立语义，
    // 绝不与 #lgFab 编辑/保存/取消混用（位置在其正下方，CSS bottom 各自错开）
    let ifab = document.getElementById('lgImportFab');
    if (!ifab) {
      ifab = document.createElement('div');
      ifab.id = 'lgImportFab';
      ifab.innerHTML = '<button class="lg-fab-btn lg-fab-import" data-fab="import" title="快捷导入：LLM 文本 / 计算器作业包 / Excel（拖文件自动识别）">📥 导入</button>';
      document.body.appendChild(ifab);
    }
    let fab = document.getElementById('lgFab');
    if (!fab) {
      fab = document.createElement('div');
      fab.id = 'lgFab';
      document.body.appendChild(fab);
    }
    const tab = state.tab;
    const editableTabs = ['bills', 'receipts', 'payments', 'advances', 'overview'];
    if (!editableTabs.includes(tab)) { fab.style.display = 'none'; return; }
    fab.style.display = '';
    if (state.editMode[tab]) {
      fab.innerHTML = '<button class="lg-fab-btn lg-fab-save" data-fab="save">💾 保存全部</button><button class="lg-fab-btn lg-fab-cancel" data-fab="cancel">✕ 取消</button>';
    } else {
      fab.innerHTML = '<button class="lg-fab-btn lg-fab-edit" data-fab="edit">✏️ 编辑本页</button>';
    }
  }

  /** 通用信息弹层（body 级，重绘不丢；#lgModal 单例——每次覆盖） */
  function showModal(innerHtml) {
    let m = document.getElementById('lgModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'lgModal';
      m.className = 'lg-modal-mask';
      document.body.appendChild(m);
    }
    m.innerHTML = `<div class="lg-modal-panel"><div class="lg-modal-head">
        <button class="lg-btn" data-act="modal-close">✕ 关闭</button></div>
      <div class="lg-modal-body" style="max-height:70vh;overflow:auto">${innerHtml}</div></div>`;
    m.querySelectorAll('[data-act="modal-close"]').forEach(b =>
      b.addEventListener('click', () => m.remove()));
  }

  function switchNav(tab) {
    document.querySelectorAll('#lgNav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  }

  /* ---------- B7 顶栏视觉控件：主题三态 / 字号双档 / 全局列宽自适应 ----------
     存档键与解析纯函数在 core.js（lg-theme / lg-fontsize，坏档安全回退）；
     data-theme 挂 <html> 由 ledger.css 三态选择器消费（显式档覆盖 prefers-color-scheme）。 */
  const THEME_ORDER = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: '跟随系统', light: '亮色', dark: '暗色' };
  const THEME_ICON = { auto: '🌗', light: '☀️', dark: '🌙' };
  function applyTheme() {
    const saved = lsGet(Core.THEME_KEY);
    const mode = THEME_ORDER.includes(saved) ? saved : 'auto';
    document.documentElement.dataset.theme = mode;
    const btn = document.getElementById('lgThemeBtn');
    if (btn) {
      btn.textContent = THEME_ICON[mode];
      btn.title = `主题：${THEME_LABEL[mode]}（点击切换）`;
    }
  }
  function applyFontsize() {
    const compact = Core.normalizeFontsize(lsGet(Core.FONTSIZE_KEY)) === 'compact';
    document.body.classList.toggle('compact', compact);
    const btn = document.getElementById('lgFontBtn');
    if (btn) {
      btn.classList.toggle('active', compact);
      btn.title = compact ? '字号：紧凑（点击切回标准）' : '字号：标准（点击切到紧凑）';
    }
  }
  function bindVisualTools() {
    const themeBtn = document.getElementById('lgThemeBtn');
    if (themeBtn) themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme || 'auto';
      const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
      lsSet(Core.THEME_KEY, next);
      applyTheme();
      render().catch(() => {}); // 重挂当前页图表（echarts 色值在挂载时读 CSS 变量）
    });
    const fontBtn = document.getElementById('lgFontBtn');
    if (fontBtn) fontBtn.addEventListener('click', () => {
      lsSet(Core.FONTSIZE_KEY, document.body.classList.contains('compact') ? 'normal' : 'compact');
      applyFontsize();
    });
    const fitBtn = document.getElementById('lgAutofitBtn');
    if (fitBtn) fitBtn.addEventListener('click', () => {
      const tables = document.querySelectorAll('#lgMain table[data-colw]');
      if (!tables.length) { toast('本页没有可调列宽的表格'); return; }
      tables.forEach(table => autoFitTable(table));
      applyColWidths();
      toast('已按内容自适应本页全部表格列宽');
    });
  }

  /* ---------- 启动 ---------- */
  applyTheme(); // B7：主题/字号在首绘前落位（防暗色用户见白闪）
  applyFontsize();
  bindVisualTools();
  Api.parties().then(p => { parties = p || []; }).catch(() => { parties = []; }).finally(() => {
    render().catch(err => toast(err.message, true));
    // B3：首次访问弹三步引导（看完/跳过标记 lg-onboarded-v1，不再打扰）
    if (window.LedgerOnboard) window.LedgerOnboard.maybeShow();
  });
})();
