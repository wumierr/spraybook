/* ============================================================
   ledger/js/app-extra.js — 审核（批次复核+数据体检）+ 主数据（M7）+ 导入 FAB 弹窗
   P2-4 从 app.js 拆出：共享工具经 init(tools) 注入，勿在此重复实现。
   P10-R4：导入页升级「审核」页（体检整体并入，HANDOFF-P10-PLAN §4）；
   导入入口 = 右下角 📥 FAB 弹窗（三类型 + 拖文件自动识别 + 解析后快捷处理）。
   ============================================================ */
(function () {
  'use strict';
  let T = null;
  let run, toast, confirmThen, needAmount, collectInputs, esc, tag, actions, Core, Api, state, switchNav;
  const importState = { batchId: null, rows: [], editId: null };
  // P10-R4：导入 FAB 弹窗状态（open/选中类型/批次快捷处理/行编辑中 id/LLM 就绪态）
  const fabState = { open: false, type: '', batchId: null, rows: [], editId: null, llmOk: null, summary: '', jobNo: null };
  // P10-R5：审核页 LLM 审查区状态（本机 LLM 就绪态——按钮置灰依据）
  let lrLlmOk = null;
  // P9-R2：数据体检缓存（主数据「疑似重复」区与「体检」页共用）+ 合并预览弹窗状态
  let mdHealth = null;            // GET /api/data-health 的最近一次结果
  let mdMergeGroup = null;        // 弹窗当前展示的重复组（suspect_dupes 元素）
  let mdMergeReturnTab = 'master'; // 打开弹窗时的页签（确认/取消后回到哪页）

  // P10-R1：主数据页市/县筛选（localStorage 记忆；审核页/图表页的市筛选 R3/R4 重建时接入）
  const MD_COUNTY_KEY = 'lg-md-county';
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }
  let mdCountyFilter = String(lsGet(MD_COUNTY_KEY) || '');

  // P9-R3：默认日期=本地墙钟今天（不用 toISOString——UTC 会在凌晨误退一天，E1 教训）
  function localToday() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* ---------- P10-R4：审核页（批次 + 行级复核 + 数据体检；HANDOFF-P10-PLAN §4） ----------
     导入页升级「审核」= 所有二次审核的唯一之家；导入入口 = 右下角 📥 FAB 弹窗（D2 裁决）。
     旧 imp-* 状态机原样保留（打开复核/逐字段改/确认/驳回/确认全部/确认并落库/放入待入库/
     取消批次/对账报告）；体检五桶并入 #reviewHealth（dh- 与 md-merge- 前缀原样，合并弹窗共用）。 */
  function renderReviewShell() {
    return `<div class="lg-panel">
      <h2>审核 · 批次（导入入口：右下角 📥 FAB——LLM 文本 / 计算器作业包 / Excel；确认后落库）</h2>
      <table class="lg-table" data-colw="import-batches"><thead><tr><th>批次</th><th>文件</th><th>来源</th><th>状态</th><th>导入时间</th><th>操作</th></tr></thead>
      <tbody id="impBatches"><tr><td colspan="6">加载中…</td></tr></tbody></table>
    </div>
    <div class="lg-panel" id="impRowsPanel" style="display:none">
      <h2>行级复核（确认后才能落库；建议对照纸表/原 Excel/原文消息；「改」逐字段订正后复核提示视为已澄清）</h2>
      <div style="margin-bottom:8px">
        <button class="lg-btn" data-act="imp-filter" data-st="">全部</button>
        <button class="lg-btn" data-act="imp-filter" data-st="pending">待复核</button>
        <button class="lg-btn primary" data-act="imp-confirm-all">确认全部待复核</button>
        <button class="lg-btn primary" data-act="imp-apply">确认并落库</button>
        <button class="lg-btn" data-act="imp-keep">放入待入库</button>
        <button class="lg-btn danger" data-act="imp-cancel-batch">取消批次</button>
        <button class="lg-btn" data-act="imp-recon">对账报告</button>
      </div>
      <div id="impRecon"></div>
      <table class="lg-table" data-colw="import-rows"><thead><tr>
        <th>sheet/行</th><th>类型</th><th>姓名</th><th>村/队</th><th>日期</th><th>应收</th><th>实收</th><th>复核提示</th><th>操作</th>
      </tr></thead><tbody id="impRows"><tr><td colspan="9">—</td></tr></tbody></table>
    </div>
    <div id="reviewHealth"><div class="lg-panel">数据体检加载中…</div></div>
    <div class="lg-panel" id="reviewLlm">
      <h2>🤖 LLM 数据审查（只挑错，不改数据；逐条人工采纳/忽略）</h2>
      <div class="lg-form">
        <button class="lg-btn primary" data-act="lr-health" id="lrHealthBtn">🤖 LLM 全库体检</button>
        <span class="hint" id="lrStatus" style="color:var(--muted);font-size:12px">检查本机 LLM…</span>
      </div>
      <div class="hint" style="color:var(--muted);font-size:12px">批次审查：上方批次表「🤖 审查这批」——发现的问题并入该批行级复核（带原文证据）；全库体检：扫描客户/作业/账单摘要找疑似同名、疑似错字、金额离群、数据缺漏。LLM 只挑错，采纳与否由人决定，绝不改数据。</div>
      <div id="lrFindings"></div>
    </div>`;
  }

  /** 审核页拼装：骨架先行 → 批次表 → 体检区异步注入（一个 Promise 链，innerHTML 不互踩） */
  async function renderReview($main) {
    $main.innerHTML = renderReviewShell();
    await loadImportBatches();
    // renderHealth 顺带写 mdHealth（合并弹窗 md-merge-open 依赖）；失败给可读占位不拖垮整页
    const hh = await renderHealth().catch(() => null);
    const el = document.getElementById('reviewHealth');
    if (el) el.innerHTML = hh || '<div class="lg-panel"><h2>数据体检</h2><div class="lg-detail">体检数据拉取失败（服务端较旧？需重启服务生效）</div></div>';
    lrLoadStatus(); // P10-R5：LLM 审查区就绪态（Ollama 不可达→按钮置灰）
  }

  /* ---------- P10-R5：LLM 数据审查区（只挑错；采纳=跳对应编辑入口，忽略=settings 登记） ---------- */
  async function lrLoadStatus() {
    const el = document.getElementById('lrStatus');
    const btn = document.getElementById('lrHealthBtn');
    try {
      const st = await Api.llmStatus();
      lrLlmOk = !!(st && st.ollama_ok);
      if (el) {
        el.textContent = lrLlmOk
          ? `本机 LLM 就绪（${st.model}）——批次审查与全库体检可用`
          : `本机 LLM 未就绪：${st.hint || st.error || '请先启动 Ollama'}——Excel/作业包导入不受影响`;
        if (!lrLlmOk) el.style.color = 'var(--err, #c62828)';
      }
      if (btn) btn.disabled = !lrLlmOk;
      if (!lrLlmOk && typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('[data-act="lr-batch"]').forEach(b2 => { b2.disabled = true; });
      }
    } catch (e) {
      lrLlmOk = false;
      if (el) el.textContent = 'LLM 状态未知：' + e.message;
      if (btn) btn.disabled = true;
    }
  }

  function lrRenderFindings(d) {
    const box = document.getElementById('lrFindings');
    if (!box) return;
    const sevTag = s => tag(s === 'high' ? '高' : s === 'medium' ? '中' : '低', s === 'high' ? 'err' : s === 'medium' ? 'warn' : '');
    const items = (d.findings || []).map(f => `<div class="lg-detail" data-lrkey="${esc(f.key)}">
      ${sevTag(f.severity)} <b>${esc(f.where)}</b>　${esc(f.what)}<br>
      <span style="color:var(--muted)">证据：${esc(f.evidence || '—')}${f.verified ? '' : '（未在原文定位，请人工核对）'}</span>
      <button class="lg-btn" data-act="lr-adopt" data-where="${esc(f.where)}">采纳（去处理）</button>
      <button class="lg-btn" data-act="lr-dismiss" data-key="${esc(f.key)}">忽略</button>
    </div>`).join('');
    box.innerHTML = items || '<div class="lg-detail">✓ 未发现可疑问题（扫描范围与模型见状态行）</div>';
  }

  async function loadImportBatches() {
    const tb = document.getElementById('impBatches');
    if (!tb) return; // P10-R4：审核页未挂载（FAB 场景/他页）——元素不在就跳过
    const batches = await Api.importBatches();
    const srcTag = (t) => t === 'llm' ? tag('LLM 文本') : t === 'excel' ? tag('Excel') : tag(t || '—');
    tb.innerHTML = batches.map(b => `<tr>
      <td>#${b.id}</td><td>${esc(b.filename)}</td><td>${srcTag(b.source_type)}</td>
      <td>${b.status === 'applied' ? tag('已落库') : b.status === 'reviewing' ? tag('待入库', 'warn') : b.status === 'rejected' ? tag('已取消', 'err') : tag(b.status)}</td>
      <td>${(b.imported_at || '').slice(0, 16).replace('T', ' ')}</td>
      <td><button class="lg-btn" data-act="imp-open" data-id="${b.id}">打开复核</button>${b.status !== 'applied' && b.status !== 'rejected' ? ` <button class="lg-btn" data-act="lr-batch" data-id="${b.id}"${lrLlmOk === false ? ' disabled title="本机 LLM 未就绪"' : ' title="LLM 只挑错带证据，绝不改数据；发现并入行级复核"'}>🤖 审查这批</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6">暂无批次</td></tr>';
    if (batches.length && !importState.batchId) {
      importState.batchId = batches[0].id;
      await loadImportRows(batches[0].id);
    }
  }

  /** P10-R4：staging 行 → 表格行（审核页与 FAB 弹窗共用一个渲染器；editing=该行编辑中）。
      data-ctx 标记按钮归属（page=审核页 / fab=FAB 弹窗），imp-row-* 动作按 ctx 读写，
      两视图同一 staging 数据（D2：弹窗=快捷路径，完整复核在审核页）。 */
  function impRowTrHtml(r, ctx, editing) {
    const p = r.parsed || {};
    const isJob = p.kind === 'job';
    const isPair = p.kind === 'income_pair';
    const kindText = isJob ? '作业' : p.kind === 'expense' ? '支出' : isPair ? '收入对' : p.kind === 'note' ? '备注' : (p.kind || '—');
    const pp = p.parsed || {};
    const op = r.status === 'applied' ? tag('已落库')
      : r.status === 'confirmed' ? tag('已确认')
      : r.status === 'rejected' ? tag('已拒绝', 'err')
      : actions(
        `<button class="lg-btn primary" data-act="imp-row-confirm" data-id="${r.id}" data-ctx="${ctx}">确认</button>`,
        `<button class="lg-btn" data-act="imp-row-edit" data-id="${r.id}" data-ctx="${ctx}">改</button>`,
        `<button class="lg-btn danger" data-act="imp-row-reject" data-id="${r.id}" data-ctx="${ctx}">拒绝</button>`
      );
    return `<tr>
      <td>${esc(r.sheet_name)} / ${r.row_no}</td>
      <td>${kindText}</td>
      <td>${esc(pp.name || pp.category_raw || (isPair ? '（无姓名）' : '—'))}</td>
      <td>${esc(pp.village || '')}${pp.team ? '/' + esc(pp.team) + '队' : ''}</td>
      <td>${esc(pp.date || '—')}</td>
      <td class="num">${isJob ? Core.fmtYuan(pp.receivable_cents) : '—'}</td>
      <td class="num">${isJob ? Core.fmtYuan(pp.paid_cents) : isPair ? Core.fmtYuan(pp.income_cents) : Core.fmtYuan(pp.amount_cents)}</td>
      <td>${(p.needs_review || []).length ? tag(p.needs_review.map(n => n.code).join(','), 'warn') : tag('OK')}</td>
      <td>${op}</td>
    </tr>` +
    (editing ? impEditRowHtml(r, ctx) : '') +
    ((p.needs_review || []).length && !editing ? `<tr><td colspan="9" class="lg-detail">${esc(r.raw_text)}</td></tr>` : '');
  }

  /** P10-R4：行内逐字段订正（审核页与 FAB 弹窗共用；PATCH parsed 合并 + 清 needs_review
      =服务端既有语义「人工编辑过视为已澄清」）。金额输入元、保存时 yuanInputToCents；
      输入 id 带 ctx 前缀防两视图同 rid 撞 id。 */
  function impEditRowHtml(r, ctx) {
    const p = (r.parsed && r.parsed.parsed) || {};
    const kind = (r.parsed && r.parsed.kind) || '';
    const eid = f => `${ctx}Ed-${r.id}-${f}`;
    const inp = (f, val, ph, num) =>
      `<input id="${eid(f)}" data-f="${f}" value="${esc(val == null ? '' : val)}" placeholder="${ph}"${num ? ' type="number" step="0.01"' : ''} style="max-width:110px">`;
    const yuan = cents => (cents == null || cents === '' ? '' : cents / 100);
    let fs = '';
    if (kind === 'job') {
      fs = inp('name', p.name, '姓名') + inp('village', p.village, '村') + inp('team', p.team, '队') +
        inp('date', p.date, 'YYYY-MM-DD') + inp('receivable_cents', yuan(p.receivable_cents), '应收(元)', 1) + inp('paid_cents', yuan(p.paid_cents), '实收(元)', 1);
    } else if (kind === 'expense') {
      fs = inp('category_raw', p.category_raw != null ? p.category_raw : p.category, '类别') + inp('village', p.village, '村') +
        inp('date', p.date, 'YYYY-MM-DD') + inp('amount_cents', yuan(p.amount_cents), '金额(元)', 1);
    } else if (kind === 'income_pair') {
      fs = inp('name', p.name, '姓名') + inp('date', p.date, 'YYYY-MM-DD') + inp('income_cents', yuan(p.income_cents), '收入(元)', 1);
    } else {
      fs = inp('name', p.name, '内容');
    }
    return `<tr class="lg-detail"><td colspan="9">逐字段改：${fs}
      <button class="lg-btn primary" data-act="imp-row-save" data-id="${r.id}" data-ctx="${ctx}">存</button>
      <button class="lg-btn" data-act="imp-row-edit" data-id="${r.id}" data-ctx="${ctx}">收起</button></td></tr>`;
  }

  async function loadImportRows(batchId, status) {
    importState.batchId = batchId;
    const panel = document.getElementById('impRowsPanel');
    if (!panel) return; // P10-R4：审核页未挂载——弹窗场景走 fabRenderRows
    panel.style.display = '';
    importState.rows = await Api.importRows(batchId, status);
    document.getElementById('impRows').innerHTML =
      importState.rows.map(r => impRowTrHtml(r, 'page', importState.editId === r.id)).join('') ||
      '<tr><td colspan="9">无行</td></tr>';
  }

  /* ---------- P10-R4：三条导入管线（收件箱三管线收编重命名；FAB 弹窗与审核页共用端点） ----------
     Excel→POST /api/import/parse（base64）+批次；计算器 JSON→core.calculatorJobPayload 校验
     +POST /api/jobs（幂等，duplicated 分支文案沿用）；LLM 文本→POST /api/llm/parse
     （default_date 取弹窗 #fabDate）。日志/反馈经 log() 回调写入弹窗 #fabLog；busy 行由
     调用方管理（fabOneFile 的 try/catch/finally 兜底，P9-R4 评审#2 模式）。 */
  function fileToB64(f) {
    return new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(String(rd.result).split(',')[1]);
      rd.onerror = () => rej(new Error('文件读取失败：' + f.name));
      rd.readAsDataURL(f);
    });
  }
  function fileToText(f) {
    return new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(String(rd.result || ''));
      rd.onerror = () => rej(new Error('文件读取失败：' + f.name));
      rd.readAsText(f, 'utf-8');
    });
  }
  /** Excel 复核管线（与旧 imp-upload 同一端点与复核流） */
  async function pipeExcel(f, log) {
    let d;
    try { d = await Api.importParse(f.name, await fileToB64(f)); }
    catch (e) { toast(e.message, true); log(`✗ <b>${esc(f.name)}</b> → Excel 复核管线：${esc(e.message)}`); return null; }
    return { kind: 'batch', d, label: f.name };
  }
  /** 计算器作业导入（与旧 imp-calc-json 同一校验与幂等端点） */
  async function pipeCalcJson(text, label, log) {
    const parsed = Core.calculatorJobPayload(text, new Date().toISOString().slice(0, 10));
    if (!parsed.ok) { toast(parsed.error, true); log(`✗ <b>${esc(label)}</b> → 计算器作业导入：${esc(parsed.error)}`); return null; }
    let d;
    try { d = await Api.createJob(parsed.payload); }
    catch (e) { toast(e.message, true); log(`✗ <b>${esc(label)}</b> → 计算器作业导入：${esc(e.message)}`); return null; }
    return { kind: 'job', d, label };
  }
  /** LLM 文本管线（与旧 llm-parse 同一端点；default_date 取弹窗 #fabDate） */
  async function pipeLlm(text, label, log) {
    const dateEl = document.getElementById('fabDate');
    const default_date = dateEl && dateEl.value ? dateEl.value : undefined;
    let d;
    try { d = await Api.llmParse({ text, filename: label, default_date }); }
    catch (e) { toast(e.message, true); log(`✗ <b>${esc(label)}</b> → LLM 管线：${esc(e.message)}`); return null; }
    return { kind: 'batch', d, label };
  }

  /* ---------- P10-R4：导入 FAB 弹窗（D2：FAB 全替代导入入口；快捷处理不另立复核体系） ---------- */
  function fabHost() {
    if (typeof document === 'undefined') return null;
    return document.body || document.documentElement || null;
  }
  /** 追加一行日志到 #fabLog，返回该行元素（busy 行 remove 用；桩环境降级拼 innerHTML） */
  function fabLog(html) {
    const box = document.getElementById('fabLog');
    if (!box) return { remove() {} };
    if (typeof document.createElement === 'function') {
      const div = document.createElement('div');
      div.className = 'lg-detail';
      div.innerHTML = html;
      box.appendChild(div);
      return div;
    }
    box.innerHTML += html;
    return { remove() {} };
  }
  function fabModalHtml() {
    return `<div class="lg-modal-panel lg-modal-import" role="dialog" aria-label="快捷导入">
      <div class="lg-modal-head"><h2>📥 快捷导入</h2>
        <button class="lg-btn" data-act="fab-close" title="关闭（已解析的批次不丢，随时到「审核」页继续）">✕ 关闭</button></div>
      <div id="fabBody"></div>
    </div>`;
  }
  function fabStage1Html() {
    const ph = fabState.type === 'calc'
      ? '把计算器「导出 → ⬇ 下载作业包」的 JSON 粘到这里（{ 开头）'
      : fabState.type === 'excel'
        ? 'Excel 请用上方虚线框（点击选择或拖入 .xlsx）；这里也可粘记账文本'
        : '把杂乱记账记录粘进来（一行一条），例如：\n3月12日 李洪富 金桂村 打药 12亩 25元/亩 应收300 收300\n3.12 油钱200 加油站\n4月 收入540 不知道谁的';
    const typeBtn = (t, icon, label, id) =>
      `<button class="lg-btn${fabState.type === t ? ' primary' : ''}" id="${id}" data-act="fab-type" data-type="${t}"${t === 'llm' && fabState.llmOk === false ? ' disabled title="本机 LLM 未就绪（Excel/作业包不受影响）"' : ''}>${icon} ${label}</button>`;
    return `<div class="lg-fab-types">
      ${typeBtn('llm', '🤖', 'LLM 文本', 'fabTypeLlm')}
      ${typeBtn('calc', '📱', '计算器作业包', 'fabTypeCalc')}
      ${typeBtn('excel', '📊', 'Excel', 'fabTypeExcel')}
    </div>
    <label class="imp-drop" id="fabDrop" for="fabFile" title="拖文件到这里，或点击选择（按扩展名自动识别）">
      <input type="file" id="fabFile" multiple accept=".xlsx,.json,.txt,.md" hidden>
      <b>拖文件到这里，或点击选择</b><br>
      <span>.xlsx 月度记账表 → Excel 复核管线 · .json 作业包 → 计算器导入 · .txt / .md → 本机 LLM 文本管线</span>
    </label>
    <textarea id="fabText" rows="4" placeholder="${esc(ph)}" style="width:100%;font-size:13px;margin-top:8px"></textarea>
    <div class="lg-form" style="margin-top:8px">
      <label>默认日期（LLM 管线无日期条目按此记，仍进需复核可改）<input type="date" id="fabDate" value="${localToday()}"></label>
      <button class="lg-btn primary" data-act="fab-send" id="fabSendBtn">解析</button>
    </div>
    <div id="fabLlmHint" class="hint" style="color:var(--muted);font-size:12px">检查本机 LLM…</div>
    <div id="fabLog"></div>`;
  }
  function fabStage2Html() {
    return `<div id="fabSummary">${fabState.summary}</div>
    <div class="lg-form" style="margin:8px 0">
      <button class="lg-btn primary" data-act="fab-apply">✔ 确认并落库（仅已确认行）</button>
      <button class="lg-btn" data-act="fab-keep">放入待入库</button>
      <button class="lg-btn" data-act="fab-goto-review">去审核页细看</button>
      <button class="lg-btn" data-act="fab-llm-review" id="fabLlmReviewBtn"${fabState.llmOk === false ? ' disabled title="本机 LLM 未就绪"' : ' title="LLM 只挑错、带原文证据，绝不改数据；发现并入行级复核"'}>🤖 LLM 审查这批</button>
      <button class="lg-btn" data-act="fab-again">↺ 再导一批</button>
    </div>
    <table class="lg-table"><thead><tr>
      <th>sheet/行</th><th>类型</th><th>姓名</th><th>村/队</th><th>日期</th><th>应收</th><th>实收</th><th>复核提示</th><th>操作</th>
    </tr></thead><tbody id="fabRows"><tr><td colspan="9">加载中…</td></tr></tbody></table>
    <div id="fabLog"></div>`;
  }
  function fabJobResultHtml() {
    const j = fabState.jobNo || {};
    return `<div class="lg-detail">${j.duplicated
      ? `ℹ 该单此前已导入（单号 ${esc(j.no)}），幂等返回原单，未重复建单。`
      : `✓ 已导入：单号 ${esc(j.no)}——可在「总表」查看并走结算收款。`}</div>
    <div class="lg-form" style="margin-top:8px">
      <button class="lg-btn primary" data-act="fab-goto-overview">去总表看</button>
      <button class="lg-btn" data-act="fab-again">↺ 再导一批</button>
      <button class="lg-btn" data-act="fab-close">关闭</button>
    </div>`;
  }
  function fabRender() {
    const body = document.getElementById('fabBody');
    if (!body) return;
    if (fabState.batchId != null) body.innerHTML = fabStage2Html();
    else if (fabState.jobNo != null) body.innerHTML = fabJobResultHtml();
    else body.innerHTML = fabStage1Html();
  }
  function fabReset() {
    fabState.type = ''; fabState.batchId = null; fabState.rows = [];
    fabState.editId = null; fabState.jobNo = null; fabState.summary = '';
  }
  function fabOpen() {
    if (fabState.open) { fabRender(); return; }
    const host = fabHost();
    if (!host || typeof document.createElement !== 'function') return;
    const wrap = document.createElement('div');
    wrap.id = 'lgImportModal';
    wrap.className = 'lg-modal-mask';
    wrap.innerHTML = fabModalHtml();
    host.appendChild(wrap);
    fabState.open = true;
    fabReset();
    bindFabEvents(wrap);
    fabRender();
    // LLM 就绪探测：只更新提示与 LLM 类型按钮置灰，不重绘（保留用户已粘内容）
    Api.llmStatus().then(st => {
      fabState.llmOk = !!(st && st.ollama_ok);
      const h = document.getElementById('fabLlmHint');
      if (h) {
        h.textContent = fabState.llmOk
          ? `本机 LLM 就绪（${st.model}）——杂乱记账文本粘进来即可`
          : `本机 LLM 未就绪：${st.hint || st.error || '请启动 Ollama'}——Excel/作业包不受影响`;
        if (!fabState.llmOk) h.style.color = 'var(--err, #c62828)';
      }
      const b = document.getElementById('fabTypeLlm');
      if (b) { b.disabled = !fabState.llmOk; b.title = fabState.llmOk ? '' : '本机 LLM 未就绪（Excel/作业包不受影响）'; }
      const rb = document.getElementById('fabLlmReviewBtn');
      if (rb) { rb.disabled = !fabState.llmOk; rb.title = fabState.llmOk ? 'LLM 只挑错、带原文证据，绝不改数据；发现并入行级复核' : '本机 LLM 未就绪'; }
    }).catch(() => { fabState.llmOk = false; });
  }
  function fabClose(refreshPage) {
    const m = document.getElementById('lgImportModal');
    if (m) {
      if (typeof m.remove === 'function') m.remove();
      else if (m.parentNode && typeof m.parentNode.removeChild === 'function') m.parentNode.removeChild(m);
    }
    fabState.open = false;
    fabReset();
    // 当前就在审核页时重绘刷新批次表；他页保持原样（导航过去时自然重绘）
    if (refreshPage && T && T.render) T.render().catch(() => {});
  }
  /** 弹窗内直接绑定（弹窗元素独立于 #lgMain 重绘存活，无需委托） */
  function bindFabEvents(wrap) {
    if (!wrap || typeof wrap.addEventListener !== 'function') return;
    const hasFiles = dt => !!(dt && dt.types && [...dt.types].includes('Files'));
    wrap.addEventListener('change', e => {
      if (!e.target || e.target.id !== 'fabFile') return;
      fabHandleFiles(e.target.files).catch(err => toast(err.message, true));
      e.target.value = ''; // 允许下次再选同一文件
    });
    wrap.addEventListener('paste', e => {
      if (!e.target || e.target.id !== 'fabText') return;
      const cd = e.clipboardData;
      if (!cd) return;
      if (hasFiles(cd)) {
        e.preventDefault();
        const files = [...cd.files];
        const img = files.find(f => /^image\//.test(f.type));
        if (img) toast('📷 拍照识别即将支持（多模态模型下轮上线），请先用文本粘贴记账');
        const rest = files.filter(f => !/^image\//.test(f.type));
        if (rest.length) fabHandleFiles(rest).catch(err => toast(err.message, true));
        return;
      }
      const text = cd.getData ? cd.getData('text/plain') : '';
      // 不 preventDefault：文本照常落框，分派失败内容保留可改
      if (text && text.trim()) fabDispatchText(text, '粘贴文本.txt');
    });
    wrap.addEventListener('dragover', e => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const z = e.target && e.target.closest ? e.target.closest('#fabDrop') : null;
      if (z) z.classList.add('dragover');
    });
    wrap.addEventListener('drop', e => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const z = e.target && e.target.closest ? e.target.closest('#fabDrop') : null;
      if (z) z.classList.remove('dragover');
      if (!z) return toast('请把文件拖到虚线框里', true);
      fabHandleFiles(e.dataTransfer.files).catch(err => toast(err.message, true));
    });
    wrap.addEventListener('dragleave', e => {
      const z = e.target && e.target.closest ? e.target.closest('#fabDrop') : null;
      if (z) z.classList.remove('dragover');
    });
  }
  /** 管线结果消费：job → 结果视图；batch → 快捷处理视图（stage2） */
  async function fabConsume(r) {
    if (r.kind === 'job') {
      fabState.jobNo = { no: r.d.job_no, duplicated: !!r.d.duplicated };
      fabRender();
      toast(r.d.duplicated ? '该单此前已导入（幂等），未重复建单' : '作业包已导入');
      return;
    }
    const d = r.d;
    const st = d.stats || {};
    const sum = (st.rows != null)
      ? `共 ${st.rows} 行，无疑问 ${st.ok}，<b>需复核 ${d.review_count}</b>`
      : `作业 ${st.jobs} / 支出 ${st.expenses} / 跳过 ${st.skipped} / <b>需复核 ${d.review_count}</b>`;
    const llmMeta = d.model ? `（模型 ${esc(d.model)}${d.chunks > 1 ? `，分 ${d.chunks} 块` : ''}）` : '';
    const totals = d.raw_totals
      ? ` 原始列合计：应收 ${Core.fmtYuan(Math.round(d.raw_totals.receivable * 100))} · 实收 ${Core.fmtYuan(Math.round(d.raw_totals.paid * 100))} · 支出 ${Core.fmtYuan(Math.round(d.raw_totals.expense * 100))}。`
      : '';
    fabState.batchId = d.batch_id;
    fabState.summary = `<div class="lg-detail">批次 #${d.batch_id}（${esc(r.label)}）${llmMeta}：${sum}。${totals}</div><div class="hint" style="color:var(--muted);font-size:12px">「改」逐字段订正 → 确认/拒绝 → 确认并落库（仅消费已确认行）；放入待入库随时到审核页继续。</div>`;
    fabRender();
    toast('解析完成，请复核');
    await fabRenderRows();
    if (document.getElementById('impBatches')) loadImportBatches().catch(() => {}); // 审核页在挂载则批次表同步
  }
  async function fabRenderRows() {
    if (fabState.batchId == null) return;
    fabState.rows = await Api.importRows(fabState.batchId);
    const tb = document.getElementById('fabRows');
    if (tb) tb.innerHTML = fabState.rows.map(r => impRowTrHtml(r, 'fab', fabState.editId === r.id)).join('') ||
      '<tr><td colspan="9">无行</td></tr>';
  }
  /** 行动作后按上下文刷新（page=审核页行表；fab=弹窗行表） */
  async function impRefreshRows(ctx) {
    if (ctx === 'fab') {
      if (fabState.open && fabState.batchId != null) await fabRenderRows();
    } else if (importState.batchId != null && document.getElementById('impRowsPanel')) {
      await loadImportRows(importState.batchId);
    }
  }
  /** 单文件分派：扩展名 → 管线；未识别给可读提示（不猜内容，D1 裁决）。
      P9-R4 评审#2 模式：整段 try/catch/finally，busy 行必清、异常不中断多文件循环。 */
  async function fabOneFile(f) {
    const pipe = Core.pickPipeline(f.name);
    if (!pipe) {
      toast('未识别的文件类型：' + f.name, true);
      fabLog(`✗ <b>${esc(f.name)}</b>：未识别的文件类型——支持 <b>.xlsx</b>（月度记账表）/ <b>.json</b>（计算器作业包）/ <b>.txt .md</b>（记账文本）`);
      return;
    }
    const busy = fabLog(`⏳ <b>${esc(f.name)}</b> → ${pipe === 'excel' ? 'Excel 复核管线' : pipe === 'calcjson' ? '计算器作业导入' : 'LLM 管线'}：处理中…`);
    try {
      let r = null;
      if (pipe === 'excel') r = await pipeExcel(f, fabLog);
      else {
        const text = await fileToText(f);
        if (pipe === 'calcjson') r = await pipeCalcJson(text, f.name, fabLog);
        else r = await pipeLlm(text, f.name, fabLog);
      }
      if (r) await fabConsume(r);
    } catch (e) {
      toast(e.message, true);
      fabLog(`✗ <b>${esc(f.name)}</b>：${esc(e.message)}`);
    } finally {
      if (busy && typeof busy.remove === 'function') busy.remove();
    }
  }
  /** 多文件按序处理（拖拽可多选；单文件意外异常不中断循环——P9-R4 评审#2） */
  async function fabHandleFiles(fileList) {
    const list = [...(fileList || [])];
    if (!list.length) return;
    for (const f of list) {
      try { await fabOneFile(f); }
      catch (e) { toast(e.message, true); fabLog(`✗ <b>${esc(f.name)}</b>：${esc(e.message)}`); }
    }
  }
  /** 粘贴框内容分派（Ctrl+V 自动触发 + 「解析」按钮共用；失败时内容保留可改） */
  function fabDispatchText(text, label) {
    const pipe = Core.pickPipelineForText(text);
    if (!pipe) { toast('先粘贴内容：记账文本，或计算器导出的作业包 JSON', true); return Promise.resolve(); }
    const busy = fabLog(`⏳ <b>${esc(label)}</b> → ${pipe === 'calcjson' ? '计算器作业导入' : 'LLM 管线'}：处理中…`);
    return (pipe === 'calcjson' ? pipeCalcJson(text, label, fabLog) : pipeLlm(text, label, fabLog))
      .then(r => { if (r) return fabConsume(r); })
      .finally(() => { if (busy && typeof busy.remove === 'function') busy.remove(); });
  }

  /* P10-R1：主数据市/县筛选 change 绑定（委托在 #lgMain 上，重绘不丢；测试桩无 addEventListener 跳过）。
     P10-R4：收件箱事件绑定随收件箱 UI 一并移除（导入入口=FAB 弹窗，弹窗内直接绑定）。 */
  (function bindExtraChange() {
    const $m = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('lgMain') : null;
    if (!$m || typeof $m.addEventListener !== 'function') return;
    $m.addEventListener('change', e => {
      if (!e.target) return;
      if (e.target.id === 'mdCountyFilter') {
        mdCountyFilter = e.target.value || '';
        lsSet(MD_COUNTY_KEY, mdCountyFilter);
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        return;
      }
      // C1 药品搜索（change 即过滤；回车/失焦触发，不抢输入焦点）
      if (e.target.id === 'mdChemQ') {
        mdChemFilter = e.target.value || '';
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
      }
    });
  })();

  /* ---------- 主数据（客户行内直填 + 新增客户 + 地块档案） ---------- */
  let mdEditId = null;      // 行内编辑中的客户 id
  let mdPlotEditId = null;  // 行内编辑中的地块 id
  let mdChemEditId = null;  // C1 行内编辑中的药品 id
  let mdChemFilter = '';    // C1 药品搜索词
  let mdShowDeleted = false; // E8：显示已停用客户（软删）与恢复入口

  async function renderMasterData() {
    let parties = [];
    try { parties = await Api.parties(); } catch (err) { parties = []; }
    const settings = await Api.settings().catch(() => ({}));
    const bootstrap = await Api.get('/api/bootstrap').catch(() => null);
    const balMap = new Map((bootstrap ? bootstrap.parties : []).map(p => [p.id, p]));
    // D3：计算器地块档案（drone_spray_plots_v1，同源 localStorage 共享；坏档容错读）
    let cplotList = [];
    try {
      const raw = JSON.parse(localStorage.getItem('drone_spray_plots_v1') || 'null');
      cplotList = Array.isArray(raw && raw.list) ? raw.list : [];
    } catch (e) { cplotList = []; }
    // P9-R2：疑似重复组（拉不到就不显示该区，不影响主数据页其余功能）
    // P10-R1：市/县筛选选中时随 ?county= 传给体检端点（四桶服务端过滤）
    mdHealth = await Api.dataHealth(mdCountyFilter || undefined).catch(() => null);
    // E8：已停用（软删）客户——默认隐藏，勾选后置灰展示并提供「恢复」
    let deletedRows = '';
    if (mdShowDeleted) {
      let all = [];
      try { all = await Api.masterList('parties'); } catch (e) { all = []; }
      deletedRows = all.filter(p => p.deleted_at && p.type === 'customer'
        && (!mdCountyFilter || p.county === mdCountyFilter)).map(p0 => `<tr class="lg-detail">
        <td>${esc(p0.name)}（已停用）</td>
        <td>${esc(p0.county || '—')}</td>
        <td>${esc(p0.region || '—')}</td>
        <td>${esc(p0.village || '—')}${p0.team ? '/' + esc(p0.team) + '队' : ''}</td>
        <td>${esc(p0.phone || '—')}</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td>—</td>
        <td><button class="lg-btn primary" data-act="md-restore" data-id="${p0.id}" data-name="${esc(p0.name)}">恢复</button></td>
      </tr>`).join('');
    }
    // P10-R1：市/县筛选（选项=在用客户的 DISTINCT county；仅前端过滤客户表，
    // 疑似重复区走服务端 ?county=）
    const custAll = parties.filter(p => p.type === 'customer');
    const counties = [...new Set(custAll.map(p => p.county).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const custList = mdCountyFilter ? custAll.filter(p => p.county === mdCountyFilter) : custAll;
    const custRows = custList.map(p0 => {
      if (mdEditId === p0.id) return mdCustomerEditRow(p0);
      const b = balMap.get(p0.id) || {};
      return `<tr>
        <td>${esc(p0.name)}</td>
        <td>${esc(p0.county || '—')}</td>
        <td>${esc(p0.region || '—')}</td>
        <td>${esc(p0.village || '—')}${p0.team ? '/' + esc(p0.team) + '队' : ''}</td>
        <td>${esc(p0.phone || '—')}</td>
        <td class="num">${p0.default_price_cents ? Core.fmtYuan(p0.default_price_cents) : '—'}</td>
        <td class="num">${Core.fmtYuan(b.receivable_cents || 0)}</td>
        <td class="num">${Core.fmtYuan(b.prepaid_cents || 0)}</td>
        <td>${b.last_job ? esc((b.last_job.date || '') + ' ' + (b.last_job.price_yuan ? b.last_job.price_yuan.toFixed(1) + '元/亩' : '')) : '—'}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="md-edit" data-id="${p0.id}">编辑</button>`,
          // C3 用药史（零新表派生；弹层在 app.js usage-view 通用处理）
          `<button class="lg-btn" data-act="usage-view" data-party-id="${p0.id}" data-party-name="${esc(p0.name)}" title="该客户的历次用药记录">💊 用药史</button>`,
          p0.enabled ? `<button class="lg-btn danger" data-act="md-disable" data-id="${p0.id}" data-name="${esc(p0.name)}">停用</button>` : ''
        )}</td>
      </tr>`;
    }).join('');
    /* C1 药品价格表：行内编辑（名称/进价/售价/库存）+ 搜索 + 按使用频率排序 +
       库存警示（空=不启用库存显'—'，低于 1 套红⚠️）+ 入库按钮（M1 手档）。
       经营三列经 masterdata TABLES 白名单（迁移 013）；作业参数列只读（计算器口径）。 */
    const chemAll = bootstrap ? (bootstrap.chemicals || []) : [];
    let chemUseCount = new Map();
    try {
      const jobsAll = await Api.jobs();
      for (const j of jobsAll || []) {
        if (!j.plant_type_name) continue;
        chemUseCount.set(j.plant_type_name, (chemUseCount.get(j.plant_type_name) || 0) + 1);
      }
    } catch (e) { /* 频率拉不到就按原序 */ }
    const chemQ = (mdChemFilter || '').trim().toLowerCase();
    const chemSorted = [...chemAll].sort((a, b) =>
      (chemUseCount.get(b.name) || 0) - (chemUseCount.get(a.name) || 0));
    const chemList = chemQ ? chemSorted.filter(c =>
      [c.name, c.key, c.description].some(v => String(v || '').toLowerCase().includes(chemQ))) : chemSorted;
    const chems = chemList.map(c => {
      if (mdChemEditId === c.id) return mdChemEditRow(c);
      const stock = c.stock_qty == null ? '—'
        : `${c.stock_qty < 1 ? '<span class="lg-tag err">⚠️</span> ' : ''}${c.stock_qty}`;
      return `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.key || '—')}</td>
        <td class="num">${c.water_per_mu ?? '—'}</td>
        <td class="num">${c.pesticide_water_per_set ?? '—'}</td>
        <td class="num">${c.price_cents_per_set ? Core.fmtYuan(c.price_cents_per_set) : '—'}</td>
        <td class="num">${c.cost_cents != null ? Core.fmtYuan(c.cost_cents) : '—'}</td>
        <td class="num">${c.price_cents != null ? Core.fmtYuan(c.price_cents) : '—'}</td>
        <td class="num">${stock}</td>
        <td>${actions(
          `<button class="lg-btn" data-act="md-chem-edit" data-id="${c.id}">编辑</button>`,
          `<button class="lg-btn" data-act="chem-restock" data-id="${c.id}" data-name="${esc(c.name)}" data-stock="${c.stock_qty ?? ''}">入库</button>`
        )}</td>
      </tr>`;
    }).join('');
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
    // P9-R2：疑似重复（同名组）——并排展示 + 合并按钮开预览弹窗
    const dupePanel = (mdHealth && mdHealth.suspect_dupes && mdHealth.suspect_dupes.length)
      ? `<div class="lg-panel">
      <h2>⚠ 疑似重复（同名客户组——同村同名未必同一人，逐组人工判后再合并）</h2>
      <table class="lg-table" data-colw="master-dupes"><thead><tr>
        <th>姓名</th><th>档案数</th><th>成员（#id · 村/队 · 电话 · 账单数 · 金额 · 未收）</th><th>操作</th>
      </tr></thead><tbody>${mdHealth.suspect_dupes.map(g => `<tr>
        <td><b>${esc(g.name)}</b></td><td>${g.members.length}</td>
        <td>${g.members.map(m => `#${m.id} · ${esc(m.village || '—')}${m.team ? '/' + esc(m.team) + '队' : ''} · ${esc(m.phone || '无电话')} · ${m.bill_count} 张 · ${Core.fmtYuan(m.bill_amount_cents)} 元 · 未收 ${Core.fmtYuan(m.due_cents)}`).join('<br>')}</td>
        <td><button class="lg-btn primary" data-act="md-merge-open" data-key="${esc(g.key)}">合并…</button></td>
      </tr>`).join('')}</tbody></table>
    </div>`
      : '';
    // P10-R1：市/县筛选下拉（默认「全部」；值记忆 localStorage，键 lg-md-county）
    const countyOpts = counties.map(c =>
      `<option value="${esc(c)}" ${c === mdCountyFilter ? 'selected' : ''}>${esc(c)}</option>`).join('');
    // D4 结算卡二维码配置状态（QRS 在 settlement-card.js；组件未加载视同未配置）
    const QRS_ = window.LedgerSettlementCard && window.LedgerSettlementCard.QRS;
    const payQr = QRS_ && QRS_.get(QRS_.PAY_KEY);
    const acctQr = QRS_ && QRS_.get(QRS_.ACCT_KEY);
    return `${dupePanel}<div class="lg-panel">
      <h2>设置</h2>
      <div class="lg-form">
        <label>记账人（写入 edit_logs 与工单 operator）<input id="mdOperator" value="${esc(settings.operator || 'local')}"></label>
        <button class="lg-btn primary" data-act="md-save-operator">保存</button>
        <button class="lg-btn" data-act="onboard-replay" title="重看三步引导（工单→结算→收款）">🎓 重看新手引导</button>
      </div>
      <!-- D4 结算卡二维码：上传后存 localStorage dataURL，工单详情「📤 生成结算卡」右下角渲染；未配置不渲染 -->
      <div class="lg-scard-qrset">
        <span class="lg-kpi-label">结算卡二维码（客户扫码用）</span>
        <label class="lg-btn" title="选一张收款码图片（自动缩到 480px 存本地）">📷 上传收款码<input type="file" id="qrPayFile" accept="image/*" hidden></label>
        <span id="qrPayState" class="lg-kpi-sub">${(window.LedgerSettlementCard && window.LedgerSettlementCard.QRS.get(window.LedgerSettlementCard.QRS.PAY_KEY)) ? '已配置' : '未配置'}</span>
        <button class="lg-btn" data-act="qr-pay-clear" title="清除收款码" ${payQr ? '' : 'hidden'}>✕</button>
        <label class="lg-btn" title="选一张账号码图片（自动缩到 480px 存本地）">📷 上传账号码<input type="file" id="qrAcctFile" accept="image/*" hidden></label>
        <span id="qrAcctState" class="lg-kpi-sub">${(window.LedgerSettlementCard && window.LedgerSettlementCard.QRS.get(window.LedgerSettlementCard.QRS.ACCT_KEY)) ? '已配置' : '未配置'}</span>
        <button class="lg-btn" data-act="qr-acct-clear" title="清除账号码" ${acctQr ? '' : 'hidden'}>✕</button>
        <span class="lg-kpi-sub">收款码=主码大位（微信扫码付款）；账号码=次码；两者都传=双码版</span>
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
        <label>市/县<input id="ncCounty" placeholder="留空默认 会理市"></label>
        <label>区域(镇)<input id="ncRegion" placeholder="如 通安/彰冠"></label>
        <label>村<input id="ncVillage" placeholder="如 金桂"></label>
        <label>队<input id="ncTeam" placeholder="数字"></label>
        <label>电话<input id="ncPhone"></label>
        <label>默认单价(元/亩)<input id="ncPrice" type="number" step="0.01" min="0"></label>
        <button class="lg-btn primary" data-act="nc-save">新增客户</button>
      </div>
    </div>
    <div class="lg-panel">
      <h2>客户（点「编辑」行内直填，回车或点保存生效）
        <label style="font-size:13px;font-weight:normal;margin-left:12px">市/县
          <select id="mdCountyFilter" title="按客户档案的市/县筛选客户列表与疑似重复区（选项来自在用客户的 DISTINCT county）">
            <option value="">全部</option>${countyOpts}
          </select>
        </label>
        <label style="font-size:13px;font-weight:normal;margin-left:12px"><input type="checkbox" data-act="md-show-deleted" ${mdShowDeleted ? 'checked' : ''}> 显示已停用客户</label>
      </h2>
      <table class="lg-table" data-colw="master-parties"><thead><tr>
        <th>姓名</th><th>市</th><th>区域</th><th>村/队</th><th>电话</th><th>默认单价</th><th>欠款(元)</th><th>预收(元)</th><th>最近作业</th><th>操作</th>
      </tr></thead><tbody>${(custRows + deletedRows) || '<tr><td colspan="10">该市/县暂无客户</td></tr>'}</tbody></table>
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
      <div class="lg-form" style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
        <label style="flex-basis:100%">计算器地块档案（drone_spray_plots_v1，含用药史；与计算器页面同源共享本地存储。挂档键=姓名+村+队，DATA-CONTRACT §2a）<span style="color:var(--muted)">${cplotList.length} 条</span></label>
        <button class="lg-btn" data-act="md-cplot-export">⬇ 导出JSON（含用药史）</button>
        <button class="lg-btn" data-act="md-cplot-import">⬆ 导入JSON</button>
      </div>
      <textarea id="mdCplotIo" rows="5" style="display:none;font-size:12px" placeholder="导出时显示全量 JSON；导入时在此粘贴后点确认"></textarea>
      <div class="lg-form" id="mdCplotActions" style="display:none">
        <button class="lg-btn primary" data-act="md-cplot-import-confirm">确认导入（同名同村队覆盖）</button>
        <button class="lg-btn" data-act="md-cplot-import-cancel">取消</button>
      </div>
      ${cplotList.length ? `<table class="lg-table" style="margin-top:6px" data-colw="master-cplots"><thead><tr>
        <th>姓名</th><th>村/队</th><th>地址</th><th>作业/圈地(亩)</th><th>当前药型</th><th>次数</th><th>用药史</th><th>操作</th>
      </tr></thead><tbody>${cplotList.map(p => `<tr>
        <td><b>${esc(p.farmerName)}</b></td>
        <td>${esc([p.farmerVillage, p.farmerTeam].filter(Boolean).join('/') || '—')}</td>
        <td>${esc(p.address || '—')}</td>
        <td>${p.areaWorkMu != null ? p.areaWorkMu : '—'}${p.areaEnclosedMu != null ? ' / ' + p.areaEnclosedMu : ''}</td>
        <td>${esc((p.currentDrug && p.currentDrug.drugName) || '—')}${p.currentDrug && p.currentDrug.pricePerMu != null ? ` ¥${p.currentDrug.pricePerMu}/亩` : ''}</td>
        <td>${p.useCount || 0}</td>
        <td>${(p.history || []).slice(-3).map(h => esc(`${h.date || ''} ${h.drugName || ''}`).trim()).join('<br>') || '—'}</td>
        <td><button class="lg-btn danger" data-act="md-cplot-del" data-id="${esc(p.id)}">删除</button></td>
      </tr>`).join('')}</tbody></table>` : ''}
    </div>
    <div class="lg-panel">
      <h2>药品价格表（进价/售价/库存行内编辑；按使用频率排序；库存空=不启用）</h2>
      <div class="lg-toolbar">
        <input id="mdChemQ" class="lg-search" value="${esc(mdChemFilter || '')}" placeholder="🔍 名称/key/说明" style="max-width:220px">
      </div>
      <table class="lg-table" data-colw="master-chems"><thead><tr>
        <th>名称</th><th>key</th><th>水量/亩</th><th>兑水/套</th><th>药价/套(作业)</th>
        <th>进价(元)</th><th>售价(元)</th><th>库存(套)</th><th>操作</th>
      </tr></thead>
      <tbody>${chems || `<tr><td colspan="9">${Core.emptyState('💊', '暂无药品档案——计算器同步后自动生成；进价/售价/库存在此维护',
        [], { cell: true })}</td></tr>`}</tbody></table>
    </div>${mdMergeModalHtml()}`;
  }

  /** C1 药品编辑行（data-mc 前缀防与客户 md- 字段撞键）：名称/进价/售价/库存（元↔分） */
  function mdChemEditRow(c) {
    const inp = (f, val, ph, type, step) =>
      `<input data-mc="${f}" value="${esc(val ?? '')}" placeholder="${ph}" ${type ? `type="${type}" step="${step || '0.01'}"` : ''}>`;
    return `<tr class="lg-detail">
      <td>${inp('name', c.name, '名称')}</td>
      <td>${esc(c.key || '—')}</td>
      <td class="num">${c.water_per_mu ?? '—'}</td>
      <td class="num">${c.pesticide_water_per_set ?? '—'}</td>
      <td class="num">${c.price_cents_per_set ? Core.fmtYuan(c.price_cents_per_set) : '—'}</td>
      <td class="num">${inp('cost_yuan', c.cost_cents != null ? c.cost_cents / 100 : '', '进价', 'number')}</td>
      <td class="num">${inp('price_yuan', c.price_cents != null ? c.price_cents / 100 : '', '售价', 'number')}</td>
      <td class="num">${inp('stock_qty', c.stock_qty ?? '', '库存(套，空=不启用)', 'number', '0.1')}</td>
      <td>${actions(
        `<button class="lg-btn primary" data-act="md-chem-edit-save" data-id="${c.id}">保存</button>`,
        `<button class="lg-btn" data-act="md-chem-edit-cancel">取消</button>`
      )}</td>
    </tr>`;
  }

  /* ---------- P9-R2：合并预览弹窗（主数据/体检两页共用） ---------- */
  /** 弹窗：组内两/三档并排对照（单数/金额/村/最近作业）+ 存续档选择 + 保留字段选择。 */
  function mdMergeModalHtml() {
    if (!mdMergeGroup) return '';
    const g = mdMergeGroup;
    const m = g.members;
    // 并排成员表：每列一个档案
    const rows = [
      ['存续档', i => `<input type="radio" name="mdMergeInto" data-minto value="${m[i].id}" ${i === 0 ? 'checked' : ''} title="勾选的档案保留，其余并入">`],
      ['#id', i => esc(m[i].id)],
      ['村/队', i => esc((m[i].village || '—') + (m[i].team ? '/' + m[i].team + '队' : ''))],
      ['区域', i => esc(m[i].region || '—')],
      ['电话', i => esc(m[i].phone || '—')],
      ['账单', i => `${m[i].bill_count} 张 / ${Core.fmtYuan(m[i].bill_amount_cents)} 元`],
      ['未收', i => Core.fmtYuan(m[i].due_cents)],
      ['最近作业', i => `<span title="按导入单精确关联（farmer_ref=档案id）；计算器来源单无法在同名组内精确归属，不显示">${esc(m[i].last_job_date || '—')}</span>`]
    ];
    const head = m.map(x => `<th>#${esc(x.id)}</th>`).join('');
    const body = rows.map(([label, cell]) =>
      `<tr><td><b>${label}</b></td>${m.map((x, i) => `<td>${cell(i)}</td>`).join('')}</tr>`).join('');
    // 保留字段（用户裁决 2026-10-07：合并时可修改任何一方数据并选择合并方向）——
    // datalist 兼"选既有值"与"自由输入"（如把 7队 改成 12队 再并）；空串=清空（允许空数据）。
    const KEEP_UI = [['village', '村'], ['team', '队'], ['region', '区域'], ['phone', '电话']];
    const keepRows = KEEP_UI.map(([f, label]) => {
      const seen = new Set();
      const opts = m.map(x => ({ id: x.id, v: String(x[f] == null ? '' : x[f]) }))
        .filter(o => { const k = o.id + '\u0000' + o.v; if (seen.has(k)) return false; seen.add(k); return true; })
        .map(o => `<option value="${esc(o.v)}">#${o.id}：${o.v === '' ? '（空）' : esc(o.v)}</option>`).join('');
      const dlId = `mdKeepDl-${f}`;
      return `<tr><td><b>保留·${label}</b></td><td colspan="${m.length}">` +
        `<input list="${dlId}" data-mkeep="${f}" value="${esc(String(m[0][f] == null ? '' : m[0][f]))}" ` +
        `title="该字段写进存续档：下拉选某档现值，或直接改成任意新值（空串=清空）">` +
        `<datalist id="${dlId}">${opts}</datalist></td></tr>`;
    }).join('');
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:60;display:flex;align-items:center;justify-content:center" id="mdMergeBox">
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:16px;max-width:92vw;max-height:88vh;overflow:auto" class="lg-detail">
        <h2>合并预览：${esc(g.name)}（${m.length} 档 → 1 档）</h2>
        <div class="hint" style="color:var(--muted);font-size:12px;margin-bottom:8px">勾「存续档」选保留哪个档案，其余档案的账单/收款/分录等引用全部改挂过去后停用（历史单据上的姓名快照不改）。金额分文不动。</div>
        <table class="lg-table"><thead><tr><th></th>${head}</tr></thead><tbody>${body}${keepRows}</tbody></table>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="lg-btn primary" data-act="md-merge-run">确认合并</button>
          <button class="lg-btn" data-act="md-merge-cancel">取消</button>
        </div>
      </div>
    </div>`;
  }

  /* ---------- P9-R2：数据体检页（问题分组清单 + 忽略登记） ---------- */
  async function renderHealth() {
    // B0.3/N-12：与主数据页体检同口径——读取同一市筛选存档（lg-md-county），
    // 两页体检结果一致；清空筛选即全库视图
    mdHealth = await Api.dataHealth(String(lsGet(MD_COUNTY_KEY) || '') || undefined).catch(() => null);
    if (!mdHealth) {
      return '<div class="lg-panel"><h2>数据体检</h2><div class="lg-detail">体检数据拉取失败（服务端较旧？需重启服务生效）</div></div>';
    }
    const dismissBtn = it => `<button class="lg-btn" data-act="dh-dismiss" data-key="${esc(it.key)}" title="登记忽略（存 settings 键 datahealth.dismissed）">忽略</button>`;
    const dupes = (mdHealth.suspect_dupes || []).map(g => `<tr>
        <td><b>${esc(g.name)}</b></td><td>${g.members.length}</td>
        <td>${g.members.map(m => `#${m.id} · ${esc(m.village || '—')}${m.team ? '/' + esc(m.team) + '队' : ''} · ${esc(m.phone || '无电话')} · ${m.bill_count} 张 · ${Core.fmtYuan(m.bill_amount_cents)} 元`).join('<br>')}</td>
        <td>${actions(`<button class="lg-btn primary" data-act="md-merge-open" data-key="${esc(g.key)}">合并…</button>`, dismissBtn(g))}</td>
      </tr>`).join('');
    const variants = (mdHealth.village_variants || []).map(v => `<tr>
        <td>${v.values.map(esc).join(' ↔ ')}（合计 ${v.party_count} 户）</td>
        <td>${dismissBtn(v)}</td>
      </tr>`).join('');
    const regionRows = (mdHealth.region_missing || []).map(r => `<tr>
        <td>#${r.id}</td><td>${esc(r.name)}</td><td>${esc(r.village || '—')}${r.team ? '/' + esc(r.team) + '队' : ''}</td>
        <td>${dismissBtn(r)}</td>
      </tr>`).join('');
    const phoneRows = (mdHealth.no_phone || []).map(r => `<tr>
        <td>#${r.id}</td><td>${esc(r.name)}</td><td>${esc(r.village || '—')}${r.team ? '/' + esc(r.team) + '队' : ''}</td>
        <td>${dismissBtn(r)}</td>
      </tr>`).join('');
    const outliers = (mdHealth.amount_outliers || []).map(o => `<tr>
        <td>${esc(o.payment_no)}</td><td class="num"><b>${Core.fmtYuan(o.amount_cents)}</b></td>
        <td>${esc(Core.MAPS.PAYMENT_CATEGORY[o.category] || o.category)}</td>
        <td>${esc((o.occurred_at || '').slice(0, 10))}</td><td>${esc(o.note || '—')}</td>
        <td>${dismissBtn(o)}</td>
      </tr>`).join('');
    const cnt = a => (a || []).length;
    return `<div class="lg-panel">
      <h2>数据体检（同名 / 村异写 / region 未填写 / 空电话 / 金额离群；忽略=登记不显示）</h2>
      <div class="hint" style="color:var(--muted);font-size:12px">体检生成于 ${(mdHealth.generated_at || '').slice(0, 19).replace('T', ' ')} · 已忽略 ${mdHealth.dismissed_count || 0} 项。region 回填与村名统一走主数据「编辑」，金额存疑先对照原始单据。</div>
    </div>
    <div class="lg-panel">
      <h2>疑似重复（同名组）· ${cnt(mdHealth.suspect_dupes)} 组</h2>
      <table class="lg-table" data-colw="health-dupes"><thead><tr><th>姓名</th><th>档案数</th><th>成员</th><th>操作</th></tr></thead>
      <tbody>${dupes || '<tr><td colspan="4">无同名组 ✓</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>村名多写（互为前缀的在用村名）· ${cnt(mdHealth.village_variants)} 组</h2>
      <table class="lg-table" data-colw="health-variants"><thead><tr><th>写法对</th><th>操作</th></tr></thead>
      <tbody>${variants || '<tr><td colspan="2">无多写 ✓</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>region 未填写 · ${cnt(mdHealth.region_missing)} 户</h2>
      <table class="lg-table" data-colw="health-region"><thead><tr><th>id</th><th>姓名</th><th>村/队</th><th>操作</th></tr></thead>
      <tbody>${regionRows || '<tr><td colspan="4">全部已填 ✓</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>空电话 · ${cnt(mdHealth.no_phone)} 户</h2>
      <table class="lg-table" data-colw="health-phone"><thead><tr><th>id</th><th>姓名</th><th>村/队</th><th>操作</th></tr></thead>
      <tbody>${phoneRows || '<tr><td colspan="4">全部已填 ✓</td></tr>'}</tbody></table>
    </div>
    <div class="lg-panel">
      <h2>金额离群（支出单笔 > 5000 元）· ${cnt(mdHealth.amount_outliers)} 笔</h2>
      <table class="lg-table" data-colw="health-outliers"><thead><tr><th>单号</th><th>金额</th><th>类别</th><th>日期</th><th>备注</th><th>操作</th></tr></thead>
      <tbody>${outliers || '<tr><td colspan="6">无离群 ✓</td></tr>'}</tbody></table>
    </div>${mdMergeModalHtml()}`;
  }

  /** 客户行内编辑行（county/region/village/team/phone/price 直填） */
  function mdCustomerEditRow(p0) {
    const inp = (f, val, ph, type) =>
      `<input data-md="${f}" value="${esc(val ?? '')}" placeholder="${ph}" ${type ? `type="${type}" step="0.01"` : ''}>`;
    return `<tr class="lg-detail">
      <td><b>${esc(p0.name)}</b></td>
      <td>${inp('county', p0.county, '市/县')}</td>
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
      /* ---- P9-R2：合并预览弹窗（md- 前缀复用既有委托通道） ---- */
      case 'md-merge-open': {
        mdMergeReturnTab = state.tab; // 主数据页或审核页（体检区）打开都回原页
        const g = ((mdHealth && mdHealth.suspect_dupes) || []).find(x => x.key === btn.dataset.key);
        if (!g || !g.members || g.members.length < 2) return toast('找不到该重复组（先刷新页面）', true);
        mdMergeGroup = g;
        window.LedgerExtra.renderTab(mdMergeReturnTab, document.getElementById('lgMain'));
        break;
      }
      case 'md-merge-cancel':
        mdMergeGroup = null;
        window.LedgerExtra.renderTab(mdMergeReturnTab, document.getElementById('lgMain'));
        break;
      case 'md-merge-run': {
        const box = document.getElementById('mdMergeBox');
        const intoRadio = box && box.querySelector('input[data-minto]:checked');
        if (!intoRadio) return toast('先勾选存续档案', true);
        const intoId = Number(intoRadio.value);
        const g = mdMergeGroup;
        const fromIds = g.members.filter(m => m.id !== intoId).map(m => m.id);
        const keep = {};
        box.querySelectorAll('[data-mkeep]').forEach(sel => { keep[sel.dataset.mkeep] = sel.value; });
        confirmThen(
          `确认把 ${g.name} 的 #${fromIds.join('、#')} 并入 #${intoId}？\n` +
          `引用将全部改挂到 #${intoId}，其余档案停用（可恢复）；金额分文不动。`,
          async () => {
            // 评审 #4：逐档独立事务，前面的合并已生效、后面可能失败（如业务键与
            // 组内在线成员互撞）——不能靠 run() 的 catch（只 toast 不重绘，页面
            // 停在过期状态，重试会对已软删档撞 INVALID_STATE）。此处自行收集
            // 成败并返回结果，失败即停，.then 里无论成败都重绘刷新。
            const done = [], failed = [];
            for (const fid of fromIds) {
              try { await Api.mergeParties({ from_id: fid, into_id: intoId, keep }); done.push(fid); }
              catch (e) { failed.push({ id: fid, msg: e.message }); break; }
            }
            return { done, failed, intoId };
          }).then(r => {
            if (!r) return; // 用户取消确认框
            mdMergeGroup = null;
            if (r.failed.length) {
              toast(`已合并 ${r.done.length} 档；#${r.failed[0].id} 合并失败：${r.failed[0].msg}。列表已刷新，请重新点「合并…」处理剩余档案`, true);
            } else {
              toast(`已合并 ${r.done.length} 档 → #${r.intoId}。请到计算器侧删除多余农户档案（本地档案不会自动消失）`);
            }
            window.LedgerExtra.renderTab(mdMergeReturnTab, document.getElementById('lgMain'));
          });
        break;
      }
      /* ---- P9-R2：体检页忽略登记（dh- 前缀，app.js 委托正则已加） ---- */
      case 'dh-dismiss':
        confirmThen(`忽略该问题项（${btn.dataset.key}）？登记后体检页不再显示。`, () => Api.dismissHealth(btn.dataset.key))
          .then(r => { if (r) { toast('已登记忽略'); window.LedgerExtra.renderTab(state.tab, document.getElementById('lgMain')); } });
        break;
      case 'md-save-operator':
        run(() => Api.saveSettings({ operator: document.getElementById('mdOperator').value || 'local' }), '记账人已保存');
        break;
      case 'qr-pay-clear':
      case 'qr-acct-clear': {
        // D4 结算卡二维码清除（上传走 app.js change 委托；此处只清档+重绘设置区）
        const QRS = window.LedgerSettlementCard && window.LedgerSettlementCard.QRS;
        if (QRS) QRS.clear(act === 'qr-pay-clear' ? QRS.PAY_KEY : QRS.ACCT_KEY);
        toast('已清除二维码');
        if (tools && tools.render) tools.render().catch(() => {});
        break;
      }
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
      case 'md-chem-edit':
        // C1 药品行内编辑（data-mc 字段；与客户 md- 编辑互斥）
        mdChemEditId = id; mdEditId = null; mdPlotEditId = null;
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        break;
      case 'md-chem-edit-cancel':
        mdChemEditId = null;
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        break;
      case 'md-chem-edit-save': {
        const tr = btn.closest('tr');
        const get = f => { const el = tr.querySelector(`[data-mc="${f}"]`); return el ? el.value : undefined; };
        const body = {};
        const name = get('name');
        if (name != null && name.trim()) body.name = name.trim();
        for (const [f, col] of [['cost_yuan', 'cost_cents'], ['price_yuan', 'price_cents']]) {
          const v = get(f);
          if (v == null) continue;
          if (v === '') { body[col] = null; continue; } // 清空=未填（NULL）
          const cents = Core.yuanInputToCents(v);
          if (cents == null || isNaN(cents) || cents < 0) return toast(`${f === 'cost_yuan' ? '进价' : '售价'}非法`, true);
          body[col] = cents;
        }
        const stock = get('stock_qty');
        if (stock != null) body.stock_qty = stock === '' ? null : Number(stock);
        if (!Object.keys(body).length) { mdChemEditId = null; return window.LedgerExtra.renderTab('master', document.getElementById('lgMain')); }
        run(() => Api.masterPatch('chemicals', id, body), '药品已更新').then(() => { mdChemEditId = null; });
        break;
      }
      case 'chem-restock': {
        // C1 入库（M1 手档）：在现库存上加数（未启用库存=从 0 起）
        const cur = btn.dataset.stock === '' ? 0 : Number(btn.dataset.stock);
        const v = window.prompt(`入库 ${btn.dataset.name}（当前库存 ${cur} 套），输入入库套数：`);
        if (v == null) return;
        const n = Number(v);
        if (!(n > 0)) return toast('入库数须为正数', true);
        run(() => Api.masterPatch('chemicals', id, { stock_qty: Math.round((cur + n) * 10) / 10 }), `已入库 ${n} 套`);
        break;
      }
      case 'md-edit-save': {
        const tr = btn.closest('tr');
        const get = f => { const el = tr.querySelector(`[data-md="${f}"]`); return el ? el.value : undefined; };
        const body = {};
        const region = get('region'), village = get('village'), team = get('team'),
          phone = get('phone'), price = get('price_yuan'), county = get('county');
        if (county != null) body.county = county.trim(); // P10-R1：市/县直填（清空=存空串，归未填写）
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
        // P10-R1：市/县留空不发键 → 走 DB 默认 '会理市'（不发空串覆盖默认）
        const ncCounty = document.getElementById('ncCounty').value.trim();
        if (ncCounty) body.county = ncCounty;
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
      /* ---------- D3 计算器地块档案导入导出（同源 localStorage；挂档键=姓名|村|队） ---------- */
      case 'md-cplot-export': {
        const box = document.getElementById('mdCplotIo');
        const acts = document.getElementById('mdCplotActions');
        if (!box) break;
        const raw = localStorage.getItem('drone_spray_plots_v1') || '{"list":[]}';
        try { box.value = JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { box.value = raw; }
        box.style.display = '';
        if (acts) acts.style.display = 'none';
        box.select();
        try { document.execCommand('copy'); toast('全量档案已复制到剪贴板（含用药史）'); }
        catch (e) { toast('已显示在文本框，请手动复制', true); }
        break;
      }
      case 'md-cplot-import': {
        const box = document.getElementById('mdCplotIo');
        const acts = document.getElementById('mdCplotActions');
        if (!box) break;
        box.value = '';
        box.style.display = '';
        if (acts) acts.style.display = '';
        break;
      }
      case 'md-cplot-import-cancel': {
        const box = document.getElementById('mdCplotIo');
        const acts = document.getElementById('mdCplotActions');
        if (box) box.style.display = 'none';
        if (acts) acts.style.display = 'none';
        break;
      }
      case 'md-cplot-import-confirm': {
        const box = document.getElementById('mdCplotIo');
        if (!box || !box.value.trim()) { toast('请先粘贴 JSON', true); break; }
        let incoming;
        try { incoming = JSON.parse(box.value); } catch (e) { toast('JSON 解析失败：' + e.message, true); break; }
        const list = Array.isArray(incoming && incoming.list) ? incoming.list
          : Array.isArray(incoming) ? incoming : [];
        const keyOf = p => [p.farmerName, p.farmerVillage, p.farmerTeam].map(x => String(x || '').trim()).join('|');
        let current = [];
        try {
          const raw = JSON.parse(localStorage.getItem('drone_spray_plots_v1') || 'null');
          current = Array.isArray(raw && raw.list) ? raw.list : [];
        } catch (e) { current = []; }
        let cover = 0, add = 0;
        list.filter(p => p && String(p.farmerName || '').trim()).forEach(p => {
          const idx = current.findIndex(x => keyOf(x) === keyOf(p));
          if (idx >= 0) { current[idx] = p; cover++; } else { current.push(p); add++; }
        });
        localStorage.setItem('drone_spray_plots_v1', JSON.stringify({ list: current }));
        toast(`导入完成：新增 ${add}，覆盖 ${cover}`);
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        break;
      }
      case 'md-cplot-del': {
        const id = btn.dataset.id;
        let current = [];
        try {
          const raw = JSON.parse(localStorage.getItem('drone_spray_plots_v1') || 'null');
          current = Array.isArray(raw && raw.list) ? raw.list : [];
        } catch (e) { current = []; }
        const hit = current.find(p => p.id === id);
        if (!hit) { toast('条目不存在', true); break; }
        confirmThen(`删除计算器地块档案「${hit.farmerName}」（含用药史 ${((hit.history) || []).length} 条）？计算器端同步消失，不可恢复。`,
          () => Promise.resolve(true))
          .then(r => {
            if (!r) return;
            localStorage.setItem('drone_spray_plots_v1', JSON.stringify({ list: current.filter(p => p.id !== id) }));
            toast('已删除');
            window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
          });
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
      case 'md-show-deleted':
        // E8：复选框经 click 委托进入；checked 即为目标态
        mdShowDeleted = !!btn.checked;
        window.LedgerExtra.renderTab('master', document.getElementById('lgMain'));
        break;
      case 'md-restore':
        confirmThen(`恢复客户 ${btn.dataset.name}？（回到客户列表）`, () => Api.post(`/api/master/parties/${btn.dataset.id}/restore`))
          .then(r => { if (r) { toast('已恢复'); window.LedgerExtra.renderTab('master', document.getElementById('lgMain')); } });
        break;
      /* ---- P9-R4：收件箱「送入管线」+ 多模态占位（D1：只留占位，多模态模型下轮再上） ---- */
      /* ---- P10-R4：导入 FAB 弹窗（fab- 前缀；FAB 触发经 app.js [data-fab]=import → fab-open，
           弹窗内按钮经 app.js 文档级委托进同一 handleAct 通道） ---- */
      case 'fab-open':
        fabOpen();
        break;
      case 'fab-close':
        fabClose(state.tab === 'review');
        break;
      case 'fab-type': {
        const t2 = btn.dataset.type;
        if (!['llm', 'calc', 'excel'].includes(t2)) break;
        // 切类型不丢已粘内容/日期（stage1 局部重绘后回填）
        const prevText = (document.getElementById('fabText') || {}).value || '';
        const prevDate = (document.getElementById('fabDate') || {}).value || '';
        fabState.type = t2;
        if (fabState.batchId == null && fabState.jobNo == null) {
          fabRender();
          const tx = document.getElementById('fabText'); if (tx) tx.value = prevText;
          const de = document.getElementById('fabDate'); if (de) de.value = prevDate || localToday();
        }
        break;
      }
      case 'fab-send': {
        const btn = document.getElementById('fabSendBtn');
        if (btn && btn.disabled) return; // backlog#1：解析进行中防重（连点会造重复 LLM 批次）
        const text = (document.getElementById('fabText') || {}).value || '';
        if (!text.trim()) return toast('先粘贴内容：记账文本 / 作业包 JSON，或拖入/选择文件', true);
        const pipe = Core.pickPipelineForText(text);
        if (!pipe) return toast('先粘贴内容：记账文本，或计算器导出的作业包 JSON', true);
        const busy = fabLog(`⏳ <b>粘贴文本.txt</b> → ${pipe === 'calcjson' ? '计算器作业导入' : 'LLM 管线'}：处理中…`);
        if (btn) btn.disabled = true;
        (pipe === 'calcjson' ? pipeCalcJson(text, '粘贴文本.txt', fabLog) : pipeLlm(text, '粘贴文本.txt', fabLog))
          .then(r => {
            if (!r) return;
            const tx = document.getElementById('fabText');
            if (tx) tx.value = '';
            return fabConsume(r);
          })
          .finally(() => {
            if (busy && typeof busy.remove === 'function') busy.remove();
            if (btn) btn.disabled = false; // 解析结束恢复（失败/成功都恢复）
          });
        break;
      }
      case 'fab-apply':
        confirmThen('落库已确认行到正式账本？（不可自动撤销，作废需逐笔处理）', () => Api.importApply(fabState.batchId))
          .then(rst => {
            if (!rst) return;
            // B6：未知类型行不再静默丢弃——随 apply 结果显式提示（与 imp-apply 同口径）
            const skipped = rst.skipped_unsupported ? `；⚠ ${rst.skipped_unsupported} 行类型不支持未入账` : '';
            const pairs = rst.income_pairs ? `，收入对 ${rst.income_pairs}` : '';
            toast(`落库完成：作业 ${rst.jobs}，支出 ${rst.expenses}${pairs}${skipped}`);
            fabRenderRows();
            if (document.getElementById('impBatches')) loadImportBatches().catch(() => {});
          });
        break;
      case 'fab-keep':
        toast('批次已放入「待入库」——到「审核」页随时继续处理');
        fabClose(state.tab === 'review');
        break;
      case 'fab-goto-review':
        fabClose(false);
        state.tab = 'review';
        if (switchNav) switchNav('review');
        if (T && T.render) T.render().catch(() => {});
        break;
      case 'fab-goto-overview':
        fabClose(false);
        state.tab = 'overview';
        if (switchNav) switchNav('overview');
        if (T && T.render) T.render().catch(() => {});
        break;
      case 'fab-again':
        fabReset();
        fabRender();
        break;
      case 'fab-llm-review':
        // P10-R5：FAB 快捷处理内审查这批（只挑错；发现 append 进行级复核 needs_review）
        if (fabState.batchId == null) return toast('先解析一批数据', true);
        run(() => Api.llmReviewBatch(fabState.batchId)).then(d => {
          if (!d) return;
          toast(`审查完成：${d.findings.length} 条发现，${d.appended} 条已并入行级复核（带证据，逐条人工判断后落库）`);
          fabRenderRows(); // 行的复核提示出现 llm_review 项
        });
        break;
      /* ---- P10-R5：审核页 LLM 审查区（lr- 前缀；只挑错，绝不改数据） ---- */
      case 'lr-batch': {
        const bid = Number(btn.dataset.id);
        run(() => Api.llmReviewBatch(bid)).then(d => {
          if (!d) return;
          toast(`审查完成：${d.findings.length} 条发现，${d.appended} 条已并入行级复核（打开复核逐条人工判断）`);
          if (importState.batchId === bid && document.getElementById('impRowsPanel')) loadImportRows(bid);
        });
        break;
      }
      case 'lr-health':
        run(async () => {
          const d = await Api.llmReviewHealth();
          lrRenderFindings(d);
          return d;
        }).then(d => {
          if (d) toast(`全库体检完成：${d.findings.length} 条发现（扫描 ${d.scanned} 条摘要${d.dismissed ? `，已忽略 ${d.dismissed} 条` : ''}）——逐条采纳或忽略`);
        });
        break;
      case 'lr-adopt': {
        // 采纳=跳对应页编辑入口（parties→主数据、jobs→工单、bills→账单）
        const where = String(btn.dataset.where || '');
        const tab = where.startsWith('parties#') ? 'master' : where.startsWith('jobs#') ? 'jobs' : where.startsWith('bills#') ? 'bills' : '';
        if (!tab) return toast('该发现未关联可跳转的实体', true);
        state.tab = tab;
        if (switchNav) switchNav(tab);
        if (T && T.render) T.render().catch(() => {});
        break;
      }
      case 'lr-dismiss':
        run(() => Api.llmReviewDismiss(btn.dataset.key)).then(r => {
          if (!r) return;
          toast('已登记忽略（settings 键 llmreview.dismissed）');
          if (typeof btn.closest === 'function') {
            const li = btn.closest('[data-lrkey]');
            if (li && typeof li.remove === 'function') li.remove();
          }
        });
        break;
      case 'imp-keep':      case 'imp-keep':
        toast('批次保持在「待入库」，随时回来继续处理');
        break;
      case 'imp-cancel-batch':
        confirmThen('取消整个批次？所有未落库行将被拒绝，不再出现在待入库。', () => Api.llmCancelBatch(importState.batchId))
          .then(r => { if (r) { toast('批次已取消'); loadImportRows(importState.batchId); loadImportBatches(); } });
        break;
      case 'imp-open':
        importState.batchId = Number(btn.dataset.id);
        document.getElementById('impRowsPanel').style.display = '';
        loadImportRows(importState.batchId);
        break;
      case 'imp-filter':
        loadImportRows(importState.batchId, btn.dataset.st || undefined);
        break;
      case 'imp-row-confirm':
        run(() => Api.importRowPatch(Number(btn.dataset.id), { action: 'confirm' })).then(() => impRefreshRows(btn.dataset.ctx));
        break;
      case 'imp-row-reject':
        run(() => Api.importRowPatch(Number(btn.dataset.id), { action: 'reject' })).then(() => impRefreshRows(btn.dataset.ctx));
        break;
      case 'imp-row-edit': {
        // P10-R4：逐字段订正（审核页与 FAB 弹窗共用渲染器；ctx 区分两视图）
        const rid = Number(btn.dataset.id);
        if (btn.dataset.ctx === 'fab') {
          fabState.editId = fabState.editId === rid ? null : rid;
          fabRenderRows();
        } else {
          importState.editId = importState.editId === rid ? null : rid;
          if (importState.batchId != null) loadImportRows(importState.batchId);
        }
        break;
      }
      case 'imp-row-save': {
        const rid = Number(btn.dataset.id);
        const ctx = btn.dataset.ctx === 'fab' ? 'fab' : 'page';
        const rows = ctx === 'fab' ? fabState.rows : importState.rows;
        const row = rows.find(x => x.id === rid);
        if (!row) return toast('行不存在（先刷新）', true);
        const kind = (row.parsed && row.parsed.kind) || '';
        const fields = kind === 'job' ? ['name', 'village', 'team', 'date', 'receivable_cents', 'paid_cents']
          : kind === 'expense' ? ['category_raw', 'village', 'date', 'amount_cents']
          : kind === 'income_pair' ? ['name', 'date', 'income_cents']
          : ['name'];
        const patch = {};
        for (const f of fields) {
          const el = document.getElementById(`${ctx}Ed-${rid}-${f}`);
          if (!el) continue;
          if (f.endsWith('_cents')) {
            if (el.value === '') continue; // 金额留空=不改原值
            const cents = Core.yuanInputToCents(el.value);
            if (isNaN(cents)) return toast('金额非法：' + el.value, true);
            patch[f] = cents;
          } else {
            patch[f] = el.value; // 文本字段：空串=清空（允许空数据）
          }
        }
        run(() => Api.importRowPatch(rid, { parsed: patch })).then(() => {
          toast('已订正（复核提示视为已澄清）');
          if (ctx === 'fab') fabState.editId = null; else importState.editId = null;
          impRefreshRows(ctx);
        });
        break;
      }
      case 'imp-confirm-all':
        confirmThen('确认全部待复核行？（对照清单后再点）', async () => {
          const rows = await Api.importRows(importState.batchId, 'pending');
          // B0.2/N-18：证据校验未过的行服务端会拒绝确认（防批量放行幻觉金额）——
          // 逐行 try/catch 跳过，结尾汇总提示，其余行照常确认
          let done = 0, skipped = 0;
          for (const r of rows) {
            try { await Api.importRowPatch(r.id, { action: 'confirm' }); done++; }
            catch (e) { skipped++; }
          }
          if (skipped) toast(`⚠ ${skipped} 行证据校验未过被跳过（须先人工订正）`);
          return done;
        }).then(n => { if (n) { toast('已确认 ' + n + ' 行'); loadImportRows(importState.batchId); } });
        break;
      case 'imp-apply':
        confirmThen('落库已确认行到正式账本？（不可自动撤销，作废需逐笔处理）', () => Api.importApply(importState.batchId))
          .then(r => {
            if (r) {
              // B6：未知类型行不再静默丢弃——随 apply 结果显式提示
              const skipped = r.skipped_unsupported ? `；⚠ ${r.skipped_unsupported} 行类型不支持未入账` : '';
              const pairs = r.income_pairs ? `，收入对 ${r.income_pairs}` : '';
              toast(`落库完成：作业 ${r.jobs}，支出 ${r.expenses}${pairs}${skipped}`);
              loadImportRows(importState.batchId); loadImportBatches();
            }
          });
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
      // P10-R4：导入页升级「审核」页（批次复核+数据体检并入，D2 裁决）；旧值 health/import
      // 映射到 review（防御旧书签/外部跳转，不白屏不丢页）；主数据页不变
      const t = (tab === 'import' || tab === 'health') ? 'review' : tab;
      const done = t === 'review'
        ? renderReview($main)
        : renderMasterData().then(html => { $main.innerHTML = html; });
      return Promise.resolve(done).then(() => { if (T && T.applyColWidths) T.applyColWidths(); });
    },
    handleAct(btn, tools) {
      setTools(tools);
      extraHandleAct(btn, tools);
    }
  };
})();
