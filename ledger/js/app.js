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
  function renderJobs(jobs) {
    const rows = jobs.map(j => {
      const r = Core.jobRow(j);
      return `<tr>
        <td>${esc(r.job_no)}</td><td>${esc(r.job_date)}</td><td>${esc(r.type)}</td>
        <td>${tag(r.statusText)}</td><td>${esc(r.primary)}</td>
        <td class="num">${r.incomeYuan}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="job-detail" data-id="${r.id}">详情/更正</button>`,
          r.canSettle ? `<button class="lg-btn primary" data-act="job-settle" data-id="${r.id}">生成结算</button>` : '',
          r.canVoid ? `<button class="lg-btn danger" data-act="job-void" data-id="${r.id}" data-no="${esc(r.job_no)}">作废</button>` : ''
        )}</td>
      </tr><tr hidden><td colspan="7" class="lg-detail-slot" data-slot="${r.id}"></td></tr>`;
    }).join('');
    return `<div class="lg-panel">
      <h2>现场工单（计算器上报，只读执行数据；金额可更正）</h2>
      <table class="lg-table"><thead><tr>
        <th>单号</th><th>日期</th><th>类型</th><th>状态</th><th>规模</th><th>收入(元)</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无工单——请用计算器完成作业并点"同步到账本"</td></tr>'}</tbody></table>
    </div>`;
  }

  async function jobDetail(slot, id) {
    const j = await Api.job(id);
    const r = Core.jobRow(j);
    const lines = (j.settlement_lines || []).map(l => `
      <tr>
        <td>${esc(l.farmer_name)}</td>
        <td class="num">${Core.fmtYuan(l.spray_fee_cents)}</td>
        <td>${l.used_sets != null ? Number(l.used_sets).toFixed(2) : '—'} 套（自备 ${l.self_sets || 0}）</td>
        <td class="num">${Core.fmtYuan(l.pesticide_fee_cents)}</td>
        <td>${l.included ? '包药' : '不包药'}</td>
        ${r.canEditLines ? `<td>
          <input data-line="${l.id}" data-field="spray_fee_cents" value="${(l.spray_fee_cents || 0) / 100}" type="number" step="0.01" min="0" title="打药费(元)">
          <input data-line="${l.id}" data-field="pesticide_fee_cents" value="${(l.pesticide_fee_cents || 0) / 100}" type="number" step="0.01" min="0" title="药钱(元)">
        </td>` : '<td></td>'}
      </tr>`).join('');
    slot.innerHTML = `
      <div class="lg-detail">
        <div>备注：${esc(j.note || '—')}　·　机器：${esc(j.plant_type_name || '—')}　·　亩数 ${j.total_area_mu ?? '—'}　·　水量 ${j.total_water_l ?? '—'}L　·　趟数 ${j.total_trips ?? '—'}　·　充电 ${j.charge_count ?? '—'} 次</div>
        <table class="lg-table"><thead><tr><th>农户</th><th>打药费</th><th>用量</th><th>药钱</th><th>口径</th>${r.canEditLines ? '<th>更正(元) 打药费/药钱</th>' : ''}</tr></thead>
        <tbody>${lines || '<tr><td colspan="6">无分家明细（吊运）</td></tr>'}</tbody></table>
        ${r.canEditLines ? `<div style="margin-top:8px">
          <label>备注更正 <input id="jobNoteInput" value="${esc(j.note || '')}"></label>
          <button class="lg-btn primary" data-act="job-save-lines" data-id="${j.id}">保存更正</button>
        </div>` : ''}
      </div>`;
  }

  /* ---------- 页签：结算 ---------- */
  function renderSettlements(list) {
    const rows = list.map(s0 => {
      const s = Core.settlementRow(s0);
      return `<tr>
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
      </tr><tr hidden><td colspan="9" class="lg-detail-slot" data-slot="st${s.id}"></td></tr>`;
    }).join('');
    return `<div class="lg-panel">
      <h2>结算单（确认后生成账单与分录；撤回=红冲重开）</h2>
      <table class="lg-table"><thead><tr>
        <th>结算号</th><th>作业单</th><th>日期</th><th>状态</th>
        <th>作业费(元)</th><th>药费(元)</th><th>应收合计</th><th>已收</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="9">暂无结算单</td></tr>'}</tbody></table>
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
        <table class="lg-table"><thead><tr><th>农户</th><th>作业费(元)</th><th>药钱(元)</th><th>口径</th></tr></thead>
          <tbody>${items || '<tr><td colspan="4">无分项</td></tr>'}</tbody></table>
        ${editable ? `<button class="lg-btn primary" data-act="st-save-items" data-id="${s.id}" style="margin-top:8px">保存分项</button>` : ''}
        ${s.bills.length ? `<h2 style="margin-top:12px">账单</h2>
        <table class="lg-table"><thead><tr><th>账单号</th><th>客户</th><th>状态</th><th>应收</th><th>已收</th></tr></thead><tbody>${bills}</tbody></table>` : ''}
      </div>`;
  }

  /* ---------- 页签：账单 ---------- */
  function renderBills(bills) {
    const rows = bills.map(b0 => {
      const b = Core.billRow(b0);
      return `<tr>
        <td>${esc(b.bill_no)}</td><td>${esc(b.party)}</td><td>${tag(b.statusText)}</td>
        <td class="num">${b.amountYuan}</td><td class="num">${b.adjustYuan}</td>
        <td class="num"><b>${b.payableYuan}</b></td><td class="num">${b.paidYuan}</td>
        <td>${actions(
          b.canReceive ? `<button class="lg-btn primary" data-act="bill-receive" data-id="${b.id}" data-party="${b.party_id || ''}" data-unpaid="${b.unpaidCents}">登记收款</button>` : '',
          b.canEdit ? `<button class="lg-btn" data-act="bill-edit" data-id="${b.id}">改金额/抹零</button>` : ''
        )}</td>
      </tr>`;
    }).join('');
    return `<div class="lg-panel">
      <h2>账单（确认后只读；未收可改金额/抹零；收款在「收款」页或下方按钮）</h2>
      <table class="lg-table"><thead><tr>
        <th>账单号</th><th>客户</th><th>状态</th><th>金额</th><th>调整</th><th>应收</th><th>已收</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="8">暂无账单</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 页签：收款 ---------- */
  function renderReceipts(list) {
    const rows = list.map(r0 => {
      const adv = r0.from_advance_id ? ' · 预收抵扣' : '';
      const alloc = (() => { try { return r0.allocations ? JSON.parse(r0.allocations).items || [] : []; } catch (e) { return []; } })();
      const allocText = alloc.length ? ` · 核销 ${alloc.length} 张账单` : '';
      return `<tr>
        <td>${esc(r0.receipt_no)}</td><td>${esc(r0.party_name || '—')}</td>
        <td class="num"><b>${Core.fmtYuan(r0.amount_cents)}</b></td>
        <td>${esc(Core.MAPS.METHOD[r0.method] || r0.method)}${adv}${allocText}</td>
        <td>${esc(r0.bill_no || (alloc.length ? '按客户核销' : '—'))}</td><td>${(r0.occurred_at || '').slice(0, 10)}</td>
        <td>${r0.status === 'void' ? tag('已作废', 'err') : `<button class="lg-btn danger" data-act="rc-void" data-id="${r0.id}" data-no="${esc(r0.receipt_no)}">作废</button>`}</td>
      </tr>`;
    }).join('');
    const custOpts = parties.filter(p => p.type === 'customer')
      .map(p => `<option value="${p.id}">${esc(p.name)}${p.village ? '（' + esc(p.village) + (p.team ? p.team + '队' : '') + '）' : ''}</option>`).join('');
    return `<div class="lg-panel">
      <h2>按客户收款（一笔钱自动按最早未清账单核销，余额转预收）</h2>
      <div class="lg-form">
        <label>客户<select id="rcCust">${custOpts}</select></label>
        <label>金额(元)<input id="rcCustAmount" type="number" step="0.01" min="0.01"></label>
        <label>方式<select id="rcCustMethod"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="bank">银行</option></select></label>
        <label>备注<input id="rcCustNote" placeholder="选填"></label>
        <button class="lg-btn primary" data-act="rc-cust-save">按客户收款</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>收款记录（作废=反向分录+账单回退）</h2>
      <table class="lg-table"><thead><tr>
        <th>单号</th><th>客户</th><th>金额(元)</th><th>方式</th><th>账单</th><th>日期</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无收款</td></tr>'}</tbody></table>
    </div>`;
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
        <label>预收抵扣(可选)<select id="rcAdvance"><option value="">不用预收</option>${advOpts}</select></label>
        <label>备注<input id="rcNote" placeholder="选填"></label>
        <button class="lg-btn primary" data-act="rc-save" data-bill="${billId}" data-party="${partyId || ''}">确认收款</button>
      </div></div>`;
  }

  /* ---------- 页签：支出 ---------- */
  function renderPayments(list) {
    const catOpts = Object.entries(Core.MAPS.PAYMENT_CATEGORY)
      .map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    const advOpts = (state._advances || []).filter(a => a.direction === 'advance_to_worker' && a.status !== 'void' && a.balance_cents > 0)
      .map(a => `<option value="${a.id}">${esc(a.party_name || a.id)}（余 ${Core.fmtYuan(a.balance_cents)}）</option>`).join('');
    const rows = list.map(p0 => `<tr>
        <td>${esc(p0.payment_no)}</td><td>${esc(Core.MAPS.PAYMENT_CATEGORY[p0.category] || p0.category)}</td>
        <td class="num"><b>${Core.fmtYuan(p0.amount_cents)}</b></td>
        <td>${esc(p0.payee_name || '—')}</td><td>${(p0.occurred_at || '').slice(0, 10)}</td>
        <td>${esc(p0.note || '')}</td>
        <td>${p0.status === 'void' ? tag('已作废', 'err') : `<button class="lg-btn danger" data-act="pm-void" data-id="${p0.id}" data-no="${esc(p0.payment_no)}">作废</button>`}</td>
      </tr>`).join('');
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
      <table class="lg-table"><thead><tr>
        <th>单号</th><th>类别</th><th>金额(元)</th><th>收款方</th><th>日期</th><th>备注</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无支出</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 页签：预收预支 ---------- */
  function renderAdvances(list) {
    const opts = parties.map(p => `<option value="${p.id}">${esc(p.name)}（${esc(Core.MAPS.PARTY_TYPE[p.type] || p.type)}）</option>`).join('');
    const rows = list.map(a0 => `<tr>
        <td>${esc(a0.advance_no)}</td><td>${esc(a0.party_name || '—')}</td>
        <td>${tag(Core.MAPS.ADVANCE_DIRECTION[a0.direction] || a0.direction)}</td>
        <td class="num">${Core.fmtYuan(a0.amount_cents)}</td>
        <td class="num"><b>${Core.fmtYuan(a0.balance_cents)}</b></td>
        <td>${(a0.occurred_at || '').slice(0, 10)}</td>
        <td>${a0.status === 'void' ? tag('已作废', 'err') : actions(
          a0.direction === 'advance_to_worker' ? `<button class="lg-btn" data-act="adv-settle" data-id="${a0.id}" data-no="${esc(a0.advance_no)}" data-balance="${a0.balance_cents}">冲销</button>` : '',
          `<button class="lg-btn danger" data-act="adv-void" data-id="${a0.id}" data-no="${esc(a0.advance_no)}">作废</button>`
        )}</td>
      </tr>`).join('');
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
      <h2>预收/预支台账（余额=可用；预收抵账在收款页选"预收抵扣"）</h2>
      <table class="lg-table"><thead><tr>
        <th>单号</th><th>对象</th><th>类型</th><th>金额</th><th>余额</th><th>日期</th><th>操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无</td></tr>'}</tbody></table>
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
      <table class="lg-table"><thead><tr><th>对象</th><th>金额(元)</th><th>作业</th><th>日期</th><th>备注</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">暂无</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 页签：流水 ---------- */
  function renderJournal(entries) {
    const rows = entries.map(e0 => {
      const e = Core.journalRow(e0);
      const lineHtml = arr => arr.map(l => `${esc(l.text)} <span class="num">${l.yuan}</span>`).join('<br>') || '—';
      return `<tr>
        <td>${esc(e.entry_no)}</td><td>${esc(e.occurred)}</td><td>${esc(e.event)}</td><td>${esc(e.memo)}</td>
        <td>${lineHtml(e.debit)}</td><td>${lineHtml(e.credit)}</td>
        <td class="num ${e.balanced ? 'lg-balance' : 'lg-balance bad'}">${e.balanced ? '✓' : '✗'} ${e.totalYuan}</td>
      </tr>`;
    }).join('');
    return `<div class="lg-panel">
      <h2>复式流水（借贷必须平衡；红冲凭证 event=reversal）</h2>
      <table class="lg-table"><thead><tr>
        <th>凭证号</th><th>日期</th><th>事件</th><th>摘要</th><th>借方</th><th>贷方</th><th>平衡/金额</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="7">暂无凭证</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 页签：报表 ---------- */
  async function renderReports() {
    const s = await Api.get('/api/reports/summary');
    const months = await Api.get('/api/reports/by-month');
    const custs = await Api.get('/api/reports/by-customer');
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
      <table class="lg-table"><thead><tr><th>月份</th><th>收入(元)</th><th>支出(元)</th><th>利润(元)</th></tr></thead>
      <tbody>${monthRows || '<tr><td colspan="4">暂无</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>支出分类</h2>
      <table class="lg-table"><thead><tr><th>科目</th><th>金额(元)</th></tr></thead>
      <tbody>${expRows || '<tr><td colspan="2">暂无</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>客户盈利与余额</h2>
      <table class="lg-table"><thead><tr><th>客户</th><th>累计收入(元)</th><th>欠款(元)</th><th>预收余额(元)</th></tr></thead>
      <tbody>${custRows || '<tr><td colspan="4">暂无</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 页签：导入（M8） ---------- */
  const importState = { batchId: null, rows: [] };

  function renderImport() {
    return `<div class="lg-panel">
      <h2>上传历史 Excel（.xlsx，月度记账表格式）</h2>
      <div class="lg-form">
        <label>文件<input type="file" id="impFile" accept=".xlsx"></label>
        <span class="hint" style="color:var(--muted);font-size:12px">解析后先复核再落库；同文件重复上传会被拒绝</span>
      </div>
      <div id="impStats"></div>
    </div>
    <div class="lg-panel">
      <h2>批次</h2>
      <table class="lg-table"><thead><tr><th>批次</th><th>文件</th><th>状态</th><th>导入时间</th><th>操作</th></tr></thead>
      <tbody id="impBatches"><tr><td colspan="5">加载中…</td></tr></tbody></table>
    </div>
    <div class="lg-panel" id="impRowsPanel" style="display:none">
      <h2>行级复核（确认后才能落库；建议对照纸表/原 Excel）</h2>
      <div style="margin-bottom:8px">
        <button class="lg-btn" data-act="imp-filter" data-st="">全部</button>
        <button class="lg-btn" data-act="imp-filter" data-st="pending">待复核</button>
        <button class="lg-btn primary" data-act="imp-confirm-all">确认全部待复核</button>
        <button class="lg-btn primary" data-act="imp-apply">落库已确认行</button>
        <button class="lg-btn" data-act="imp-recon">对账报告</button>
      </div>
      <div id="impRecon"></div>
      <table class="lg-table"><thead><tr>
        <th>sheet/行</th><th>类型</th><th>姓名</th><th>村/队</th><th>日期</th><th>应收</th><th>实收</th><th>复核提示</th><th>操作</th>
      </tr></thead><tbody id="impRows"><tr><td colspan="9">—</td></tr></tbody></table>
    </div>`;
  }

  async function loadImportBatches() {
    const batches = await Api.importBatches();
    const tb = document.getElementById('impBatches');
    tb.innerHTML = batches.map(b => `<tr>
      <td>#${b.id}</td><td>${esc(b.filename)}</td>
      <td>${b.status === 'applied' ? tag('已落库') : b.status === 'reviewing' ? tag('待确认', 'warn') : tag(b.status)}</td>
      <td>${(b.imported_at || '').slice(0, 16).replace('T', ' ')}</td>
      <td><button class="lg-btn" data-act="imp-open" data-id="${b.id}">打开复核</button></td>
    </tr>`).join('') || '<tr><td colspan="5">暂无批次</td></tr>';
    if (batches.length && !importState.batchId) {
      importState.batchId = batches[0].id;
      await loadImportRows(batches[0].id);
    }
  }

  async function loadImportRows(batchId, status) {
    importState.batchId = batchId;
    document.getElementById('impRowsPanel').style.display = '';
    importState.rows = await Api.importRows(batchId, status);
    const rows = importState.rows.map(r => {
      const p = r.parsed || {};
      const isJob = p.kind === 'job';
      const pp = p.parsed || {};
      return `<tr>
        <td>${esc(r.sheet_name)} / ${r.row_no}</td>
        <td>${isJob ? '作业' : '支出'}</td>
        <td>${esc(pp.name || pp.category_raw || '—')}</td>
        <td>${esc(pp.village || '')}${pp.team ? '/' + esc(pp.team) + '队' : ''}</td>
        <td>${esc(pp.date || '—')}</td>
        <td class="num">${isJob ? Core.fmtYuan(pp.receivable_cents) : '—'}</td>
        <td class="num">${isJob ? Core.fmtYuan(pp.paid_cents) : Core.fmtYuan(pp.amount_cents)}</td>
        <td>${(p.needs_review || []).length ? tag(p.needs_review.map(n => n.code).join(','), 'warn') : tag('OK')}</td>
        <td>${r.status === 'confirmed' ? tag('已确认') : r.status === 'rejected' ? tag('已拒绝', 'err') : actions(
          `<button class="lg-btn primary" data-act="imp-row-confirm" data-id="${r.id}">确认</button>`,
          `<button class="lg-btn danger" data-act="imp-row-reject" data-id="${r.id}">拒绝</button>`
        )}</td>
      </tr>` +
      ((p.needs_review || []).length ? `<tr><td colspan="9" class="lg-detail">${esc(r.raw_text)}</td></tr>` : '');
    }).join('');
    document.getElementById('impRows').innerHTML = rows || '<tr><td colspan="9">无行</td></tr>';
  }

  /* ---------- 页签：主数据（M7） ---------- */
  async function renderMasterData() {
    if (!parties.length) { try { parties = await Api.parties(); } catch (e) { parties = []; } }
    const settings = await Api.settings().catch(() => ({}));
    const bootstrap = await Api.get('/api/bootstrap').catch(() => null);
    const balMap = new Map((bootstrap ? bootstrap.parties : []).map(p => [p.id, p]));
    const custRows = parties.filter(p => p.type === 'customer').map(p0 => {
      const b = balMap.get(p0.id) || {};
      return `<tr>
        <td>${esc(p0.name)}</td>
        <td>${esc(p0.village || '—')}${p0.team ? '/' + esc(p0.team) + '队' : ''}</td>
        <td>${esc(p0.phone || '—')}</td>
        <td class="num">${p0.default_price_cents ? Core.fmtYuan(p0.default_price_cents) : '—'}</td>
        <td class="num">${Core.fmtYuan(b.receivable_cents || 0)}</td>
        <td class="num">${Core.fmtYuan(b.prepaid_cents || 0)}</td>
        <td>${b.last_job ? esc((b.last_job.date || '') + ' ' + (b.last_job.price_yuan ? b.last_job.price_yuan.toFixed(1) + '元/亩' : '')) : '—'}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="md-edit" data-id="${p0.id}" data-name="${esc(p0.name)}">编辑</button>`,
          p0.enabled ? `<button class="lg-btn danger" data-act="md-disable" data-id="${p0.id}" data-name="${esc(p0.name)}">停用</button>` : ''
        )}</td>
      </tr>`;
    }).join('');
    const chems = (bootstrap ? bootstrap.chemicals : []).map(c => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.key || '—')}</td>
        <td class="num">${c.water_per_mu ?? '—'}</td>
        <td class="num">${c.pesticide_water_per_set ?? '—'}</td>
        <td class="num">${c.price_cents_per_set ? Core.fmtYuan(c.price_cents_per_set) : '—'}</td>
      </tr>`).join('');
    return `<div class="lg-panel">
      <h2>设置</h2>
      <div class="lg-form">
        <label>记账人（写入 edit_logs 与工单 operator）<input id="mdOperator" value="${esc(settings.operator || 'local')}"></label>
        <button class="lg-btn primary" data-act="md-save-operator">保存</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>期初补录（Excel 之外的旧账；生成 opening 单据 + 期初权益凭证）</h2>
      <div class="lg-form">
        <label>客户<select id="opParty">${parties.filter(p => p.type === 'customer').map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>类型<select id="opKind"><option value="receivable">旧欠款（应收）</option><option value="prepaid">客户预收</option><option value="worker_advance">员工预支</option></select></label>
        <label>金额(元)<input id="opAmount" type="number" step="0.01" min="0.01"></label>
        <label>说明<input id="opNote" placeholder="如：2025 年旧账"></label>
        <button class="lg-btn primary" data-act="op-save">补录</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>客户（同步自计算器/导入；编辑=电话/村/队/默认单价）</h2>
      <table class="lg-table"><thead><tr>
        <th>姓名</th><th>村/队</th><th>电话</th><th>默认单价</th><th>欠款(元)</th><th>预收(元)</th><th>最近作业</th><th>操作</th>
      </tr></thead><tbody>${custRows}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>药品/用药类型（计算器类型库镜像；编辑暂走计算器端）</h2>
      <table class="lg-table"><thead><tr><th>名称</th><th>key</th><th>水量/亩</th><th>兑水/套</th><th>药价/套</th></tr></thead>
      <tbody>${chems || '<tr><td colspan="5">暂无（首次计算器同步后生成）</td></tr>'}</tbody></table>
    </div>`;
  }

  /* ---------- 渲染调度 ---------- */
  const state = { tab: 'jobs', _advances: [] };

  async function render() {
    const tab = state.tab;
    if (tab === 'jobs') {
      $main.innerHTML = renderJobs(await Api.jobs());
    } else if (tab === 'settlements') {
      $main.innerHTML = renderSettlements(await Api.settlements());
    } else if (tab === 'bills') {
      $main.innerHTML = renderBills(await Api.bills());
    } else if (tab === 'receipts') {
      if (!parties.length) { try { parties = await Api.parties(); } catch (e) { parties = []; } }
      $main.innerHTML = renderReceipts(await Api.receipts());
    } else if (tab === 'reports') {
      $main.innerHTML = await renderReports();
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
    } else if (tab === 'import') {
      $main.innerHTML = renderImport();
      await loadImportBatches();
    } else if (tab === 'master') {
      $main.innerHTML = await renderMasterData();
    }
    refreshSummary();
  }

  async function refreshSummary() {
    try {
      const s = await Api.summary();
      document.getElementById('lgSummary').textContent =
        `应收 ${Core.fmtYuan(s.receivable_cents)} · 已收 ${Core.fmtYuan(s.received_cents)} · 支出 ${Core.fmtYuan(s.expense_cents)} · 预收余 ${Core.fmtYuan(s.prepaid_cents)}`;
    } catch (e) { /* 顶部汇总失败不打扰 */ }
  }

  /* ---------- 事件委托 ---------- */
  document.getElementById('lgNav').addEventListener('click', e => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    document.querySelectorAll('#lgNav button').forEach(b => b.classList.toggle('active', b === btn));
    state.tab = btn.dataset.tab;
    render().catch(err => toast(err.message, true));
  });

  $main.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (btn) { handleAct(btn); return; }
    const slotBtn = e.target.closest('td[data-slot]');
    if (slotBtn && slotBtn.textContent.trim() === '') slotBtn.closest('tr').remove();
  });

  function collectInputs(attr) {
    const map = new Map();
    document.querySelectorAll(`[${attr}]`).forEach(inp => {
      const id = inp.getAttribute(attr);
      if (!map.has(id)) map.set(id, {});
      map.get(id)[inp.dataset.field] = Core.yuanInputToCents(inp.value);
    });
    return map;
  }
  function toggleDetailSlot(slot, loader) {
    const tr = slot.closest('tr');
    tr.hidden = !tr.hidden;
    if (!tr.hidden && slot.innerHTML === '') loader();
  }
  function needAmount(v) {
    if (v == null || isNaN(v) || v <= 0) { toast('金额非法', true); return false; }
    return true;
  }

  function handleAct(btn) {
    const act = btn.dataset.act;
    const id = Number(btn.dataset.id);
    switch (act) {
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
        tr$.insertAdjacentHTML('afterend',
          `<tr><td colspan="8">${receiveForm(id, Number(btn.dataset.party) || null, Number(btn.dataset.unpaid))}</td></tr>`);
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
      case 'md-save-operator':
        run(() => Api.saveSettings({ operator: document.getElementById('mdOperator').value || 'local' }), '记账人已保存');
        break;
      case 'op-save': {
        const amount = Core.yuanInputToCents(document.getElementById('opAmount').value);
        if (!needAmount(amount)) return;
        confirmThen('确认期初补录？将生成 opening 单据与期初权益凭证。', () => Api.importOpening({
          party_id: Number(document.getElementById('opParty').value),
          kind: document.getElementById('opKind').value,
          amount_cents: amount,
          note: document.getElementById('opNote').value || undefined
        }));
        break;
      }
      case 'md-edit': {
        const name = btn.dataset.name;
        const village = window.prompt('村名（如 彰冠红拉 / 通安金桂村；清空则不填）：') ?? undefined;
        const team = window.prompt('队伍号（数字，可空）：') ?? undefined;
        const phone = window.prompt('电话（可空）：') ?? undefined;
        const price = window.prompt('默认单价（元/亩，可空）：') ?? undefined;
        const body = {};
        if (village !== null && village !== undefined) body.village = village;
        if (team !== null && team !== undefined) body.team = team || '';
        if (phone !== null && phone !== undefined) body.phone = phone || '';
        if (price !== null && price !== undefined && price !== '') {
          const cents = Core.yuanInputToCents(price);
          if (cents == null || isNaN(cents) || cents < 0) return toast('单价非法', true);
          body.default_price_cents = cents;
        }
        if (!Object.keys(body).length) return;
        run(() => Api.masterPatch('parties', Number(btn.dataset.id), body), '客户已更新').then(() => { parties = []; });
        break;
      }
      case 'md-disable':
        confirmThen(`停用客户 ${btn.dataset.name}？（软删除，可恢复）`, () => Api.post(`/api/master/parties/${btn.dataset.id}/void`));
        break;
      case 'imp-upload': {
        const f = document.getElementById('impFile').files[0];
        if (!f) return toast('先选 .xlsx 文件', true);
        const rd = new FileReader();
        rd.onload = () => {
          const b64 = rd.result.split(',')[1];
          run(async () => {
            const d = await Api.importParse(f.name, b64);
            importState.batchId = d.batch_id;
            document.getElementById('impStats').innerHTML =
              `<div class="lg-detail">批次 #${d.batch_id}：作业 ${d.stats.jobs} / 支出 ${d.stats.expenses} / 跳过 ${d.stats.skipped} / <b>需复核 ${d.review_count}</b>。原始列合计：应收 ${Core.fmtYuan(Math.round(d.raw_totals.receivable * 100))} · 实收 ${Core.fmtYuan(Math.round(d.raw_totals.paid * 100))} · 支出 ${Core.fmtYuan(Math.round(d.raw_totals.expense * 100))}</div>`;
            await loadImportBatches();
            await loadImportRows(d.batchId);
            return d;
          }, '解析完成，请复核');
        };
        rd.readAsDataURL(f);
        break;
      }
      case 'imp-open':
        importState.batchId = Number(btn.dataset.id);
        document.getElementById('impRowsPanel').style.display = '';
        loadImportRows(importState.batchId);
        break;
      case 'imp-filter':
        loadImportRows(importState.batchId, btn.dataset.st || undefined);
        break;
      case 'imp-row-confirm':
        run(() => Api.importRowPatch(Number(btn.dataset.id), { action: 'confirm' })).then(() => loadImportRows(importState.batchId));
        break;
      case 'imp-row-reject':
        run(() => Api.importRowPatch(Number(btn.dataset.id), { action: 'reject' })).then(() => loadImportRows(importState.batchId));
        break;
      case 'imp-confirm-all':
        confirmThen('确认全部待复核行？（对照清单后再点）', async () => {
          const rows = await Api.importRows(importState.batchId, 'pending');
          for (const r of rows) await Api.importRowPatch(r.id, { action: 'confirm' });
          return rows.length;
        }).then(n => { if (n) { toast('已确认 ' + n + ' 行'); loadImportRows(importState.batchId); } });
        break;
      case 'imp-apply':
        confirmThen('落库已确认行到正式账本？（不可自动撤销，作废需逐笔处理）', () => Api.importApply(importState.batchId))
          .then(r => { if (r) { toast('落库完成 ' + JSON.stringify(r)); loadImportRows(importState.batchId); loadImportBatches(); } });
        break;
      case 'imp-recon':
        run(async () => Api.importRecon(importState.batchId)).then(rec => {
          if (rec) {
            document.getElementById('impRecon').innerHTML =
              `<div class="lg-detail ${rec.balanced ? 'lg-balance' : ''}">对账：作业 ${rec.staged.jobs} / 支出 ${rec.staged.expenses}；应收 diff ${Core.fmtYuan(rec.diff.receivable_cents)} · 实收 diff ${Core.fmtYuan(rec.diff.paid_cents)} · 支出 diff ${Core.fmtYuan(rec.diff.expense_cents)} —— ${rec.balanced ? '✓ 全部对平' : '✗ 有差异'}</div>`;
          }
        });
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

  function switchNav(tab) {
    document.querySelectorAll('#lgNav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  }

  /* ---------- 启动 ---------- */
  Api.parties().then(p => { parties = p || []; }).catch(() => { parties = []; }).finally(() => {
    render().catch(err => toast(err.message, true));
  });
})();
