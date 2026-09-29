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

  const Core = {
    fmtYuan, yuanInputToCents, statusLabel,
    billPayable, billUnpaid, jobRow, settlementRow, billRow, journalRow,
    MAPS: { JOB_STATUS, SETTLEMENT_STATUS, BILL_STATUS, PAYMENT_CATEGORY, ADVANCE_DIRECTION, METHOD, PARTY_TYPE }
  };

  if (typeof window !== 'undefined') window.LedgerCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})();
