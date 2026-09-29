/* ============================================================
   db/client.js — 统一数据库访问层
   - 每个连接强制 PRAGMA foreign_keys=ON + busy_timeout（SQLite 默认不开外键）
   - 文件库开 WAL（多读单写并发友好）；:memory: 测试库不开
   - migrate(): 顺序执行 db/migrations/*.sql，schema_migrations 记账，
     已应用跳过；migration 文件只增不改
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const SEED_FILE = path.join(__dirname, 'seed.sql');

function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name)
  );
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // 001_xxx.sql 顺序编号，只增不改
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    if (sql.includes('-- spraybook:no-tx')) {
      // 表重建类迁移：PRAGMA foreign_keys 不能在事务内切换，整文件裸执行
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)')
        .run(f, new Date().toISOString());
      continue;
    }
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)')
        .run(f, new Date().toISOString());
    });
    tx();
  }
}

function seed(db) {
  const sql = fs.readFileSync(SEED_FILE, 'utf8');
  db.exec(sql); // INSERT OR IGNORE，可重复执行
}

/** 标准初始化：打开 + 迁移 + 种子 */
function initDb(dbPath) {
  const db = openDb(dbPath);
  migrate(db);
  seed(db);
  return db;
}

module.exports = { openDb, migrate, seed, initDb };
