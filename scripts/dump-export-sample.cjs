/* ============================================================
   dump-export-sample.cjs — 生成一次真实作业的 exportJSON+计算结果样本
   运行：node scripts/dump-export-sample.cjs
   产物：docs/export-json-sample.json
   用途：M1 建表（001_init.sql）以该样本为唯一字段依据，不靠推断。
   复用 tests/calc.test.js 的 vm 加载壳（零依赖）。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const ctx = vm.createContext({
  window: {},
  console,
  navigator: {},
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  }
});
for (const f of ['js/data.js', 'js/calculator.js', 'js/storage.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}

function baseState(mode) {
  return vm.runInContext(`({
    mode: ${JSON.stringify(mode)},
    plant: null,
    field: null,
    costs: null,
    income: null,
    timing: null,
    haulField: { ...DEFAULT_HAUL_FIELD },
    haulCosts: { ...DEFAULT_HAUL_COSTS },
    haulIncome: { ...DEFAULT_HAUL_INCOME },
    workOrder: null,
    farmers: [],
    batteries: null,
    typeLibrary: []
  })`, ctx);
}

/* ============================================================
   样本 1：打药——多农户多地块 + 凑药 + 实际用量 + 油费直填 + 电池
   ============================================================ */
function spraySample() {
  const s = baseState('spray');
  s.plant = vm.runInContext('({ ...PLANT_DATABASE.shajun })', ctx);
  s.field = vm.runInContext('({ ...DEFAULT_FIELD })', ctx);
  s.costs = vm.runInContext('({ ...DEFAULT_COSTS })', ctx);
  s.income = vm.runInContext('({ ...DEFAULT_INCOME })', ctx);
  s.timing = vm.runInContext('({ ...DEFAULT_TIMING })', ctx);

  // 农户档案（drone_spray_farmers_v1 的条目形状）
  s.farmers = [
    { id: 'farmer_default', name: '（未建档）', phone: '', pricePerMu: 0, typeId: '', notes: '删除农户后的兜底', enabled: true, plotTemplate: { area: 10 } },
    { id: 'f_zhang', name: '张大国', phone: '13900001111', pricePerMu: 9, typeId: 'shajun', notes: '果园东片，常客', enabled: true, plotTemplate: { area: 12 } },
    { id: 'f_li', name: '李秀英', phone: '13800002222', pricePerMu: 8, typeId: '', notes: '', enabled: true, plotTemplate: { area: 8 } },
    { id: 'f_wang', name: '王强', phone: '', pricePerMu: 0, typeId: '', notes: '按全局价', enabled: true, plotTemplate: { area: 5 } }
  ];

  // 地块列表（v4.3 只填亩数；groupId 连片成组 1-9）
  s.field.plots = [
    { id: 'p1', name: '张家果园东', area: 12, groupId: 1, farmerId: 'f_zhang' },
    { id: 'p2', name: '张家果园西', area: 8, groupId: 1, farmerId: 'f_zhang' },
    { id: 'p3', name: '李家大田', area: 14, groupId: 2, farmerId: 'f_li' },
    { id: 'p4', name: '王家菜地', area: 5, groupId: 3, farmerId: 'f_wang' }
  ];
  s.field.spareWater = 35;
  s.field.drawReserve = 40;
  s.field.droneTank = 85;
  s.field.plantKey = 'shajun';
  s.field.manualDosePerMu = 1.2;
  s.field.existingPesticideSets = 2;

  // 成本（v4.1 油费直填）：pesticidePrice 元/套，pesticideIncluded=包药
  s.costs.pesticidePrice = 80;
  s.costs.pesticideIncluded = true;
  s.costs.fuelExpense = 120;
  s.costs.batteryDepreciation = 3;
  s.costs.cycleArea = 120;

  // 时间参数
  s.timing.batchCapacity = 1000;
  s.timing.batteryCount = 4;

  // 工单（现场完成态）：已完成升数、自备套数、实际用量、备注
  s.workOrder = {
    completedByPlot: { p1: 260, p2: 180, p3: 320, p4: 110 },
    selfByFarmer: { f_zhang: 2, f_li: 1 },
    completedSingle: false,
    actualSets: 12.5,
    note: '下午风大，西片少打一遍；李家要求下次早来',
    farmerNameDone: '张大国'
  };

  // 电池台账（drone_spray_batteries_v1）
  s.batteries = {
    list: [
      { id: 'batt1', name: '1号电池', cycles: 231 },
      { id: 'batt2', name: '2号电池', cycles: 198 }
    ],
    records: []
  };

  const result = vm.runInContext('window.Calculator', ctx).computePlots(s);
  return { mode: 'spray', export: JSON.parse(vm.runInContext('window.Storage', ctx).exportJSON(s, 'spray')), result };
}

/* ============================================================
   样本 2：吊运——只有斤数和钱
   ============================================================ */
function haulSample() {
  const s = baseState('haul');
  s.haulField = vm.runInContext('({ ...DEFAULT_HAUL_FIELD })', ctx);
  s.haulCosts = vm.runInContext('({ ...DEFAULT_HAUL_COSTS })', ctx);
  s.haulIncome = vm.runInContext('({ ...DEFAULT_HAUL_INCOME })', ctx);
  s.haulField.totalWeight = 3500;
  s.haulCosts.fuelExpense = 200;
  s.haulIncome.pricePerJin = 8; // 毛/斤（×0.1 转元）
  s.workOrder = { note: '葡萄园 B 区' };

  const result = vm.runInContext('window.Calculator', ctx).computeHaul({
    field: s.haulField, costs: s.haulCosts, income: s.haulIncome
  });
  return { mode: 'haul', export: JSON.parse(vm.runInContext('window.Storage', ctx).exportJSON(s, 'haul')), result };
}

const sample = {
  _readme: 'spraybook 建表依据样本：export=Storage.exportJSON(state,mode) 的解析结果（主数据+输入参数），result=Calculator.computePlots/computeHaul 输出（执行结果）。M1 建表逐字段对照本文件。',
  generatedAt: new Date().toISOString(),
  spray: spraySample(),
  haul: haulSample()
};

const out = path.join(ROOT, 'docs', 'export-json-sample.json');
fs.writeFileSync(out, JSON.stringify(sample, null, 2), 'utf8');
console.log('written:', out);
console.log('spray settlement lines:', sample.spray.result.settlement.length,
  '| spray totalTrips:', sample.spray.result.totalTrips,
  '| haul income(元):', sample.haul.result.income);
