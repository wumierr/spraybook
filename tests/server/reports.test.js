/* ============================================================
   reports.test.js — M6 报表与按客户 FIFO 核销
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildApp } = require('../../server/index');
const { freshDb } = require('./helpers/db');

const SAMPLE = require(path.join(__dirname, '..', '..', 'docs', 'export-json-sample.json'));

let db, server, base;
let seq = 0;

beforeEach(async () => {
  db = freshDb();
  const app = buildApp(db);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => {
  if (server) { await new Promise(r => server.close(r)); server = null; }
});

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function getJson(url) {
  return (await (await fetch(url)).json()).data;
}
async function createSettledJob() {
  seq += 1;
  const p = {
    client_job_id: `r-${seq}-${Date.now()}`, job_type: 'spray', job_date: '2026-09-2' + (seq % 10),
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  };
  const job = (await post(`${base}/jobs`, p)).data;
  const st = (await post(`${base}/settlements`, { job_id: job.id })).data;
  await post(`${base}/settlements/${st.id}/confirm`);
  return { job, st };
}

function assertBalanced() {
  const rows = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS d,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS c
     FROM journal_lines`).get();
  assert.strictEqual(rows.d, rows.c, `总账借贷不平: ${rows.d} vs ${rows.c}`);
}

test('按客户收款：FIFO 核销两张账单 + 余额转预收；作废全联动回退', async () => {
  // 同一客户张大国两张账单（两单作业）
  await createSettledJob();
  await createSettledJob();
  const bills = (await getJson(`${base}/bills`)).filter(b => b.party_name === '张大国');
  assert.strictEqual(bills.length, 2, '张大国两张账单');
  const older = bills.reduce((a, b) => (a.id < b.id ? a : b));
  const newer = bills.reduce((a, b) => (a.id > b.id ? a : b));
  const olderUnpaid = older.amount_cents + older.adjust_cents - older.paid_cents;
  const newerUnpaid = newer.amount_cents + newer.adjust_cents - newer.paid_cents;
  const total = olderUnpaid + newerUnpaid;

  // 一笔钱 = 两单全清 + 5000 余额
  const rc = await post(`${base}/receipts`, {
    party_id: older.party_id, amount_cents: total + 5000, method: 'cash'
  });
  assert.strictEqual(rc.ok, true, JSON.stringify(rc));
  const allocations = JSON.parse(rc.data.allocations);
  assert.deepStrictEqual(allocations.items.map(a => a.bill_id), [older.id, newer.id], 'FIFO 先老后新');
  assert.strictEqual(allocations.items[0].amount_cents, olderUnpaid);
  assert.ok(allocations.remainder_advance_id, '余额生成预收');

  const b1 = (await getJson(`${base}/bills`)).find(b => b.id === older.id);
  const b2 = (await getJson(`${base}/bills`)).find(b => b.id === newer.id);
  assert.strictEqual(b1.status, 'paid');
  assert.strictEqual(b2.status, 'paid');
  const adv = db.prepare('SELECT * FROM advances WHERE id = ?').get(allocations.remainder_advance_id);
  assert.strictEqual(adv.balance_cents, 5000);
  assert.strictEqual(adv.direction, 'prepaid_by_customer');

  assertBalanced();

  // 作废该收款：两张账单回未清、余额预收联动作废
  await post(`${base}/receipts/${rc.data.id}/void`);
  const b1v = (await getJson(`${base}/bills`)).find(b => b.id === older.id);
  const b2v = (await getJson(`${base}/bills`)).find(b => b.id === newer.id);
  assert.strictEqual(b1v.status, 'unpaid');
  assert.strictEqual(b2v.status, 'unpaid');
  const advV = db.prepare('SELECT * FROM advances WHERE id = ?').get(allocations.remainder_advance_id);
  assert.strictEqual(advV.status, 'void');
  assert.strictEqual(advV.balance_cents, 0);
  assertBalanced();
});

test('按客户收款：钱不够全清时只核销最老的账单', async () => {
  await createSettledJob();
  await createSettledJob();
  const bills = (await getJson(`${base}/bills`)).filter(b => b.party_name === '张大国');
  const older = bills.reduce((a, b) => (a.id < b.id ? a : b));
  const olderUnpaid = older.amount_cents + older.adjust_cents - older.paid_cents;

  const rc = await post(`${base}/receipts`, { party_id: older.party_id, amount_cents: olderUnpaid - 100 });
  assert.strictEqual(rc.ok, true);
  const allocations = JSON.parse(rc.data.allocations);
  assert.strictEqual(allocations.items.length, 1, '只核销一张');
  assert.strictEqual(allocations.remainder_advance_id, null, '无余额不转预收');
  const b = (await getJson(`${base}/bills`)).find(b => b.id === older.id);
  assert.strictEqual(b.status, 'partial');
  assertBalanced();
});

test('报表：summary/by-month/by-customer/by-job 数字与手账一致', async () => {
  const { st } = await createSettledJob();
  await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '油费' });
  await post(`${base}/payments`, { category: 'meal', amount_cents: 3000, note: '午饭' });
  // 张大国账单收清
  const bills = (await getJson(`${base}/bills`)).filter(b => b.party_name === '张大国');
  const zUnpaid = bills.reduce((a, b) => a + b.amount_cents + b.adjust_cents - b.paid_cents, 0);
  await post(`${base}/receipts`, { party_id: bills[0].party_id, amount_cents: zUnpaid });

  const s = await getJson(`${base}/reports/summary`);
  assert.strictEqual(s.income_cents, st.total_receivable_cents, '收入=确认结算合计');
  assert.strictEqual(s.expense_cents, 15000, '支出=12000+3000');
  assert.strictEqual(s.profit_cents, st.total_receivable_cents - 15000);
  assert.ok(s.expense_by_category.some(c => c.code === '5002' && c.cents === 12000));

  const months = await getJson(`${base}/reports/by-month`);
  assert.strictEqual(months.length, 1);
  // occurred_at 用确认时刻（真实当前日期），不写死月份——利润必须与 summary 一致
  assert.strictEqual(months[0].profit_cents, s.profit_cents);

  const custs = await getJson(`${base}/reports/by-customer`);
  const zhang = custs.find(c => c.name === '张大国');
  assert.ok(zhang, '按客户收入有张大国');
  assert.ok(zhang.income_cents > 0);
  assert.strictEqual(zhang.receivable_cents, 0, '张大国已收清');

  const byJobs = await getJson(`${base}/reports/by-job`);
  assert.strictEqual(byJobs.length, 1);
  assert.strictEqual(byJobs[0].profit_cents, Math.round(SAMPLE.spray.result.profit * 100), '作业利润=income-cost（样本 -1659.4 元）');
  assertBalanced();
});

test('party balance：欠款/预收/最近作业', async () => {
  await createSettledJob();
  const parties = await getJson(`${base}/parties`);
  const li = parties.find(p => p.name === '李秀英');
  const bal = await getJson(`${base}/parties/${li.id}/balance`);
  assert.strictEqual(bal.party.name, '李秀英');
  assert.ok(bal.receivable_cents > 0, '李秀英有欠款');
  assert.ok(bal.last_job, '有最近作业');
});

/* ==================== P4-M2 报表时间分组（月/周/季/年） ==================== */

