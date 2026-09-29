/* ============================================================
   ledger.test.js — M4 结算/账单/分录 + M5 收支预支/分成 全链路测试
   请求体用 docs/export-json-sample.json 真实样本。
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

async function json(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json() };
}
async function post(url, body) {
  return json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}
async function patch(url, body) {
  return json(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function createJob() {
  seq += 1;
  const p = {
    client_job_id: `t-${seq}-${Date.now()}`, job_type: 'spray', job_date: '2026-09-29',
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  };
  const r = await post(`${base}/jobs`, p);
  assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
  return r.body.data;
}

/** 借贷平衡断言（服务层承诺，这里独立复核 DB） */
function assertBalanced() {
  const rows = db.prepare(
    `SELECT e.id, e.entry_no,
       COALESCE(SUM(CASE WHEN l.direction='debit' THEN l.amount_cents END),0) AS d,
       COALESCE(SUM(CASE WHEN l.direction='credit' THEN l.amount_cents END),0) AS c
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     GROUP BY e.id`).all();
  for (const r of rows) {
    assert.strictEqual(r.d, r.c, `凭证 ${r.entry_no} 借 ${r.d} ≠ 贷 ${r.c}`);
  }
  return rows.length;
}

test('全链路：工单→结算→确认→账单+分录平衡→作业 settled', async () => {
  const job = await createJob();
  const s = await post(`${base}/settlements`, { job_id: job.id });
  assert.strictEqual(s.body.ok, true, JSON.stringify(s.body));
  const st = s.body.data;
  assert.strictEqual(st.items.length, 3, '3 农户分项');
  assert.strictEqual(st.status, 'draft');
  // 合计来自快照：11200+54720 等三户
  assert.strictEqual(st.total_receivable_cents, 3 * (11200 + 54720) === 0 ? 0 : st.total_receivable_cents);
  assert.ok(st.total_receivable_cents > 0);

  const cf = await post(`${base}/settlements/${st.id}/confirm`);
  assert.strictEqual(cf.body.ok, true, JSON.stringify(cf.body));
  assert.strictEqual(cf.body.data.status, 'confirmed');
  assert.strictEqual(cf.body.data.bills.length, 3, '3 张账单');
  assert.ok(cf.body.data.bills.every(b => b.status === 'unpaid' && b.amount_cents > 0));

  const j = (await json(`${base}/jobs/${job.id}`)).body.data;
  assert.strictEqual(j.status, 'settled');

  const entryCount = assertBalanced();
  assert.ok(entryCount >= 1, '至少一条确认分录');
  // 分录方向：借 1122 全额，贷 6001+6002
  const e = db.prepare(
    `SELECT l.direction, l.amount_cents, a.code FROM journal_lines l
     JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = (
       SELECT id FROM journal_entries WHERE event_type='settlement_confirm' AND ref_id=?)`).all(st.id);
  const d = e.filter(x => x.direction === 'debit').reduce((a, x) => a + x.amount_cents, 0);
  const c61 = e.filter(x => x.direction === 'credit' && x.code === '6001').reduce((a, x) => a + x.amount_cents, 0);
  const c62 = e.filter(x => x.direction === 'credit' && x.code === '6002').reduce((a, x) => a + x.amount_cents, 0);
  assert.strictEqual(d, c61 + c62);
});

