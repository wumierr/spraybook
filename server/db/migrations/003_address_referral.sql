-- ============================================================
-- spraybook 003_address_referral.sql — 对照真实历史 Excel 的结构补缺
-- 依据：D:\agent work\samples\植保收支明细.xlsx 全量画像（2026-09-29）
--  1) 客户地址"村名+队伍名"混填（如 彰冠红拉12队/通安金桂村/铜矿7队），
--     用户要求村名与队伍名分开存 → parties 增 village/team 两列，
--     业务键唯一索引同步扩展（同名客户可按村/队区分）；
--  2) 原表"业务来源"（拉单人，提成依据）→ jobs.referral_name 快照；
--  3) 原表"收款人"（收款经手人）→ receipts.collector_name 快照。
-- 003 起允许 ALTER；001/002 不可改。
-- ============================================================

ALTER TABLE parties ADD COLUMN village TEXT;
ALTER TABLE parties ADD COLUMN team TEXT;

DROP INDEX IF EXISTS idx_parties_name_phone;
CREATE UNIQUE INDEX idx_parties_business_key
  ON parties(name, IFNULL(phone,''), IFNULL(village,''), IFNULL(team,''))
  WHERE deleted_at IS NULL;

ALTER TABLE jobs ADD COLUMN referral_name TEXT;
ALTER TABLE receipts ADD COLUMN collector_name TEXT;