/** 指定 job_date 的确认结算作业（by-period 作业轴打点用） */
async function createSettledJobAt(jobDate) {
  seq += 1;
  const p = {
    client_job_id: `rp-${seq}-${Date.now()}`, job_type: 'spray', job_date: jobDate,
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  };
  const job = (await post(`${base}/jobs`, p)).data;
  const st = (await post(`${base}/settlements`, { job_id: job.id })).data;
  await post(`${base}/settlements/${st.id}/confirm`);
  return { job, st };
}

test('by-period：granularity 白名单校验与双轴结构', async () => {
  const bad = await (await fetch(`${base}/reports/by-period?granularity=decade`)).json();
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error.code, 'VALIDATION');
  const bad2 = await (await fetch(`${base}/reports/adjustments?granularity=hour`)).json();
  assert.strictEqual(bad2.ok, false);
  assert.strictEqual(bad2.error.code, 'VALIDATION');
  const bad3 = await (await fetch(`${base}/reports/cost-breakdown?source=nope`)).json();
  assert.strictEqual(bad3.ok, false);
  assert.strictEqual(bad3.error.code, 'VALIDATION');

  await createSettledJobAt('2026-04-02');
  const d = await getJson(`${base}/reports/by-period?granularity=month`);
  assert.strictEqual(d.granularity, 'month');
  assert.ok(Array.isArray(d.pl) && Array.isArray(d.work));
  // pl 轴字段齐全（确认时点 occurred_at 分桶）
  for (const f of ['period', 'period_start', 'period_end', 'income_cents', 'expense_cents',
    'profit_cents', 'income_pct', 'expense_pct', 'profit_pct']) {
    assert.ok(f in d.pl[0], `pl 缺字段 ${f}`);
  }
  for (const f of ['period', 'period_start', 'period_end', 'jobs_count', 'area_mu',
    'customer_count', 'jobs_pct', 'area_pct']) {
    assert.ok(f in d.work[0], `work 缺字段 ${f}`);
  }
  assert.strictEqual(d.pl[0].income_cents, d.pl[0].profit_cents, '零支出时 profit=income');
  assert.strictEqual(d.pl[0].income_pct, null, '首桶环比 null');
  assert.ok(/^\d{4}-\d{2}$/.test(d.pl[0].period), 'pl 桶按确认时点（真实当前时间）');
  assert.strictEqual(d.work[0].period, '2026-04', 'work 桶按 job_date');
  assert.strictEqual(d.work[0].jobs_count, 1, '作业数=作业单数（不随分项行数翻倍）');
  assert.strictEqual(d.work[0].customer_count, 3, '客户数=结算分项 party 去重');
});

