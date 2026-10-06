/* ============================================================
   services/normalize.js — P9-R2 地名别名规范化（D4）
   place_aliases（migration 009）驱动：写侧三处接入——
     ① importExcel.parseWorkbook 解析段（村/队/region，入 staging 前归一）
     ② llmImport.parseTextToBatch 编排层（llmValidate 纯函数不持 db，
        归一放在校验后、写 staging 前，只动 parsed.village/team）
     ③ 落库 parties 查找前（importExcel.upsertImportParty——导入落库
        与 LLM apply 共用此函数；计算器同步 upsertCustomersFromCalculator
        的 payload 无村/队字段，无事可归一，见 services/parties.js）
   原则：命中→canonical；未命中/空值原样返回（绝不猜、绝不新建别名）。
   存量数据不改写侧，靠 backfill-011（待用户裁决后执行）。
   ============================================================ */
'use strict';

/** 查 place_aliases 归一单个地名。
 *  kind: 'region' | 'village' | 'team'；value 原样返回当：非字符串 /
 *  空串 / 表中无此别名。整串精确匹配（trim 后），不做模糊/包含推断。 */
function normalizePlace(db, kind, value) {
  if (typeof value !== 'string') return value; // null/undefined/数字（team 可能存数字？parties.team 为 TEXT，写侧恒字符串）
  const v = value.trim();
  if (!v) return value;
  const row = db.prepare(
    'SELECT canonical FROM place_aliases WHERE kind = ? AND alias = ?'
  ).get(kind, v);
  return row ? row.canonical : value;
}

/** 归一 parsed 里的村/队/region 三字段（就地修改并返回）。
 *  用于 Excel/LLM 两个解析段：缺的字段跳过，不补建键。 */
function normalizeParsedPlaces(db, parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed.region !== undefined && parsed.region !== null) {
    parsed.region = normalizePlace(db, 'region', parsed.region);
  }
  if (parsed.village !== undefined && parsed.village !== null) {
    parsed.village = normalizePlace(db, 'village', parsed.village);
  }
  if (parsed.team !== undefined && parsed.team !== null) {
    parsed.team = normalizePlace(db, 'team', parsed.team);
  }
  return parsed;
}

module.exports = { normalizePlace, normalizeParsedPlaces };
