/* ============================================================
   reversal-regression.test.js — 红冲目标检索回归（审查 R1 修复验证）
   背景：原实现按「第一条 active 分录」取红冲目标，而红冲后原分录保持
   active（journal.js 审计红线），编辑/作废已编辑过的单据会重复红冲最初
   分录 → 现金负数、幽灵收入/应收。修复 = findActiveEntry：排除已被
   reversal_of 指向者，按 id 倒序取最新未红冲分录。
   三组回归：编辑两次 / 编辑后作废 / 撤回改数再撤回；另覆盖
   updatePayment 重过账回读贷方科目（payments 无 method 列）。
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildApp } = require('../../server/index');
const { freshDb } = require('./helpers/db');

const SAMPLE = require(path.join(__dirname, '..', '..', 'docs', 'export-json-sample.json'));

let db, server, base;

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
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function patch(url, body) {
  const res = await fetch(base + url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function getJson(url) { return (await (await fetch(base + url)).json()).data; }

function assertBalanced() {
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) AS d,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) AS c
     FROM journal_lines`).get();
  assert.strictEqual(t.d, t.c, `借贷不平 ${t.d} vs ${t.c}`);
}

/** 某单据全部相关分录（含红冲）的 id / 被红冲指向情况 */
function entriesOf(refType, refId) {
  return db.prepare(
    `SELECT id, event_type, reversal_of,
       (SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents END),0) FROM journal_lines WHERE entry_id=e.id) AS debit,
       (SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents END),0) FROM journal_lines WHERE entry_id=e.id) AS credit
     FROM journal_entries e WHERE ref_type=? AND ref_id=? ORDER BY id`).all(refType, refId);
}

/** 每条被红冲分录的指向必须唯一（重复指向 = 同一分录被红冲两次） */
function assertNoDoubleReversal(refType, refId) {
  const dup = db.prepare(
    `SELECT reversal_of, COUNT(*) AS n FROM journal_entries
     WHERE event_type='reversal' AND ref_type=? AND ref_id=? AND reversal_of IS NOT NULL
     GROUP BY reversal_of HAVING n > 1`).all(refType, refId);
  assert.deepStrictEqual(dup, [], `存在被红冲多次的分录: ${JSON.stringify(dup)}`);
}

