/* ============================================================
   spraybook server — 单端口三个角色
   1) /api/*      一体化 API（计算器上报 + 记账后台）
   2) /           计算器（白名单静态：仅计算器所需根文件与目录）
   3) /ledger     记账后台（原生 JS）
   运行：cd server && npm start   （默认 8080）
   ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { initDb } = require('./db/client');
const { ApiError } = require('./services/apiError');
const { createJobsRouter } = require('./routes/jobs');

const ROOT = path.join(__dirname, '..');      // 仓库根（计算器所在）
const DATA_DIR = process.env.SPRAYBOOK_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const PORT = Number(process.env.PORT) || 8080;

/** 组装 app（测试与生产共用；db 由调用方给，便于 :memory: 测试） */
function buildApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' })); // 一条作业 raw_json 可到几十 KB

  /* ---------- API：CORS（file:// 打开的计算器 Origin=null，必须放行） ---------- */
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', (req, res) => {
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch (e) { dbOk = false; }
    res.json({ ok: true, data: { name: 'spraybook', version: '0.1.0', db: dbOk ? 'ok' : 'fail', time: new Date().toISOString() } });
  });

  app.use('/api', createJobsRouter(db));
  // M4/M5: settlements/bills/receipts/payments/advances/journal 路由挂载点

  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `未知 API: ${req.method} ${req.path}` } });
  });
  app.use('/api', (err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof ApiError) {
      return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    const msg = String((err && err.message) || err);
    const code = /UNIQUE/.test(msg) ? 'DUPLICATE' : /FOREIGN KEY/.test(msg) ? 'VALIDATION' : 'INTERNAL';
    console.error('[api:error]', msg);
    res.status(code === 'INTERNAL' ? 500 : 400)
      .json({ ok: false, error: { code, message: msg } });
  });

  /* ---------- 静态白名单：仅计算器所需（排除 server/data/tests/docs/scripts） ---------- */
  const CALC_FILES = ['index.html', 'sw.js', 'manifest.json', 'drone-spray-calculator-standalone.html'];
  const CALC_DIRS = ['css', 'js', 'assets'];

  for (const f of CALC_FILES) {
    app.get(`/${f}`, (req, res) => res.sendFile(path.join(ROOT, f)));
  }
  for (const d of CALC_DIRS) {
    app.use(`/${d}`, express.static(path.join(ROOT, d), { fallthrough: false, maxAge: '1h' }));
  }
  // 记账后台
  app.use('/ledger', express.static(path.join(ROOT, 'ledger'), { maxAge: 0 }));
  app.get('/ledger', (req, res) => res.sendFile(path.join(ROOT, 'ledger', 'index.html')));

  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `路径不存在: ${req.path}` } });
  });
  return app;
}

/* ---------- 启动（仅直接运行时） ---------- */
if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = initDb(DB_FILE);
  const app = buildApp(db);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[spraybook] listening on http://0.0.0.0:${PORT}`);
    console.log(`[spraybook] 计算器: http://<本机IP>:${PORT}/  记账后台: http://<本机IP>:${PORT}/ledger/  API: /api/health`);
  });
}

module.exports = { buildApp, DB_FILE, DATA_DIR };
