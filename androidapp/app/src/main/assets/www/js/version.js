/* ============================================================
   js/version.js — 应用版本单一来源（P7-C3）
   改版本只改这里：
   - index.html 顶部徽标经 window.APP_VERSION 渲染
   - js/app.js 控制台横幅引用
   - sw.js 经 importScripts 引用派生 CACHE_VERSION（改版本即换缓存）
   - androidapp/app/build.gradle 的 versionName 随版本手动同步（构建脚本无
     预处理器，保持字面量；R3 验收核对两处一致）
   规则：改任何 JS/CSS 后必须递增此版本（README 缓存守门规则）。
   ============================================================ */
const APP_VERSION = '4.8.0';
if (typeof window !== 'undefined') window.APP_VERSION = APP_VERSION;
