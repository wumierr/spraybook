-- ============================================================
-- spraybook 012_price_rules_updated_at.sql — A0-B-C4
-- price_rules 建表（001）时漏了 updated_at 列（parties/plots/chemicals/
-- equipment 均有，仅此表缺），而 routes/masterdata.js 通用写路径
-- （POST/PATCH/void/restore）恒拼 updated_at → 该表写路径 100% 500。
-- ADD COLUMN 只增，存量行由 DEFAULT 覆盖为建表时的 created_at 口径
-- （用空串默认 + 回填 created_at，保证 NOT NULL 且无歧义）。
-- ============================================================

ALTER TABLE price_rules ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE price_rules SET updated_at = created_at WHERE updated_at = '';
