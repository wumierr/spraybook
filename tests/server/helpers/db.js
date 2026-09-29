/* ============================================================
   tests/server/helpers/db.js — 测试数据库统一隔离
   每个测试文件/用例 :memory: 独立库，beforeEach 跑 001+seed
   ============================================================ */
'use strict';

const path = require('path');
const { initDb } = require(path.join(__dirname, '..', '..', '..', 'server', 'db', 'client'));

/** 新建一个已迁移+已种子的内存库（每测试独立，互不污染） */
function freshDb() {
  return initDb(':memory:');
}

module.exports = { freshDb };
