/* ============================================================
   ⚠️ 一次性数据订正脚本（P9-R2，backfill-011）：村/队/region 别名规范化
   ══════════════════════════════════════════════════════════
   ⚠️ 待用户裁决 docs/DATA-AUDIT-20261006.md（§Q2 村名标准名、§Q2-b region
   回填、§Q3 合并谁进谁）之后才允许执行。本轮（P9-R2）只交付脚本，
   不 seed place_aliases 映射、不执行本脚本——映射内容等用户逐条裁决。
   ══════════════════════════════════════════════════════════
   数据源：data/normalize-mappings.json（不随仓库分发，本地按裁决结果手写）：
     {
       "village": { "金桂": "金桂村", "大发": "大发梁子" },
       "region":  { "通安金桂": "通安" },
       "team":    {}
     }
   行为：
     1) 读映射文件——缺失 / 非法 JSON / 不是对象 → 打印说明 exit 1，绝不空跑；
     2) better-sqlite3 db.backup() 在线备份到 <db>.bak-011（WAL 库禁 cp，坑①）；
     3) 单事务逐条 UPDATE parties：SET <kind列> = canonical WHERE <kind列> = alias；
        每条断言只动 region/village/team 其中一列（逐行全列 diff，出现任何
        预期外列变更即 throw 回滚）；金额列分文不动；
     4) 内置执行前后金额 SUM 断言（分录借贷/账单三列/收款/支出/结算应收/作业收入），
        任何变化即报错 exit 1；
     5) edit_logs 留痕（record_id=0 批次级订正，backfill-010 惯例）。
   运行（裁决后）：
     cd server && node db/backfill-011-normalize.js
   验收：npm run reconcile 全绿 + 本脚本报告 warnings 为空。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { initDb, openDb } = require('./client');
const { logEdit } = require('../services/audit');

const KINDS = ['village', 'region', 'team']; // 只允许这三列
const MAPPINGS_FILE = 'normalize-mappings.json';

/** 映射文件路径（跟随 SPRAYBOOK_DATA_DIR，与 dirty-addresses.json 同约定） */
function mappingsPath(dataDir) {
  const dir = dataDir || process.env.SPRAYBOOK_DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dir, MAPPINGS_FILE);
}

/** 读映射：缺失/非法 → throw（带操作说明），由 main 打印并 exit 1 */
function loadMappings(dataDir) {
  const file = mappingsPath(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(
      `未找到映射文件 ${file}\n` +
      `本脚本绝不空跑：请先按 docs/DATA-AUDIT-20261006.md §Q2 的用户裁决结果，\n` +
      `在数据目录手写 ${MAPPINGS_FILE}（格式：\n` +
      `  { "village": {"金桂": "金桂村"}, "region": {}, "team": {} } ）\n` +
      `逐条核对 alias→canonical 后再运行。`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON：${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} 顶层必须是对象 {village:{别名:标准名}, region:{...}, team:{...}}`);
  }
  const out = {};
  for (const kind of KINDS) {
    const seg = parsed[kind] == null ? {} : parsed[kind];
    if (typeof seg !== 'object' || Array.isArray(seg)) {
      throw new Error(`${file} 的 "${kind}" 段必须是对象`);
    }
    for (const [alias, canonical] of Object.entries(seg)) {
      if (typeof canonical !== 'string' || !canonical.trim()) {
        throw new Error(`${file} "${kind}.${alias}" 的标准名必须是非空字符串`);
      }
    }
    out[kind] = seg;
  }
  return out;
}

/** 金额基线（backfill-010 同款键集）：执行前后必须分文不变 */
function snapshotSums(db) {
  const one = (sql) => db.prepare(sql).get().s;
  return {
    jobs_income: one('SELECT COALESCE(SUM(income_cents),0) s FROM jobs'),
    bill_amount: one('SELECT COALESCE(SUM(amount_cents),0) s FROM bills'),
    bill_paid: one('SELECT COALESCE(SUM(paid_cents),0) s FROM bills'),
    bill_adjust: one('SELECT COALESCE(SUM(adjust_cents),0) s FROM bills'),
    receipt_amount: one('SELECT COALESCE(SUM(amount_cents),0) s FROM receipts'),
    payment_amount: one("SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE status='active'"),
    settlement_receivable: one('SELECT COALESCE(SUM(total_receivable_cents),0) s FROM settlements'),
    journal_debit: one("SELECT COALESCE(SUM(amount_cents),0) s FROM journal_lines WHERE direction='debit'"),
    journal_credit: one("SELECT COALESCE(SUM(amount_cents),0) s FROM journal_lines WHERE direction='credit'")
  };
}

/** 单条 UPDATE：改一列，并逐行全列 diff 断言「只动了这一列」。 */
function updateOneColumn(db, kind, alias, canonical, now) {
  if (!KINDS.includes(kind)) throw new Error(`非法维度: ${kind}（只允许 ${KINDS.join('/')}）`);
  const beforeRows = db.prepare(`SELECT * FROM parties WHERE ${kind} = ?`).all(alias);
  const info = db.prepare(`UPDATE parties SET ${kind} = ? WHERE ${kind} = ?`).run(canonical, alias);
  if (info.changes !== beforeRows.length) {
    throw new Error(`UPDATE parties SET ${kind}='${canonical}' 影响行数 ${info.changes} ≠ 命中 ${beforeRows.length}，中止`);
  }
  for (const row of beforeRows) {
    const after = db.prepare('SELECT * FROM parties WHERE id = ?').get(row.id);
    const changed = Object.keys(row).filter(k => row[k] !== after[k]);
    const unexpected = changed.filter(k => k !== kind);
    if (unexpected.length) {
      throw new Error(`parties#${row.id} 出现预期外列变更: ${unexpected.join(', ')}（只允许改 ${kind}），中止回滚`);
    }
  }
  return { changes: info.changes, now };
}

