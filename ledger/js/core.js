/* ============================================================
   ledger/js/core.js — 纯函数层（数据变换与格式化，node:test 可测）
   渲染层 app.js 只做 DOM；本文件不碰 DOM / fetch。
   ============================================================ */
(function () {
  'use strict';

  /** 分 → 元字符串（两位小数；负数用于抹零） */
  function fmtYuan(cents) {
    if (cents == null || isNaN(cents)) return '—';
    const yuan = cents / 100;
    return yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** 元输入框值 → 分（Math.round(×100)）；空返回 null；非法返回 NaN */
  function yuanInputToCents(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return NaN;
    return Math.round(n * 100);
  }

  const JOB_STATUS = {
    draft: '草稿', completed: '待结算', settled: '已结算', reopened: '已重开', void: '已作废'
  };
  const SETTLEMENT_STATUS = { draft: '待确认', confirmed: '已确认', void: '已作废' };
  const BILL_STATUS = { unpaid: '未收', partial: '部分收款', paid: '已收清', void: '已作废' };
  const PAYMENT_CATEGORY = {
    fuel: '油费', chemical: '药费', repair: '维修', meal: '吃饭',
    equipment: '设备', labor: '人工', other: '其他'
  };
  const ADVANCE_DIRECTION = { prepaid_by_customer: '客户预收', advance_to_worker: '员工预支' };
  const METHOD = { cash: '现金', wechat: '微信', alipay: '支付宝', bank: '银行', other: '其他' };
  const PARTY_TYPE = { customer: '客户', employee: '员工', partner: '合作方', supplier: '供应商' };

  function statusLabel(map, status) { return map[status] || status || '—'; }

  /** 账单应收 = 金额 + 调整（adjust 负数=抹零/优惠） */
  function billPayable(bill) { return (bill.amount_cents || 0) + (bill.adjust_cents || 0); }
  /** 账单未收余额 */
  function billUnpaid(bill) { return billPayable(bill) - (bill.paid_cents || 0); }

  /** 作业行摘要（列表用） */
  function jobRow(job) {
    return {
      id: job.id, job_no: job.job_no, job_date: (job.job_date || '').slice(0, 10),
      type: job.job_type === 'haul' ? '吊运' : '打药', status: job.status,
      statusText: statusLabel(JOB_STATUS, job.status),
      primary: job.job_type === 'haul'
        ? (job.weight_jin != null ? job.weight_jin + ' 斤' : '—')
        : (job.total_area_mu != null ? job.total_area_mu + ' 亩' : '—'),
      incomeYuan: fmtYuan(job.income_cents),
      canSettle: job.status === 'completed' || job.status === 'reopened',
      canVoid: job.status === 'completed' || job.status === 'draft',
      canEditLines: job.status === 'completed' || job.status === 'reopened'
    };
  }

  /** 结算行摘要 */
  function settlementRow(s) {
    return {
      id: s.id, settlement_no: s.settlement_no, job_no: s.job_no, job_date: (s.job_date || '').slice(0, 10),
      status: s.status, statusText: statusLabel(SETTLEMENT_STATUS, s.status),
      sprayYuan: fmtYuan(s.total_spray_fee_cents), pesticideYuan: fmtYuan(s.total_pesticide_fee_cents),
      totalYuan: fmtYuan(s.total_receivable_cents), paidYuan: fmtYuan(s.paid_cents),
      canEdit: s.status === 'draft', canConfirm: s.status === 'draft',
      canReopen: s.status === 'confirmed', canVoid: s.status !== 'void'
    };
  }

  /** 账单行摘要 */
  function billRow(b) {
    return {
      id: b.id, bill_no: b.bill_no, party_id: b.party_id, party: b.party_name || b.farmer_name,
      status: b.status, statusText: statusLabel(BILL_STATUS, b.status),
      amountYuan: fmtYuan(b.amount_cents), adjustYuan: fmtYuan(b.adjust_cents),
      payableYuan: fmtYuan(billPayable(b)), paidYuan: fmtYuan(b.paid_cents),
      unpaidCents: billUnpaid(b), unpaidYuan: fmtYuan(billUnpaid(b)),
      canReceive: b.status === 'unpaid' || b.status === 'partial',
      canEdit: (b.status === 'unpaid') && (b.paid_cents || 0) === 0
    };
  }

  /** 总表行（P4-M1）：/api/overview 聚合行 → 列表显示行（纯函数，node:test 可测）
      金额列保留分值由渲染层求和；此处只做展示派生（日期/地址/状态/编辑权界） */
  function overviewRow(r) {
    let ops = [];
    try { ops = typeof r.operator_names === 'string' ? JSON.parse(r.operator_names || '[]') : (r.operator_names || []); }
    catch (e) { ops = []; }
    const addr = [r.village || '', r.team ? r.team + '队' : ''].filter(Boolean).join('·') || '—';
    const billStatuses = String(r.bill_statuses || '').split(',').filter(Boolean);
    const billCount = r.bill_count || 0;
    const billStatus = billStatuses[0] || null;
    return {
      id: r.id, job_no: r.job_no, job_date: (r.job_date || '').slice(0, 10),
      status: r.job_status, statusText: statusLabel(JOB_STATUS, r.job_status),
      source: r.source || '',
      customer_names: r.customer_names || '',
      region: r.region || '', addr,
      areaMu: r.total_area_mu != null ? r.total_area_mu : null,
      unitPriceYuan: fmtYuan(r.unit_price_cents),
      plantLabel: r.plant_label || '',
      extraCents: r.extra_cents || 0,
      referral: r.referral_name || '',
      operators: ops,
      collector: r.collector_name || '',
      note: r.note || '',
      billCount, billStatuses,
      billId: r.bill_id || null, billPartyId: r.bill_party_id || null,
      billAdjust: r.bill_adjust != null ? r.bill_adjust : 0,
      billNote: r.bill_note || '',
      // 编辑权界与账单页 billRow.canEdit 同口径：单账单 + 未收 + 零收款
      canEditBill: billCount === 1 && billStatus === 'unpaid' && (r.paid_cents || 0) === 0,
      canReceive: billCount === 1 && (billStatus === 'unpaid' || billStatus === 'partial')
    };
  }

  /** 流水行：借贷分列与平衡标记 */
  function journalRow(e) {
    const debit = e.lines.filter(l => l.direction === 'debit');
    const credit = e.lines.filter(l => l.direction === 'credit');
    const d = debit.reduce((a, l) => a + l.amount_cents, 0);
    const c = credit.reduce((a, l) => a + l.amount_cents, 0);
    return {
      id: e.id, entry_no: e.entry_no, event: e.event_type, memo: e.memo || '',
      occurred: (e.occurred_at || '').slice(0, 10),
      debit: debit.map(l => ({ text: l.account_code + ' ' + l.account_name, yuan: fmtYuan(l.amount_cents) })),
      credit: credit.map(l => ({ text: l.account_code + ' ' + l.account_name, yuan: fmtYuan(l.amount_cents) })),
      balanced: d === c, totalYuan: fmtYuan(d)
    };
  }

  /** 从行集合派生月份集合（'YYYY-MM'，倒序） */
  function monthKeys(rows, field) {
    const set = new Set();
    for (const r of rows || []) {
      const d = String((r[field] || '')).slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(d)) set.add(d);
    }
    return [...set].sort().reverse();
  }

  /** CSV 单元转义：引号包裹 + 内部引号翻倍（Excel 直接打开需前置 BOM，由调用方处理） */
  function csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  }
  /** 行数组 → CSV 文本（\r\n 行尾） */
  function csvRow(cells) {
    return cells.map(csvCell).join(',');
  }

  /* ---------- SVG 图表纯函数（P4-M2，零依赖；渲染拼装在 charts.js） ---------- */

  /** 坐标保留两位小数，避免 path 字符串冗长 */
  function coord(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  /** 线性映射：值域 [d0,d1] → 像素域 [r0,r1]；域宽 0 时恒返回 r0（空数据安全） */
  function scaleLinear(d0, d1, r0, r1) {
    const span = d1 - d0;
    return v => span ? r0 + (v - d0) * (r1 - r0) / span : r0;
  }

  /** 1/2/5×10^k 步进刻度：返回 {max, ticks[]}；空/非法数据返回零网格 */
  function niceTicks(maxVal, n = 4) {
    if (maxVal == null || !isFinite(maxVal) || maxVal <= 0) return { max: 0, ticks: [0] };
    const rough = maxVal / Math.max(1, n);
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 5, 10].map(m => m * pow).find(s => s >= rough) || 10 * pow;
    const max = Math.ceil(maxVal / step) * step;
    const ticks = [];
    for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(coord(v));
    return { max, ticks };
  }

  /** 折线 path：pts=[{x,y}]，y/x 为 null 断线（多段 M…L…） */
  function linePath(pts) {
    let d = '', pen = false;
    for (const p of pts || []) {
      if (p == null || p.x == null || p.y == null) { pen = false; continue; }
      d += (d === '' ? 'M' : (pen ? ' L' : ' M')) + coord(p.x) + ',' + coord(p.y);
      pen = true;
    }
    return d;
  }

  /** 竖向条形：vals=[{cx(槽中心), v}]，y=值→像素函数（0 值像素=基线），band 槽宽，gap 内边距 → [{x,y,w,h}] */
  function barRects(vals, y, band, gap) {
    const baseY = y(0);
    return (vals || []).map(p => {
      const v = p.v == null ? 0 : p.v;
      const w = Math.max(0, band - gap);
      const h = Math.max(0, coord(baseY - y(v)));
      return { x: coord(p.cx - w / 2), y: coord(baseY - h), w: coord(w), h };
    });
  }

  /** 分组条形：seriesCount 个系列在每槽内错位；pts=[{cx, values:[各系列值]}]
      返回扁平 [{x,y,w,h,si(系列序),cx}] */
  function groupedBarRects(seriesCount, pts, y, band, gap) {
    const n = Math.max(1, seriesCount | 0);
    const subBand = (band - gap) / n;
    const baseY = y(0);
    const out = [];
    for (const p of pts || []) {
      (p.values || []).forEach((v, si) => {
        const val = v == null ? 0 : v;
        const h = Math.max(0, coord(baseY - y(val)));
        out.push({
          x: coord(p.cx - (band - gap) / 2 + si * subBand), y: coord(baseY - h),
          w: coord(subBand), h, si, cx: p.cx
        });
      });
    }
    return out;
  }

  /** 横向条形：items=[{v}]，按 maxVal 归一 → [{v,wPct}]（wPct∈[0,1]，maxVal≤0 全 0） */
  function hBarRects(items, maxVal) {
    const max = Number(maxVal);
    return (items || []).map(it => ({
      v: it.v == null ? 0 : it.v,
      wPct: max > 0 ? Math.max(0, Math.min(1, (it.v || 0) / max)) : 0
    }));
  }

  const Core = {
    monthKeys, csvCell, csvRow,
    fmtYuan, yuanInputToCents, statusLabel,
    billPayable, billUnpaid, jobRow, settlementRow, billRow, journalRow, overviewRow,
    scaleLinear, niceTicks, linePath, barRects, groupedBarRects, hBarRects,
    MAPS: { JOB_STATUS, SETTLEMENT_STATUS, BILL_STATUS, PAYMENT_CATEGORY, ADVANCE_DIRECTION, METHOD, PARTY_TYPE }
  };

  if (typeof window !== 'undefined') window.LedgerCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})();