test('by-period：四粒度 bucket 键与周/季边界（2026-01-01 落 W00；03-31/04-01 跨季；同周合并）', async () => {
  // 作业轴：job_date 直打边界日。2026-03-31 与 04-01 同属 W13（周一始自然周）但跨 Q1/Q2
  for (const d of ['2026-01-01', '2026-03-31', '2026-04-01', '2026-12-31']) {
    await createSettledJobAt(d);
  }
  const areaTotal = 4 * SAMPLE.spray.result.area;

  const mon = await getJson(`${base}/reports/by-period?granularity=month`);
  assert.deepStrictEqual(mon.work.map(r => r.period), ['2026-01', '2026-03', '2026-04', '2026-12']);
  assert.strictEqual(mon.work[0].period_start, '2026-01-01');

  const wk = await getJson(`${base}/reports/by-period?granularity=week`);
  assert.deepStrictEqual(wk.work.map(r => r.period), ['2026-W00', '2026-W13', '2026-W52'],
    '01-01 落 W00；03-31 与 04-01 同周合并；12-31 落 W52');
  const w13 = wk.work.find(r => r.period === '2026-W13');
  assert.strictEqual(w13.jobs_count, 2);
  assert.strictEqual(w13.period_start, '2026-03-31', 'period_start/end=桶内实际日期 MIN/MAX（跨月可见）');
  assert.strictEqual(w13.period_end, '2026-04-01');

  const q = await getJson(`${base}/reports/by-period?granularity=quarter`);
  assert.deepStrictEqual(q.work.map(r => r.period), ['2026-Q1', '2026-Q2', '2026-Q4'],
    '季=1-3 月一组；03-31 在 Q1、04-01 在 Q2');
  assert.strictEqual(q.work.find(r => r.period === '2026-Q1').jobs_count, 2);

  const yr = await getJson(`${base}/reports/by-period?granularity=year`);
  assert.deepStrictEqual(yr.work.map(r => r.period), ['2026']);
  assert.strictEqual(yr.work[0].jobs_count, 4);
  // 年合计 = 四季合计（jobs_count 与 area_mu 双断言）
  const qSumJobs = q.work.reduce((a, r) => a + r.jobs_count, 0);
  const qSumArea = q.work.reduce((a, r) => a + r.area_mu, 0);
  assert.strictEqual(yr.work[0].jobs_count, qSumJobs, '年作业数=四季之和');
  assert.strictEqual(Math.round(yr.work[0].area_mu * 100), Math.round(qSumArea * 100), '年亩数=四季之和');
  assert.strictEqual(Math.round(yr.work[0].area_mu * 100), Math.round(areaTotal * 100));
  // customer_count 跨桶去重（4 单同 3 农户 → 恒 3）
  assert.strictEqual(yr.work[0].customer_count, 3);
});

