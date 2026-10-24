-- ============================================================
-- spraybook 014_plot_enclosed_area.sql — D2 圈地面积双口径
-- 裁决（2026-10-21）：圈地面积只进结算（客户只见圈地）；作业面积参与计算；
-- 现场圈地先于航线作业面积产生（时间差是真实业务事实），允许只填圈地先预估。
-- 1) 主数据 plots 表起用：作业/圈地两口径面积 + 当前药型/单价/备注
--    （D3 地块档案系统的服务端地基；area_mu 原列保留兼容不迁移）
-- 2) job_plots 加圈地面积逐地块快照（result.plots[].areaEnclosedMu；
--    物理量只读口径与 area_mu 一致，D3 地块档案 history / D4 结算卡取数用）
-- 3) job_settlement_lines 加圈地面积快照 + 计费口径：
--    price_basis 缺省 'work'（作业面积）——旧 2.1 作业包无该字段=按作业面积，兼容。
-- 消费方：services/jobs.js insertSubtables（POST /api/jobs 落快照）；
--         计算器 js/calculator.js computePlots（结算按口径取面积）。
-- ADD COLUMN 只增可空（price_basis 带 DEFAULT 满足 NOT NULL），存量行零回填。
-- ============================================================

ALTER TABLE plots ADD COLUMN area_work_mu REAL;
ALTER TABLE plots ADD COLUMN area_enclosed_mu REAL;
ALTER TABLE plots ADD COLUMN current_drug_type_id INTEGER REFERENCES chemicals(id);
ALTER TABLE plots ADD COLUMN current_price_cents INTEGER;
ALTER TABLE plots ADD COLUMN note TEXT;

ALTER TABLE job_plots ADD COLUMN area_enclosed_mu REAL;
ALTER TABLE job_settlement_lines ADD COLUMN area_enclosed_mu REAL;
ALTER TABLE job_settlement_lines ADD COLUMN price_basis TEXT NOT NULL DEFAULT 'work' CHECK(price_basis IN ('work','enclosed'));
