-- ============================================================
-- spraybook 002_split_account.sql — 手工分成成本科目（M5）
-- 001 已合并不可改（migration 只增不改）；追加 5007 分成科目
-- ============================================================
INSERT OR IGNORE INTO accounts (code, name, type, is_cash, created_at) VALUES
  ('5007', '主营成本-分成', 'expense', 0, '2026-01-01T00:00:00');
