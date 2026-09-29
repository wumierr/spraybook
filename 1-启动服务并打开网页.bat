@echo off
chcp 65001 >nul 2>&1
title spraybook 启动并打开网页
netstat -aon | findstr ":8080" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo 服务已在运行，直接打开网页...
  start "" http://127.0.0.1:8080/ledger/
  start "" http://127.0.0.1:8080/
  exit /b 0
)
start "spraybook服务" cmd /c ""%~dp0启动spraybook服务.bat""
timeout /t 3 >nul
start "" http://127.0.0.1:8080/ledger/
start "" http://127.0.0.1:8080/