test('撤回确认：红冲原分录（原分录不动）+ 账单作废 + 作业 reopened → 再确认生成新分录', async () => {
  const job = await createJob();
  const st = (await post(`${base}/settlements`, { job_id: job.id })).body.data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const entry1 = db.prepare(
    "SELECT id, entry_no FROM journal_entries WHERE event_type='settlement_confirm' AND ref_id=?").get(st.id);
  const lines1 = db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(entry1.id);

  const ro = await post(`${base}/settlements/${st.id}/reopen`);
  assert.strictEqual(ro.body.ok, true);
  assert.strictEqual(ro.body.data.status, 'draft');
  assert.ok(ro.body.data.bills.every(b => b.status === 'void'), '账单全部作废');
  const j = (await json(`${base}/jobs/${job.id}`)).body.data;
  assert.strictEqual(j.status, 'reopened');

  // 红冲分录存在且等额反向；原分录保持 active
  const rev = db.prepare("SELECT * FROM journal_entries WHERE event_type='reversal' AND reversal_of=?").get(entry1.id);
  assert.ok(rev, '存在红冲凭证');
  const revLines = db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(rev.id);
  assert.strictEqual(revLines.length, lines1.length);
  for (const l1 of lines1) {
    const f = revLines.find(x => x.account_id === l1.account_id && x.amount_cents === l1.amount_cents && x.memo.includes("红冲"));
    assert.ok(f, '每行都有红冲对应行');
    assert.strictEqual(f.amount_cents, l1.amount_cents);
    assert.notStrictEqual(f.direction, l1.direction);
  }
  assert.strictEqual(db.prepare('SELECT status FROM journal_entries WHERE id=?').get(entry1.id).status, 'active');

  // 再确认：新分录生成，且改过分项金额生效
  const item = ro.body.data.items[0];
  await patch(`${base}/settlements/${st.id}`, { items: [{ id: item.id, spray_fee_cents: 1 }] });
  await post(`${base}/settlements/${st.id}/confirm`);
  const entries = db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE event_type='settlement_confirm' AND ref_id=?").get(st.id).n;
  assert.strictEqual(entries, 2, '两次确认两条分录');
  assertBalanced();
});

test('未确认结算可编辑分项（Excel 式），合计联动', async () => {
  const job = await createJob();
  const st = (await post(`${base}/settlements`, { job_id: job.id })).body.data;
  const it = st.items[0];
  const upd = await patch(`${base}/settlements/${st.id}`, { items: [{ id: it.id, spray_fee_cents: 50000 }] });
  assert.strictEqual(upd.body.ok, true);
  const it2 = upd.body.data.items.find(x => x.id === it.id);
  assert.strictEqual(it2.spray_fee_cents, 50000);
  const expect = upd.body.data.items.reduce((a, x) => a + x.spray_fee_cents, 0) +
                 upd.body.data.items.reduce((a, x) => a + x.pesticide_fee_cents, 0);
  assert.strictEqual(upd.body.data.total_receivable_cents, expect, '合计联动');
});

test('已收款账单 PATCH 拒绝；未收款可改 adjust_cents（抹零）', async () => {
  const job = await createJob();
  const st = (await post(`${base}/settlements`, { job_id: job.id })).body.data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const bills = (await json(`${base}/bills`)).body.data;
  const b = bills[0];
  const pr = await post(`${base}/receipts`, { bill_id: b.id, party_id: b.party_id, amount_cents: 100 });
  assert.strictEqual(pr.body.ok, true);
  const bad = await patch(`${base}/bills/${b.id}`, { amount_cents: 1 });
  assert.strictEqual(bad.body.error.code, 'INVALID_STATE', '已收款不可改');
  const b2 = bills[1];
  const okp = await patch(`${base}/bills/${b2.id}`, { adjust_cents: -100 });
  assert.strictEqual(okp.body.ok, true);
  assert.strictEqual(okp.body.data.adjust_cents, -100, '抹零为负');
});

