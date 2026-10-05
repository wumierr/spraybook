/* ============================================================
   ⚠️ 一次性数据订正：2026-10-05（P7-R1/A3，HANDOFF-P7-PLAN §A3，用户裁决"全部订正"）
   四项真库订正（用户 2026-10-05 逐项裁决）：
   (a) 抹零符号归一：9 张导入单 adjust_cents 取负（写侧 importExcel 同步改负，
       应付=amount+adjust 约定不变）。只改表述符号，amount/paid/分录分文不动。
   (b) P20261001-002 恢复导入原值：500.00 元/设备（note 原文"水管"本就正确，
       不动）——2026-10-01 另一会话 GUI 编辑实测误改为 131.00/油费。走
       finance.updatePayment 正常编辑接口：自动红冲重过账+留痕，支出合计
       +369.00 元恢复导入基线 38,421.00。
   (c) region 回填：village∈{鹿厂,铜矿} 且 region 空的 14 户 → region=镇名、
       village=NULL（splitAddress 守卫 B4 修复后不再产生此类；写侧同步修）。
   (d) raw_import_rows#143（4 月无姓名收入对 540 元，30 元/亩）落账：借 1001
       现金 / 贷 6099 其他收入（6099 由 seed.sql 幂等补种），occurred_at 用
       导入"日期无法解析→当月 1 号"同款惯例取 2026-04-01；行 parsed_json 加
       booked 标记防重复落库（apply 侧 B6 同函数幂等）。
   幂等：四项各自带"已处理即跳过"条件，重跑 0 变更。
   验收：npm run reconcile 全绿（C3 由此转绿）+ 本脚本内置基线断言。
   运行：cd server && node db/backfill-010-cleanup.js   （自动先备份 .bak-010）
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { initDb, openDb } = require('./client');
const { updatePayment } = require('../services/finance');
const { postEntry } = require('../services/journal');
const { logEdit } = require('../services/audit');

/** 金额基线：分文不动或按预期变化的列（前后对照断言用） */
function snapshotSums(db) {
  const one = (sql) => db.prepare(sql).get().s;
  return {
    jobs_income: one('SELECT COALESCE(SUM(income_cents),0) s FROM jobs'),
    bill_amount: one('SELECT COALESCE(SUM(amount_cents),0) s FROM bills'),
    bill_paid: one('SELECT COALESCE(SUM(paid_cents),0) s FROM bills'),
    bill_adjust: one('SELECT COALESCE(SUM(adjust_cents),0) s FROM bills'),
    receipt_amount: one('SELECT COALESCE(SUM(amount_cents),0) s FROM receipts'),
    payment_amount: one('SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE status=\'active\''),
    settlement_receivable: one('SELECT COALESCE(SUM(total_receivable_cents),0) s FROM settlements'),
    journal_debit: one("SELECT COALESCE(SUM(amount_cents),0) s FROM journal_lines WHERE direction='debit'"),
    journal_credit: one("SELECT COALESCE(SUM(amount_cents),0) s FROM journal_lines WHERE direction='credit'")
  };
}

