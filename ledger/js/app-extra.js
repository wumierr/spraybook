/* ============================================================
   ledger/js/app-extra.js — 导入（M8）+ 主数据（M7）页签
   P2-4 从 app.js 拆出：共享工具经 init(tools) 注入，勿在此重复实现。
   ============================================================ */
(function () {
  'use strict';
  let T = null;
  let run, toast, confirmThen, needAmount, collectInputs, esc, tag, actions, Core, Api, state, switchNav;
  const importState = { batchId: null, rows: [] };

  function renderImport() {
    return `<div class="lg-panel">
      <h2>粘贴计算器作业包（离线单；在计算器「导出 → ⬇ 下载作业包」后粘贴 JSON）</h2>
      <textarea id="calcJobJson" rows="6" placeholder='粘贴 {"type":"drone-spray-config","schemaVersion":"2.1",...} 完整内容' style="width:100%;font-family:monospace;font-size:12px"></textarea>
      <div class="lg-form" style="margin-top:8px">
        <button class="lg-btn primary" data-act="imp-calc-json">解析并导入作业</button>
        <span class="hint" style="color:var(--muted);font-size:12px">幂等：同一单重复导入自动去重；成功后可在「总表」看到并走结算收款</span>
      </div>
      <div id="calcJobResult"></div>
    </div>
    <div class="lg-panel">
      <h2>上传历史 Excel（.xlsx，月度记账表格式）</h2>
      <div class="lg-form">
        <label>文件<input type="file" id="impFile" accept=".xlsx"></label>
        <button class="lg-btn primary" data-act="imp-upload">解析并复核</button>
        <span class="hint" style="color:var(--muted);font-size:12px">解析后先复核再落库；同文件重复上传会被拒绝</span>
      </div>
      <div id="impStats"></div>
    </div>
    <div class="lg-panel">
      <h2>批次</h2>
      <table class="lg-table" data-colw="import-batches"><thead><tr><th>批次</th><th>文件</th><th>状态</th><th>导入时间</th><th>操作</th></tr></thead>
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
      <table class="lg-table" data-colw="import-rows"><thead><tr>
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


  /* ---------- 主数据（客户行内直填 + 新增客户 + 地块档案） ---------- */
  let mdEditId = null;      // 行内编辑中的客户 id
  let mdPlotEditId = null;  // 行内编辑中的地块 id

  async function renderMasterData() {
    let parties = [];
    try { parties = await Api.parties(); } catch (err) { parties = []; }
    const settings = await Api.settings().catch(() => ({}));
    const bootstrap = await Api.get('/api/bootstrap').catch(() => null);
    const balMap = new Map((bootstrap ? bootstrap.parties : []).map(p => [p.id, p]));
    const custRows = parties.filter(p => p.type === 'customer').map(p0 => {
      if (mdEditId === p0.id) return mdCustomerEditRow(p0);
      const b = balMap.get(p0.id) || {};
      return `<tr>
        <td>${esc(p0.name)}</td>
        <td>${esc(p0.region || '—')}</td>
        <td>${esc(p0.village || '—')}${p0.team ? '/' + esc(p0.team) + '队' : ''}</td>
        <td>${esc(p0.phone || '—')}</td>
        <td class="num">${p0.default_price_cents ? Core.fmtYuan(p0.default_price_cents) : '—'}</td>
        <td class="num">${Core.fmtYuan(b.receivable_cents || 0)}</td>
        <td class="num">${Core.fmtYuan(b.prepaid_cents || 0)}</td>
        <td>${b.last_job ? esc((b.last_job.date || '') + ' ' + (b.last_job.price_yuan ? b.last_job.price_yuan.toFixed(1) + '元/亩' : '')) : '—'}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="md-edit" data-id="${p0.id}">编辑</button>`,
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
    /* 地块档案（007：作业按名自动关联） */
    let plots = [];
    try { plots = (await Api.masterList('plots')).filter(p => !p.deleted_at); } catch (e) { plots = []; }
    const partyName = new Map(parties.map(p => [p.id, p.name]));
    const plotRows = plots.map(pl => {
      if (mdPlotEditId === pl.id) return mdPlotEditRow(pl, parties);
      return `<tr>
        <td>${esc(pl.name)}</td>
        <td>${esc(partyName.get(pl.party_id) || '—')}</td>
        <td class="num">${pl.area_mu ?? '—'}</td>
        <td>${esc(pl.notes || '')}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="plot-edit" data-id="${pl.id}">编辑</button>`,
          `<button class="lg-btn danger" data-act="plot-void" data-id="${pl.id}" data-name="${esc(pl.name)}">停用</button>`
        )}</td>
      </tr>`;
    }).join('');
    const custOpts = parties.filter(p => p.type === 'customer')
      .map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
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
      <h2>新增客户（导入/计算器同步的客户也会进这里；业务键=姓名+村+队）</h2>
      <div class="lg-form">
        <label>姓名*<input id="ncName" placeholder="必填"></label>
        <label>区域(镇)<input id="ncRegion" placeholder="如 通安/彰冠"></label>
        <label>村<input id="ncVillage" placeholder="如 金桂"></label>
        <label>队<input id="ncTeam" placeholder="数字"></label>
        <label>电话<input id="ncPhone"></label>
        <label>默认单价(元/亩)<input id="ncPrice" type="number" step="0.01" min="0"></label>
        <button class="lg-btn primary" data-act="nc-save">新增客户</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>客户（点「编辑」行内直填，回车或点保存生效）</h2>
      <table class="lg-table" data-colw="master-parties"><thead><tr>
        <th>姓名</th><th>区域</th><th>村/队</th><th>电话</th><th>默认单价</th><th>欠款(元)</th><th>预收(元)</th><th>最近作业</th><th>操作</th>
      </tr></thead><tbody>${custRows}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>地块档案（按客户维护地块；计算器同步的作业按地块名自动关联）</h2>
      <div class="lg-form">
        <label>地块名*<input id="plotName" placeholder="如 张家果园东"></label>
        <label>所属客户<select id="plotParty">${custOpts}</select></label>
        <label>面积(亩)<input id="plotArea" type="number" step="0.1" min="0"></label>
        <label>备注<input id="plotNote" placeholder="选填"></label>
        <button class="lg-btn primary" data-act="plot-add">新增地块</button>
      </div>
      <table class="lg-table" style="margin-top:8px" data-colw="master-plots"><thead><tr>
        <th>地块名</th><th>所属客户</th><th>面积(亩)</th><th>备注</th><th>操作</th>
      </tr></thead><tbody>${plotRows || '<tr><td colspan="5">暂无地块——新增后作业明细将自动按名关联</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>药品/用药类型（计算器类型库镜像；编辑暂走计算器端）</h2>
      <table class="lg-table" data-colw="master-chems"><thead><tr><th>名称</th><th>key</th><th>水量/亩</th><th>兑水/套</th><th>药价/套</th></tr></thead>
      <tbody>${chems || '<tr><td colspan="5">暂无（首次计算器同步后生成）</td></tr>'}</tbody></table>
    </div>`;
  }

  /** 客户行内编辑行（region/village/team/phone/price 直填） */
  function mdCustomerEditRow(p0) {
    const inp = (f, val, ph, type) =>
      `<input data-md="${f}" value="${esc(val ?? '')}" placeholder="${ph}" ${type ? `type="${type}" step="0.01"` : ''}>`;
    return `<tr class="lg-detail">
      <td><b>${esc(p0.name)}</b></td>
      <td>${inp('region', p0.region, '镇')}</td>
      <td>${inp('village', p0.village, '村')} ${inp('team', p0.team, '队', '')}</td>
      <td>${inp('phone', p0.phone, '电话')}</td>
      <td class="num">${inp('price_yuan', p0.default_price_cents ? (p0.default_price_cents / 100) : '', '元/亩', 'number')}</td>
      <td colspan="3"></td>
      <td>${actions(
        `<button class="lg-btn primary" data-act="md-edit-save" data-id="${p0.id}">保存</button>`,
        `<button class="lg-btn" data-act="md-edit-cancel">取消</button>`
      )}</td>
    </tr>`;
  }
  function mdPlotEditRow(pl, parties) {
    const opts = parties.filter(p => p.type === 'customer')
      .map(p => `<option value="${p.id}" ${p.id === pl.party_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    return `<tr class="lg-detail">
      <td><input data-pl="name" value="${esc(pl.name)}"></td>
      <td><select data-pl="party_id">${opts}</select></td>
      <td class="num"><input data-pl="area_yuan" type="number" step="0.1" value="${pl.area_mu ?? ''}"></td>
      <td><input data-pl="notes" value="${esc(pl.notes || '')}"></td>
      <td>${actions(
        `<button class="lg-btn primary" data-act="plot-edit-save" data-id="${pl.id}">保存</button>`,
        `<button class="lg-btn" data-act="plot-edit-cancel">取消</button>`
      )}</td>
    </tr>`;
  }



  function extraHandleAct(btn, tools) {
    const act = btn.dataset.act;
    const id = Number(btn.dataset.id);
    switch (act) {
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
      case 'md-edit':
        mdEditId = id; mdPlotEditId = null;
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        break;
      case 'md-edit-cancel':
        mdEditId = null;
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        break;
      case 'md-edit-save': {
        const tr = btn.closest('tr');
        const get = f => { const el = tr.querySelector(`[data-md="${f}"]`); return el ? el.value : undefined; };
        const body = {};
        const region = get('region'), village = get('village'), team = get('team'),
          phone = get('phone'), price = get('price_yuan');
        if (region != null) body.region = region.trim();
        if (village != null) body.village = village.trim();
        if (team != null) body.team = team.trim();
        if (phone != null) body.phone = phone.trim();
        if (price != null && price !== '') {
          const cents = Core.yuanInputToCents(price);
          if (cents == null || isNaN(cents) || cents < 0) return toast('默认单价非法', true);
          body.default_price_cents = cents;
        } else if (price === '') body.default_price_cents = null;
        if (!Object.keys(body).length) { mdEditId = null; return window.LedgerExtra.renderTab('master', document.getElementById('lgMain')); }
        run(() => Api.masterPatch('parties', id, body), '客户已更新').then(() => { mdEditId = null; });
        break;
      }
      case 'nc-save': {
        const name = document.getElementById('ncName').value.trim();
        if (!name) return toast('姓名必填', true);
        const price = document.getElementById('ncPrice').value;
        const body = {
          type: 'customer', name,
          region: document.getElementById('ncRegion').value.trim(),
          village: document.getElementById('ncVillage').value.trim(),
          team: document.getElementById('ncTeam').value.trim(),
          phone: document.getElementById('ncPhone').value.trim()
        };
        if (price !== '') {
          const cents = Core.yuanInputToCents(price);
          if (cents == null || isNaN(cents) || cents < 0) return toast('单价非法', true);
          body.default_price_cents = cents;
        }
        run(() => Api.masterCreate('parties', body), '客户已新增');
        break;
      }
      case 'plot-add': {
        const name = document.getElementById('plotName').value.trim();
        if (!name) return toast('地块名必填', true);
        const area = document.getElementById('plotArea').value;
        const body = {
          name,
          party_id: Number(document.getElementById('plotParty').value) || null,
          notes: document.getElementById('plotNote').value.trim() || null
        };
        if (area !== '') {
          const n = Number(area);
          if (!Number.isFinite(n) || n < 0) return toast('面积非法', true);
          body.area_mu = n;
        }
        run(() => Api.masterCreate('plots', body), '地块已新增');
        break;
      }
      case 'plot-edit':
        mdPlotEditId = id; mdEditId = null;
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        break;
      case 'plot-edit-cancel':
        mdPlotEditId = null;
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        break;
      case 'plot-edit-save': {
        const tr = btn.closest('tr');
        const name = tr.querySelector('[data-pl="name"]').value.trim();
        if (!name) return toast('地块名必填', true);
        const area = tr.querySelector('[data-pl="area_yuan"]').value;
        const body = {
          name,
          party_id: Number(tr.querySelector('[data-pl="party_id"]').value) || null,
          notes: tr.querySelector('[data-pl="notes"]').value.trim() || null
        };
        if (area !== '') {
          const n = Number(area);
          if (!Number.isFinite(n) || n < 0) return toast('面积非法', true);
          body.area_mu = n;
        } else body.area_mu = null;
        run(() => Api.masterPatch('plots', id, body), '地块已更新').then(() => { mdPlotEditId = null; });
        break;
      }
      case 'plot-void':
        confirmThen(`停用地块 ${btn.dataset.name}？（软删除）`, () => Api.post(`/api/master/plots/${btn.dataset.id}/void`));
        break;
      case 'md-disable':
        confirmThen(`停用客户 ${btn.dataset.name}？（软删除，可恢复）`, () => Api.post(`/api/master/parties/${btn.dataset.id}/void`));
        break;
      case 'imp-calc-json': {
        // P6-M1：计算器导出 JSON → /api/jobs（幂等；成功后切总表）
        const text = document.getElementById('calcJobJson').value;
        if (!text.trim()) return toast('先粘贴作业包 JSON', true);
        const parsed = Core.calculatorJobPayload(text, new Date().toISOString().slice(0, 10));
        if (!parsed.ok) {
          document.getElementById('calcJobResult').innerHTML = `<div class="lg-detail">✗ ${esc(parsed.error)}</div>`;
          return toast(parsed.error, true);
        }
        run(async () => {
          const d = await Api.createJob(parsed.payload);
          document.getElementById('calcJobJson').value = '';
          document.getElementById('calcJobResult').innerHTML =
            `<div class="lg-detail">✓ 已导入：${esc(d.job_no)}${d.duplicated ? '（该单此前已导入，幂等返回原单）' : ''}</div>`;
          return d;
        }, '计算器作业已导入');
        break;
      }
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
            await loadImportRows(d.batch_id);
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
    }
  }

  function setTools(tools) {
    T = tools;
    run = tools.run; toast = tools.toast; confirmThen = tools.confirmThen;
    needAmount = tools.needAmount; collectInputs = tools.collectInputs;
    esc = tools.esc; tag = tools.tag; actions = tools.actions;
    Core = tools.Core; Api = tools.Api; state = tools.state; switchNav = tools.switchNav;
  }

  window.LedgerExtra = {
    renderTab(tab, $main) {
      setTools(window.__ledgerTools);
      // P5-M3：doRender 旁路的 5 处直调重绘（md-edit/md-edit-cancel/md-edit-save 空改/plot-edit/
      // plot-edit-cancel）不经 doRender 尾部挂钩，挂在本函数返回链上统一恢复列宽；
      // master 分支是 renderMasterData().then(html=>innerHTML)、import 分支同步 innerHTML 后
      // 异步 loadImportBatches——都须等 innerHTML 落位后再 apply（同步调会早于 DOM 更新）
      const done = tab === 'import'
        ? ($main.innerHTML = renderImport(), loadImportBatches())
        : renderMasterData().then(html => { $main.innerHTML = html; });
      return Promise.resolve(done).then(() => { if (T && T.applyColWidths) T.applyColWidths(); });
    },
    handleAct(btn, tools) {
      setTools(tools);
      extraHandleAct(btn, tools);
    }
  };
})();
