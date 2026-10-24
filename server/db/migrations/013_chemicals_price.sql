-- ============================================================
-- spraybook 013_chemicals_price.sql — C1 药品价格表
-- chemicals 建表（001）只有作业参数（price_cents_per_set=每套药钱的计算口径），
-- 缺经营三列：cost_cents（进价，分）/ price_cents（售价，分）/ stock_qty（库存套数，
-- 可空=不启用库存）。ADD COLUMN 只增可空，存量 0 行无回填（真库 chemicals 空）。
-- 消费方：主数据页「药品价格表」行内编辑（masterdata TABLES 白名单加三列，零新路由）、
-- 计算器快照联动（js/sync.js buildJobPayload 附 chemicalPrices 参考段，不改现场计算）。
-- ============================================================

ALTER TABLE chemicals ADD COLUMN cost_cents INTEGER;
ALTER TABLE chemicals ADD COLUMN price_cents INTEGER;
ALTER TABLE chemicals ADD COLUMN stock_qty REAL;
