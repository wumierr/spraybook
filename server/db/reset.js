/* ============================================================
   db/reset.js — 重建本地开发数据库（npm run db:reset）
   删除 data/app.db（含 WAL/SHM）后重新迁移+种子
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { initDb } = require('./client');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const f = DB_FILE + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = initDb(DB_FILE);
const tables = db.prepare(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).get().n;
const accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
const fk = db.pragma('foreign_key_check');
console.log(`[db:reset] 重建完成: ${DB_FILE}`);
console.log(`[db:reset] 表数量=${tables} 科目=${accounts} foreign_key_check=${fk.length === 0 ? 'OK' : 'FAIL'}`);
db.close();
