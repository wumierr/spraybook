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


  async function renderMasterData() {
    let parties = [];
    try { parties = await Api.parties(); } catch (err) { parties = []; }
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
      if (tab === 'import') {
        $main.innerHTML = renderImport();
        return loadImportBatches();
      }
      return renderMasterData().then(html => { $main.innerHTML = html; });
    },
    handleAct(btn, tools) {
      setTools(tools);
      extraHandleAct(btn, tools);
    }
  };
})();
