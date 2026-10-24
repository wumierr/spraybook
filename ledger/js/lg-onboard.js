/* ============================================================
   ledger/js/lg-onboard.js — B3 首次引导遮罩（三步半透明层）
   localStorage lg-onboarded-v1 一次性（看完/跳过都标记，不再打扰）；
   主数据页「设置」区 data-act="onboard-replay" 可随时重看（app.js 转发）。
   纯结构版：文字步骤卡 + 上一步/下一步/跳过；视觉打磨=批4 flash。
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'lg-onboarded-v1';
  const STEPS = [
    { icon: '🛩️', title: '记录工单', text: '计算器完成作业后点「同步到账本」自动上报；纸质/微信记账用右下角 📥 导入（LLM 文本 / 作业包 / Excel），杂乱文字也能整理。' },
    { icon: '🧾', title: '生成结算并确认', text: '工单页对已完成作业点「生成结算」，核对分项后确认——自动记账并生成客户账单。' },
    { icon: '💰', title: '收款核销', text: '账单页点「登记收款」（挂单笔），或收款页按客户收款（一笔钱自动核销最早的未清账单，多收转预收）。每笔都过账，月底对账一键 reconcile。' }
  ];

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 隐私模式丢弃 */ } }

  let idx = 0;
  let mask = null;

  function stepHtml(i) {
    const s = STEPS[i];
    const dots = STEPS.map((_, j) => `<span class="lg-onboard-dot ${j === i ? 'cur' : (j < i ? 'done' : '')}"></span>`).join('');
    return `<div class="lg-onboard-card">
      <div class="lg-onboard-icon">${s.icon}</div>
      <h2>第 ${i + 1}/${STEPS.length} 步 · ${s.title}</h2>
      <p>${s.text}</p>
      <div class="lg-onboard-dots">${dots}</div>
      <div class="lg-onboard-actions">
        <button class="lg-btn" id="lgOnboardSkip">跳过</button>
        ${i > 0 ? '<button class="lg-btn" id="lgOnboardPrev">上一步</button>' : ''}
        <button class="lg-btn primary" id="lgOnboardNext">${i === STEPS.length - 1 ? '开始使用' : '下一步'}</button>
      </div>
    </div>`;
  }

  function renderStep() {
    if (!mask) return;
    mask.innerHTML = stepHtml(idx);
    const next = document.getElementById('lgOnboardNext');
    const prev = document.getElementById('lgOnboardPrev');
    const skip = document.getElementById('lgOnboardSkip');
    if (next) next.addEventListener('click', () => {
      if (idx < STEPS.length - 1) { idx++; renderStep(); }
      else close();
    });
    if (prev) prev.addEventListener('click', () => { if (idx > 0) { idx--; renderStep(); } });
    if (skip) skip.addEventListener('click', close);
  }

  function close() {
    lsSet(KEY, '1');
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    mask = null;
  }

  function show() {
    if (mask) return; // 已在显示
    idx = 0;
    mask = document.createElement('div');
    mask.id = 'lgOnboardMask';
    mask.className = 'lg-onboard-mask';
    document.body.appendChild(mask);
    renderStep();
  }

  /** 启动钩子：首次（无标记）才自动弹 */
  function maybeShow() {
    if (!lsGet(KEY)) show();
  }

  if (typeof window !== 'undefined') window.LedgerOnboard = { maybeShow, show };
})();
