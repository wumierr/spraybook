/* ============================================================
   sync.test.js — M3 同步适配层测试（node:test + vm 壳）
   运行：node tests/sync.test.js   或   node --test tests/
   注意：vm 环境故意不给 fetch / document —— 验证离线行为与 DOM 守卫
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');

const fakeStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
const ctx = vm.createContext({
  window: { localStorage: fakeStorage },   // sync.js 用 window.localStorage
  console,
  navigator: {},
  localStorage: fakeStorage                // storage.js 用顶层 localStorage
});
for (const f of ['js/data.js', 'js/calculator.js', 'js/storage.js', 'js/sync.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}

function eq(actual, expected, msg = '') {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}
function ok(cond, msg = '') { assert.ok(cond, msg); }

const S = vm.runInContext('window.SpraySync', ctx);

function makeState() {
  return vm.runInContext(`({
    mode: 'spray',
    plant: { ...PLANT_DATABASE.shajun },
    field: { ...DEFAULT_FIELD,
      plots: [{ id: 'p1', name: '测试地块', area: 10, groupId: 1, farmerId: 'f1' }],
      drawReserve: 40, manualDosePerMu: 1.2 },
    costs: { ...DEFAULT_COSTS, pesticidePrice: 80, fuelExpense: 120, batteryDepreciation: 3 },
    income: { ...DEFAULT_INCOME, pricePerMu: 8 },
    timing: { ...DEFAULT_TIMING },
    workOrder: { actualSets: 5, note: '测试备注', completedByPlot: { p1: 100 }, selfByFarmer: { f1: 1 } },
    farmers: [{ id: 'f1', name: '测试户', phone: '13800000000', pricePerMu: 8, enabled: true, plotTemplate: { area: 10 } }],
    batteries: null,
    typeLibrary: []
  })`, ctx);
}

function lastResult(state) {
  return vm.runInContext('window.Calculator', ctx).computePlots(state);
}

function resetQueue() {
  fakeStorage._d = {}; // 共享 vm：清 localStorage 残留（含队列与配置）
}

/* ---------- job_no / uuid / 日期 / 退避 ---------- */

test('genJobNo：YYYYMMDD-XXXX，字符集无易混 I O 0 1', () => {
  for (let i = 0; i < 200; i++) {
    const no = S.genJobNo('2026-09-29');
    ok(/^[0-9]{8}-[A-Z2-9]{4}$/.test(no), `非法单号 ${no}`);
  }
});

test('genJobNo：可注入随机数（确定性）', () => {
  eq(S.genJobNo('2026-09-29', () => 0), '20260929-AAAA');
});

test('localDateStr：用本地日期不用 UTC（晚上 21:30 不跨天）', () => {
  eq(S.localDateStr(new Date(2026, 8, 29, 21, 30, 0)), '2026-09-29');
});

test('nextRetryDelayMs 退避：1/5/30 分钟封顶', () => {
  eq(S.nextRetryDelayMs(1), 60000);
  eq(S.nextRetryDelayMs(2), 300000);
  eq(S.nextRetryDelayMs(3), 1800000);
  eq(S.nextRetryDelayMs(9), 1800000);
});

test('isDead：10 次转 dead', () => {
  eq(S.isDead(9), false);
  eq(S.isDead(10), true);
});

test('uuid：两次调用不重复', () => {
  ok(S.uuid() !== S.uuid());
});

/* ---------- buildJobPayload ---------- */

test('buildJobPayload：快照+结果完整，本地日期与备注进 payload', () => {
  const state = makeState();
  const payload = S.buildJobPayload(state, lastResult(state), 'spray', new Date(2026, 8, 29, 21, 30));
  ok(payload, 'payload 应非空');
  ok(/^[0-9]{8}-[A-Z2-9]{4}$/.test(payload.job_no), `job_no 格式 ${payload.job_no}`);
  ok(payload.job_no.startsWith('20260929-'), 'job_no 用本地日期');
  ok(payload.client_job_id && payload.client_job_id.length >= 10, 'client_job_id 存在');
  eq(payload.job_type, 'spray');
  eq(payload.job_date, '2026-09-29');
  eq(payload.note, '测试备注');
  eq(payload.snapshot.plant.name, state.plant.name, 'snapshot.plant 快照');
  eq(payload.snapshot.farmers.length, 1, 'snapshot.farmers');
  ok(payload.snapshot.costs && payload.snapshot.costs.pesticidePrice === 80, 'snapshot.costs');
  eq(payload.result.settlement.length, 1, 'result.settlement 快照');
  ok(payload.result.totalTrips > 0, 'result.totalTrips');
});

test('buildJobPayload：两次调用 client_job_id 必不同', () => {
  const state = makeState();
  const r = lastResult(state);
  ok(S.buildJobPayload(state, r, 'spray').client_job_id !==
     S.buildJobPayload(state, r, 'spray').client_job_id);
});

test('buildJobPayload：缺 state/result 返回 null', () => {
  eq(S.buildJobPayload(null, null, 'spray'), null);
  eq(S.buildJobPayload(makeState(), null, 'spray'), null);
});

test('buildJobPayload：haul 模式 job_type 正确', () => {
  const state = makeState();
  state.mode = 'haul';
  const payload = S.buildJobPayload(state, { totalWeight: 100 }, 'haul');
  eq(payload.job_type, 'haul');
});

/* ---------- 队列与离线行为（vm 无 fetch = 离线） ---------- */

test('队列 save/load 往返', () => {
  resetQueue();
  const q = { v: 1, queue: [{ client_job_id: 'x1', status: 'pending' }] };
  S._queue.save(q);
  eq(S._queue.load().queue.length, 1);
  eq(S._queue.load().queue[0].client_job_id, 'x1');
});

test('enqueueCurrent：未配置服务器返回 disabled，不写队列', () => {
  resetQueue();
  const state = makeState();
  ctx.window.UI = { state, _lastResult: lastResult(state) };
  const r = S.enqueueCurrent();
  eq(r.ok, false);
  eq(r.reason, 'disabled');
  eq(S._queue.load().queue.length, 0);
});

test('（async）配置后入队；离线 flush 后 entry 仍 pending、attempts 不累加', async () => {
  resetQueue();
  const state = makeState();
  ctx.window.UI = { state, _lastResult: lastResult(state) };
  S.setSettings('http://192.168.1.5:8080', true);
  const r = S.enqueueCurrent();
  eq(r.ok, true);
  ok(r.job_no && r.client_job_id, '入队返回单号与幂等键');
  eq(S._queue.load().queue.length, 1);
  eq(S.getStatus().pending, 1);
  await new Promise(r => setTimeout(r, 20)); // 等 enqueueCurrent 内部那次 flushNow 单飞结束
  const acc = await S.flushNow();
  eq(acc.offline, true, '应报告离线');
  const entry = S._queue.load().queue[0];
  eq(entry.status, 'pending', '离线不改变状态');
  eq(entry.attempts, 0, '探测门：不累加 attempts');
});

test('（async）getStatus 汇总与 requeueFailed', async () => {
  resetQueue();
  const state = makeState();
  ctx.window.UI = { state, _lastResult: lastResult(state) };
  S.setSettings('http://192.168.1.5:8080', true);
  S.enqueueCurrent();
  const q = S._queue.load();
  q.queue[0].status = 'dead';
  q.queue[0].attempts = 10;
  S._queue.save(q);
  eq(S.getStatus().dead, 1);
  await S.requeueFailed();
  const entry = S._queue.load().queue[0];
  eq(entry.status, 'pending', '重推后回 pending');
  eq(entry.attempts, 0, '重推清零 attempts');
});
