-- ============================================================
-- spraybook 009_place_aliases.sql — P9-R2（D4 村/队/region 别名规范化）
-- 目的：地名异写（如 金桂/金桂村、大发/大发梁子）在写侧自动归一到标准名。
-- 原则：
--   - 只增不改：新表，不动任何既有表/列。
--   - 本轮不 seed 任何映射——标准名以用户裁决 docs/DATA-AUDIT-20261006.md §Q2
--     为准，裁决后经后台/settings 或 backfill-011（读 data/normalize-mappings.json）
--     再落别名；表先就位，写侧（services/normalize.js）即可接入。
--   - UNIQUE(kind, alias)：一个别名在每个维度只指向一个标准名；
--     反向（canonical 作 alias 指回别的名）不在此拦，由录入方自律。
-- 查询方：services/normalize.js normalizePlace(db, kind, value)。
-- ============================================================

CREATE TABLE place_aliases (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('region','village','team')),
  alias TEXT NOT NULL,             -- 原始写法（如 金桂）
  canonical TEXT NOT NULL,         -- 标准名（如 金桂村）
  created_at TEXT NOT NULL,
  UNIQUE(kind, alias)
);
CREATE INDEX idx_place_aliases_kind ON place_aliases(kind);