test('by-period：pl 轴按凭证 occurred_at 分桶（测试拨时）与环比；年利润=四季利润之和', async () => {
  const r1 = await createSettledJobAt('2026-02-10');
  const r2 = await createSettledJobAt('2026-05-10');
  const inc1 = r1.st.total_receivable_cents;
  const inc2 = r2.st.total_receivable_cents;
  // 确认时点拨到固定日（默认 occurred_at=真实当前时间，无法写死桶键）
  db.prepare("UPDATE journal_entries SET occurred_at = ? WHERE event_type='settlement_confirm' AND ref_type='settlement' AND ref_id = ?")
    .run('2026-01-15T10:00:00', r1.st.id);
  db.prepare("UPDATE journal_entries SET occurred_at = ? WHERE event_type='settlement_confirm' AND ref_type='settlement' AND ref_id = ?")
    .run('2026-04-20T10:00:00', r2.st.id);

  const mon = await getJson(`${base}/reports/by-period?granularity=month`);
  assert.deepStrictEqual(mon.pl.map(r => r.period), ['2026-01', '2026-04']);
  assert.strictEqual(mon.pl[0].income_cents, inc1);
  assert.strictEqual(mon.pl[1].income_cents, inc2);
  assert.strictEqual(mon.pl[1].income_pct,
    Math.round((inc2 - inc1) / inc1 * 10000) / 100, '环比=对上一返回桶');

  const q = await getJson(`${base}/reports/by-period?granularity=quarter`);
  assert.deepStrictEqual(q.pl.map(r => r.period), ['2026-Q1', '2026-Q2']);
  assert.strictEqual(q.pl[0].income_cents, inc1);
  assert.strictEqual(q.pl[1].income_cents, inc2);

  const wk = await getJson(`${base}/reports/by-period?granularity=week`);
  assert.deepStrictEqual(wk.pl.map(r => r.period), ['2026-W02', '2026-W16'],
    '凭证轴周桶：01-15→W02、04-20→W16（strftime %W 周一始）');

  const yr = await getJson(`${base}/reports/by-period?granularity=year`);
  assert.strictEqual(yr.pl.length, 1);
  assert.strictEqual(yr.pl[0].income_cents, inc1 + inc2, '年收入=四季之和');
  assert.strictEqual(yr.pl[0].income_cents,
    q.pl.reduce((a, r) => a + r.income_cents, 0), '年合计=四季合计');
  assert.strictEqual(yr.pl[0].profit_cents,
    q.pl.reduce((a, r) => a + r.profit_cents, 0), '年利润=四季利润之和');
});

