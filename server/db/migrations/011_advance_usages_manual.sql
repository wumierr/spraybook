-- ============================================================
-- spraybook 011_advance_usages_manual.sql — A0-B-C1
-- advance_usages.ref_type CHECK 扩为 bill|receipt|payment|manual：
-- settleAdvance（services/finance.js settleAdvance）允许 ref_type='manual'
--（手工冲销/现金还款场景），但 001 的 CHECK 只放行 bill/receipt/payment，
-- manual 路径必撞 CHECK 报 500 —— 本迁移补齐契约。
-- SQLite 改 CHECK 只能整表重建，严格仿 010 先例：
--   建新表 → INSERT SELECT → 行数/内容断言（双向 EXCEPT）→ DROP 旧 → RENAME。
-- advance_usages 无外键引用（receipts.from_advance_id 指向 advances 而非本表），
-- 不切 PRAGMA foreign_keys，走 migrate() 默认事务，断言失败整体回滚。
-- ============================================================

CREATE TABLE advance_usages_new (
  id INTEGER PRIMARY KEY,
  advance_id INTEGER NOT NULL REFERENCES advances(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  ref_type TEXT NOT NULL CHECK(ref_type IN ('bill','receipt','payment','manual')),
  ref_id INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),
  created_at TEXT NOT NULL
);

INSERT INTO advance_usages_new (id, advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at)
  SELECT id, advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at FROM advance_usages;

-- 断言：行数一致且双向 EXCEPT 为空（内容逐行一致），否则 CHECK 违例中止
DROP TABLE IF EXISTS _011_assert;
CREATE TEMP TABLE _011_assert (ok INTEGER NOT NULL CHECK(ok = 1));
INSERT INTO _011_assert (ok)
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM advance_usages) = (SELECT COUNT(*) FROM advance_usages_new)
    AND NOT EXISTS (
      SELECT advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at FROM advance_usages
      EXCEPT
      SELECT advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at FROM advance_usages_new)
    AND NOT EXISTS (
      SELECT advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at FROM advance_usages_new
      EXCEPT
      SELECT advance_id, amount_cents, ref_type, ref_id, occurred_at, note, status, created_at FROM advance_usages)
    THEN 1 ELSE 0 END;
DROP TABLE _011_assert;

DROP TABLE advance_usages;
ALTER TABLE advance_usages_new RENAME TO advance_usages;
CREATE INDEX idx_advance_usages_advance ON advance_usages(advance_id);
