-- ============================================================
-- spraybook 016_allocations_structured.sql — C3 核销明细结构化（已裁 2026-10-24）
-- receipts.allocations JSON → receipt_allocations 结构化表 + receipts.remainder_advance_id 列。
-- 真库 FIFO allocations=0（零存量迁移窗口，REVIEW-FUSION §6-1 裁决）；下方防御性
-- 回填语句在有空存量时把 JSON items 解析入表（真库执行=零行，幂等无害）。
-- 结构化后 B0-N-1 类守卫（按 paid_cents）与核销明细天然一致。
-- ============================================================

CREATE TABLE receipt_allocations (
  id INTEGER PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id),
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_receipt_alloc_receipt ON receipt_allocations(receipt_id);
CREATE INDEX idx_receipt_alloc_bill ON receipt_allocations(bill_id);

ALTER TABLE receipts ADD COLUMN remainder_advance_id INTEGER REFERENCES advances(id);

-- 防御性存量回填（真库=零行；幂等：仅迁 JSON 里存在且表内尚无该收据行时插入）
INSERT INTO receipt_allocations (receipt_id, bill_id, amount_cents, created_at)
SELECT r.id,
       CAST(json_extract(je.value, '$.bill_id') AS INTEGER),
       CAST(json_extract(je.value, '$.amount_cents') AS INTEGER),
       r.created_at
FROM receipts r,
     json_each(json_extract(r.allocations, '$.items')) je
WHERE r.allocations IS NOT NULL
  AND json_valid(r.allocations)
  AND json_extract(r.allocations, '$.items') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM receipt_allocations ra WHERE ra.receipt_id = r.id);

-- remainder_advance_id 存量回填（同防御口径）
UPDATE receipts
   SET remainder_advance_id = CAST(json_extract(allocations, '$.remainder_advance_id') AS INTEGER)
 WHERE allocations IS NOT NULL
   AND json_valid(allocations)
   AND json_extract(allocations, '$.remainder_advance_id') IS NOT NULL
   AND remainder_advance_id IS NULL;
