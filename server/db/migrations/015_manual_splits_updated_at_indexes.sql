-- ============================================================
-- spraybook 015_manual_splits_updated_at_indexes.sql — B0.3（N-3 + 深审性能项）
-- ① manual_splits 建表（001）漏了 updated_at 列且无作废路径（N-3）：
--    补列后 voidFinanceRecord 通用作废（红冲 5007/1001 分录）才能落此表；
--    ADD COLUMN 只增，存量行回填 created_at 口径（照 012 先例）。
-- ② idx_parties_county：多市县筛选（P10-R1 起 bills/结算/报表按县过滤）
--    与 B2 账龄按客户聚合的锚点索引，客户数千后查询不再全表扫。
-- ③ idx_bills_issued：账龄分桶（B2 按 issued_at 0-30/31-60/61-90/90+）
--    的排序列索引。
-- ============================================================

ALTER TABLE manual_splits ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE manual_splits SET updated_at = created_at WHERE updated_at = '';

CREATE INDEX IF NOT EXISTS idx_parties_county ON parties(county);
CREATE INDEX IF NOT EXISTS idx_bills_issued ON bills(issued_at);
