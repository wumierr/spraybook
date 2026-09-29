/* ============================================================
   db/backup.js — 在线安全备份（better-sqlite3 backup API）
   用法：cd server && npm run db:backup
   产物：backups/app-YYYYMMDD.db（保留最近 30 份）
   注意：不要在服务运行时直接复制 .db 文件（WAL 下可能不一致），
        本脚本用 SQLite backup API 保证一致性。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'data', 'app.db');
const DIR = path.join(ROOT, 'backups');
const KEEP = 30;

if (!fs.existsSync(SRC)) {
  console.error('[backup] 找不到 ' + SRC + '，先运行 npm run db:reset 或启动一次服务');
  process.exit(1);
}
fs.mkdirSync(DIR, { recursive: true });

const d = new Date();
const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const target = path.join(DIR, `app-${stamp}.db`);

const db = new Database(SRC, { readonly: true });
db.backup(target).then(() => {
  db.close();
  const size = (fs.statSync(target).size / 1024).toFixed(1);
  console.log(`[backup] 完成: ${target} (${size} KB)`);
  // 清理：仅保留最近 KEEP 份
  const files = fs.readdirSync(DIR)
    .filter(f => /^app-\d{8}\.db$/.test(f))
    .sort()
    .reverse();
  for (const f of files.slice(KEEP)) {
    fs.unlinkSync(path.join(DIR, f));
    console.log('[backup] 清理旧备份 ' + f);
  }
}).catch(err => {
  console.error('[backup] 失败:', err.message);
  process.exit(1);
});
