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
    const c = cls || (text === '已收清' || text === '已确认' ? '' : (text === '未收' || text === '待确认' || text === '待结算' || text === '已重开' ? 'warn' : (text === '已作废' ? 'err' : '')));
    return `<span class="lg-tag ${c}">${esc(text)}</span>`;
  }
  function actions(...btns) { return btns.filter(Boolean).join(' '); }

  /* ---------- 页签：工单 ---------- */
  function renderJobs(jobsAll) {
    const rowsAll = jobsAll.map(j => ({
      ...Core.jobRow(j), _month: (j.job_date || '').slice(0, 7), _note: j.note || '', _income: j.income_cents
    }));
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
    return `<div class="lg-panel">
      <h2>现场工单（计算器上报，只读执行数据；金额可更正）</h2>
      ${toolbarHtml('jobs', { searchPh: '单号/备注' })}
      ${monthStrip('jobs', rowsAll, '_month')}
      <table class="lg-table" data-colw="jobs"><thead><tr>
        <th>单号</th><th>日期</th><th>类型</th><th>状态</th><th>规模</th><th>收入(元)</th><th>操作</th>
      </tr></thead><tbody>${body || '<tr><td colspan="7">暂无工单——请用计算器完成作业并点"同步到账本"</td></tr>'}</tbody>
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
    // 成本构成快照（007，仅计算器来源单有值）
    const parts = [
      ['油费', j.fuel_expense_cents], ['电池折旧', j.battery_depreciation_cents],
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
    return `<div class="lg-panel">
      <h2>结算单（确认后生成账单与分录；撤回=红冲重开）</h2>
      ${toolbarHtml('settlements', { statusMap: Core.MAPS.SETTLEMENT_STATUS, searchPh: '结算号/作业单号' })}
      ${monthStrip('settlements', listAll, 'job_date')}
      <table class="lg-table" data-colw="st-main"><thead><tr>
        <th>结算号</th><th>作业单</th><th>日期</th><th>状态</th>
        <th>作业费(元)</th><th>药费(元)</th><th>应收合计</th><th>已收</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="9">暂无结算单</td></tr>'}</tbody>
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
    const list = pipeFilters(byMonth(rowsAll, '_month', 'bills'), 'bills', { q: ['bill_no', 'party'], party: 'party' });
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
      return `<tr>
        <td>${esc(b.bill_no)}</td>${custCell(b.party)}<td>${tag(b.statusText)}</td>
        <td class="num">${amountCell}</td><td class="num">${adjustCell}</td>
        <td class="num"><b>${b.payableYuan}</b></td><td class="num">${b.paidYuan}</td>
        <td>${actions(
          b.canReceive ? `<button class="lg-btn primary" data-act="bill-receive" data-id="${b.id}" data-party="${b.party_id || ''}" data-unpaid="${b.unpaidCents}">登记收款</button>` : '',
          b.canEdit && !em ? `<button class="lg-btn" data-act="bill-edit" data-id="${b.id}">改金额/抹零</button>` : ''
        )}</td>
      </tr>`;
    }).join('');
    return `<div class="lg-panel">
      <h2>账单（确认后只读；未收可改金额/抹零；收款在「收款」页或下方按钮）</h2>
      ${toolbarHtml('bills', { statusMap: Core.MAPS.BILL_STATUS, searchPh: '客户名/账单号' })}
      ${monthStrip('bills', rowsAll, '_month')}
      <table class="lg-table" data-colw="bills"><thead><tr>
        <th>账单号</th><th>客户</th><th>状态</th><th>金额</th><th>调整</th><th>应收</th><th>已收</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="8">暂无账单</td></tr>'}</tbody>
      ${tfootHtml(3, list, [['金额', sumCents(list, '_amount')], ['调整', sumCents(list, '_adjust')], ['应收', sumCents(list, '_payable')], ['已收', sumCents(list, '_paid')]], 1)}</table>
    </div>`;
  }

  /* ---------- 页签：收款 ---------- */
  function renderReceipts(listAll) {
    const rowsAll = listAll.map(r0 => ({ ...r0, _amount: r0.amount_cents }));
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
    return `<div class="lg-panel">
      <h2>按客户收款（一笔钱自动按最早未清账单核销，余额转预收）</h2>
      <div class="lg-form">
        <label>客户<select id="rcCust">${custOpts}</select></label>
        <label>金额(元)<input id="rcCustAmount" type="number" step="0.01" min="0.01"></label>
        <label>方式<select id="rcCustMethod"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="bank">银行</option></select></label>
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
      </tr></thead><tbody>${rows || '<tr><td colspan="8">暂无收款</td></tr>'}</tbody>
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
        <label>经手人<input id="rcCollector" placeholder="选填"></label>
        <label>预收抵扣(可选)<select id="rcAdvance"><option value="">不用预收</option>${advOpts}</select></label>
        <label>备注<input id="rcNote" placeholder="选填"></label>
        <button class="lg-btn primary" data-act="rc-save" data-bill="${billId}" data-party="${partyId || ''}">确认收款</button>
      </div></div>`;
  }

  /* ---------- 页签：支出 ---------- */
  function renderPayments(listAll) {
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
    return `<div class="lg-panel">
      <h2>登记支出（油费/药费/维修/吃饭/设备/人工）</h2>
      <div class="lg-form">
        <label>类别<select id="pmCategory">${catOpts}</select></label>
        <label>金额(元)<input id="pmAmount" type="number" step="0.01" min="0.01"></label>
        <label>支付方式<select id="pmMethod"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option></select></label>
        <label>从预支付款<select id="pmAdvance"><option value="">不使用</option>${advOpts}</select></label>
        <label>备注<input id="pmNote" placeholder="如：中石化加油站"></label>
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
        : Core.fmtYuan(r._amount);
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
    return `${barData ? renderKpiBar(barData.range, barData.kpi, barData.region, barData.operator) : ''}
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
      ${toolbarHtml('ovpay', { category: true, searchPh: '收款方/单号/备注' })}
      ${monthStrip('ovpay', listAll, 'occurred_at')}
      <table class="lg-table" data-colw="ov-pay"><thead><tr>
        <th>单号</th><th>类别</th><th>金额(元)</th><th>收款方</th><th>日期</th><th>备注</th><th>状态</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无支出</td></tr>'}</tbody>
      ${tfootHtml(2, liveRows, [['支出', sumCents(liveRows, '_amount')]], 4)}</table>
    </div>`;
  }

  /* ---------- 总表顶部数据条（P5-M2 §3）：区间计算 ---------- */
  function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dstr(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
  function parseD(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }

  /** 周区间：复刻服务端 %W 归桶口径（reports.js bucketExpr week：周一始自然周，
      年内首个周一前的日子记 W00）——锚点落 W00 窗口时区间=当年 1 月 1 日..首个周一前一日，
      与图表周桶对齐（R1 建议 10）；简单"取本周一"会落到上一年 12 月而错位 */
  function weekRange(anchor) {
    const d = parseD(anchor);
    const dow = (d.getUTCDay() + 6) % 7; // 0=周一
    const monday = new Date(d); monday.setUTCDate(monday.getUTCDate() - dow);
    const y = Number(String(anchor).slice(0, 4));
    const jan1 = new Date(Date.UTC(y, 0, 1));
    const firstMonday = new Date(jan1);
    firstMonday.setUTCDate(firstMonday.getUTCDate() + (7 - (jan1.getUTCDay() + 6) % 7) % 7);
    if (monday < firstMonday) {
      const w00end = new Date(firstMonday); w00end.setUTCDate(w00end.getUTCDate() - 1);
      return { from: `${y}-01-01`, to: dstr(w00end), w00: true };
    }
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    return { from: dstr(monday), to: dstr(sunday), w00: false };
  }

  /** 数据条 [from,to]：日/周/月/季/年（锚点=具体某日，改日期即切某日/周边/某月/某季/某年） */
  function barRangeOf(bar) {
    const a = /^\d{4}-\d{2}-\d{2}$/.test(bar.anchor || '') ? bar.anchor : todayStr();
    if (bar.gran === 'day') return { from: a, to: a, note: `${a}（当日）` };
    if (bar.gran === 'week') {
      const r = weekRange(a);
      return { from: r.from, to: r.to, note: `${r.from}..${r.to}（周${r.w00 ? '，W00 窗口' : ''}）` };
    }
    const y = Number(a.slice(0, 4)), m = Number(a.slice(5, 7));
    if (bar.gran === 'month') {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(last)}`, note: `${y}-${pad2(m)}（月）` };
    }
    if (bar.gran === 'quarter') {
      const qs = Math.floor((m - 1) / 3) * 3 + 1, qe = qs + 2, qi = Math.floor((m - 1) / 3) + 1;
      const last = new Date(Date.UTC(y, qe, 0)).getUTCDate();
      return { from: `${y}-${pad2(qs)}-01`, to: `${y}-${pad2(qe)}-${pad2(last)}`, note: `${y} Q${qi}（季）` };
    }
    return { from: `${y}-01-01`, to: `${y}-12-31`, note: `${y}（年）` };
  }

  /** KPI 数据条 DOM（收支三卡 + 单数/亩数/客户数 + 粒度/锚点 + 两张小图） */
  function renderKpiBar(range, kpi, region, operator) {
    const granDef = [['day', '日'], ['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年']];
    const btns = granDef.map(([v, t]) =>
      `<button class="lg-btn ${state.bar.gran === v ? 'primary' : ''}" data-act="bar-gran" data-gran="${v}">${t}</button>`).join('');
    const fmt = c => Core.fmtYuan(c);
    const pCount = (parties || []).length;
    const un = operator && operator.unrecorded;
    return `<div class="lg-kpis" id="lgKpiBar">
      <div class="lg-kpi"><span class="lg-kpi-label">收入(元)</span><b class="lg-kpi-num">${fmt(kpi.income_cents)}</b><span class="lg-kpi-sub">${esc(range.note)}</span></div>
      <div class="lg-kpi"><span class="lg-kpi-label">支出(元)</span><b class="lg-kpi-num">${fmt(kpi.expense_cents)}</b><span class="lg-kpi-sub">${esc(range.from)}..${esc(range.to)}</span></div>
      <div class="lg-kpi"><span class="lg-kpi-label">利润(元)</span><b class="lg-kpi-num ${kpi.profit_cents < 0 ? 'bad' : ''}">${fmt(kpi.profit_cents)}</b><span class="lg-kpi-sub">收入/支出=账簿确认口径</span></div>
      <div class="lg-kpi"><span class="lg-kpi-label">作业单数</span><b class="lg-kpi-num">${kpi.jobs_count}</b><span class="lg-kpi-sub">亩数 ${kpi.area_mu ?? '—'}（作业口径）</span></div>
      <div class="lg-kpi"><span class="lg-kpi-label">客户数</span><b class="lg-kpi-num">${kpi.customer_count}</b><span class="lg-kpi-sub">本期作业客户 · 总数 ${pCount}（启用）</span></div>
      <div class="lg-kpi lg-kpi--ctrl"><span class="lg-kpi-label">区间（改日期即切某日/周边/某月…）</span>
        <div class="lg-gran">${btns}</div>
        <input type="date" id="barAnchor" value="${esc(state.bar.anchor)}" title="锚点日期：当日/该周边/该月/该季/该年">
      </div>
      <div class="lg-kpi lg-kpi--chart"><span class="lg-kpi-label">地区收入占比${(region && region.rows || []).some(r => r.label === '(未填)') ? '（含未填）' : ''}</span><div class="lg-chart-canvas" data-chart="bar-region"></div></div>
      <div class="lg-kpi lg-kpi--chart"><span class="lg-kpi-label">飞手收入占比${un && un.income_cents > 0 ? `（未记录 ${un.jobs_count} 单）` : ''}</span><div class="lg-chart-canvas" data-chart="bar-operator"></div></div>
    </div>`;
  }

  /* ---------- 渲染调度 ---------- */
  const state = { tab: 'overview', _advances: [], month: {}, editMode: {}, filter: {}, custFilter: null, bar: { gran: 'day', anchor: todayStr() } };

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
  function toolbarHtml(tab, { statusMap = null, category = false, searchPh = '客户名/单号/备注' } = {}) {
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
      <button class="lg-btn" data-act="csv-export" title="导出当前月份与筛选口径为 CSV（Excel 可开）">⬇ 导出CSV</button>
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
  function render() {
    const p = renderChain.then(() => doRender());
    renderChain = p.catch(() => {});
    return p;
  }

  async function doRender() {
    // P5-M2：innerHTML 重建前统一释放 echarts 实例（charts.js renderTab 开头另有一次，双保险）
    if (window.LedgerCharts && window.LedgerCharts.disposeAll) window.LedgerCharts.disposeAll();
    const tab = state.tab;
    if (tab === 'overview') {
      // 预收下拉依赖 state._advances（同 payments 分支）；支出面板块复用 payments 列表
      state._advances = await Api.advances();
      const range = barRangeOf(state.bar);
      const [data, pays, kpi, region, operator] = await Promise.all([
        Api.overview(), Api.payments(),
        Api.barRange(range.from, range.to),
        Api.byRegion('region', range.from, range.to),
        Api.byOperator(range.from, range.to)
      ]);
      $main.innerHTML = renderOverview(data, pays, { range, kpi, region, operator });
      // 数据条两张小图（地区环图 + 飞手饼图；复用 charts.js 实例注册表；vendor 缺失时内部降级提示）
      if (window.LedgerCharts && window.LedgerCharts.mountMini) {
        window.LedgerCharts.mountMini(document.getElementById('lgKpiBar'), { region, operator });
      }
    } else if (tab === 'jobs') {
      $main.innerHTML = renderJobs(await Api.jobs());
    } else if (tab === 'settlements') {
      $main.innerHTML = renderSettlements(await Api.settlements());
    } else if (tab === 'bills') {
      $main.innerHTML = renderBills(await Api.bills());
    } else if (tab === 'receipts') {
      try { parties = await Api.parties(); } catch (e) { /* 拉不到就用旧缓存 */ }
      $main.innerHTML = renderReceipts(await Api.receipts());
    } else if (tab === 'reports') {
      $main.innerHTML = await renderReports();
    } else if (tab === 'charts') {
      // 图表页（P4-M2，ledger/js/charts.js）：内联 SVG 手绘
      await window.LedgerCharts.renderTab(tab, $main);
    } else if (tab === 'payments') {
      state._advances = await Api.advances();
      $main.innerHTML = renderPayments(await Api.payments());
    } else if (tab === 'advances') {
      state._advances = await Api.advances();
      $main.innerHTML = renderAdvances(state._advances);
    } else if (tab === 'splits') {
      $main.innerHTML = renderSplits(await Api.splits());
    } else if (tab === 'journal') {
      $main.innerHTML = renderJournal(await Api.journal());
    } else if (tab === 'import' || tab === 'master') {
      await window.LedgerExtra.renderTab(tab, $main);
    }
    applyColWidths(); // P5-M3：全量重绘后统一恢复列宽（含明细插槽外各表的手柄注入）
    refreshSummary();
    updateFab();
  }

  async function refreshSummary() {
    try {
      const s = await Api.summary();
      document.getElementById('lgSummary').textContent =
        `应收 ${Core.fmtYuan(s.receivable_cents)} · 已收 ${Core.fmtYuan(s.received_cents)} · 支出 ${Core.fmtYuan(s.expense_cents)} · 预收余 ${Core.fmtYuan(s.prepaid_cents)}`;
    } catch (e) { /* 顶部汇总失败不打扰 */ }
  }

  /* ---------- 列宽拖拽与记忆（P5-M3 表格 Excel 化；纯函数在 core.js：colwKey/parseColw/clampColw） ----------
     applyColWidths 在每次全量重绘后统一恢复：doRender 尾部 / toggleDetailSlot 明细插槽挂钩 /
     LedgerExtra.renderTab 返回链（app-extra 直调重绘的旁路）。有存档的表才插 colgroup+lg-fixed
     （table-layout:fixed），无存档表零改动；拖拽是 $main 上一条 mousedown 委托（与既有
     click/input/change 委托同构，全量重绘与 app-extra 直调重绘都不会丢监听），手柄上
     preventDefault+stopPropagation，与点击过滤/排序、handleAct 委托互不干扰。 */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 隐私模式丢弃 */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* 忽略 */ } }
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
      h.title = '拖动调列宽；双击恢复默认列宽';
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
    const h = e.target.closest('.lg-colw-h');
    if (!h) return;
    const table = h.closest('table[data-colw]');
    if (!table || !table.dataset.colw) return;
    lsDel(Core.colwKey(state.tab, table.dataset.colw)); // 双击手柄=清除该表存档回默认
    applyColWidths();
  });
  window.LedgerColWidths = { apply: applyColWidths };

  /* ---------- 事件委托 ---------- */
  document.getElementById('lgNav').addEventListener('click', e => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    document.querySelectorAll('#lgNav button').forEach(b => b.classList.toggle('active', b === btn));
    state.tab = btn.dataset.tab;
    render().catch(err => toast(err.message, true));
  });

  document.addEventListener('click', e => {
    const fb = e.target.closest('[data-fab]');
    if (!fb) return;
    const tab = state.tab;
    if (fb.dataset.fab === 'edit') { state.editMode[tab] = true; render().catch(() => {}); }
    else if (fb.dataset.fab === 'cancel') { state.editMode[tab] = false; render().catch(() => {}); }
    else if (fb.dataset.fab === 'save') { saveEditMode(tab); }
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
  $main.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'barAnchor') {
      // P5-M2 数据条：改锚点日期即按当前档位重算区间（清空不触发，避免空区间请求）
      if (el.value) { state.bar.anchor = el.value; render().catch(err => toast(err.message, true)); }
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
    if (!tr.hidden && slot.innerHTML === '') {
      // P5-M3：明细插槽异步向 slot 插表（job-detail/st-detail/st-edit 三入口），
      // doRender 尾部与 renderTab 返回链都不会在明细展开后执行，loader 完成后单独恢复列宽
      const r = loader();
      if (r && typeof r.then === 'function') r.then(() => applyColWidths());
      else applyColWidths();
    }
  }
  function needAmount(v) {
    if (v == null || isNaN(v) || v <= 0) { toast('金额非法', true); return false; }
    return true;
  }

  const T = { run, toast, confirmThen, needAmount, collectInputs, esc, tag, actions, Core, Api, state, switchNav, render, applyColWidths };
  window.__ledgerTools = T; // app-extra.js 的工具注入源（P2-4 拆分）

  function handleAct(btn) {
    const act = btn.dataset.act;
    const id = Number(btn.dataset.id);
    // 导入/主数据页签的处理在 app-extra.js（P2-4 拆分）
    if (window.LedgerExtra && /^(imp-|md-|op-|nc-|plot-)/.test(act)) return window.LedgerExtra.handleAct(btn, T);
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
        const row$ = btn.closest('tr');
        const amountCell = row$.children[3], adjustCell = row$.children[4];
        amountCell.innerHTML = `<input data-be="amount" type="number" step="0.01" value="${amountCell.textContent.replace(/,/g, '')}">`;
        adjustCell.innerHTML = `<input data-be="adjust" type="number" step="0.01" value="${adjustCell.textContent === '—' ? 0 : adjustCell.textContent.replace(/,/g, '')}">`;
        btn.textContent = '保存';
        btn.dataset.act = 'bill-edit-save';
        break;
      }
      case 'bill-edit-save': {
        const row$ = btn.closest('tr');
        const amount = Core.yuanInputToCents(row$.querySelector('[data-be="amount"]').value);
        const adjust = Core.yuanInputToCents(row$.querySelector('[data-be="adjust"]').value);
        run(() => Api.patchBill(id, {
          amount_cents: amount == null ? undefined : amount,
          adjust_cents: adjust == null ? undefined : adjust
        }), '账单已更新');
        break;
      }
      case 'rc-cust-save': {
        const amount = Core.yuanInputToCents(document.getElementById('rcCustAmount').value);
        if (!needAmount(amount)) return;
        run(() => Api.createReceipt({
          party_id: Number(document.getElementById('rcCust').value),
          amount_cents: amount,
          method: document.getElementById('rcCustMethod').value,
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
        const advId = document.getElementById('pmAdvance').value;
        run(() => Api.createPayment({
          category: document.getElementById('pmCategory').value,
          amount_cents: amount,
          method: document.getElementById('pmMethod').value,
          from_advance_id: advId ? Number(advId) : undefined,
          note: document.getElementById('pmNote').value || undefined
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
      case 'bar-gran':
        // P5-M2 数据条：切 日/周/月/季/年（区间按锚点重算后重渲染）
        state.bar.gran = btn.dataset.gran;
        render().catch(err => toast(err.message, true));
        break;
      case 'gran-set':
      case 'ov-jump-month':
        // 图表页（P4-M2）：粒度切换与柱/点跳总表当月，处理在 ledger/js/charts.js
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
  }

  /** 右下角浮动总编辑按钮（position:fixed，跟随滚动） */
  function updateFab() {
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

  function switchNav(tab) {
    document.querySelectorAll('#lgNav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  }

  /* ---------- 启动 ---------- */
  Api.parties().then(p => { parties = p || []; }).catch(() => { parties = []; }).finally(() => {
    render().catch(err => toast(err.message, true));
  });
})();
