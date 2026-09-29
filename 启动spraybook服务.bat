@echo off
chcp 65001 >nul 2>&1
title spraybook 服务（计算器 + 记账后台）
cd /d "%~dp0server"

rem ---- 定位 node.exe（PATH 里有就用，没有则试常见安装位） ----
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do ( if not defined NODE_EXE set "NODE_EXE=%%i" )
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo 未找到 node.exe。请安装 Node.js 20+ 后重试，或把 node.exe 路径写进本脚本。
  pause
  exit /b 1
)
for %%i in ("%NODE_EXE%") do set "PATH=%%~dpi;%PATH%"

if not exist node_modules (
  echo [首次运行] 安装依赖（本机需 --ignore-scripts + 手动预编译，详见 docs/OPS.md）...
  call npm install --ignore-scripts
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
  pushd node_modules\better-sqlite3
  node ..\prebuild-install\bin.js
  popd
)

echo.
echo  ============================================
echo   spraybook 服务已启动  http://127.0.0.1:8080
echo   计算器(现场手机):  http://本机IP:8080/
echo   记账后台:          http://127.0.0.1:8080/ledger/
echo   关闭本窗口 = 停止服务
echo  ============================================
echo.
node index.js
pause
