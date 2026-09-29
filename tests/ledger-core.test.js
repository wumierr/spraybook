/* ============================================================
   ledger-core.test.js — 记账后台纯函数层测试
   运行：node --test tests/ledger-core.test.js
   ============================================================ */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Core = require('../ledger/js/core.js');

test('fmtYuan：分→元，含负数（抹零）与空值', () => {
  assert.strictEqual(Core.fmtYuan(11200), '112.00');
  assert.strictEqual(Core.fmtYuan(54720), '547.20');
  assert.strictEqual(Core.fmtYuan(-100), '-1.00');
  assert.strictEqual(Core.fmtYuan(null), '—');
  assert.strictEqual(Core.fmtYuan(undefined), '—');
});

test('yuanInputToCents：元→分（Math.round×100），空→null，非法→NaN', () => {
  assert.strictEqual(Core.yuanInputToCents('8.1'), 810);
  assert.strictEqual(Core.yuanInputToCents('0.1'), 10);
  assert.strictEqual(Core.yuanInputToCents('35.6'), 3560);
  assert.strictEqual(Core.yuanInputToCents(''), null);
  assert.ok(Number.isNaN(Core.yuanInputToCents('abc')));
});

test('billPayable/billUnpaid：应收=金额+调整，未收=应收-已收', () => {
  const bill = { amount_cents: 10000, adjust_cents: -100, paid_cents: 4000 };
  assert.strictEqual(Core.billPayable(bill), 9900);
  assert.strictEqual(Core.billUnpaid(bill), 5900);
});

test('jobRow：状态机映射与可操作位', () => {
  const spray = { id: 1, job_no: 'J1', job_date: '2026-09-29', job_type: 'spray', status: 'completed', total_area_mu: 39, income_cents: 31200 };
  const r = Core.jobRow(spray);
  assert.strictEqual(r.type, '打药');
  assert.strictEqual(r.statusText, '待结算');
  assert.strictEqual(r.primary, '39 亩');
  assert.strictEqual(r.canSettle, true);
  assert.strictEqual(r.canEditLines, true);

  const settled = { ...spray, status: 'settled' };
  assert.strictEqual(Core.jobRow(settled).canSettle, false);

  const haul = { ...spray, job_type: 'haul', status: 'completed', weight_jin: 3500 };
  const h = Core.jobRow(haul);
  assert.strictEqual(h.type, '吊运');
  assert.strictEqual(h.primary, '3500 斤');
});

test('settlementRow/billRow：确认前可编辑，已收账单只读', () => {
  const s = Core.settlementRow({ id: 1, settlement_no: 'S1', job_no: 'J1', job_date: '2026-09-29', status: 'draft', total_spray_fee_cents: 100, total_pesticide_fee_cents: 200, total_receivable_cents: 300, paid_cents: 0 });
  assert.strictEqual(s.canConfirm, true);
  assert.strictEqual(s.canReopen, false);
  const sc = Core.settlementRow({ id: 1, settlement_no: 'S1', job_no: 'J1', job_date: '2026-09-29', status: 'confirmed', total_spray_fee_cents: 100, total_pesticide_fee_cents: 200, total_receivable_cents: 300, paid_cents: 0 });
  assert.strictEqual(sc.canConfirm, false);
  assert.strictEqual(sc.canReopen, true);

  const b = Core.billRow({ id: 1, bill_no: 'B1', party_name: '张三', farmer_name: '张三', status: 'unpaid', amount_cents: 10000, adjust_cents: 0, paid_cents: 0 });
  assert.strictEqual(b.canReceive, true);
  assert.strictEqual(b.canEdit, true);
  const bp = Core.billRow({ id: 1, bill_no: 'B1', party_name: '张三', farmer_name: '张三', status: 'partial', amount_cents: 10000, adjust_cents: 0, paid_cents: 4000 });
  assert.strictEqual(bp.canReceive, true);
  assert.strictEqual(bp.canEdit, false, '部分收款后金额只读');
});

test('journalRow：借贷分列与平衡标记', () => {
  const e = {
    id: 1, entry_no: 'V1', event_type: 'settlement_confirm', memo: 'x', occurred_at: '2026-09-29T00:00:00',
    lines: [
      { direction: 'debit', amount_cents: 300, account_code: '1122', account_name: '应收账款' },
      { direction: 'credit', amount_cents: 100, account_code: '6001', account_name: '作业收入' },
      { direction: 'credit', amount_cents: 200, account_code: '6002', account_name: '药收入' }
    ]
  };
  const r = Core.journalRow(e);
  assert.strictEqual(r.balanced, true);
  assert.strictEqual(r.debit.length, 1);
  assert.strictEqual(r.credit.length, 2);
  const bad = Core.journalRow({ ...e, lines: [e.lines[0]] });
  assert.strictEqual(bad.balanced, false);
});
