/* ============================================================
   js/settlement-card.js — D4 结算卡（客户分享件，纯前端，计算器端）
   工单弹窗「📤 生成结算卡」→ Canvas 竖版 3:4 渲染（视觉基准
   docs/SETTLEMENT-CARD-MOCK.html）→ toBlob 保存图片 / 系统分享。
   口径红线：客户只见圈地面积——本文件只消费 data.settlementCardData
   的白名单输出（客户/圈地/药型/单价/应收/日期/地址/单号/飞手），
   白名单之外的字段一概不取不显（守门断言见 tests）。
   二维码两版：A 单码=收款码右下主位；B 双码=账号码（次）+收款码（主），
   主从用大小+描边区分；码在 ☁️ 同步设置弹窗上传（Storage.getQr/saveQr，
   drone_spray_qr_v1 dataURL），未配置不渲染。
   分享卡是已裁例外：非数据图表，不受 echarts 铁律限制；零外链。
   ============================================================ */
(function () {
  'use strict';

  const W = 750, H = 1000;
  const C_TEAL = '#0e7c66', C_TEAL2 = '#1e9e6a', C_TEXT = '#1c2733',
    C_MUTED = '#6b7a89', C_GRAY = '#98a6b3', C_LINE = '#e5e9ee';
  const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",Arial,sans-serif';

  /** 金额短格式：整数去 .00 零头，带零头保留两位（卡面大数字） */
  function fmtYuanShort(cents) {
    if (cents == null || isNaN(cents)) return '—';
    const s = (cents / 100).toFixed(2);
    return s.endsWith('.00') ? s.slice(0, -3) : s;
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fitFont(ctx, text, basePx, maxW, weight) {
    let px = basePx;
    ctx.font = `${weight || 700} ${px}px ${FONT}`;
    while (px > 16 && ctx.measureText(text).width > maxW) {
      px -= 2;
      ctx.font = `${weight || 700} ${px}px ${FONT}`;
    }
    return px;
  }
  function ellipsize(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  /** dataURL → HTMLImageElement（坏图/空值 resolve null，调用方跳过不渲染） */
  function loadImage(dataURL) {
    return new Promise(resolve => {
      if (!dataURL) { resolve(null); return; }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataURL;
    });
  }

  /** 上传规范化：File → 读图 → 最长边 480px 内 PNG dataURL（控制 localStorage 体积） */
  async function normalizeImage(file) {
    if (!file || !/^image\//.test(file.type)) return null;
    const raw = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ''));
      fr.onerror = () => rej(new Error('读图失败'));
      fr.readAsDataURL(file);
    });
    const img = await loadImage(raw);
    if (!img) return null;
    const k = Math.min(1, 480 / Math.max(img.width, img.height));
    if (k >= 1 && raw.length < 300 * 1024) return raw;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  /** 渲染卡面（同步；二维码图先由调用方 loadImage 预载传入） */
  function renderCard(canvas, data, imgs, opts) {
    const ctx = canvas.getContext('2d');
    const o = opts || {};
    ctx.clearRect(0, 0, W, H);
    rr(ctx, 0, 0, W, H, 40);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.save();
    rr(ctx, 0, 0, W, H, 40);
    ctx.clip();

    /* ---- 头部：青绿渐变 + 品牌行 + 客户标题 + 🚁 ---- */
    const grad = ctx.createLinearGradient(0, 0, W, 176);
    grad.addColorStop(0, C_TEAL);
    grad.addColorStop(1, C_TEAL2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 176);
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = `400 25px ${FONT}`;
    ctx.fillText('无人机植保作业 · 结算单', 48, 68);
    const title = (data.customers && data.customers.length)
      ? (data.customers.length <= 2 ? data.customers.join('、') : `${data.customers[0]} 等${data.customers.length}户`)
      : '植保作业结算单';
    ctx.fillStyle = '#ffffff';
    const titlePx = fitFont(ctx, title, 46, W - 48 - 130);
    ctx.font = `700 ${titlePx}px ${FONT}`;
    ctx.fillText(title, 48, 136);
    ctx.globalAlpha = .9;
    ctx.font = `400 72px ${FONT}`;
    ctx.fillText('🚁', W - 48 - 76, 112);
    ctx.globalAlpha = 1;

    /* ---- 金额区：本次作业应收 + 大数字 + 状态戳 ---- */
    let y = 226;
    ctx.textAlign = 'center';
    ctx.fillStyle = C_MUTED;
    ctx.font = `400 27px ${FONT}`;
    ctx.fillText('本次作业应收', W / 2, y);
    ctx.textAlign = 'left';
    y = 330;
    const big = fmtYuanShort(data.amountCents);
    ctx.fillStyle = C_TEAL;
    ctx.font = `800 46px ${FONT}`;
    const curW = ctx.measureText('¥').width;
    ctx.font = `800 98px ${FONT}`;
    const numW = ctx.measureText(big).width;
    const x = W / 2 - (curW + 8 + numW) / 2;
    ctx.font = `800 46px ${FONT}`;
    ctx.fillText('¥', x, y - 48);
    ctx.font = `800 98px ${FONT}`;
    ctx.fillText(big, x + curW + 8, y);
    if (data.done) {
      ctx.textAlign = 'center';
      ctx.font = `600 23px ${FONT}`;
      const st = '✓ 作业已完成';
      const sw = ctx.measureText(st).width + 52;
      rr(ctx, W / 2 - sw / 2, 356, sw, 44, 22);
      ctx.strokeStyle = C_TEAL2;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = C_TEAL2;
      ctx.fillText(st, W / 2, 386);
      ctx.textAlign = 'left';
    }

    /* ---- mini 三格：圈地面积 / 每亩 / 药型 ---- */
    const enclosed = (data.enclosedMu != null ? data.enclosedMu
      : (o.manualEnclosedMu != null && o.manualEnclosedMu !== '' && Number(o.manualEnclosedMu) > 0)
        ? Number(o.manualEnclosedMu) : null);
    const minis = [
      { n: enclosed != null ? `${enclosed} 亩` : '—', t: '圈地面积' },
      { n: data.unitPriceYuan != null ? `¥${data.unitPriceYuan}` : '—', t: '每亩' },
      { n: data.drugType || '—', t: '药型' }
    ];
    const cellW = (W - 96 - 36) / 3;
    let cx = 48;
    const cy = 430, cellH = 100;
    for (const m of minis) {
      rr(ctx, cx, cy, cellW, cellH, 20);
      ctx.fillStyle = '#f4f6f8';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = C_TEXT;
      ctx.font = `700 33px ${FONT}`;
      ctx.fillText(ellipsize(ctx, m.n, cellW - 16), cx + cellW / 2, cy + 44);
      ctx.fillStyle = C_MUTED;
      ctx.font = `400 23px ${FONT}`;
      ctx.fillText(m.t, cx + cellW / 2, cy + 80);
      cx += cellW + 18;
    }
    ctx.textAlign = 'left';

    /* ---- 信息行：日期 / 地址 / 单号 / 飞手 ---- */
    const rows = [
      ['作业日期', data.date || '—'],
      ['地块地址', data.address || '—'],
      ['作业单号', data.jobNo || '—'],
      ['作业飞手', (data.operators && data.operators.length) ? data.operators.join('、') : '—']
    ];
    let ry = 572;
    rows.forEach(([k, v], i) => {
      ctx.fillStyle = C_MUTED;
      ctx.font = `400 28px ${FONT}`;
      ctx.fillText(k, 48, ry);
      ctx.fillStyle = C_TEXT;
      ctx.font = `600 30px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(ellipsize(ctx, v, W - 96 - 170), W - 48, ry);
      ctx.textAlign = 'left';
      if (i < rows.length - 1) {
        ctx.strokeStyle = C_LINE;
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 8]);
        ctx.beginPath();
        ctx.moveTo(48, ry + 20);
        ctx.lineTo(W - 48, ry + 20);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ry += 56;
    });

    /* ---- 页脚（有码时左移留位） ---- */
    const hasQr = !!(imgs.pay || imgs.acct);
    ctx.strokeStyle = '#eef1f4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 856);
    ctx.lineTo(W, 856);
    ctx.stroke();
    ctx.fillStyle = C_GRAY;
    ctx.font = `400 23px ${FONT}`;
    if (hasQr) {
      ctx.fillText('感谢信任 · 有疑问请联系飞手核对', 48, 896);
      ctx.fillText('spraybook 无人机记账', 48, 928);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText('感谢信任 · 有疑问请联系飞手核对', W / 2, 896);
      ctx.fillText('spraybook 无人机记账', W / 2, 928);
      ctx.textAlign = 'left';
    }

    /* ---- 二维码角（右下；主从=大小+描边） ---- */
    const drawQr = (img, size, cap, capColor, xRight) => {
      if (!img) return 0;
      const bw = size + 16;
      const by = 1000 - 26 - bw - 40;
      rr(ctx, xRight - bw, by, bw, bw, 14);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = capColor === C_TEAL ? C_TEAL2 : '#dfe7ee';
      ctx.lineWidth = capColor === C_TEAL ? 5 : 3;
      ctx.stroke();
      ctx.drawImage(img, xRight - bw + 8, by + 8, size, size);
      ctx.fillStyle = capColor;
      ctx.font = `${capColor === C_TEAL ? '700 23' : '400 22'}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(cap, xRight - bw / 2, by + bw + 30);
      ctx.textAlign = 'left';
      return bw;
    };
    let rightX = W - 36;
    if (imgs.pay) {
      drawQr(imgs.pay, 168, '微信扫码付款', C_TEAL, rightX);
      rightX -= 168 + 16 + 26;
    }
    if (imgs.acct) drawQr(imgs.acct, 136, '扫码关注', C_GRAY, rightX);

    ctx.restore();
  }

  /* ---------- 弹窗（计算器既有 modal 体系内自管；模块自有监听） ---------- */
  let current = null; // { data, imgs, canvas }

  function paint() {
    if (!current) return;
    const input = document.getElementById('cardEnclosedInput');
    renderCard(current.canvas, current.data, current.imgs, {
      manualEnclosedMu: input ? input.value : null
    });
  }

  function fileName(data) {
    return `结算卡-${data.jobNo || data.date || '作业'}.png`;
  }
  function toBlob() {
    return new Promise(resolve => {
      if (!current) { resolve(null); return; }
      current.canvas.toBlob(b => resolve(b), 'image/png');
    });
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
  async function save() {
    const blob = await toBlob();
    if (!blob) return;
    download(blob, fileName(current.data));
  }
  async function share() {
    const blob = await toBlob();
    if (!blob) return;
    const file = new File([blob], fileName(current.data), { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: current.data.jobNo || '结算单' }); }
      catch (e) { /* 用户取消分享不算错误 */ }
    } else {
      download(blob, fileName(current.data));
    }
  }

  /**
   * 入口：open(entry)——entry={ result, state, jobNo, date, address, operators }
   * result/state 取 UI._lastResult 与 UI.state；纯函数装配见 data.settlementCardData。
   */
  async function open(entry) {
    const data = window.settlementCardData(entry.result, entry.state, entry);
    const qr = window.Storage ? window.Storage.getQr() : { pay: '', acct: '' };
    const [pay, acct] = await Promise.all([loadImage(qr.pay), loadImage(qr.acct)]);
    // 填充行：无圈地快照（旧结果/全未填）时手填一次（仅进图片，不落任何存储）
    const fillRow = data.enclosedMu == null
      ? `<div class="card-fill">
           <label>圈地面积(亩) <input id="cardEnclosedInput" type="number" step="0.1" min="0" placeholder="本单未记圈地，可手填"></label>
           <span class="hint">仅进图片，不写入任何数据</span>
         </div>`
      : '';
    const wrap = document.getElementById('cardModalBody');
    if (!wrap) return;
    wrap.innerHTML = `
      ${fillRow}
      <div class="card-canvaswrap"><canvas id="cardCanvas" width="${W}" height="${H}"></canvas></div>
      <div class="btn-row" style="justify-content:center">
        <button class="btn btn-primary" data-card="save">⬇ 保存图片</button>
        <button class="btn btn-secondary" data-card="share">📤 系统分享</button>
      </div>
      <div class="hint" style="text-align:center">收款码/账号码在 ☁️ 同步设置上传；未配置不渲染。分享件只含圈地面积口径。</div>`;
    current = {
      data,
      imgs: { pay, acct },
      canvas: document.getElementById('cardCanvas')
    };
    wrap.onclick = e => {
      const b = e.target.closest('[data-card]');
      if (!b) return;
      if (b.dataset.card === 'save') save();
      else if (b.dataset.card === 'share') share();
    };
    const input = document.getElementById('cardEnclosedInput');
    if (input) input.addEventListener('input', paint);
    paint();
  }

  function resetBody() {
    const wrap = document.getElementById('cardModalBody');
    if (wrap) { wrap.innerHTML = ''; wrap.onclick = null; }
    current = null;
  }

  window.CalcSettlementCard = { open, resetBody, renderCard, fmtYuanShort, normalizeImage, loadImage };
})();
