/* ============================================================
   db/renumber-import-jobs.js — 一次性：把导入的 IMP-* 作业单号
   重编为可读格式 J+YYYYMMDD-当日序号（用户反馈：单号要可读）
   运行：cd server && node db/renumber-import-jobs.js
   幂等：只处理 job_no LIKE 'IMP-%' 的行，重跑无副作用。
   ============================================================ */
'use strict';
const path = require('path');
const { initDb } = require('./client');

const db = initDb(path.join(__dirname, '..', '..', 'data', 'app.db'));

const rows = db.prepare(
  "SELECT id, job_no, job_date FROM jobs WHERE job_no LIKE 'IMP-%' ORDER BY job_date, id").all();
const counters = new Map();
const upd = db.prepare('UPDATE jobs SET job_no = ?, raw_json = ? WHERE id = ?');
let n = 0;
const tx = db.transaction(() => {
  for (const j of rows) {
    const day = String(j.job_date || '').slice(0, 10).replace(/-/g, '') || '00000000';
    const seq = (counters.get(day) || 0) + 1;
    counters.set(day, seq);
    const newNo = `J${day}-${String(seq).padStart(2, '0')}`;
    let raw = null;
    try { raw = JSON.parse(db.prepare('SELECT raw_json FROM jobs WHERE id = ?').get(j.id).raw_json || 'null'); } catch (e) { /* */ }
    if (raw) { raw.renamed_from = j.job_no; raw = JSON.stringify(raw); }
    upd.run(newNo, raw, j.id);
    n++;
  }
});
tx();
console.log(`[renumber] 已重编 ${n} 个作业单号（IMP-* → J+日期-序号）`);
db.close();
