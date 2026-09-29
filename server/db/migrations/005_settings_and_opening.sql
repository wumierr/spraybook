-- ============================================================
-- 005_settings_and_opening.sql — M7/M5.5（整文件 no-tx：含 bills 表重建）
-- 1) settings 键值表（operator 等）
-- 2) bills.settlement_id 改为可空（期初补录账单无结算单可挂）
--    SQLite 不能直接改列约束 → 标准表重建流程
-- ============================================================
-- spraybook:no-tx
PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE bills_new (
  id INTEGER PRIMARY KEY,
  bill_no TEXT UNIQUE NOT NULL,
  settlement_id INTEGER REFERENCES settlements(id),
  party_id INTEGER REFERENCES parties(id),
  farmer_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  adjust_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','partial','paid','void')),
  issued_at TEXT,
  note TEXT,
  opening INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO bills_new (id, bill_no, settlement_id, party_id, farmer_name, amount_cents, adjust_cents, paid_cents, status, issued_at, note, opening, created_at, updated_at)
  SELECT id, bill_no, settlement_id, party_id, farmer_name, amount_cents, adjust_cents, paid_cents, status, issued_at, note, opening, created_at, updated_at FROM bills;
DROP TABLE bills;
ALTER TABLE bills_new RENAME TO bills;
CREATE INDEX idx_bills_settlement ON bills(settlement_id);
CREATE INDEX idx_bills_party ON bills(party_id);
CREATE INDEX idx_bills_status ON bills(status);

PRAGMA foreign_keys=ON;