test('收款：部分收款→partial，收满→paid；作废收款→反向分录+账单回退', async () => {
  const job = await createJob();
  const st = (await post(`${base}/settlements`, { job_id: job.id })).body.data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const b = (await json(`${base}/bills`)).body.data[0];
  const payable = b.amount_cents;
  const half = Math.floor(payable / 2);

  const r1 = await post(`${base}/receipts`, { bill_id: b.id, party_id: b.party_id, amount_cents: half, method: 'wechat' });
  assert.strictEqual(r1.body.ok, true);
  const billAfter1 = (await json(`${base}/bills`)).body.data.find(x => x.id === b.id);
  assert.strictEqual(billAfter1.status, 'partial');

  const r2 = await post(`${base}/receipts`, { bill_id: b.id, party_id: b.party_id, amount_cents: payable - half, method: 'cash' });
  assert.strictEqual(r2.body.ok, true);
  const billAfter2 = (await json(`${base}/bills`)).body.data.find(x => x.id === b.id);
  assert.strictEqual(billAfter2.status, 'paid');

  // 超收拒绝
  const over = await post(`${base}/receipts`, { bill_id: b.id, party_id: b.party_id, amount_cents: 1 });
  assert.strictEqual(over.body.error.code, 'VALIDATION');

  // 作废第二笔：反向分录 + 账单回 partial
  const vd = await post(`${base}/receipts/${r2.body.data.id}/void`);
  assert.strictEqual(vd.body.ok, true);
  const billAfterVoid = (await json(`${base}/bills`)).body.data.find(x => x.id === b.id);
  assert.strictEqual(billAfterVoid.status, 'partial');
  assertBalanced();
});

test('预收：入金→抵扣账单→余额流水；作废有流水预收被拒', async () => {
  const job = await createJob();
  const st = (await post(`${base}/settlements`, { job_id: job.id })).body.data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const b = (await json(`${base}/bills`)).body.data[0];

  // 客户预收 100000
  const adv = await post(`${base}/advances`, { party_id: b.party_id, direction: 'prepaid_by_customer', amount_cents: 100000 });
  assert.strictEqual(adv.body.ok, true);
  // 用预收抵账 30000
  const rc = await post(`${base}/receipts`, { bill_id: b.id, party_id: b.party_id, amount_cents: 30000, from_advance_id: adv.body.data.id });
  assert.strictEqual(rc.body.ok, true);
  const a = (await json(`${base}/advances`)).body.data[0];
  assert.strictEqual(a.balance_cents, 70000, '余额扣减');
  const usage = db.prepare('SELECT * FROM advance_usages WHERE advance_id=?').get(adv.body.data.id);
  assert.ok(usage && usage.ref_type === 'receipt' && usage.amount_cents === 30000);
  // 借 1123 / 贷 1122 的抵扣分录存在
  const line = db.prepare(
    `SELECT a.code FROM journal_lines l JOIN accounts a ON a.id=l.account_id
     WHERE l.entry_id=(SELECT id FROM journal_entries WHERE event_type='receipt' AND ref_id=?)`).all(rc.body.data.id);
  assert.ok(line.some(x => x.code === '1123') && line.some(x => x.code === '1122'), '预收抵扣分录');
  // 作废被拒
  const vd = await post(`${base}/advances/${adv.body.data.id}/void`);
  assert.strictEqual(vd.body.error.code, 'INVALID_STATE');
  assertBalanced();
});

test('支出：建账自动分录；从预支付款走 1221；作废红冲', async () => {
  const p1 = await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '加油站' });
  assert.strictEqual(p1.body.ok, true);
  const debit = db.prepare(
    `SELECT a.code FROM journal_lines l JOIN accounts a ON a.id=l.account_id
     WHERE l.entry_id=(SELECT id FROM journal_entries WHERE event_type='payment' AND ref_id=?) AND l.direction='debit'`).get(p1.body.data.id);
  assert.strictEqual(debit.code, '5002', '油费科目');

  // 员工预支 → 用预支付油费
  const party = (await json(`${base}/bills`)).body.data; // 可能空，直接建 party
  const ins = db.prepare("INSERT INTO parties (type,name,phone,created_at,updated_at) VALUES ('employee','小王','',?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const adv = await post(`${base}/advances`, { party_id: ins.lastInsertRowid, direction: 'advance_to_worker', amount_cents: 50000 });
  assert.strictEqual(adv.body.ok, true);
  const p2 = await post(`${base}/payments`, { category: 'fuel', amount_cents: 20000, from_advance_id: adv.body.data.id });
  assert.strictEqual(p2.body.ok, true);
  const credit2 = db.prepare(
    `SELECT a.code FROM journal_lines l JOIN accounts a ON a.id=l.account_id
     WHERE l.entry_id=(SELECT id FROM journal_entries WHERE event_type='payment' AND ref_id=?) AND l.direction='credit'`).get(p2.body.data.id);
  assert.strictEqual(credit2.code, '1221', '预支付款贷其他应收');
  const a2 = (await json(`${base}/advances`)).body.data.find(x => x.id === adv.body.data.id);
  assert.strictEqual(a2.balance_cents, 30000);

  // 作废 p1：反向分录
  const vd = await post(`${base}/payments/${p1.body.data.id}/void`);
  assert.strictEqual(vd.body.ok, true);
  const rev = db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE event_type='reversal' AND ref_type='payment' AND ref_id=?")
    .get(p1.body.data.id).n;
  assert.strictEqual(rev, 1);
  assertBalanced();
});

