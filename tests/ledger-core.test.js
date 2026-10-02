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

test('overviewRow：总表聚合行的展示派生（P4-M1）', () => {
  const row = Core.overviewRow({
    id: 1, job_no: 'J1', job_date: '2026-09-29T00:00:00', job_status: 'settled', source: 'import',
    total_area_mu: 39, unit_price_cents: 3000, plant_label: '清园', extra_cents: 2500,
    customer_names: '李秀英,王强', region: '通安', village: '金桂', team: '3',
    operator_names: '["甲","乙"]', referral_name: '沈鹏', collector_name: '丙', note: '备注X',
    bill_statuses: 'paid,unpaid', bill_count: 2, paid_cents: 100,
    bill_id: 7, bill_party_id: 5, bill_adjust: -100, bill_note: '账单备注'
  });
  assert.strictEqual(row.job_date, '2026-09-29');
  assert.strictEqual(row.statusText, '已结算');
  assert.strictEqual(row.addr, '金桂·3队', '村·队 拼接');
  assert.strictEqual(row.unitPriceYuan, '30.00');
  assert.deepStrictEqual(row.operators, ['甲', '乙'], 'operator_names 服务端已解数组');
  assert.deepStrictEqual(row.billStatuses, ['paid', 'unpaid']);
  assert.strictEqual(row.extraCents, 2500);
  // 多账单：锁定编辑、不提供登记收款按钮
  assert.strictEqual(row.canEditBill, false, '多账单不可直填');
  assert.strictEqual(row.canReceive, false, '多账单不提供按行收款');
  // 单账单 unpaid：与账单页 canEdit 同口径
  const single = Core.overviewRow({ id: 2, job_no: 'J2', job_status: 'settled', bill_statuses: 'unpaid', bill_count: 1, paid_cents: 0, bill_id: 9 });
  assert.strictEqual(single.canEditBill, true);
  assert.strictEqual(single.canReceive, true);
  assert.strictEqual(single.addr, '—');
  const partial = Core.overviewRow({ id: 3, job_no: 'J3', job_status: 'settled', bill_statuses: 'partial', bill_count: 1, paid_cents: 100, bill_id: 10 });
  assert.strictEqual(partial.canEditBill, false, '部分收款后不可直填');
  assert.strictEqual(partial.canReceive, true);
  // operator_names 非法 JSON 不炸
  const bad = Core.overviewRow({ id: 4, job_no: 'J4', job_status: 'completed', operator_names: '{oops', bill_count: 0 });
  assert.deepStrictEqual(bad.operators, []);
});

test('csvCell/csvRow：引号转义与行拼装（导出 Excel 兼容）', () => {
  assert.strictEqual(Core.csvCell('普通'), '"普通"');
  assert.strictEqual(Core.csvCell('含"引号"'), '"含""引号"""');
  assert.strictEqual(Core.csvCell(null), '""');
  assert.strictEqual(Core.csvCell(123), '"123"');
  assert.strictEqual(Core.csvRow(['a', 'b"c', 12]), '"a","b""c","12"');
});

/* ==================== P4-M2 SVG 图表纯函数 ==================== */

test('scaleLinear：线性映射，零域宽返回 r0（空数据安全）', () => {
  const y = Core.scaleLinear(0, 1000, 200, 0); // 值越大像素越小（倒轴）
  assert.strictEqual(y(0), 200);
  assert.strictEqual(y(1000), 0);
  assert.strictEqual(y(500), 100);
  const flat = Core.scaleLinear(0, 0, 200, 0);
  assert.strictEqual(flat(500), 200, '域宽 0 恒返回 r0');
});

test('niceTicks：1/2/5×10^k 步进；空/非法数据返回零网格；末刻度=max', () => {
  assert.deepStrictEqual(Core.niceTicks(4000, 4), { max: 4000, ticks: [0, 1000, 2000, 3000, 4000] });
  const t5 = Core.niceTicks(5000, 4); // rough=1250 → step 2000 → max 6000
  assert.strictEqual(t5.max, 6000);
  assert.deepStrictEqual(t5.ticks, [0, 2000, 4000, 6000]);
  assert.ok(Core.niceTicks(10117010).max >= 10117010, 'max 覆盖数据最大值');
  assert.deepStrictEqual(Core.niceTicks(0), { max: 0, ticks: [0] });
  assert.deepStrictEqual(Core.niceTicks(null), { max: 0, ticks: [0] });
  assert.deepStrictEqual(Core.niceTicks(-5), { max: 0, ticks: [0] });
});

test('linePath：折线拼接与缺值断线（多段 M…）', () => {
  assert.strictEqual(Core.linePath([{ x: 0, y: 10 }, { x: 10, y: 20 }]), 'M0,10 L10,20');
  assert.strictEqual(
    Core.linePath([{ x: 0, y: 10 }, { x: 10, y: null }, { x: 20, y: 30 }]),
    'M0,10 M20,30', '中间缺值断成两段');
  assert.strictEqual(Core.linePath([]), '');
  assert.strictEqual(Core.linePath([{ x: 0.4, y: 10.256 }]), 'M0.4,10.26', '坐标保留两位小数');
});

test('barRects：基线/高度/槽内居中几何', () => {
  // 值域 0..1000 → 像素 100..0；band 40 gap 8
  const y = Core.scaleLinear(0, 1000, 100, 0);
  const rects = Core.barRects([{ cx: 50, v: 500 }, { cx: 150, v: 0 }], y, 40, 8);
  assert.deepStrictEqual(rects[0], { x: 34, y: 50, w: 32, h: 50 });
  assert.deepStrictEqual(rects[1], { x: 134, y: 100, w: 32, h: 0 }, '零值=零高度贴基线');
  const n = Core.barRects([{ cx: 50, v: null }], y, 40, 8);
  assert.strictEqual(n[0].h, 0, 'null 值按 0 处理不炸');
});

test('groupedBarRects：每槽按系列错位，扁平结构带 si', () => {
  const y = Core.scaleLinear(0, 400, 200, 0);
  const rects = Core.groupedBarRects(2, [{ cx: 50, values: [100, 200] }], y, 40, 8);
  assert.strictEqual(rects.length, 2);
  assert.deepStrictEqual(rects[0], { x: 34, y: 150, w: 16, h: 50, si: 0, cx: 50 });
  assert.deepStrictEqual(rects[1], { x: 50, y: 100, w: 16, h: 100, si: 1, cx: 50 });
  const empty = Core.groupedBarRects(2, [{ cx: 50, values: [] }], y, 40, 8);
  assert.strictEqual(empty.length, 0);
});

test('hBarRects：按 maxVal 归一化到 0..1，max 非正全 0', () => {
  assert.deepStrictEqual(Core.hBarRects([{ v: 100 }, { v: 50 }, { v: 0 }], 100),
    [{ v: 100, wPct: 1 }, { v: 50, wPct: 0.5 }, { v: 0, wPct: 0 }]);
  assert.deepStrictEqual(Core.hBarRects([{ v: 10 }], 0), [{ v: 10, wPct: 0 }]);
});

test('charts.js：node 下可 require（动作路由入口存在）', () => {
  const Charts = require('../ledger/js/charts.js');
  assert.strictEqual(typeof Charts.renderTab, 'function');
  assert.strictEqual(typeof Charts.handleAct, 'function');
});
