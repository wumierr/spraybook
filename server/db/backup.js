/* ============================================================
   db/backup.js — 在线安全备份（better-sqlite3 backup API）
   用法：cd server && npm run db:backup
   产物：backups/app-YYYYMMDD-HHMM.db（文件名含时分，同日多次不互相覆盖；
        清理兼容旧的纯日期名 app-YYYYMMDD.db）
   备份即验证（E1）：备份完成后对副本只读跑 reconcile C1-C7，
        结果追加到 logs/backup-reconcile.log；任一硬检查失败 exitCode=1
        ——坏备份当场报警，不留到恢复那天才发现。
   注意：不要在服务运行时直接复制 .db 文件（WAL 下可能不一致），
        本脚本用 SQLite backup API 保证一致性。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runReconcile } = require('./reconcile');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'data', 'app.db');
const DIR = path.join(ROOT, 'backups');
const LOG_DIR = path.join(ROOT, 'logs');
const KEEP = 30;

/** 对刚产出的备份副本只读跑对账，结果追加日志；返回 true=硬检查全过 */
function verifyBackup(target) {
  const db = new Database(target, { readonly: true });
  let result;
  try {
    result = runReconcile(db);
  } finally {
    db.close();
    // readonly 打开 WAL 库会在副本旁残留 -shm/-wal 映射文件，验证完即清
    for (const ext of ['-shm', '-wal']) {
      const side = target + ext;
      if (fs.existsSync(side)) fs.unlinkSync(side);
    }
  }
  const hard = result.checks.filter(c => c.id.startsWith('C'));
  const failed = hard.filter(c => !c.ok);
  const lines = [
    `[${new Date().toISOString()}] ${path.basename(target)}`,
    ...result.checks.map(c => `  ${c.ok ? '✓' : '✗'} ${c.id} ${c.name} — ${c.detail}`),
  ];
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, 'backup-reconcile.log'), lines.join('\n') + '\n', 'utf8');
  return failed.length === 0;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[backup] 找不到 ' + SRC + '，先运行 npm run db:reset 或启动一次服务');
    process.exit(1);
  }
  fs.mkdirSync(DIR, { recursive: true });

  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const target = path.join(DIR, `app-${stamp}.db`);

  const db = new Database(SRC, { readonly: true });
  db.backup(target).then(() => {
    db.close();
    const size = (fs.statSync(target).size / 1024).toFixed(1);
    console.log(`[backup] 完成: ${target} (${size} KB)`);

    // 备份即验证：副本对账不过 = 备份不可信，exit 1 报警
    if (verifyBackup(target)) {
      console.log('[backup] 验证: reconcile C1-C7 全部通过（详见 logs/backup-reconcile.log）');
    } else {
      console.error('[backup] 验证失败: 备份副本 reconcile 存在未过项，见 logs/backup-reconcile.log');
      process.exitCode = 1;
    }

    // 清理：仅保留最近 KEEP 份（新名含时分，旧名纯日期，一并参与排序清理）
    const files = fs.readdirSync(DIR)
      .filter(f => /^app-\d{8}(-\d{4})?\.db$/.test(f))
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
}

if (require.main === module) main();
module.exports = { verifyBackup };
