-- ============================================================
-- spraybook 007_cost_plots_lines.sql — P3 数据补全（审查结论 1/2/3）
-- 1) jobs 补成本构成快照列：杂费/人工/药剂/设备/补贴此前只躺在
--    raw_json.result.costBreakdown 与 snapshot.income.subsidy 里，
--    报表无法做构成分析。income_cents/total_cost_cents/profit_cents
--    三个总额列保持原样，本组列只是 total_cost 的拆分快照。
-- 2) job_settlement_lines / settlement_items 补 kind + unit_price_cents：
--    导入"另按 N 元/亩"额外收入此前伪装成结算行（farmer_name 塞
--    "张三（另按 25 元/亩）"文本、面积留空），改为结构化标注；
--    存量行由 db/backfill-007.js 订正（只改表述，金额分文不动）。
-- 3) job_plots.plot_id 关联主数据 plots（可空，按名匹配，匹配不到留空）。
-- ============================================================
ALTER TABLE jobs ADD COLUMN labor_cost_cents INTEGER;
ALTER TABLE jobs ADD COLUMN pesticide_cost_cents INTEGER;
ALTER TABLE jobs ADD COLUMN equipment_cost_cents INTEGER;
ALTER TABLE jobs ADD COLUMN misc_cost_cents INTEGER;
ALTER TABLE jobs ADD COLUMN subsidy_cents INTEGER;

ALTER TABLE job_settlement_lines ADD COLUMN kind TEXT NOT NULL DEFAULT 'spray'
  CHECK (kind IN ('spray','extra'));
ALTER TABLE job_settlement_lines ADD COLUMN unit_price_cents INTEGER;
ALTER TABLE settlement_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'spray'
  CHECK (kind IN ('spray','extra'));
ALTER TABLE settlement_items ADD COLUMN unit_price_cents INTEGER;

ALTER TABLE job_plots ADD COLUMN plot_id INTEGER REFERENCES plots(id);
