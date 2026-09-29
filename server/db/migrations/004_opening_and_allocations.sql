-- ============================================================
-- spraybook 004_opening_and_allocations.sql — M6/M5.5
--  1) 期初标记：Excel 之外的旧账手工补录单据打 opening=1
--  2) 按客户收款的分摊明细：一笔收款 FIFO 核销多张账单 + 余额转预收，
--     allocations JSON=[{bill_id, amount_cents}]，作废时逐张回退
-- ============================================================

ALTER TABLE bills ADD COLUMN opening INTEGER NOT NULL DEFAULT 0;
ALTER TABLE advances ADD COLUMN opening INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receipts ADD COLUMN allocations TEXT;