/** 某单据全部相关分录（含红冲）在指定科目上的净额（借-贷） */
function netForAccount(refType, refId, code) {
  return db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN l.direction='debit' THEN l.amount_cents ELSE -l.amount_cents END),0) AS v
     FROM journal_lines l JOIN accounts a ON a.id=l.account_id
     WHERE a.code=? AND l.entry_id IN (SELECT id FROM journal_entries WHERE ref_type=? AND ref_id=?)`)
    .get(code, refType, refId).v;
}

/** 最新未红冲分录的指定方向行科目（独立于服务端 findActiveEntry 的行为断言） */
function newestEntryLineCode(refType, refId, eventType, direction) {
  const e = db.prepare(
    `SELECT id FROM journal_entries
     WHERE ref_type=? AND ref_id=? AND event_type=? AND status='active'
       AND id NOT IN (SELECT reversal_of FROM journal_entries WHERE reversal_of IS NOT NULL)
     ORDER BY id DESC LIMIT 1`).get(refType, refId, eventType);
  assert.ok(e, '存在未红冲的最新分录');
  const line = db.prepare(
    `SELECT a.code FROM journal_lines l JOIN accounts a ON a.id=l.account_id
     WHERE l.entry_id=? AND l.direction=? ORDER BY l.id LIMIT 1`).get(e.id, direction);
  return line ? line.code : null;
}

async function setupBill() { // 作业→结算→确认→取一张账单
  const job = (await post('/jobs', {
    client_job_id: 'rev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    job_type: 'spray', job_date: '2026-09-29',
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  })).data;
  const st = (await post('/settlements', { job_id: job.id })).data;
  await post(`/settlements/${st.id}/confirm`);
  const b = (await getJson('/bills')).find(x => x.party_name === '李秀英');
  return { job, st, bill: b };
}

/* ---------- 组1：编辑两次 ---------- */

test('回归-编辑两次收款：第二次编辑红冲的是上一次编辑的分录，不再重复红冲最初分录', async () => {
  const { bill } = await setupBill();
  // 李秀英账单应收 659.20 元，收款/改额都控制在额度内
  const r = (await post('/receipts', { bill_id: bill.id, party_id: bill.party_id, amount_cents: 60000, method: 'cash' })).data;

  await patch(`/receipts/${r.id}`, { amount_cents: 40000 });           // 编辑1：600 → 400
  await patch(`/receipts/${r.id}`, { amount_cents: 25000 });           // 编辑2：400 → 250

  assertNoDoubleReversal('receipt', r.id);
  const es = entriesOf('receipt', r.id);
  assert.strictEqual(es.length, 5, '原分录 + 红冲1 + 改1 + 红冲2 + 改2');
  // 两次红冲指向不同分录，且第二次红冲的是第一次编辑产生的新分录（id 递增）
  const targets = es.filter(e => e.event_type === 'reversal').map(e => e.reversal_of);
  assert.ok(targets[0] < targets[1], `第二次红冲对象应更新: ${targets}`);
  // 净额：现金 +250 元；应收被核销 -250 元；无幽灵
  assert.strictEqual(netForAccount('receipt', r.id, '1001'), 25000, `现金净额应为 250 元，实际 ${netForAccount('receipt', r.id, '1001') / 100}`);
  assert.strictEqual(netForAccount('receipt', r.id, '1122'), -25000, '应收核销净额 -250 元');
  const b2 = (await getJson('/bills')).find(x => x.id === bill.id);
  assert.strictEqual(b2.paid_cents, 25000, '账单 paid 与最终金额一致');
  assert.strictEqual(b2.status, 'partial');
  assertBalanced();
});

test('回归-编辑两次支出：第二次编辑红冲最新分录，现金净额不出现负数幽灵', async () => {
  const p = (await post('/payments', { category: 'fuel', amount_cents: 100000, method: 'cash' })).data;
  await patch(`/payments/${p.id}`, { amount_cents: 70000 });
  await patch(`/payments/${p.id}`, { amount_cents: 30000 });

  assertNoDoubleReversal('payment', p.id);
  const es = entriesOf('payment', p.id);
  assert.strictEqual(es.length, 5, '原分录 + 红冲1 + 改1 + 红冲2 + 改2');
  assert.strictEqual(netForAccount('payment', p.id, '1001'), -30000, `现金净流出 300 元，实际 ${netForAccount('payment', p.id, '1001') / 100}`);
  assert.strictEqual(netForAccount('payment', p.id, '5002'), 30000, '油费净额 300 元');
  assertBalanced();
});

/* ---------- 组2：编辑后作废 ---------- */

test('回归-编辑后作废收款：作废红冲的是编辑后的最新分录，整单净额归零', async () => {
  const { bill } = await setupBill();
  const r = (await post('/receipts', { bill_id: bill.id, party_id: bill.party_id, amount_cents: 60000, method: 'cash' })).data;
  await patch(`/receipts/${r.id}`, { amount_cents: 30000 });           // 先编辑 600 → 300
  const vd = await post(`/receipts/${r.id}/void`);
  assert.strictEqual(vd.ok, true, JSON.stringify(vd));

  assertNoDoubleReversal('receipt', r.id);
  const es = entriesOf('receipt', r.id);
  const last = es[es.length - 1];
  assert.strictEqual(last.event_type, 'reversal', '最后一条是作废红冲');
  const edited = es.find(e => e.event_type === 'receipt' && e.credit === 30000 && e.debit === 30000);
  assert.strictEqual(last.reversal_of, edited.id, '作废红冲指向编辑后的 300 分录，而非最初的 600 分录');
  // 整单净额归零：现金 0、应收核销 0
  assert.strictEqual(netForAccount('receipt', r.id, '1001'), 0, '现金净额必须归零');
  assert.strictEqual(netForAccount('receipt', r.id, '1122'), 0, '应收核销净额必须归零');
  const b2 = (await getJson('/bills')).find(x => x.id === bill.id);
  assert.strictEqual(b2.paid_cents, 0, '账单回退到未收');
  assert.strictEqual(b2.status, 'unpaid');
  assertBalanced();
});

test('回归-编辑后作废支出：作废红冲编辑后分录，现金净额归零', async () => {
  const p = (await post('/payments', { category: 'meal', amount_cents: 90000, method: 'wechat' })).data;
  await patch(`/payments/${p.id}`, { amount_cents: 40000 });
  const vd = await post(`/payments/${p.id}/void`);
  assert.strictEqual(vd.ok, true, JSON.stringify(vd));

  assertNoDoubleReversal('payment', p.id);
  assert.strictEqual(netForAccount('payment', p.id, '1002'), 0, '微信科目净额归零（原实现会错红冲最初分录留下幽灵）');
  assert.strictEqual(netForAccount('payment', p.id, '5004'), 0, '餐费科目净额归零');
  assertBalanced();
});

/* ---------- 组3：撤回改数再撤回（结算 confirm/reopen 循环） ---------- */

test('回归-撤回改数再确认再撤回：每次撤回红冲当次 confirm 分录，净额归零', async () => {
  const { job, st } = await setupBill();

  await post(`/settlements/${st.id}/confirm`);                          // confirm1
  const ro1 = await post(`/settlements/${st.id}/reopen`);               // 撤回1
  assert.strictEqual(ro1.ok, true);
  const item = ro1.data.items[0];
  await patch(`/settlements/${st.id}`, { items: [{ id: item.id, spray_fee_cents: 12345 }] }); // 改数
  await post(`/settlements/${st.id}/confirm`);                          // confirm2
  const ro2 = await post(`/settlements/${st.id}/reopen`);               // 撤回2
  assert.strictEqual(ro2.ok, true);

  const es = entriesOf('settlement', st.id);
  const confirms = es.filter(e => e.event_type === 'settlement_confirm');
  const reversals = es.filter(e => e.event_type === 'reversal');
  assert.strictEqual(confirms.length, 2, '两次确认两条分录');
  assert.strictEqual(reversals.length, 2, '两次撤回两条红冲');
  assert.deepStrictEqual(
    reversals.map(r => r.reversal_of).sort((a, b) => a - b),
    confirms.map(c => c.id).sort((a, b) => a - b),
    '每条 confirm 分录各被红冲一次（原实现第二次撤回会重复红冲第一条）');
  // 1122 净额归零（确认借入又被红冲/撤回清干净）
  assert.strictEqual(netForAccount('settlement', st.id, '1122'), 0, '应收净额归零');
  assert.strictEqual(netForAccount('settlement', st.id, '6001'), 0, '作业收入净额归零');
  const j = (await getJson(`/jobs/${job.id}`));
  assert.strictEqual(j.status, 'reopened', '作业回到 reopened');
  assert.ok(ro2.data.bills.every(b => b.status === 'void'), '账单全部作废');
  assertBalanced();
});

test('回归-作废已确认结算（撤回后未 reopen 路径）：红冲最新 confirm 分录，收入净额归零', async () => {
  const { st } = await setupBill();
  await post(`/settlements/${st.id}/confirm`);
  const vd = await post(`/settlements/${st.id}/void`);
  assert.strictEqual(vd.ok, true, JSON.stringify(vd));

  assertNoDoubleReversal('settlement', st.id);
  assert.strictEqual(netForAccount('settlement', st.id, '1122'), 0, '应收净额归零');
  assert.strictEqual(netForAccount('settlement', st.id, '6001'), 0, '收入净额归零');
  assertBalanced();
});

/* ---------- updatePayment：重过账回读原贷方科目（payments 无 method 列） ---------- */

test('回归-编辑支出不带 method：微信付款重过账仍记 1002，不再硬编码回退现金', async () => {
  const p = (await post('/payments', { category: 'repair', amount_cents: 20000, method: 'wechat' })).data;
  assert.strictEqual(newestEntryLineCode('payment', p.id, 'payment', 'credit'), '1002');
  const up = await patch(`/payments/${p.id}`, { amount_cents: 25000 });  // 不传 method
  assert.strictEqual(up.ok, true, JSON.stringify(up));
  assert.strictEqual(newestEntryLineCode('payment', p.id, 'payment', 'credit'), '1002',
    '重过账贷方应沿用原微信科目');
  assert.strictEqual(netForAccount('payment', p.id, '1002'), -25000, '微信净流出 250 元');
  assert.strictEqual(netForAccount('payment', p.id, '1001'), 0, '现金不得被误记');
  assertBalanced();
});

test('回归-编辑支出不带 method：显式 method 可改科目；预支付款（1221）重过账不变成现金', async () => {
  // 显式改支付宝
  const p1 = (await post('/payments', { category: 'meal', amount_cents: 5000, method: 'cash' })).data;
  await patch(`/payments/${p1.id}`, { amount_cents: 6000, method: 'alipay' });
  assert.strictEqual(newestEntryLineCode('payment', p1.id, 'payment', 'credit'), '1003', '显式 method 生效');

  // 员工预支付款的支出：贷方 1221；编辑金额（不传 method）→ 仍 1221
  const c = (await post('/parties', { type: 'employee', name: '回归员工' })).data;
  const adv = (await post('/advances', { party_id: c.id, direction: 'advance_to_worker', amount_cents: 100000 })).data;
  const p2 = (await post('/payments', { category: 'labor', amount_cents: 30000, from_advance_id: adv.id })).data;
  assert.strictEqual(newestEntryLineCode('payment', p2.id, 'payment', 'credit'), '1221');
  await patch(`/payments/${p2.id}`, { amount_cents: 20000 });
  assert.strictEqual(newestEntryLineCode('payment', p2.id, 'payment', 'credit'), '1221',
    '预支付款重过账不得改记现金');
  assert.strictEqual(netForAccount('payment', p2.id, '1001'), 0, '现金不得被误记');
  assertBalanced();
});