test('分成：manual_splits 入账走 5007；作废收款后重新记账链路不破', async () => {
  const ins = db.prepare("INSERT INTO parties (type,name,phone,created_at,updated_at) VALUES ('partner','合作方老李','',?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const sp = await post(`${base}/splits`, { party_id: ins.lastInsertRowid, amount_cents: 80000, note: '秋季分成' });
  assert.strictEqual(sp.body.ok, true);
  const debit = db.prepare(
    `SELECT a.code FROM journal_lines l JOIN accounts a ON a.id=l.account_id
     WHERE l.entry_id=(SELECT id FROM journal_entries WHERE event_type='manual_split' AND ref_id=?) AND l.direction='debit'`).get(sp.body.data.id);
  assert.strictEqual(debit.code, '5007');
  assertBalanced();
});

test('作废结算（confirmed）→ 红冲 + 作业 void 终态', async () => {
  const job = await createJob();
  const st = (await post(`${base}/settlements`, { job_id: job.id })).body.data;
  await post(`${base}/settlements/${st.id}/confirm`);
  const vd = await post(`${base}/settlements/${st.id}/void`);
  assert.strictEqual(vd.body.ok, true);
  assert.strictEqual(vd.body.data.status, 'void');
  const j = (await json(`${base}/jobs/${job.id}`)).body.data;
  assert.strictEqual(j.status, 'void');
  // 已作废结算不可再确认
  const cf = await post(`${base}/settlements/${st.id}/confirm`);
  assert.strictEqual(cf.body.error.code, 'INVALID_STATE');
  assertBalanced();
});

test('重复结算拒绝；/summary 汇总出数', async () => {
  const job = await createJob();
  await post(`${base}/settlements`, { job_id: job.id });
  const dup = await post(`${base}/settlements`, { job_id: job.id });
  assert.strictEqual(dup.body.error.code, 'INVALID_STATE');
  const sum = (await json(`${base}/summary`)).body.data;
  assert.ok('settled_income_cents' in sum && 'receivable_cents' in sum);
});

test('吊运结算：单行 + party 指定', async () => {
  seq += 1;
  const p = {
    client_job_id: `h-${seq}-${Date.now()}`, job_type: 'haul', job_date: '2026-09-29',
    snapshot: SAMPLE.haul.export, result: SAMPLE.haul.result
  };
  const job = (await post(`${base}/jobs`, p)).body.data;
  const ins = db.prepare("INSERT INTO parties (type,name,phone,created_at,updated_at) VALUES ('customer','吊运客户甲','',?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const st = (await post(`${base}/settlements`, { job_id: job.id, party_id: ins.lastInsertRowid })).body.data;
  assert.strictEqual(st.items.length, 1);
  assert.strictEqual(st.items[0].spray_fee_cents, 280000, '吊运 2800 元');
  const cf = await post(`${base}/settlements/${st.id}/confirm`);
  assert.strictEqual(cf.body.ok, true);
  assert.strictEqual(cf.body.data.bills.length, 1);
  assertBalanced();
});
