/* ============================================================
   charts-render.test.js — P5-M2 图表页 renderTab 冒烟（echarts 适配层）
   无 DOM / 无 echarts 环境：以 stub 工具集（$main={innerHTML} + 真 API）
   驱动 ledger/js/charts.js，断言容器/粒度按钮/跳转动作/口径标注真实拼出，
   vendor 缺失时 10 个图表容器全部降级提示，option 断言在 ledger-core.test.js。
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
    Api: {
      get: p => getJson(p),
      overview: () => getJson('/api/overview'),
      parties: () => getJson('/api/parties')
    },
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

test('charts renderTab：12 卡容器/粒度按钮/降级提示/口径标注，无 NaN/undefined 泄漏', async () => {
  const { st } = await seedOneSettledJob();
  await post(`${base}/payments`, { category: 'fuel', amount_cents: 12000, note: '油费' });
  await post(`${base}/receipts`, {
    bill_id: db.prepare('SELECT id FROM bills WHERE settlement_id = ?').get(st.id).id,
    party_id: db.prepare('SELECT party_id FROM bills WHERE settlement_id = ? LIMIT 1').get(st.id).party_id,
    amount_cents: 100
  });

  global.window = {}; // 无 window.echarts → 挂载层走降级
  const Charts = require('../../ledger/js/charts.js');
  const tools = makeTools();
  global.window.__ledgerTools = tools;
  // 假 $main：innerHTML 照收；querySelector 按选择器返回可写容器（供挂载层写降级提示）
  const boxes = new Map();
  const $main = {
    innerHTML: '',
    querySelector: sel => { if (!boxes.has(sel)) boxes.set(sel, { innerHTML: '' }); return boxes.get(sel); },
    querySelectorAll: () => []
  };
  await Charts.renderTab('charts', $main);
  const html = $main.innerHTML;

  // 验收：C1 各期 income 之和 = /api/reports/summary.income_cents（同源对账，程序内断言）
  const s = await getJson('/api/reports/summary');
  const bp = await getJson('/api/reports/by-period?granularity=month');
  assert.strictEqual(bp.pl.reduce((a, r) => a + r.income_cents, 0), s.income_cents,
    'by-period 各期收入合计=summary 收入');

  // 12 张卡（C1..C10 + C11 地区/C12 飞手）+ 10 个 echarts 容器 + 6 张时间卡×4 粒度按钮
  assert.strictEqual((html.match(/lg-chart-card/g) || []).length, 12, '12 张图表卡');
  for (const k of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c11', 'c12']) {
    assert.ok(html.includes(`data-chart="${k}"`), `容器 data-chart=${k} 存在`);
  }
  assert.strictEqual((html.match(/data-act="gran-set"/g) || []).length, 24,
    '6 张时间卡（C1/C2/C3/C4/C7/C9）× 4 粒度按钮（周→月→季→年）');
  const granHtml = html.match(/data-act="gran-set" data-chart="pl"[^>]*>/g)[0];
  assert.ok(granHtml.includes('data-gran="week"'), '粒度按钮从小到大（周在列）');

  // vendor 未加载：10 个容器全部降级提示（表格卡 C9/C10 不受影响）
  const fallback = [...boxes.values()].filter(el => el.innerHTML.includes('图表库未加载'));
  assert.strictEqual(fallback.length, 10, 'echarts 缺失时容器降级提示，不白屏不抛错');

  // 原始 period 键仍在 DOM（C9 期间格 title 悬浮），人类 label 在显示位
  assert.ok(html.includes('2026-'), '期键（原始）进入 C9 title');
  assert.ok(html.includes('4月'), '人类 label 进入显示位');

  // C11/C12 与口径标注
  assert.ok(html.includes('地区收入占比'), 'C11 地区卡');
  assert.ok(html.includes('飞手收入占比'), 'C12 飞手卡');
  assert.ok(html.includes('未记录'), 'C12 未记录桶标注');
  assert.ok(html.includes('(未填)'), 'C11 (未填) 桶脚注');
  assert.ok(html.includes('客户总数'), 'C6 客户总数（启用）');
  assert.ok(html.includes('导入单成本=0'), 'C8 导入零成本标注');
  assert.ok(html.includes('不可相加'), '两口径不可相加标注');
  assert.ok(html.includes('回收率'), 'C3 口径脚注');
  assert.ok(html.includes('W00'), '周粒度 W00 脚注保留');
  assert.ok(!html.includes('NaN'), '无 NaN 泄漏');
  assert.ok(!html.includes('>undefined<') && !html.includes('undefined 元'), '无 undefined 泄漏');
  assert.ok(!html.includes('<svg class="lg-chart"'), '手绘 SVG 内核已移除');

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

  // 切周粒度后再渲染：服务端周桶 label（人类格式）进入 option 通道（经 builder 断言）
  tools.state.tab = 'charts';
  tools.state.gran.work = 'week';
  await Charts.renderTab('charts', $main);
  const wk = await getJson('/api/reports/by-period?granularity=week');
  const wkOpt = Charts.buildTimeOption({
    rows: wk.work,
    bars: [{ key: 'area_mu', name: '亩数', color: '#000' }],
    lines: [],
    colors: {},
    tip: r => `${Charts.periodLabel(r)}(${r.period})`
  });
  assert.ok(/^\d{4}-W\d{2}$/.test(wk.work[0].period), '周桶原始键=2026-W13 族');
  assert.ok(/^W\d{2}\(\d{2}-\d{2}\)$/.test(wkOpt.xAxis.data[0]), '周轴 label 人类格式 W13(MM-DD)');
  assert.ok(wkOpt.tooltip.formatter([{ dataIndex: 0 }]).includes('2026-W'), 'tooltip 保留原始周键');
});
