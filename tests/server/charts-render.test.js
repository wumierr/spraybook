/* ============================================================
   charts-render.test.js — P4-M2 图表页 renderTab 冒烟
   无 DOM 环境：以 stub 工具集（$main={innerHTML} + 真 API）驱动
   ledger/js/charts.js，断言 SVG/粒度按钮/跳转动作/口径标注真实拼出。
   ============================================================ */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildApp } = require('../../server/index');
const { freshDb } = require('./helpers/db');

const SAMPLE = require(path.join(__dirname, '..', '..', 'docs', 'export-json-sample.json'));

let db, server, base;
let root = '';   // http://127.0.0.1:PORT（charts.js 的 Api.get 入参已含 /api 前缀）
let seq = 0;

beforeEach(async () => {
  db = freshDb();
  const app = buildApp(db);
  server = app.listen(0);
  root = `http://127.0.0.1:${server.address().port}`;
  base = root + '/api';
});
afterEach(async () => {
  if (server) { await new Promise(r => server.close(r)); server = null; }
  delete global.window;
});

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function getJson(p) {
  const j = await (await fetch(root + p)).json();
  if (!j.ok) throw new Error(j.error ? j.error.code + ': ' + j.error.message : 'HTTP error');
  return j.data;
}

/** 与 app.js window.__ledgerTools 同形状的最小工具集 */
function makeTools() {
  return {
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c])),
    toast: () => {}, render: async () => {}, switchNav: () => {},
    Core: require('../../ledger/js/core.js'),
    Api: { get: p => getJson(p), overview: () => getJson('/api/overview') },
    state: { tab: 'charts', month: {}, gran: {} }
  };
}

async function seedOneSettledJob() {
  seq += 1;
  const p = {
    client_job_id: `ch-${seq}-${Date.now()}`, job_type: 'spray', job_date: '2026-04-02',
    snapshot: SAMPLE.spray.export, result: SAMPLE.spray.result
  };
  const job = (await post(`${base}/jobs`, p)).data;
  const st = (await post(`${base}/settlements`, { job_id: job.id })).data;
  await post(`${base}/settlements/${st.id}/confirm`);
  return { job, st };
}

test('charts renderTab：真库数据拼出 SVG/粒度按钮/跳转/口径标注，无 NaN/undefined 泄漏', async () => {
  const { st } = await seedOneSettledJob();
  await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '油费' });
  await post(`${base}/receipts`, {
    bill_id: db.prepare('SELECT id FROM bills WHERE settlement_id = ?').get(st.id).id,
    party_id: db.prepare('SELECT party_id FROM bills WHERE settlement_id = ? LIMIT 1').get(st.id).party_id,
    amount_cents: 100
  });

  global.window = {};
  const Charts = require('../../ledger/js/charts.js');
  const tools = makeTools();
  global.window.__ledgerTools = tools;
  const $main = { innerHTML: '' };
  await Charts.renderTab('charts', $main);
  const html = $main.innerHTML;

  // 验收：C1 各期 income 之和 = /api/reports/summary.income_cents（同源对账，程序内断言）
  const s = await getJson('/api/reports/summary');
  const bp = await getJson('/api/reports/by-period?granularity=month');
  assert.strictEqual(bp.pl.reduce((a, r) => a + r.income_cents, 0), s.income_cents,
    'by-period 各期收入合计=summary 收入');

  // 十张卡 + 每张时间卡 月/周/季/年
  assert.ok(html.includes('<svg class="lg-chart"'), '内联 SVG 已拼出');
  const granBtns = (html.match(/data-act="gran-set"/g) || []).length;
  assert.strictEqual(granBtns, 6 * 4, '6 张时间卡（C1/C2/C3/C4/C7/C9）× 4 粒度按钮');
  assert.ok(html.includes('data-act="ov-jump-month"'), '月粒度柱/点带跳总表动作');
  assert.ok(html.includes('2026-'), '期键进入 X 标签');
  assert.ok(html.includes('导入单成本=0'), 'C8 导入零成本标注');
  assert.ok(html.includes('不可相加'), '两口径不可相加标注');
  assert.ok(html.includes('回收率'), 'C3 口径脚注');
  assert.ok(!html.includes('NaN'), '无 NaN 泄漏');
  assert.ok(!html.includes('>undefined<') && !html.includes('undefined 元'), '无 undefined 泄漏');

  // gran-set：按图保存粒度并触发重渲染
  let renderCalls = 0;
  tools.render = async () => { renderCalls += 1; };
  Charts.handleAct({ dataset: { act: 'gran-set', chart: 'pl', gran: 'week' } }, tools);
  assert.strictEqual(tools.state.gran.pl, 'week');
  assert.strictEqual(renderCalls, 1);

  // ov-jump-month：写总表月份键 + 切页签
  Charts.handleAct({ dataset: { act: 'ov-jump-month', month: '2026-04' } }, tools);
  assert.strictEqual(tools.state.month.overview, '2026-04');
  assert.strictEqual(tools.state.tab, 'overview');
  Charts.handleAct({ dataset: { act: 'ov-jump-month', month: '2026-W13' } }, tools);
  assert.strictEqual(tools.state.month.overview, '2026-04', '非月键跳转被拒绝');

  // 切周粒度后再渲染：周桶文本进入页面（job_date 2026-04-02 落 2026-W13）
  tools.state.tab = 'charts';
  tools.state.gran.work = 'week';
  await Charts.renderTab('charts', $main);
  assert.ok($main.innerHTML.includes('2026-W13'), '周粒度桶键进入 X 标签');
});