test('adjustments：正负 adjust 双语义归一（抹零=Σ|adjust|）、超收造数回收率>100%、分母 0 记 null、年=季', async () => {
  const r1 = await createSettledJob();
  const bills = db.prepare('SELECT * FROM bills WHERE settlement_id = ? ORDER BY id').all(r1.st.id);
  assert.strictEqual(bills.length, 3);
  // 手工抹零（负）与导入式抹零（正）各一笔，统一拨到 2026-02；原样账单拨 2026-03
  db.prepare('UPDATE bills SET adjust_cents = -100, issued_at = ? WHERE id = ?').run('2026-02-10', bills[0].id);
  db.prepare('UPDATE bills SET adjust_cents = 50, issued_at = ? WHERE id = ?').run('2026-02-20', bills[1].id);
  db.prepare('UPDATE bills SET issued_at = ? WHERE id = ?').run('2026-03-15', bills[2].id);

  let d = await getJson(`${base}/reports/adjustments?granularity=month`);
  const feb = d.rows.find(r => r.period === '2026-02');
  const mar = d.rows.find(r => r.period === '2026-03');
  assert.ok(feb && mar);
  assert.strictEqual(feb.billed_cents, bills[0].amount_cents + bills[1].amount_cents,
    'billed=Σamount（不含 adjust）');
  assert.strictEqual(feb.discount_cents, 150, '抹零=Σ|adjust|（正负均按优惠金额计）');
  assert.strictEqual(feb.collected_cents, 0);
  assert.strictEqual(feb.due_cents, feb.billed_cents - 150, 'due=billed−抹零（零收款）');
  assert.strictEqual(feb.collection_rate, 0);
  assert.strictEqual(feb.overpaid_cents, 0);

  // 超收造数：paid 超过 amount−|adjust|（createReceipt 超额校验保持不变，经 db 句柄直改，
  // 同导入路径落库后的账面状态：status='paid'）
  db.prepare("UPDATE bills SET paid_cents = ?, status = 'paid' WHERE id = ?")
    .run(bills[2].amount_cents + 200, bills[2].id);
  d = await getJson(`${base}/reports/adjustments?granularity=month`);
  const mar2 = d.rows.find(r => r.period === '2026-03');
  assert.strictEqual(mar2.overpaid_cents, 200, '超收=ΣMAX(0, paid−(amount−|adjust|))');
  assert.strictEqual(mar2.due_cents, 0, '已清账单不计未收');
  assert.ok(mar2.collection_rate > 100, `超收月份回收率>100%（实为 ${mar2.collection_rate}）`);
  assert.strictEqual(d.totals.overpaid_cents, 200);
  assert.ok(typeof d.note === 'string' && d.note.includes('回收率'), '响应附口径说明字段');

  // 分母 0 记 null：独立 8 月桶只放一张 0 金额账单
  const r2 = await createSettledJob();
  const b2 = db.prepare('SELECT id FROM bills WHERE settlement_id = ? ORDER BY id LIMIT 1').get(r2.st.id);
  db.prepare("UPDATE bills SET amount_cents = 0, paid_cents = 0, adjust_cents = 0, issued_at = '2026-08-15' WHERE id = ?").run(b2.id);
  d = await getJson(`${base}/reports/adjustments?granularity=month`);
  const aug = d.rows.find(r => r.period === '2026-08');
  assert.ok(aug);
  assert.strictEqual(aug.billed_cents, 0);
  assert.strictEqual(aug.collection_rate, null, '回收率分母 0 记 null');

  // 年合计 = 四季合计（billed/discount/overpaid）
  const q = await getJson(`${base}/reports/adjustments?granularity=quarter`);
  const yr = await getJson(`${base}/reports/adjustments?granularity=year`);
  assert.strictEqual(yr.rows.length, 1);
  assert.strictEqual(yr.rows[0].billed_cents, q.rows.reduce((a, r) => a + r.billed_cents, 0));
  assert.strictEqual(yr.rows[0].discount_cents, q.rows.reduce((a, r) => a + r.discount_cents, 0));
  assert.strictEqual(yr.rows[0].overpaid_cents, q.rows.reduce((a, r) => a + r.overpaid_cents, 0));
});

test('P5-M1 label：by-period/adjustments 每行带人类可读 label（period 原键不变）', async () => {
  for (const d of ['2026-01-01', '2026-03-31', '2026-04-01']) {
    await createSettledJobAt(d);
  }
  const mon = await getJson(`${base}/reports/by-period?granularity=month`);
  assert.strictEqual(mon.work.find(r => r.period === '2026-01').label, '1月');
  assert.strictEqual(mon.work.find(r => r.period === '2026-03').label, '3月');
  assert.strictEqual(mon.work.find(r => r.period === '2026-04').label, '4月');
  assert.ok(mon.pl.length && /^\d+月$/.test(mon.pl[0].label), 'pl 轴行也有 label');
  assert.ok(/^\d{4}-\d{2}$/.test(mon.work[0].period), 'period 原始键不变（跳转/拼接/缓存依赖）');

  const wk = await getJson(`${base}/reports/by-period?granularity=week`);
  assert.strictEqual(wk.work.find(r => r.period === '2026-W00').label, 'W00(01-01)');
  assert.strictEqual(wk.work.find(r => r.period === '2026-W13').label, 'W13(03-31)');

  const q = await getJson(`${base}/reports/by-period?granularity=quarter`);
  assert.strictEqual(q.work.find(r => r.period === '2026-Q1').label, 'Q1');
  const yr = await getJson(`${base}/reports/by-period?granularity=year`);
  assert.strictEqual(yr.work[0].label, '2026');

  // adjustments rows[] 同样追加 label（bills.issued_at 分桶；确认建账单 issued_at=当下，统一拨到 04-10）
  db.prepare("UPDATE bills SET issued_at = '2026-04-10T08:00:00'").run();
  const adjM = await getJson(`${base}/reports/adjustments?granularity=month`);
  assert.ok(adjM.rows.length, '有账单桶');
  assert.strictEqual(adjM.rows[0].label, '4月');
  const adjWk = await getJson(`${base}/reports/adjustments?granularity=week`);
  assert.strictEqual(adjWk.rows[0].label, 'W14(04-10)');
});