/** 应用映射（单事务；任何异常整体回滚）。返回报告。 */
function applyMappings(db, mappings) {
  const report = { updated: {}, warnings: [], before: null, after: null };
  for (const kind of KINDS) {
    report.updated[kind] = 0;
  }
  report.before = snapshotSums(db);

  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    for (const kind of KINDS) {
      for (const [alias, canonical] of Object.entries(mappings[kind] || {})) {
        if (alias === canonical) {
          report.warnings.push(`跳过自映射 ${kind}: "${alias}" → "${canonical}"`);
          continue;
        }
        const { changes } = updateOneColumn(db, kind, alias, canonical, now);
        report.updated[kind] += changes;
        if (changes) {
          logEdit(db, { table: 'parties', recordId: 0, action: 'update',
            after: { backfill: '011-normalize', kind, alias, canonical, changes,
              note: '地名别名规范化（record_id=0 表示批次级订正）' } });
        }
      }
    }
    // 金额分文不动断言（事务内）
    report.after = snapshotSums(db);
    for (const key of Object.keys(report.before)) {
      if (report.after[key] !== report.before[key]) {
        throw new Error(`金额基线 ${key} 变化 ${report.before[key]} → ${report.after[key]}（必须为 0），已回滚`);
      }
    }
  });
  tx();
  return report;
}

module.exports = { loadMappings, applyMappings, mappingsPath, snapshotSums };

if (require.main === module) {
  (async () => {
    // 1) 先读映射：缺失/非法绝不碰库
    let mappings;
    try {
      mappings = loadMappings();
    } catch (e) {
      console.error('[backfill-011] ' + e.message);
      process.exit(1);
    }
    const total = Object.values(mappings).reduce((a, s) => a + Object.keys(s).length, 0);
    if (!total) {
      console.error('[backfill-011] 映射文件存在但为空（village/region/team 均无条目）——没有可执行的订正，exit 1。');
      process.exit(1);
    }

    const dbPath = path.join(process.env.SPRAYBOOK_DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'app.db');
    const bak = dbPath + '.bak-011';
    // 2) 在线备份（better-sqlite3 backup API；WAL 库禁止 cp 主文件）
    if (fs.existsSync(bak)) {
      console.log('[backfill-011] 备份已存在，不覆盖: ' + bak);
    } else {
      const probe = openDb(dbPath);
      await probe.backup(bak);
      probe.close();
      console.log('[backfill-011] 已在线备份: ' + bak);
    }

    const db = initDb(dbPath); // 迁移幂等；确保 place_aliases/列都就位
    try {
      const report = applyMappings(db, mappings);
      console.log('[backfill-011] 报告:', JSON.stringify(report, null, 2));
      console.log('[backfill-011] 完成。请运行 npm run reconcile 验收三平。');
      if (report.warnings.length) {
        console.warn('[backfill-011] 注意项:', report.warnings);
      }
    } catch (e) {
      console.error('[backfill-011] 失败（事务已回滚，库保持原状）:', e.message);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  })();
}
