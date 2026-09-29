@echo off
chcp 65001 >nul 2>&1
title 停止 spraybook 服务
set FOUND=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8080" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1 && set FOUND=1
)
if "%FOUND%"=="1" (
  echo spraybook 服务已停止。
) else (
  echo 未发现运行中的 spraybook 服务（端口 8080 无监听）。
)
pause