test('cost-breakdown：journal=500 科目现金口径、job=作业快照口径（导入单=0）且两口径不可相加', async () => {
  const r1 = await createSettledJob();
  await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '油费' });
  await post(`${base}/payments`, { category: 'meal', amount_cents: 3000, note: '午饭' });

  const cbj = await getJson(`${base}/reports/cost-breakdown?source=journal`);
  assert.ok(cbj.items.some(c => c.code === '5002' && c.cents === 12000));
  assert.ok(cbj.items.some(c => c.code === '5004' && c.cents === 3000));
  assert.strictEqual(cbj.total_cents, 15000);
  assert.ok(/不可相加/.test(cbj.note), 'journal 口径附不可相加说明');

  const cbJob = await getJson(`${base}/reports/cost-breakdown?source=job`);
  assert.deepStrictEqual(cbJob.items.map(i => i.key),
    ['fuel', 'battery', 'labor', 'pesticide', 'equipment', 'misc'], '六类成本齐全');
  assert.strictEqual(cbJob.total_cents, cbJob.items.reduce((a, c) => a + c.cents, 0));
  assert.ok(cbJob.total_cents > 0, '计算器样本作业有成本快照');
  assert.strictEqual(cbJob.calculator_only_cents, cbJob.total_cents, '测试作业均为 calculator 来源');
  assert.ok(/导入单成本=0/.test(cbJob.import_zero_note));
  assert.ok(/不可相加/.test(cbJob.note));

  // 同一作业改为导入来源：金额合计不变，calculator 子合计归零（合计虚低属预期）
  db.prepare("UPDATE jobs SET source = 'import' WHERE id = ?").run(r1.job.id);
  const cbImp = await getJson(`${base}/reports/cost-breakdown?source=job`);
  assert.strictEqual(cbImp.total_cents, cbJob.total_cents, '成本快照金额不变');
  assert.strictEqual(cbImp.calculator_only_cents, 0, 'calculator-only 子合计归零');
  // from/to 过滤（作业轴按 job_date）
  const cbFiltered = await getJson(`${base}/reports/cost-breakdown?source=job&from=2030-01-01`);
  assert.strictEqual(cbFiltered.total_cents, 0);
});

test('by-customer include_all：补零收入客户与欠款客户；默认口径零回归', async () => {
  await createSettledJob();
  const np = await post(`${base}/parties`, { type: 'customer', name: '零收入客户' });
  assert.strictEqual(np.ok, true, JSON.stringify(np));
  const npId = np.data.id;

  let custs = await getJson(`${base}/reports/by-customer`);
  assert.ok(!custs.some(c => c.party_id === npId), '默认口径：无收入客户不出现');

  custs = await getJson(`${base}/reports/by-customer?include_all=1`);
  const z = custs.find(c => c.party_id === npId);
  assert.ok(z, 'include_all 补出零收入客户');
  assert.strictEqual(z.income_cents, 0);
  assert.strictEqual(z.receivable_cents, 0);
  assert.strictEqual(z.prepaid_cents, 0);

  // 该客户持有欠款账单（直改既有账单归属）→ include_all 下可见欠款
  const bill = db.prepare("SELECT id, amount_cents FROM bills WHERE status = 'unpaid' LIMIT 1").get();
  db.prepare('UPDATE bills SET party_id = ? WHERE id = ?').run(npId, bill.id);
  custs = await getJson(`${base}/reports/by-customer?include_all=1`);
  const z2 = custs.find(c => c.party_id === npId);
  assert.strictEqual(z2.receivable_cents, bill.amount_cents, '期内无收入但有欠款的客户被补出');

  // 默认口径仍正常：有收入客户在列
  const def = await getJson(`${base}/reports/by-customer`);
  assert.ok(def.some(c => c.name === '张大国'));
});

/* ==================== P5-M2 总表数据条 / 占比三端点（HANDOFF-P5-PLAN §3.3） ==================== */

