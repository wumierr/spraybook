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
      jobIncomeCents: r.income_cents != null ? r.income_cents : 0,
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

  /* ---------- SVG 图表纯函数已随 P5-M2 echarts 化移除（charts.js 改 option 构建器） ---------- */

  /* ---------- 列宽存取（P5-M3 表格 Excel 化；DOM 无关，node:test 可测） ---------- */
  const COLW_MIN = 48, COLW_MAX = 800;
  /** 列宽规范化到 48–800px；非数回退下限（拖拽边界与存档读取共用一条口径） */
  function clampColw(px) {
    const n = Math.round(Number(px));
    if (!Number.isFinite(n)) return COLW_MIN;
    return Math.min(COLW_MAX, Math.max(COLW_MIN, n));
  }
  /** localStorage 存取键：按 页签+表 组合，不同页签同表名互不串档 */
  function colwKey(tab, tableKey) {
    return 'lg-colw:' + String(tab == null ? '' : tab) + ':' + String(tableKey == null ? '' : tableKey);
  }
  /** 解析列宽存档：坏 JSON / 非数组 / 列数超出现表（结构变更）/ 坏值 → 整包 null 丢弃防错位；
      短数组允许（仅前列有存档）；每项经 clampColw 规范化 */
  function parseColw(json, thCount) {
    let arr;
    try { arr = JSON.parse(json); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    if (arr.length > thCount) return null;
    const out = [];
    for (const v of arr) {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      out.push(clampColw(n));
    }
    return out;
  }

  /**
   * 计算器导出 JSON → /api/jobs 同步协议载荷（P6-M1 离线数据通路）。
   * 返回 { ok:true, payload } 或 { ok:false, error }。
   * 规则：
   *  - 必须 type='drone-spray-config'；schemaVersion='2.1' 才带 result（可导入），
   *    2.0/缺失 → 友好报错（老版本导出没有计算结果快照）；
   *  - client_job_id：优先用导出自带，否则本地生成（幂等键，含随机后缀防撞）；
   *  - job_date 取 exportedAt 的日期前缀，缺省 todayStr；
   *  - snapshot = 原导出对象剥离 result/schemaVersion/client_job_id（服务端原样存 raw_json）。
   */
  function calculatorJobPayload(text, todayStr) {
    let obj;
    try { obj = JSON.parse(typeof text === 'string' ? text.trim() : ''); }
    catch (e) { return { ok: false, error: '不是合法的 JSON' }; }
    if (!obj || obj.type !== 'drone-spray-config') {
      return { ok: false, error: '不是计算器导出的作业 JSON（缺少 type 标识）' };
    }
    if (obj.schemaVersion !== '2.1' || !obj.result) {
      return { ok: false, error: '旧版导出（无计算结果快照）。请在计算器重新计算后用「⬇ 下载作业包」导出' };
    }
    const mode = obj.mode === 'haul' ? 'haul' : 'spray';
    const exported = String(obj.exportedAt || '');
    // E1（P7-R4）：日期口径与同步通路（sync.js localDateStr）对齐——
    // 新作业包 exportedAt 是本地墙钟串，直接取前 10 位；旧包（ISO/UTC，含 T）
    // 按北京时间 +8 换算取日期，避免凌晨导出的作业记到前一天。
    let jobDate;
    if (/^\d{4}-\d{2}-\d{2}/.test(exported)) {
      if (exported.includes('T')) {
        const d = new Date(exported);
        if (!isNaN(d)) {
          const p = (n) => (n < 10 ? '0' + n : '' + n);
          const loc = new Date(d.getTime() + 8 * 3600 * 1000);
          jobDate = `${loc.getUTCFullYear()}-${p(loc.getUTCMonth() + 1)}-${p(loc.getUTCDate())}`;
        } else jobDate = todayStr || exported.slice(0, 10);
      } else {
        jobDate = exported.slice(0, 10);
      }
    } else {
      jobDate = todayStr || exported;
    }
    const snapshot = { ...obj };
    delete snapshot.result;
    delete snapshot.schemaVersion;
    delete snapshot.client_job_id;
    return {
      ok: true,
      payload: {
        client_job_id: obj.client_job_id || 'paste-' + (todayStr || '') + '-' + Math.random().toString(36).slice(2, 8),
        job_type: mode,
        job_date: jobDate,
        note: (obj.workOrder && obj.workOrder.note) || undefined,
        snapshot,
        result: obj.result
      }
    };
  }

  const Core = {
    monthKeys, csvCell, csvRow, calculatorJobPayload,
    fmtYuan, yuanInputToCents, statusLabel,
    billPayable, billUnpaid, jobRow, settlementRow, billRow, journalRow, overviewRow,
    colwKey, clampColw, parseColw,
    MAPS: { JOB_STATUS, SETTLEMENT_STATUS, BILL_STATUS, PAYMENT_CATEGORY, ADVANCE_DIRECTION, METHOD, PARTY_TYPE }
  };

  if (typeof window !== 'undefined') window.LedgerCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})();
