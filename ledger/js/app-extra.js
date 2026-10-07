/* ============================================================
   ledger/js/app-extra.js — 导入（M8）+ 主数据（M7）页签
   P2-4 从 app.js 拆出：共享工具经 init(tools) 注入，勿在此重复实现。
   ============================================================ */
(function () {
  'use strict';
  let T = null;
  let run, toast, confirmThen, needAmount, collectInputs, esc, tag, actions, Core, Api, state, switchNav;
  const importState = { batchId: null, rows: [] };
  // P9-R2：数据体检缓存（主数据「疑似重复」区与「体检」页共用）+ 合并预览弹窗状态
  let mdHealth = null;            // GET /api/data-health 的最近一次结果
  let mdMergeGroup = null;        // 弹窗当前展示的重复组（suspect_dupes 元素）
  let mdMergeReturnTab = 'master'; // 打开弹窗时的页签（确认/取消后回到哪页）

  // P9-R3：默认日期=本地墙钟今天（不用 toISOString——UTC 会在凌晨误退一天，E1 教训）
  function localToday() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function renderImport() {
    // P9-R4（D1 裁决）：统一收件箱置顶——拖拽/点选文件/Ctrl+V 粘贴，按扩展名分派
    // （分派口径在 core.pickPipeline 纯函数）；默认日期选择器也搬到收件箱（LLM 管线
    // 两入口共用同一 #llmDate，旧 llm-parse 读同一 id 不改逻辑）。
    // 旧三面板收进「手动选择管线」折叠区，全部 id/data-act 原样保留（老习惯零回归）。
    return `<div class="lg-panel" id="impInbox">
      <h2>📥 导入收件箱（拖文件 / 点选文件 / 粘贴文本，按类型自动分派）</h2>
      <label id="impDrop" class="imp-drop" for="impInboxFile" title="点击选择文件，或把文件拖进虚线框">
        <input type="file" id="impInboxFile" multiple accept=".xlsx,.json,.txt,.md" hidden>
        <b>把文件拖到这里，或点击选择文件</b><br>
        <span>.xlsx 月度记账表 → Excel 复核管线 · .json 作业包 → 计算器导入 · .txt / .md → 本机 LLM 文本管线</span>
      </label>
      <textarea id="inboxText" rows="3" placeholder="也可把记账文本或计算器作业包 JSON 粘到这里（Ctrl+V 自动分派；图片/语音识别即将支持）" style="width:100%;font-size:13px"></textarea>
      <div class="lg-form" style="margin-top:8px">
        <button class="lg-btn primary" data-act="imp-inbox-send">送入管线</button>
        <button class="lg-btn" data-act="imp-photo" aria-disabled="true" title="多模态模型下轮上线">📷 拍照识别 · 即将支持</button>
        <button class="lg-btn" data-act="imp-voice" aria-disabled="true" title="多模态模型下轮上线">🎙 语音记账 · 即将支持</button>
        <label>默认日期（LLM 管线无日期条目按此记，仍进需复核可改）<input type="date" id="llmDate" value="${localToday()}"></label>
      </div>
      <div id="inboxResult"></div>
    </div>
    <details class="lg-details">
      <summary>手动选择管线（旧入口：粘贴作业包 JSON / 上传 Excel / 粘贴文本给 LLM）</summary>
      <div class="lg-panel">
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
        <h2>🤖 粘贴文本（本地 LLM 整理；Ollama 全程本机运行）</h2>
        <textarea id="llmText" rows="5" placeholder="把杂乱记账记录粘进来，一行一条，例如：&#10;3月12日 李洪富 金桂村 打药 12亩 25元/亩 应收300 收300&#10;3.12 油钱200 加油站&#10;4月 收入540 不知道谁的" style="width:100%;font-size:13px"></textarea>
        <div class="lg-form" style="margin-top:8px">
          <button class="lg-btn primary" data-act="llm-parse" id="llmParseBtn">解析并预览</button>
          <span class="hint" id="llmStatus" style="color:var(--muted);font-size:12px">检查本机 LLM…</span>
        </div>
        <div class="hint" style="color:var(--muted);font-size:12px;margin-top:4px">硬约束：金额必须能在原文定位（防幻觉）、派生金额由代码算、拿不准自动进需复核；解析后进「待入库」，逐行确认后才落账；长文本自动分块（>500 行请分天导入）。默认日期在上方收件箱设置（两个入口共用）。</div>
      </div>
    </details>
    <div class="lg-panel">
      <h2>批次</h2>
      <table class="lg-table" data-colw="import-batches"><thead><tr><th>批次</th><th>文件</th><th>来源</th><th>状态</th><th>导入时间</th><th>操作</th></tr></thead>
      <tbody id="impBatches"><tr><td colspan="6">加载中…</td></tr></tbody></table>
    </div>
    <div class="lg-panel" id="impRowsPanel" style="display:none">
      <h2>行级复核（确认后才能落库；建议对照纸表/原 Excel/原文消息）</h2>
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
    </div>`;
  }

  async function loadImportBatches() {
    const batches = await Api.importBatches();
    const tb = document.getElementById('impBatches');
    const srcTag = (t) => t === 'llm' ? tag('LLM 文本') : t === 'excel' ? tag('Excel') : tag(t || '—');
    tb.innerHTML = batches.map(b => `<tr>
      <td>#${b.id}</td><td>${esc(b.filename)}</td><td>${srcTag(b.source_type)}</td>
      <td>${b.status === 'applied' ? tag('已落库') : b.status === 'reviewing' ? tag('待入库', 'warn') : b.status === 'rejected' ? tag('已取消', 'err') : tag(b.status)}</td>
      <td>${(b.imported_at || '').slice(0, 16).replace('T', ' ')}</td>
      <td><button class="lg-btn" data-act="imp-open" data-id="${b.id}">打开复核</button></td>
    </tr>`).join('') || '<tr><td colspan="6">暂无批次</td></tr>';
    if (batches.length && !importState.batchId) {
      importState.batchId = batches[0].id;
      await loadImportRows(batches[0].id);
    }
  }

  async function loadLlmStatus() {
    const el = document.getElementById('llmStatus');
    if (!el) return;
    try {
      const st = await Api.llmStatus();
      const btn = document.getElementById('llmParseBtn');
      if (st.ollama_ok) {
        el.textContent = `本机 LLM 就绪（${st.model}）`;
      } else {
        el.textContent = `本机 LLM 未就绪：${st.hint || st.error}`;
        el.style.color = 'var(--err, #c62828)';
        if (btn) btn.disabled = true;
      }
    } catch (err) {
      el.textContent = 'LLM 状态检查失败（服务端较旧？）';
    }
  }

  async function loadImportRows(batchId, status) {
    importState.batchId = batchId;
    document.getElementById('impRowsPanel').style.display = '';
    importState.rows = await Api.importRows(batchId, status);
    const rows = importState.rows.map(r => {
      const p = r.parsed || {};
      const isJob = p.kind === 'job';
      const isPair = p.kind === 'income_pair';
      const kindText = isJob ? '作业' : p.kind === 'expense' ? '支出' : isPair ? '收入对' : p.kind === 'note' ? '备注' : (p.kind || '—');
      const pp = p.parsed || {};
      return `<tr>
        <td>${esc(r.sheet_name)} / ${r.row_no}</td>
        <td>${kindText}</td>
        <td>${esc(pp.name || pp.category_raw || (isPair ? '（无姓名）' : '—'))}</td>
        <td>${esc(pp.village || '')}${pp.team ? '/' + esc(pp.team) + '队' : ''}</td>
        <td>${esc(pp.date || '—')}</td>
        <td class="num">${isJob ? Core.fmtYuan(pp.receivable_cents) : '—'}</td>
        <td class="num">${isJob ? Core.fmtYuan(pp.paid_cents) : isPair ? Core.fmtYuan(pp.income_cents) : Core.fmtYuan(pp.amount_cents)}</td>
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

  /* ---------- P9-R4：导入收件箱（拖拽/点选/Ctrl+V → 按扩展名分派三条既有管线） ----------
     分派口径是 core.pickPipeline / pickPipelineForText 纯函数；三条管线各自复用旧入口的
     端点与复核流（excel→POST /api/import/parse+批次表/行级复核，calcjson→core.
     calculatorJobPayload 校验+POST /api/jobs 幂等，llm→POST /api/llm/parse 带 #llmDate）。
     反馈沿用 E2 持久提示方案：结果写在 inboxRun 的 T.render()（重绘）之后，才不会被抹掉；
     失败时 toast + 收件箱反馈区持久留痕，粘贴/输入的内容保留可改。 */
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
  function inboxAppend(html) {
    const box = document.getElementById('inboxResult');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'lg-detail';
    div.innerHTML = html;
    box.appendChild(div);
    return div;
  }
  function inboxBusyLine(html) {
    return inboxAppend('⏳ ' + html) || { remove() {} };
  }

  /** Excel 复核管线（与 imp-upload 同一端点 base64→/api/import/parse 与同一复核流；
      差异仅在反馈写收件箱区，且在重绘后展开行级复核——render 会重置面板显隐） */
  async function inboxExcel(f, busy) {
    let d;
    try {
      const b64 = await fileToB64(f);
      d = await Api.importParse(f.name, b64);
    } catch (e) {
      if (busy) busy.remove();
      toast(e.message, true);
      inboxAppend(`✗ <b>${esc(f.name)}</b> → Excel 复核管线：${esc(e.message)}`);
      return false;
    }
    importState.batchId = d.batch_id;
    toast('解析完成，请复核');
    await T.render(); // 批次表随重绘刷新；行级复核须在重绘后加载才可见（E2）
    await loadImportRows(d.batch_id);
    if (busy) busy.remove();
    inboxAppend(`✓ <b>${esc(f.name)}</b> → Excel 复核管线：批次 #${d.batch_id}——作业 ${d.stats.jobs} / 支出 ${d.stats.expenses} / 跳过 ${d.stats.skipped} / <b>需复核 ${d.review_count}</b>。原始列合计：应收 ${Core.fmtYuan(Math.round(d.raw_totals.receivable * 100))} · 实收 ${Core.fmtYuan(Math.round(d.raw_totals.paid * 100))} · 支出 ${Core.fmtYuan(Math.round(d.raw_totals.expense * 100))}——请在下方逐行复核后落库`);
    return true;
  }

  /** 计算器作业导入（与 imp-calc-json 同一校验 core.calculatorJobPayload 与同一幂等端点
      POST /api/jobs；duplicated 分支与旧入口同文案） */
  async function inboxCalcJson(text, label, busy) {
    const parsed = Core.calculatorJobPayload(text, new Date().toISOString().slice(0, 10));
    if (!parsed.ok) {
      if (busy) busy.remove();
      toast(parsed.error, true);
      inboxAppend(`✗ <b>${esc(label)}</b> → 计算器作业导入：${esc(parsed.error)}`);
      return false;
    }
    let d;
    try { d = await Api.createJob(parsed.payload); }
    catch (e) {
      if (busy) busy.remove();
      toast(e.message, true);
      inboxAppend(`✗ <b>${esc(label)}</b> → 计算器作业导入：${esc(e.message)}`);
      return false;
    }
    toast(d.duplicated ? '该单此前已导入（幂等），未重复建单' : '作业包已导入');
    await T.render();
    if (busy) busy.remove();
    inboxAppend(d.duplicated
      ? `ℹ <b>${esc(label)}</b> → 计算器作业导入：该单此前已导入（单号 ${esc(d.job_no)}），幂等返回原单，未重复建单。`
      : `✓ <b>${esc(label)}</b> → 计算器作业导入：单号 ${esc(d.job_no)}——可在「总表」查看并走结算收款。`);
    return true;
  }

  /** LLM 文本管线（与 llm-parse 同一端点 POST /api/llm/parse，default_date 取收件箱
      #llmDate；成功后同样展开行级复核） */
  async function inboxLlm(text, label, busy) {
    const dateEl = document.getElementById('llmDate');
    const default_date = dateEl && dateEl.value ? dateEl.value : undefined;
    let d;
    try { d = await Api.llmParse({ text, filename: label, default_date }); }
    catch (e) {
      if (busy) busy.remove();
      toast(e.message, true);
      inboxAppend(`✗ <b>${esc(label)}</b> → LLM 管线：${esc(e.message)}`);
      return false;
    }
    toast('解析完成，请逐行复核后落库');
    await T.render();
    await loadImportRows(d.batch_id);
    if (busy) busy.remove();
    inboxAppend(`✓ <b>${esc(label)}</b> → LLM 管线：批次 #${d.batch_id}（模型 ${esc(d.model)}${d.chunks > 1 ? `，分 ${d.chunks} 块` : ''}）共 ${d.stats.rows} 行，无疑问 ${d.stats.ok}，<b>需复核 ${d.review_count}</b>——有疑虑的行逐条改字段或驳回；确认后点「确认并落库」。`);
    return true;
  }

  /** 单文件分派：扩展名 → 管线；未识别给可读提示（不猜内容，D1 裁决）。
      p9-r4 评审#2：fileToText 等管线调用之前的失败（FileReader onerror）也曾把
      「⏳ 处理中」busy 行永久滞留并中断多文件循环——整段包 try/catch/finally：
      任何异常都 toast+收件箱持久提示、busy 行必清（finally 与管线内部的
      busy.remove 幂等叠加，remove 在已分离节点上是 no-op）。 */
  async function inboxOneFile(f) {
    const pipe = Core.pickPipeline(f.name);
    if (!pipe) {
      toast('未识别的文件类型：' + f.name, true);
      inboxAppend(`✗ <b>${esc(f.name)}</b>：未识别的文件类型——收件箱支持 <b>.xlsx</b>（月度记账表）/ <b>.json</b>（计算器作业包）/ <b>.txt .md</b>（记账文本）；图片/语音识别即将支持，可先转成文本粘贴`);
      return;
    }
    const busy = inboxBusyLine(`<b>${esc(f.name)}</b> → ${pipe === 'excel' ? 'Excel 复核管线' : pipe === 'calcjson' ? '计算器作业导入' : 'LLM 管线'}：处理中…`);
    try {
      if (pipe === 'excel') return await inboxExcel(f, busy);
      const text = await fileToText(f);
      if (pipe === 'calcjson') return await inboxCalcJson(text, f.name, busy);
      return await inboxLlm(text, f.name, busy);
    } catch (e) {
      toast(e.message, true);
      inboxAppend(`✗ <b>${esc(f.name)}</b>：${esc(e.message)}`);
    } finally {
      busy.remove();
    }
  }

  /** 多文件按序处理（拖拽可多选；结果逐行追加进收件箱反馈区）。
      p9-r4 评审#2：逐文件 try 兜底——单文件意外异常不再中断循环，后续文件继续。 */
  async function inboxHandleFiles(fileList) {
    const list = [...(fileList || [])];
    if (!list.length) return;
    for (const f of list) {
      try { await inboxOneFile(f); }
      catch (e) { toast(e.message, true); inboxAppend(`✗ <b>${esc(f.name)}</b>：${esc(e.message)}`); }
    }
  }

  /** 粘贴框内容分派（Ctrl+V 自动触发 + 「送入管线」按钮共用；失败时内容保留可改） */
  function inboxDispatchText(text, label) {
    const pipe = Core.pickPipelineForText(text);
    if (!pipe) return toast('先粘贴内容：记账文本，或计算器导出的作业包 JSON', true);
    const busy = inboxBusyLine(`<b>${esc(label)}</b> → ${pipe === 'calcjson' ? '计算器作业导入' : 'LLM 管线'}：处理中…`);
    if (pipe === 'calcjson') return inboxCalcJson(text, label, busy);
    return inboxLlm(text, label, busy);
  }

  /* 收件箱事件绑定：委托在 #lgMain 上（重绘不丢）；测试桩无 addEventListener 时跳过。
     dragover/drop 只对带 Files 的拖拽接管（防浏览器直接打开文件/误拖整页跳走），
     文本拖拽不接、交给浏览器默认行为。 */
  (function bindInbox() {
    const $m = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('lgMain') : null;
    if (!$m || typeof $m.addEventListener !== 'function') return;
    const hasFiles = dt => !!(dt && dt.types && [...dt.types].includes('Files'));
    $m.addEventListener('change', e => {
      if (!e.target || e.target.id !== 'impInboxFile') return;
      inboxHandleFiles(e.target.files).catch(err => toast(err.message, true));
      e.target.value = ''; // 允许下次再选同一文件
    });
    $m.addEventListener('paste', e => {
      if (!e.target || e.target.id !== 'inboxText') return;
      const cd = e.clipboardData;
      if (!cd) return;
      if (hasFiles(cd)) {
        e.preventDefault();
        const files = [...cd.files];
        const img = files.find(f => /^image\//.test(f.type));
        if (img) {
          toast('📷 拍照识别即将支持（多模态模型下轮上线），请先用文本粘贴记账');
          inboxAppend(`ℹ 收到粘贴的图片「${esc(img.name || '截图')}」——拍照识别即将支持，请先把内容转成文本粘贴`);
        }
        const rest = files.filter(f => !/^image\//.test(f.type));
        if (rest.length) inboxHandleFiles(rest).catch(err => toast(err.message, true));
        return;
      }
      const text = cd.getData ? cd.getData('text/plain') : '';
      // 不 preventDefault：文本照常落框，分派失败时内容保留可改（成功后重绘自然清空）
      if (text && text.trim()) inboxDispatchText(text, '粘贴文本.txt');
    });
    $m.addEventListener('dragover', e => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault(); // 允许 drop；同时防浏览器默认打开文件
      const z = e.target && e.target.closest ? e.target.closest('#impDrop') : null;
      if (z) { e.dataTransfer.dropEffect = 'copy'; z.classList.add('dragover'); }
      else e.dataTransfer.dropEffect = 'none';
    });
    $m.addEventListener('drop', e => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const z = e.target && e.target.closest ? e.target.closest('#impDrop') : null;
      if (z) z.classList.remove('dragover');
      if (!z) return toast('请把文件拖到「导入收件箱」的虚线框里', true);
      inboxHandleFiles(e.dataTransfer.files).catch(err => toast(err.message, true));
    });
    $m.addEventListener('dragleave', e => {
      const z = e.target && e.target.closest ? e.target.closest('#impDrop') : null;
      if (z) z.classList.remove('dragover');
    });
  })();


  /* ---------- 主数据（客户行内直填 + 新增客户 + 地块档案） ---------- */
  let mdEditId = null;      // 行内编辑中的客户 id
  let mdPlotEditId = null;  // 行内编辑中的地块 id
  let mdShowDeleted = false; // E8：显示已停用客户（软删）与恢复入口

  async function renderMasterData() {
    let parties = [];
    try { parties = await Api.parties(); } catch (err) { parties = []; }
    const settings = await Api.settings().catch(() => ({}));
    const bootstrap = await Api.get('/api/bootstrap').catch(() => null);
    const balMap = new Map((bootstrap ? bootstrap.parties : []).map(p => [p.id, p]));
    // P9-R2：疑似重复组（拉不到就不显示该区，不影响主数据页其余功能）
    mdHealth = await Api.dataHealth().catch(() => null);
    // E8：已停用（软删）客户——默认隐藏，勾选后置灰展示并提供「恢复」
    let deletedRows = '';
    if (mdShowDeleted) {
      let all = [];
      try { all = await Api.masterList('parties'); } catch (e) { all = []; }
      deletedRows = all.filter(p => p.deleted_at && p.type === 'customer').map(p0 => `<tr class="lg-detail">
        <td>${esc(p0.name)}（已停用）</td>
        <td>${esc(p0.region || '—')}</td>
        <td>${esc(p0.village || '—')}${p0.team ? '/' + esc(p0.team) + '队' : ''}</td>
        <td>${esc(p0.phone || '—')}</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td>—</td>
        <td><button class="lg-btn primary" data-act="md-restore" data-id="${p0.id}" data-name="${esc(p0.name)}">恢复</button></td>
      </tr>`).join('');
    }
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
    return `${dupePanel}<div class="lg-panel">
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
      <h2>客户（点「编辑」行内直填，回车或点保存生效）
        <label style="font-size:13px;font-weight:normal;margin-left:12px"><input type="checkbox" data-act="md-show-deleted" ${mdShowDeleted ? 'checked' : ''}> 显示已停用客户</label>
      </h2>
      <table class="lg-table" data-colw="master-parties"><thead><tr>
        <th>姓名</th><th>区域</th><th>村/队</th><th>电话</th><th>默认单价</th><th>欠款(元)</th><th>预收(元)</th><th>最近作业</th><th>操作</th>
      </tr></thead><tbody>${custRows}${deletedRows}</tbody></table>
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
    </div>${mdMergeModalHtml()}`;
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
    // 保留字段选择：每字段选一档的值覆盖存续档（默认=第一档）
    const KEEP_UI = [['village', '村'], ['team', '队'], ['region', '区域'], ['phone', '电话']];
    const keepRows = KEEP_UI.map(([f, label]) => {
      const seen = new Set();
      const opts = m.map(x => ({ id: x.id, v: String(x[f] == null ? '' : x[f]) }))
        .filter(o => { const k = o.id + '\u0000' + o.v; if (seen.has(k)) return false; seen.add(k); return true; })
        .map(o => `<option value="${esc(o.v)}">#${o.id}：${o.v === '' ? '（空）' : esc(o.v)}</option>`).join('');
      return `<tr><td><b>保留·${label}</b></td><td colspan="${m.length}"><select data-mkeep="${f}" title="该字段以所选档案的值覆盖存续档">${opts}</select></td></tr>`;
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
    mdHealth = await Api.dataHealth().catch(() => null);
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
      <h2>数据体检（同名 / 村异写 / region 未填 / 空电话 / 金额离群；忽略=登记不显示）</h2>
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
      <h2>region 未填 · ${cnt(mdHealth.region_missing)} 户</h2>
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
      /* ---- P9-R2：合并预览弹窗（md- 前缀复用既有委托通道） ---- */
      case 'md-merge-open': {
        mdMergeReturnTab = state.tab; // 主数据页或体检页打开都回原页
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
        box.querySelectorAll('select[data-mkeep]').forEach(sel => { keep[sel.dataset.mkeep] = sel.value; });
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
      case 'imp-inbox-send': {
        const text = (document.getElementById('inboxText') || {}).value || '';
        inboxDispatchText(text, '粘贴文本.txt');
        break;
      }
      case 'imp-photo':
        toast('📷 拍照识别即将支持（多模态模型下轮上线）——现在请把内容用文本粘贴进收件箱');
        break;
      case 'imp-voice':
        toast('🎙 语音记账即将支持（多模态模型下轮上线）——现在请把内容用文本粘贴进收件箱');
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
        // E2（P7-R4）：结果写在 run()（含尾部 render）完成之后——否则内联提示
        // 会被重绘抹掉；幂等返回给"该单此前已导入"的独立文案，与首导可区分。
        run(async () => Api.createJob(parsed.payload)).then(d => {
          if (!d) return; // 失败：run 已 toast
          document.getElementById('calcJobJson').value = '';
          const box = document.getElementById('calcJobResult');
          if (d.duplicated) {
            if (box) box.innerHTML = `<div class="lg-detail">ℹ 该单此前已导入（单号 ${esc(d.job_no)}），幂等返回原单，未重复建单。</div>`;
            toast('该单此前已导入（幂等），未重复建单');
          } else {
            if (box) box.innerHTML = `<div class="lg-detail">✓ 已导入：单号 ${esc(d.job_no)}——可在「总表」查看并走结算收款。</div>`;
          }
        });
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
      case 'llm-parse': {
        const text = (document.getElementById('llmText') || {}).value || '';
        if (text.trim().length < 5) return toast('先把记账记录粘进文本框', true);
        // P9-R4：按钮 loading + 分批预估文案（Core.estimateLlmChunks 与服务端 llmChunk
        // 同口径近似；逐批进度条=异步任务化，进 backlog）。成功路径按钮随重绘重建，
        // 失败路径（无重绘）在 settle 里恢复并重查 LLM 状态。
        const est = Core.estimateLlmChunks(text);
        const btn = document.getElementById('llmParseBtn');
        const st = document.getElementById('llmStatus');
        if (btn) btn.disabled = true;
        if (st) st.textContent = '解析中…' + (est > 1 ? `文本较长将分批处理（约 ${est} 批），请勿关闭页面` : '请稍候');
        // P9-R3：默认日期随解析请求透传（无日期条目按它记，服务端标 date_default 进复核；
        // P9-R4 起 #llmDate 搬进收件箱，旧入口读同一 id）
        const dateEl = document.getElementById('llmDate');
        const default_date = dateEl && dateEl.value ? dateEl.value : undefined;
        run(async () => {
          const d = await Api.llmParse({ text, filename: '粘贴文本.txt', default_date });
          document.getElementById('llmText').value = '';
          await loadImportBatches();
          await loadImportRows(d.batch_id);
          return d;
        }, '解析完成，请逐行复核后落库').then(d => {
          if (d) {
            document.getElementById('impStats') && (document.getElementById('impStats').innerHTML =
              `<div class="lg-detail">LLM 批次 #${d.batch_id}（模型 ${d.model}${d.chunks > 1 ? `，分 ${d.chunks} 块` : ''}）：共 ${d.stats.rows} 行，无疑问 ${d.stats.ok}，<b>需复核 ${d.review_count}</b>。有疑虑的行逐条改字段或驳回；确认后点「确认并落库」。</div>`);
          }
        }).then(() => {
          const b = document.getElementById('llmParseBtn');
          if (b && b.isConnected) { b.disabled = false; loadLlmStatus(); }
        });
        break;
      }
      case 'imp-keep':
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
      const done = tab === 'import'
        ? ($main.innerHTML = renderImport(), loadImportBatches(), loadLlmStatus())
        : tab === 'health'
          ? renderHealth().then(html => { $main.innerHTML = html; }) // P9-R2 数据体检
          : renderMasterData().then(html => { $main.innerHTML = html; });
      return Promise.resolve(done).then(() => { if (T && T.applyColWidths) T.applyColWidths(); });
    },
    handleAct(btn, tools) {
      setTools(tools);
      extraHandleAct(btn, tools);
    }
  };
})();