test('by-range：损益走账簿轴（occurred_at）、计数走作业轴（job_date）双口径 + from/to 校验', async () => {
  const bad = await (await fetch(`${base}/reports/by-range?from=2026-1-1`)).json();
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error.code, 'VALIDATION', 'from 非 YYYY-MM-DD 被拒');
  const bad2 = await (await fetch(`${base}/reports/by-range?to=2030/01/01`)).json();
  assert.strictEqual(bad2.error.code, 'VALIDATION');

  const { st } = await createSettledJobAt('2026-04-02');
  await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '油费' });
  // 收入/支出凭证统一拨到 2026-04（账簿轴按确认时点 occurred_at，测试拨时同 by-period pl 轴做法）
  db.prepare("UPDATE journal_entries SET occurred_at = '2026-04-05T09:00:00' WHERE event_type IN ('settlement_confirm','payment')").run();

  const apr = await getJson(`${base}/reports/by-range?from=2026-04-01&to=2026-04-30`);
  assert.strictEqual(apr.from, '2026-04-01');
  assert.strictEqual(apr.income_cents, st.total_receivable_cents, '收入=区间内确认结算（账簿轴）');
  assert.strictEqual(apr.expense_cents, 12000, '支出=区间内付款凭证（现金口径）');
  assert.strictEqual(apr.profit_cents, st.total_receivable_cents - 12000);
  assert.strictEqual(apr.jobs_count, 1, '单数按 job_date（作业轴）');
  assert.strictEqual(apr.customer_count, 3, '客户数=结算分项挂 party 去重');
  assert.ok(apr.area_mu > 0, '亩数来自 jobs 快照');

  const empty = await getJson(`${base}/reports/by-range?from=2030-01-01&to=2030-12-31`);
  assert.strictEqual(empty.income_cents, 0);
  assert.strictEqual(empty.jobs_count, 0);
  assert.strictEqual(empty.customer_count, 0);
});

test('by-region：地区守恒（各地区合计=Σ账单金额）、(未填) 桶返回、village 级、share_pct、level 校验', async () => {
  const bad = await (await fetch(`${base}/reports/by-region?level=street`)).json();
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error.code, 'VALIDATION', 'level 白名单校验');

  await createSettledJobAt('2026-04-02'); // 样本 3 农户 → 3 账单
  // 直改主数据区域：李秀英/王强=通安·金桂；张大国不填（进 (未填) 桶）
  db.prepare("UPDATE parties SET region = '通安', village = '金桂' WHERE name IN ('李秀英','王强')").run();

  const d = await getJson(`${base}/reports/by-region?from=2026-04-01&to=2026-04-30`);
  const totalBills = db.prepare(
    `SELECT COALESCE(SUM(b.amount_cents), 0) AS n
     FROM bills b
     JOIN settlements s ON s.id = b.settlement_id
     JOIN jobs j ON j.id = s.job_id
     WHERE b.status != 'void' AND s.status != 'void'
       AND j.deleted_at IS NULL AND j.status != 'void'
       AND j.job_date BETWEEN '2026-04-01' AND '2026-04-30'`
  ).get().n;
  assert.ok(totalBills > 0, '造数有效');
  assert.strictEqual(d.rows.reduce((a, r) => a + r.income_cents, 0), totalBills,
    '守恒：各地区合计=区间 Σ账单金额');
  assert.strictEqual(d.totals.income_cents, totalBills);
  const un = d.rows.find(r => r.label === '(未填)');
  assert.ok(un, '(未填) 桶必须返回（张大国未填区域）');
  assert.ok(un.income_cents > 0);
  const ta = d.rows.find(r => r.label === '通安');
  assert.ok(ta && ta.income_cents > 0);
  assert.strictEqual(ta.share_pct, Math.round(ta.income_cents / totalBills * 10000) / 100, 'share_pct 口径');
  assert.strictEqual(Math.round(d.rows.reduce((a, r) => a + r.share_pct, 0)), 100, 'share_pct 合计≈100%');
  assert.ok(/未填/.test(d.note), 'note 说明 (未填) 口径');

  const v = await getJson(`${base}/reports/by-region?level=village&from=2026-04-01&to=2026-04-30`);
  assert.ok(v.rows.some(r => r.label === '通安·金桂'), 'village 级 label=region·village');
  assert.ok(v.rows.some(r => r.label === '(未填)·(未填)'), 'village 级未填桶=·(未填)');
  assert.strictEqual(v.rows.reduce((a, r) => a + r.income_cents, 0), totalBills, 'village 级同样守恒');

  // 作废结算后金额退出统计（非 void 口径）
  await post(`${base}/settlements/${(await getJson(`${base}/settlements`))[0].id}/void`);
  const after = await getJson(`${base}/reports/by-region?from=2026-04-01&to=2026-04-30`);
  assert.strictEqual(after.rows.length, 0, '非 void 结算作废后无桶');
});

