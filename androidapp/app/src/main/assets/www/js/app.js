/* ============================================================
   app.js — 主入口
   ============================================================ */

(function() {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    // 应用初始主题
    UI.applyTheme(Storage.getTheme());

    // 初始化 UI
    UI.init();

    // 全局错误捕获
    window.addEventListener('error', e => {
      console.error('App error:', e.error);
      UI.toast('发生错误：' + (e.message || '未知错误'), 'error');
    });

    // 友好的首次访问提示
    if (!localStorage.getItem('drone_spray_visited')) {
      setTimeout(() => {
        UI.toast('👋 欢迎使用！点击右上角 i 图标查看每个参数说明', 'success');
        localStorage.setItem('drone_spray_visited', '1');
      }, 800);
    }

    // 控制台彩蛋（版本单一来源 js/version.js；顺带同步页头徽标）
    const v = (typeof window !== 'undefined' && window.APP_VERSION) || '4.8.0';
    const badge = document.getElementById('appVersion');
    if (badge) badge.textContent = 'v' + v;
    console.log(`%c🚁 无人机打药计算器 v${v}`, 'font-size:20px;color:#2e7d32;font-weight:bold;');
    console.log('%c本地存储不上传 · 可打包 APK · GitHub 友好', 'color:#1565c0;');
    console.log('快捷键：Ctrl/Cmd + Shift + V 一键粘贴导入配置');
  });
})();
