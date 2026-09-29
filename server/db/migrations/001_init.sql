-- ============================================================
-- spraybook 001_init.sql — 五层 24 表（P0 全量）
-- 依据：docs/PLAN.md 关键规则 + docs/export-json-sample.json 逐字段对照
-- 约定：金额 INTEGER 存分（*_cents）；日期 TEXT ISO8601；
--       枚举 TEXT+CHECK；软删除 deleted_at；外键显式，连接时
--       PRAGMA foreign_keys=ON + busy_timeout + WAL（文件库）。
-- 计算器本地 farmer/plot id（'farmer_xxx'/'p_xxx'）不入主数据外键，
-- 跨端业务键=姓名+电话；作业子表保存姓名快照。
-- ============================================================

-- ---------- 第 0 层：迁移账本（client.js 维护） ----------
-- schema_migrations 由 db/client.js 创建，不在此文件内。

-- ============================================================
-- 第一层：主数据（计算器与记账双方读写）
-- ============================================================

-- 参与方：客户（农户档案）/员工/合作方/供应商 合一
CREATE TABLE parties (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('customer','employee','partner','supplier')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT,
  -- 客户扩展（农户档案）：默认单价（分/亩）、常用亩数
  default_price_cents INTEGER,
  default_area_mu REAL,
  notes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT CHECK(source IN ('calculator','ledger','import')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
-- 客户 upsert 业务键：name+phone（phone 空退化按 name）；只建不改
CREATE UNIQUE INDEX idx_parties_name_phone
  ON parties(name, IFNULL(phone,'')) WHERE deleted_at IS NULL;
CREATE INDEX idx_parties_type ON parties(type);

-- 地块主数据（作业子表另存快照，改名/删除不影响历史）
CREATE TABLE plots (
  id INTEGER PRIMARY KEY,
  party_id INTEGER REFERENCES parties(id),
  name TEXT NOT NULL,
  area_mu REAL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_plots_party ON plots(party_id);

-- 药品 = 计算器"用药类型库"（drone_spray_types_v1 条目形状）
CREATE TABLE chemicals (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE,
  name TEXT NOT NULL,
  icon TEXT,
  default_basis TEXT CHECK(default_basis IN ('tree','area')),
  flight_height REAL,
  line_spacing REAL,
  flight_speed REAL,
  water_per_mu REAL,
  trees_per_mu REAL,
  water_per_tree REAL,
  pesticide_water_per_set REAL,
  drone_saving_coeff REAL,
  builtin INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  notes TEXT,
  price_cents_per_set INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- 设备：飞机/电池/充电器；电池带累计循环数（drone_spray_batteries_v1.list）
CREATE TABLE equipment (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('drone','battery','charger','other')),
  cycles_count INTEGER,
  notes TEXT,
  status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- 价格策略（最小版）：农户价优先，回退全局；生效日期预留
CREATE TABLE price_rules (
  id INTEGER PRIMARY KEY,
  party_id INTEGER REFERENCES parties(id),
  job_type TEXT CHECK(job_type IN ('spray','haul')),
  unit TEXT NOT NULL CHECK(unit IN ('mu','jin','set')),
  price_cents INTEGER NOT NULL,
  effective_from TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_price_rules_party ON price_rules(party_id);

-- ============================================================
-- 第二层：作业执行（计算器只写，记账只读）
-- ============================================================

-- 作业单主表（纽带）
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  job_no TEXT UNIQUE NOT NULL,              -- YYYYMMDD-XXXX，客户端生成、服务端冲突重生成回传
  client_job_id TEXT UNIQUE NOT NULL,       -- 幂等键（uuid），重复提交返回原单
  job_type TEXT NOT NULL CHECK(job_type IN ('spray','haul')),
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK(status IN ('draft','completed','settled','reopened','void')),
  job_date TEXT NOT NULL,
  address TEXT,
  note TEXT,
  operator_names TEXT,                      -- JSON 数组，未来按人统计
  source TEXT CHECK(source IN ('calculator','manual','import')),

  -- 打药快照（spray）
  plant_type_key TEXT,
  plant_type_name TEXT,
  total_area_mu REAL,                       -- result.area
  drone_tank_l REAL,                        -- result.droneTank
  spare_water_l REAL,                       -- field.spareWater
  draw_reserve_l REAL,                      -- field.drawReserve
  manual_dose_per_mu REAL,                  -- 农户标准=manualDosePerMu×省药系数
  existing_sets REAL,                       -- result.existingSets
  actual_sets REAL,                         -- workOrder.actualSets（实际用药，空回退标准）
  used_sets REAL,                           -- result.usedSets 合计小数套
  pesticide_rounded_sets REAL,              -- result.pesticideRounded 采购口径（7舍8入）
  need_to_buy_sets REAL,                    -- result.needToBuy
  pesticide_price_cents INTEGER,            -- costs.pesticidePrice 元/套→分
  pesticide_included INTEGER,               -- 包药 1/0
  total_water_l REAL,                       -- result.water 计算水量
  total_add_water_l REAL,                   -- result.totalAddWater =计算+富余
  total_trips INTEGER,                      -- result.totalTrips（组数口径）
  mix_batches INTEGER,                      -- result.timing.mixRounds
  total_flight_min REAL,                    -- result.totalFlightMin
  total_minutes REAL,                       -- result.timing.totalTime
  charge_count INTEGER,                     -- result.cycles 充电次数
  charge_source TEXT CHECK(charge_source IN ('manual','estimate')),
  fuel_expense_cents INTEGER,               -- v4.1 油费直填（元→分）
  battery_depreciation_cents INTEGER,       -- 元/次充电→分
  total_cost_cents INTEGER,                 -- result.totalCost
  income_cents INTEGER,                     -- result.income
  profit_cents INTEGER,                     -- result.profit

  -- 吊运快照（haul；pricePerJin 单位=毛/斤，×10=分/斤）
  weight_jin REAL,                          -- result.totalWeight
  haul_price_cents_per_jin INTEGER,
  pickup_included INTEGER,                  -- 包采摘

  raw_json TEXT,                            -- export+result 全量快照，仅追溯/扩展，不参与结算
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_jobs_date ON jobs(job_date);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(job_type);

-- 逐地块快照（result.plots[]；吊运无数据）
CREATE TABLE job_plots (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  seq INTEGER NOT NULL DEFAULT 0,
  plot_name TEXT NOT NULL,                  -- 快照：主数据可改名/删除
  area_mu REAL,                             -- 快照
  farmer_ref TEXT,                          -- 计算器本地 farmerId（仅溯源）
  farmer_name TEXT,                         -- 快照
  group_no INTEGER,                         -- 作业组 1-9
  water_l REAL,
  flight_min REAL,
  pesticide_sets REAL,                      -- pesticideRaw 小数套
  pesticide_rounded REAL,
  completed_l REAL,                         -- workOrder.completedByPlot[plotId]
  trips_override INTEGER
);
CREATE INDEX idx_job_plots_job ON job_plots(job_id);

-- 飞行组（result.groups[]：连片地块成组，组内不返航）
CREATE TABLE flight_groups (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  group_no INTEGER NOT NULL,
  water_l REAL,
  min_trips INTEGER,
  trips INTEGER,
  trips_override INTEGER,
  per_trip_water_l REAL,
  per_trip_time_min REAL
);
CREATE INDEX idx_flight_groups_job ON flight_groups(job_id);

-- 分农户结算快照（result.settlement[]；吊运为空）
CREATE TABLE job_settlement_lines (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  farmer_ref TEXT,                          -- 计算器本地 farmerId（仅溯源）
  farmer_name TEXT NOT NULL,                -- 快照
  area_mu REAL,
  spray_fee_cents INTEGER,                  -- 打药钱（元→分）
  used_sets REAL,                           -- 用药量小数套
  self_sets REAL,                           -- 自备（凑药）
  supplement_sets REAL,                     -- 补充 = max(0, 用量-自备)
  pesticide_fee_cents INTEGER,              -- 药钱 = included 时 补充×药价
  included INTEGER                          -- 是否包药
);
CREATE INDEX idx_job_settlement_job ON job_settlement_lines(job_id);

-- 作业电池循环快照
CREATE TABLE job_battery_cycles (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  battery_name TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX idx_job_battery_job ON job_battery_cycles(job_id);

-- ============================================================
-- 第三层：结算财务（记账只写，计算器读状态）
-- ============================================================

-- 结算单（每作业一张头）
CREATE TABLE settlements (
  id INTEGER PRIMARY KEY,
  settlement_no TEXT UNIQUE NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','void')),
  total_spray_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_pesticide_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_receivable_cents INTEGER NOT NULL DEFAULT 0,   -- 应收合计=作业钱+药钱（不含 adjust）
  note TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_settlements_job ON settlements(job_id);
CREATE INDEX idx_settlements_status ON settlements(status);

-- 结算明细（每农户分项；未确认可改→bills 联动重算）
CREATE TABLE settlement_items (
  id INTEGER PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES settlements(id),
  party_id INTEGER REFERENCES parties(id),
  farmer_name TEXT NOT NULL,
  area_mu REAL,
  spray_fee_cents INTEGER NOT NULL DEFAULT 0,
  used_sets REAL,
  self_sets REAL,
  supplement_sets REAL,
  pesticide_fee_cents INTEGER NOT NULL DEFAULT 0,
  included INTEGER,
  note TEXT
);
CREATE INDEX idx_settlement_items_settlement ON settlement_items(settlement_id);
CREATE INDEX idx_settlement_items_party ON settlement_items(party_id);

-- 账单（每农户一张；确认后只读；应收=amount_cents+adjust_cents，adjust 通常为负=抹零/优惠）
CREATE TABLE bills (
  id INTEGER PRIMARY KEY,
  bill_no TEXT UNIQUE NOT NULL,
  settlement_id INTEGER NOT NULL REFERENCES settlements(id),
  party_id INTEGER REFERENCES parties(id),
  farmer_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  adjust_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','partial','paid','void')),
  issued_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bills_settlement ON bills(settlement_id);
CREATE INDEX idx_bills_party ON bills(party_id);
CREATE INDEX idx_bills_status ON bills(status);

-- 收款（部分收款=同 bill 多笔；预收抵扣带 from_advance_id）
CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT UNIQUE NOT NULL,
  bill_id INTEGER REFERENCES bills(id),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  from_advance_id INTEGER REFERENCES advances(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK(method IN ('cash','wechat','alipay','bank','other')),
  occurred_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_receipts_bill ON receipts(bill_id);
CREATE INDEX idx_receipts_party ON receipts(party_id);

-- 支出/付款（油费、药费、维修、吃饭、设备、人工、其他）
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  payment_no TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('fuel','chemical','repair','meal','equipment','labor','other')),
  payee_party_id INTEGER REFERENCES parties(id),
  job_id INTEGER REFERENCES jobs(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  occurred_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payments_category ON payments(category);
CREATE INDEX idx_payments_job ON payments(job_id);

-- 预收/预支（双向；balance_cents 为可用余额）
CREATE TABLE advances (
  id INTEGER PRIMARY KEY,
  advance_no TEXT UNIQUE NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  direction TEXT NOT NULL CHECK(direction IN ('prepaid_by_customer','advance_to_worker')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  balance_cents INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','partial','closed','void')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_advances_party ON advances(party_id);
CREATE INDEX idx_advances_direction ON advances(direction);

-- 预收抵扣/预支冲销流水（余额变动全部留痕）
CREATE TABLE advance_usages (
  id INTEGER PRIMARY KEY,
  advance_id INTEGER NOT NULL REFERENCES advances(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  ref_type TEXT NOT NULL CHECK(ref_type IN ('bill','receipt','payment')),
  ref_id INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_advance_usages_advance ON advance_usages(advance_id);

-- 手工分成登记（简单记账，非分账引擎）
CREATE TABLE manual_splits (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  job_id INTEGER REFERENCES jobs(id),
  amount_cents INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_manual_splits_party ON manual_splits(party_id);

-- ============================================================
-- 第四层：复式记账（记账只写）
-- ============================================================

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','income','expense','equity')),
  is_cash INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

-- 凭证头（合并"业务事件"：event_type + ref 定位来源；红冲不删原分录）
CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY,
  entry_no TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,                 -- settlement_confirm / receipt / payment / advance / ...
  ref_type TEXT,                            -- settlement / bill / receipt / payment / advance
  ref_id INTEGER,
  occurred_at TEXT NOT NULL,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),
  reversal_of INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_journal_entries_ref ON journal_entries(ref_type, ref_id);
CREATE INDEX idx_journal_entries_date ON journal_entries(occurred_at);

-- 凭证行（服务层断言 SUM(debit)=SUM(credit)，破平衡即 bug → UNBALANCED）
CREATE TABLE journal_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK(direction IN ('debit','credit')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  party_id INTEGER REFERENCES parties(id),
  job_id INTEGER REFERENCES jobs(id),
  memo TEXT
);
CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX idx_journal_lines_party ON journal_lines(party_id);

-- ============================================================
-- 第五层：审计 + 导入复核
-- ============================================================

-- 编辑留痕（ledger 侧所有 create/update/void/reopen）
CREATE TABLE edit_logs (
  id INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','update','void','reopen')),
  before_json TEXT,
  after_json TEXT,
  operator TEXT NOT NULL DEFAULT 'local',   -- P0 固定，M7 补设置页
  created_at TEXT NOT NULL
);
CREATE INDEX idx_edit_logs_target ON edit_logs(table_name, record_id);

-- 导入批次
CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  source_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewing','applied','rejected')),
  note TEXT,
  imported_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 原始行（status 即复核状态：pending→confirmed/rejected/merged；保留 sheet/行号/原文）
CREATE TABLE raw_import_rows (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  sheet_name TEXT,
  row_no INTEGER,
  raw_text TEXT,
  parsed_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','merged')),
  target_type TEXT,
  target_id INTEGER,
  error_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_raw_rows_batch ON raw_import_rows(batch_id);
CREATE INDEX idx_raw_rows_status ON raw_import_rows(status);
