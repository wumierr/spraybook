-- ============================================================
-- spraybook 008_job_purpose.sql — P4-M1 总表（HANDOFF-P4-PLAN §2.3）
-- jobs 补"作业目的"列：总表端点的目的列取
--   COALESCE(jobs.purpose, jobs.plant_type_name)
-- 把 plant_type_name 还给计算器"作物"语义、导入表的"作业目的"
-- 走新列，修 plant_type_name 双语义。
-- 仅加列（migration 只增不改）；存量回填与导入写列属订正脚本
-- backfill-008 / importExcel 落库修正，不在本迁移内。
-- ============================================================
ALTER TABLE jobs ADD COLUMN purpose TEXT;
