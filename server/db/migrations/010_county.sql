-- ============================================================
-- spraybook 010_county.sql — P10-R1 多市县基座（D4 裁决：不建区划树表，
-- parties.county 单列 + 各报表端点筛选；存量默认'会理市'）
-- 1) parties ADD COLUMN county TEXT NOT NULL DEFAULT '会理市'
--    ADD COLUMN 只增；存量行由 DEFAULT 统一覆盖（业务现居会理市）。
-- 2) place_aliases 的 kind CHECK 扩为 region|village|team|county
--    —— SQLite 改 CHECK 只能整表重建，严格仿 005 bills_new 先例：
--    建新表 → INSERT SELECT → 行数/内容断言 → DROP 旧 → RENAME → 补索引。
-- 断言（迁移内，CHECK 桩表实现）：重建前后行数一致 + 内容逐行一致
-- （(kind,alias,canonical,created_at) 双向 EXCEPT 为空；两侧 (kind,alias)
-- UNIQUE 保证无重复行，集合相等即逐行一致）。断言不满足 → CHECK 违例
-- 中断；本迁移不切 PRAGMA foreign_keys（place_aliases 无任何外键引用），
-- 走 migrate() 默认事务 → 断言失败整体回滚，绝不留半重建状态。
-- ============================================================

ALTER TABLE parties ADD COLUMN county TEXT NOT NULL DEFAULT '会理市';

CREATE TABLE place_aliases_new (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('region','village','team','county')),
  alias TEXT NOT NULL,             -- 原始写法（如 金桂）
  canonical TEXT NOT NULL,         -- 标准名（如 金桂村）
  created_at TEXT NOT NULL,
  UNIQUE(kind, alias)
);

INSERT INTO place_aliases_new (id, kind, alias, canonical, created_at)
  SELECT id, kind, alias, canonical, created_at FROM place_aliases;

-- 断言：行数一致且双向 EXCEPT 为空（内容逐行一致），否则 CHECK 违例中止
DROP TABLE IF EXISTS _010_assert;
CREATE TEMP TABLE _010_assert (ok INTEGER NOT NULL CHECK(ok = 1));
INSERT INTO _010_assert (ok)
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM place_aliases) = (SELECT COUNT(*) FROM place_aliases_new)
    AND NOT EXISTS (
      SELECT kind, alias, canonical, created_at FROM place_aliases
      EXCEPT
      SELECT kind, alias, canonical, created_at FROM place_aliases_new)
    AND NOT EXISTS (
      SELECT kind, alias, canonical, created_at FROM place_aliases_new
      EXCEPT
      SELECT kind, alias, canonical, created_at FROM place_aliases)
    THEN 1 ELSE 0 END;
DROP TABLE _010_assert;

DROP TABLE place_aliases;
ALTER TABLE place_aliases_new RENAME TO place_aliases;
CREATE INDEX idx_place_aliases_kind ON place_aliases(kind);
