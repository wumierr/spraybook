@echo off
chcp 65001 >nul 2>&1
title spraybook 一体化服务（计算器 + 记账后台）
cd /d "%~dp0server"

if not exist node_modules (
  echo 首次运行：安装依赖（本机需 --ignore-scripts + 手动预编译，见 docs/OPS.md）...
  call npm install --ignore-scripts
  cd node_modules\better-sqlite3 && node ..\prebuild-install\bin.js && cd ..\..
)

echo.
echo  ============================================
echo   spraybook 服务启动中：http://127.0.0.1:8080
echo   计算器:  http://<本机IP>:8080/
echo   记账后台: http://<本机IP>:8080/ledger/
echo   关闭本窗口即停止服务
echo  ============================================
echo.
node index.js
pause