test('by-operator：展开计数与 jobs 一致（含未记录桶）、多人单均摊守恒（余数给首位）、单内同名去重', async () => {
  const r1 = await createSettledJobAt('2026-04-02');
  const r2 = await createSettledJobAt('2026-04-03');
  db.prepare('UPDATE jobs SET operator_names = ? WHERE id = ?').run('["李凌琦","沈鹏"]', r1.job.id);
  // r2 不填 operator_names → 未记录桶

  const d = await getJson(`${base}/reports/by-operator?from=2026-04-01&to=2026-04-30`);
  assert.strictEqual(d.totals.jobs_count, 2, '区间作业数（jobs 轴）');
  assert.strictEqual(d.rows.reduce((a, r) => a + r.jobs_count, 0), 2,
    '展开计数：r1 两人单 → 李凌琦/沈鹏各计 1 条人单');
  assert.strictEqual(d.unrecorded.jobs_count, 1, 'r2 无 operator → 未记录 1 单');
  const totalBills = db.prepare(
    `SELECT COALESCE(SUM(b.amount_cents), 0) AS n FROM bills b
     JOIN settlements s ON s.id = b.settlement_id
     WHERE b.status != 'void' AND s.status != 'void'`).get().n;
  assert.strictEqual(d.rows.reduce((a, r) => a + r.income_cents, 0) + d.unrecorded.income_cents, totalBills,
    '守恒：均摊合计+未记录=Σ账单金额');

  const li = d.rows.find(r => r.operator === '李凌琦');
  const sh = d.rows.find(r => r.operator === '沈鹏');
  assert.ok(li && sh, '两人都在列');
  const jobBills = db.prepare(
    `SELECT COALESCE(SUM(b.amount_cents), 0) AS n FROM bills b
     JOIN settlements s ON s.id = b.settlement_id
     WHERE s.job_id = ? AND b.status != 'void'`).get(r1.job.id).n;
  const half = Math.floor(jobBills / 2);
  assert.strictEqual(li.income_cents, jobBills - half, '整数分均摊余数给首位（李凌琦）');
  assert.strictEqual(sh.income_cents, half, '第二人得 floor 份');
  assert.strictEqual(li.jobs_count, 1, '李凌琦参与 r1 一单，计 1');
  assert.strictEqual(sh.jobs_count, 1, '沈鹏参与同一单，也各计 1（多人单每人计 1 单）');
  assert.strictEqual(d.unrecorded.jobs_count, 1, '未记录单数');
  assert.strictEqual(d.unrecorded.income_cents, totalBills - jobBills, '未记录金额=r2 单账单合计');
  assert.ok(d.rows[0].share_pct != null && /均摊/.test(d.note));

  // 单内同名去重：计数不虚增
  db.prepare('UPDATE jobs SET operator_names = ? WHERE id = ?').run('["甲","甲","乙"]', r2.job.id);
  const d2 = await getJson(`${base}/reports/by-operator?from=2026-04-01&to=2026-04-30`);
  const jia = d2.rows.find(r => r.operator === '甲');
  assert.strictEqual(jia.jobs_count, 1, '单内同名去重，每人计 1 单');
  assert.strictEqual(d2.rows.reduce((a, r) => a + r.jobs_count, 0), 4,
    '2 单展开：李凌琦+沈鹏+甲+乙=4 条人单');
  assert.strictEqual(d2.unrecorded.jobs_count, 0, 'r2 补了 operator，未记录归零');
  assert.strictEqual(d2.totals.jobs_count, 2, '作业数不随展开变化');
  const bad = await (await fetch(`${base}/reports/by-operator?from=x`)).json();
  assert.strictEqual(bad.error.code, 'VALIDATION');
});
