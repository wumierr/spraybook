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

/* ==================== P5-M2 echarts option 构建器（charts.js 纯函数层；
   P4-M2 手绘 SVG 几何函数已随内核更换移除，原 6 个几何用例同步删除） ==================== */

const Charts = require('../ledger/js/charts.js');

test('charts.buildTimeOption：x 轴人类 label、柱+折线各自值域 yAxis、抽稀 interval、tooltip 首行 label(period)', () => {
  const rows = [
    { period: '2026-01', label: '1月', income_cents: 10000, expense_cents: 4000, profit_cents: 6000, income_pct: null, expense_pct: null },
    { period: '2026-02', label: '2月', income_cents: 20000, expense_cents: 5000, profit_cents: 15000, income_pct: 100, expense_pct: 25 }
  ];
  const opt = Charts.buildTimeOption({
    rows,
    bars: [
      { key: 'income_cents', name: '收入', color: '#0e7c66' },
      { key: 'expense_cents', name: '支出', color: '#c0392b' }
    ],
    lines: [{ key: 'profit_cents', name: '利润', color: '#b7791f', fmt: v => String(v) }],
    colors: { muted: '#6b7a89', border: '#dde3e9' },
    yFmt: v => String(v),
    tip: r => `${Charts.periodLabel(r)}(${r.period})`
  });
  assert.deepStrictEqual(opt.xAxis.data, ['1月', '2月'], 'x 轴=人类可读 label，按 rows 序（服务端升序返回）');
  assert.strictEqual(opt.yAxis.length, 2, '柱值域轴 + 折线自有值域轴');
  assert.strictEqual(opt.series.length, 3, '2 柱 + 1 线');
  assert.strictEqual(opt.series[0].type, 'bar');
  assert.strictEqual(opt.series[2].type, 'line');
  assert.strictEqual(opt.series[2].yAxisIndex, 1, '折线挂自有值域轴');
  assert.deepStrictEqual(opt.series[0].data, [10000, 20000], '柱数据取自 rows（_cents 整数分）');
  assert.strictEqual(opt.xAxis.axisLabel.interval, 0, 'n≤12 全显示');
  assert.strictEqual(typeof opt.tooltip.formatter, 'function');
  assert.strictEqual(opt.tooltip.formatter([{ dataIndex: 0 }]), '1月(2026-01)',
    'tooltip 首行=label(period)，原始键在括号内');
  assert.strictEqual(opt.tooltip.formatter([{ dataIndex: 9 }]), '', '越界 dataIndex 安全');

  const many = Charts.buildTimeOption({
    rows: Array.from({ length: 13 }, (_, i) => ({ period: `2026-${String(i + 1).padStart(2, '0')}`, label: `${i + 1}月` })),
    bars: [], lines: [], colors: {}
  });
  assert.strictEqual(many.xAxis.axisLabel.interval, 1, '13 桶抽稀（最多 12 个 label）');
  assert.strictEqual(many.yAxis.length, 1, '无柱无线时兜底单轴');
  assert.ok(many.xAxis.axisLabel.hideOverlap, '轴标签防重叠');
});

test('charts.buildBarOption：y 轴 category=名字（客户/科目名），值 label 与 tooltip 走 items', () => {
  const items = [
    { label: '张大国', v: 91600, tip: '张大国：91,600 元' },
    { label: '李秀英', v: 50400, tip: '李秀英：50,400 元' }
  ];
  const opt = Charts.buildBarOption({
    items, colors: { c1: '#0e7c66', text: '#000', muted: '#666', border: '#ddd' },
    valFmt: v => String(v)
  });
  assert.deepStrictEqual(opt.yAxis.data, ['张大国', '李秀英'], '客户图用名字');
  assert.strictEqual(opt.yAxis.inverse, true, '第一项在顶部');
  assert.strictEqual(opt.series[0].data[0].value, 91600);
  assert.strictEqual(opt.tooltip.formatter({ dataIndex: 1 }), '李秀英：50,400 元');
  assert.strictEqual(opt.xAxis.axisLabel.formatter(91600), '91600', '值轴 formatter 透传');
  assert.strictEqual(opt.series[0].label.formatter({ value: 50400 }), '50400', '条尾值 label');
});

test('charts.buildPieOption：环图半径、(未填)/未记录灰色桶、legend 收纳、空数据 title', () => {
  const theme = { c1: '#111111', c2: '#222222', c3: '#333333', c4: '#444444', muted: '#999999' };
  const opt = Charts.buildPieOption({
    items: [{ label: '通安', v: 100 }, { label: '(未填)', v: 50, color: '#999999' }],
    donut: true, colors: theme, valFmt: v => String(v)
  });
  assert.deepStrictEqual(opt.series[0].radius, ['42%', '68%'], '环图');
  assert.deepStrictEqual(opt.series[0].data.map(d => d.name), ['通安', '(未填)']);
  assert.strictEqual(opt.series[0].data[1].itemStyle.color, '#999999', '(未填) 桶灰色');
  assert.strictEqual(opt.series[0].data[0].itemStyle.color, '#111111', '其余按调色板首色');
  assert.ok(opt.legend, '≤6 项给 legend');
  const many = Charts.buildPieOption({
    items: Array.from({ length: 9 }, (_, i) => ({ label: `r${i}`, v: i })), colors: theme
  });
  assert.strictEqual(many.legend, undefined, '多于 6 项隐藏 legend（明细在旁表）');
  const empty = Charts.buildPieOption({ items: [], colors: theme });
  assert.strictEqual(empty.title.text, '暂无数据', '空数据给占位 title');
});

test('charts.periodLabel：前端兜底映射（服务端 label 缺失时），服务端 label 优先', () => {
  assert.strictEqual(Charts.periodLabel({ period: '2026-03' }), '3月');
  assert.strictEqual(Charts.periodLabel({ period: '2026-Q2' }), 'Q2');
  assert.strictEqual(Charts.periodLabel({ period: '2026' }), '2026');
  assert.strictEqual(Charts.periodLabel({ period: '2026-W13', period_start: '2026-03-31' }), 'W13(03-31)');
  assert.strictEqual(Charts.periodLabel({ period: '2026-W00' }), 'W00', 'period_start 缺失退化');
  assert.strictEqual(Charts.periodLabel({ period: '2026-04', label: '4月' }), '4月', '服务端 label 优先');
  assert.strictEqual(Charts.periodLabel(null), '', '空行安全');
});

test('charts.js：node 下可 require（渲染/动作/挂载/构建器入口存在）', () => {
  assert.strictEqual(typeof Charts.renderTab, 'function');
  assert.strictEqual(typeof Charts.handleAct, 'function');
  assert.strictEqual(typeof Charts.mountMini, 'function');
  assert.strictEqual(typeof Charts.disposeAll, 'function');
  assert.strictEqual(typeof Charts.buildTimeOption, 'function');
  assert.strictEqual(typeof Charts.buildBarOption, 'function');
  assert.strictEqual(typeof Charts.buildPieOption, 'function');
});