function backfill010(db, { now = new Date().toISOString(), incomePairRowId = 143 } = {}) {
  const report = { a_negated: 0, b_restored: false, c_region: 0, d_posted: null, warnings: [], before: null, after: null };

  report.before = snapshotSums(db);

  /* 前置一致性：抹零行数必须是已知形态（9 张、全部 paid、paid=amount−adjust） */
  const disc = db.prepare('SELECT id, bill_no, adjust_cents, amount_cents, paid_cents, status FROM bills WHERE adjust_cents > 0').all();
  for (const b of disc) {
    if (b.status !== 'paid' || b.amount_cents - b.adjust_cents !== b.paid_cents) {
      throw new Error(`账单 ${b.bill_no} 形态与已知抹零模式不符（status=${b.status}），中止——请人工核对`);
    }
  }

  const tx = db.transaction(() => {
    /* (a) 抹零取负 */
    report.a_negated = db.prepare(
      'UPDATE bills SET adjust_cents = -adjust_cents, updated_at = ? WHERE adjust_cents > 0').run(now).changes;
    if (disc.length) {
      logEdit(db, { table: 'bills', recordId: 0, action: 'update',
        before: { adjust_sum: report.before.bill_adjust },
        after: { backfill: '010a', count: report.a_negated, note: '导入抹零符号归一（+→−），record_id=0 表示批次级订正' } });
    }

    /* (b) P20261001-002 恢复 500.00/设备（经编辑接口自动红冲+留痕） */
    const pay = db.prepare("SELECT id, payment_no, amount_cents, category FROM payments WHERE payment_no = 'P20261001-002' AND status = 'active'").get();
    if (pay && pay.amount_cents === 13100 && pay.category === 'fuel') {
      updatePayment(db, pay.id, { amount_cents: 50000, category: 'equipment' });
      report.b_restored = true;
    }

    /* (c) region 回填：鹿厂/铜矿滞留 village → region */
    report.c_region = db.prepare(
      `UPDATE parties SET region = village, village = NULL, updated_at = ?
         WHERE deleted_at IS NULL AND region IS NULL AND region IS NOT village
           AND village IN ('鹿厂', '铜矿')`).run(now).changes;
    if (report.c_region) {
      logEdit(db, { table: 'parties', recordId: 0, action: 'update',
        after: { backfill: '010c', count: report.c_region, note: 'village=鹿厂/铜矿 搬入 region（village 置 NULL），record_id=0 表示批次级订正' } });
    }

    /* (d) 收入对落账（6099 其他收入；booked 标记防重复）。生产库目标行=143，
           测试库通过 options.incomePairRowId 指定。 */
    const row = db.prepare(
      'SELECT id, batch_id, sheet_name, row_no, parsed_json FROM raw_import_rows WHERE id = ?').get(incomePairRowId);
    if (row) {
      const meta = JSON.parse(row.parsed_json || '{}');
      if ((meta.kind === 'income_pair') && !meta.booked) {
        const amount = meta.parsed && meta.parsed.income_cents;
        if (!Number.isInteger(amount) || amount <= 0) throw new Error(`行#143 income_cents 非法: ${amount}`);
        const entryId = postEntry(db, {
          event_type: 'other_income', ref_type: 'import_row', ref_id: row.id,
          occurred_at: '2026-04-01T00:00:00.000Z',
          memo: `导入收入对落账：${row.sheet_name} 行${row.row_no} 无姓名收入对（${amount / 100} 元，${(meta.parsed.price_yuan || '?')} 元/亩），日期不可考按当月 1 号`,
          lines: [
            { account_code: '1001', direction: 'debit', amount_cents: amount, memo: '收入对实收' },
            { account_code: '6099', direction: 'credit', amount_cents: amount, memo: '其他收入（无姓名收入对）' }
          ]
        });
        meta.booked = { entry_id: entryId, at: now };
        db.prepare('UPDATE raw_import_rows SET parsed_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(meta), now, row.id);
        report.d_posted = { entry_id: entryId, amount_cents: amount };
      }
    }
  });
  tx();

  /* 事后断言：各列相对基线只允许预期变化。
     journal 借/贷合计的增量=流水条数级增量（红冲也是新分录）：
     (b) 恢复 = 红冲错误分录(13,100 反向行) + 新过账(50,000) = 63,100；
     (d) 收入对 = 54,000。余额级变化（+36,900 / +54,000）由 reconcile C1/C2 把关。 */
  report.after = snapshotSums(db);
  const b = report.before, a = report.after;
  const JOURNAL_B = report.b_restored ? 13100 + 50000 : 0;
  const JOURNAL_D = report.d_posted ? report.d_posted.amount_cents : 0;
  const expect = [
    ['jobs_income', 0], ['bill_amount', 0], ['bill_paid', 0],
    ['receipt_amount', 0], ['settlement_receivable', 0],
    ['bill_adjust', report.a_negated ? -2 * disc.reduce((s, x) => s + x.adjust_cents, 0) : 0],
    ['payment_amount', report.b_restored ? 36900 : 0],
    ['journal_debit', JOURNAL_B + JOURNAL_D],
    ['journal_credit', JOURNAL_B + JOURNAL_D]
  ];
  for (const [key, delta] of expect) {
    if (a[key] - b[key] !== delta) {
      report.warnings.push(`${key} 变化 ${a[key] - b[key]} ≠ 预期 ${delta}（before=${b[key]} after=${a[key]}）`);
    }
  }
  return report;
}

module.exports = { backfill010 };

if (require.main === module) {
  (async () => {
    const dbPath = path.join(__dirname, '..', '..', 'data', 'app.db');
    const bak = dbPath + '.bak-010';
    const walBusy = fs.existsSync(dbPath + '-wal') && fs.statSync(dbPath + '-wal').size > 0;
    if (fs.existsSync(dbPath) && !fs.existsSync(bak)) {
      if (walBusy) {
        const probe = openDb(dbPath);
        await probe.backup(bak);
        probe.close();
        console.log('[backfill-010] WAL 非空，已用在线备份: ' + bak);
      } else {
        fs.copyFileSync(dbPath, bak);
        console.log('[backfill-010] 已备份 ' + bak);
      }
    } else if (fs.existsSync(bak)) {
      console.log('[backfill-010] 备份已存在，不覆盖: ' + bak);
    }
    const db = initDb(dbPath); // seed() 幂等补种 6099 其他收入
    try {
      const report = backfill010(db);
      console.log('[backfill-010] 报告:', JSON.stringify(report, null, 2));
      if (report.warnings.length) {
        console.error('[backfill-010] 基线断言异常，请检查备份 ' + bak);
        process.exitCode = 1;
      }
    } catch (e) {
      console.error('[backfill-010] 失败（事务已回滚，库保持原状）:', e.message);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  })();
}
