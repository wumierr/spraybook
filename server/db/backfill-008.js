/* ============================================================
   ⚠️ 一次性数据订正：2026-10-05 在生产库真实执行（.bak-008 已生成，27/27 搬迁，
   金额分文不动）。注意：本头部曾于编写当日（10-01）误标"已于 2026-10 生产库
   执行完毕"，实际未执行——2026-10-05 只读审查发现（purpose 全 NULL、无
   .bak-008）后补执行并订正本标注。勿对生产库重跑（逻辑幂等，重跑无副作用
   但无意义；回归见 tests/server/backfill*.test.js）。
   db/backfill-008.js — 一次性数据订正（P4-M1，HANDOFF-P4-PLAN §2.3）
   plant_type_name 双语义收尾：migration 008 只加了 jobs.purpose 列，
   存量导入行（importExcel.js 曾把 Excel「作业目的」写进 plant_type_name）
   仍靠 overview 的 COALESCE(purpose, plant_type_name) 掩盖。本脚本把
   存量非作物值搬到 purpose、plant_type_name 置回 NULL（作物语义）。
   圈定「非作物」= source='import'：计算器作业的 plant_type_name 来自
   作物类型库（services/jobs.js s.plant.name），从不写 purpose；全库唯一
   把目的值写进 plant_type_name 的是导入路径（importExcel.js applyJobRow），
   其 raw_json.raw.purpose 与 plant_type_name 同源可交叉校验。
   幂等：只处理 purpose IS NULL 行，重跑 0 行变更。
   金额分文不动：backfill-009 的九个金额键前后相等。
   运行：cd server && node db/backfill-008.js   （自动先备份 .db）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { initDb, openDb } = require('./client');
const { snapshotSums } = require('./backfill-009');

/** 订正主函数（事务内），返回报告
 *  {scanned, moved, skipped_has_purpose, skipped_empty, warnings[], money_unchanged} */
function backfill008(db) {
  const report = {
    scanned: 0, moved: 0, skipped_has_purpose: 0, skipped_empty: 0,
    warnings: [], money_unchanged: false
  };

  const sumsBefore = snapshotSums(db);

  const tx = db.transaction(() => {
    // 候选 = 导入行且 plant_type_name 有值且 purpose 尚为空（已有 purpose 的行另行计数、永不触碰）
    report.skipped_has_purpose = db.prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE source = 'import' AND plant_type_name IS NOT NULL AND TRIM(plant_type_name) != ''
         AND purpose IS NOT NULL AND purpose != ''`).get().n;
    const rows = db.prepare(
      `SELECT id, job_no, plant_type_name, purpose,
              json_extract(raw_json, '$.raw.purpose') AS raw_purpose
       FROM jobs
       WHERE source = 'import' AND plant_type_name IS NOT NULL AND TRIM(plant_type_name) != ''
         AND (purpose IS NULL OR purpose = '')`).all();
    report.scanned = rows.length;
    const upd = db.prepare('UPDATE jobs SET purpose = ?, plant_type_name = NULL, updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    for (const r of rows) {
      const value = String(r.plant_type_name).trim();
      if (!value) { report.skipped_empty++; continue; }
      // 交叉校验：导入落库时 plant_type_name 即 raw.purpose，不一致只 warning 不拦（人为改过则以列值为准）
      if (r.raw_purpose != null && String(r.raw_purpose).trim() !== value) {
        report.warnings.push(`job#${r.id}(${r.job_no}) plant_type_name「${value}」与 raw_json.purpose「${r.raw_purpose}」不一致，按列值搬移`);
      }
      upd.run(value, now, r.id);
      report.moved++;
    }
  });
  tx();

  const sumsAfter = snapshotSums(db);
  report.money_unchanged = JSON.stringify(sumsBefore) === JSON.stringify(sumsAfter);
  if (!report.money_unchanged) {
    report.warnings.push('金额基线变化！before=' + JSON.stringify(sumsBefore) +
      ' after=' + JSON.stringify(sumsAfter));
  }
  return report;
}

module.exports = { backfill008 };

if (require.main === module) {
  (async () => {
    const dbPath = path.join(__dirname, '..', '..', 'data', 'app.db');
    const bak = dbPath + '.bak-008';
    const wal = dbPath + '-wal';
    const walBusy = fs.existsSync(wal) && fs.statSync(wal).size > 0;
    if (fs.existsSync(dbPath) && !fs.existsSync(bak)) {
      if (walBusy) {
        // WAL 非空时 copyFileSync 主库文件会得到不完整备份（同 backfill-009），改用在线一致备份
        const probe = openDb(dbPath);
        await probe.backup(bak);
        probe.close();
        console.log('[backfill-008] WAL 非空，已用在线备份（better-sqlite3 db.backup）: ' + bak);
      } else {
        fs.copyFileSync(dbPath, bak);
        console.log('[backfill-008] 已备份 ' + bak);
      }
    } else if (fs.existsSync(bak)) {
      console.log('[backfill-008] 备份已存在，不覆盖: ' + bak);
    } else {
      console.error('[backfill-008] 找不到数据库 ' + dbPath);
      process.exitCode = 1;
      return;
    }
    const db = initDb(dbPath); // 自动迁移（008 列由服务端启动时迁移，脚本单独跑时自迁）
    try {
      const report = backfill008(db);
      console.log('[backfill-008] 报告:', JSON.stringify(report, null, 2));
      if (!report.money_unchanged) {
        console.error('[backfill-008] 金额基线变化，请检查备份 ' + bak);
        process.exitCode = 1;
      }
    } catch (e) {
      console.error('[backfill-008] 失败:', e.message);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  })().catch(e => {
    console.error('[backfill-008] 失败:', e.message);
    process.exitCode = 1;
  });
}
