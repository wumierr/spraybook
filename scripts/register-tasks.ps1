# ============================================================
#  register-tasks.ps1 — 注册本机运维计划任务（E1/E3，可重复跑=幂等覆盖）
#
#  任务一：spraybook每日备份  每天 09:30  server/db/backup.js
#          （在线备份 + 备份即验证 reconcile，产物 backups/app-YYYYMMDD-HHMM.db）
#  任务二：spraybook夜间检查  每天 22:30  scripts/nightly-check.ps1
#          （全量测试 + reconcile + 零外链 grep，产物 logs/nightly-*.log）
#
#  两者都带 StartWhenAvailable（错过开机时刻则开机后尽快补跑）。
#  改时间：改本文件下方 $BackupTime/$NightlyTime 后重跑本脚本。
#
#  用法:
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-tasks.ps1
# ============================================================

[CmdletBinding()]
param(
    [string]$BackupTime  = '09:30',
    [string]$NightlyTime = '22:30'
)

$NodeExe     = 'D:\nodejs\node.exe'          # 本机 Node 绝对路径（不进 PATH，HANDOFF 坑#5）
$ProjectRoot = Split-Path -Parent $PSScriptRoot

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

# ---------- 任务一：每日备份 ----------
$act1 = New-ScheduledTaskAction -Execute $NodeExe `
    -Argument ('"{0}"' -f (Join-Path $ProjectRoot 'server\db\backup.js')) `
    -WorkingDirectory (Join-Path $ProjectRoot 'server')
Register-ScheduledTask -TaskName 'spraybook每日备份' -Action $act1 `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $BackupTime) -Settings $settings -Force | Out-Null
Write-Host "[OK] 已注册 spraybook每日备份（每天 $BackupTime）"

# ---------- 任务二：夜间检查 ----------
$act2 = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $ProjectRoot 'scripts\nightly-check.ps1')) `
    -WorkingDirectory $ProjectRoot
Register-ScheduledTask -TaskName 'spraybook夜间检查' -Action $act2 `
    -Trigger (New-ScheduledTaskTrigger -Daily -At $NightlyTime) -Settings $settings -Force | Out-Null
Write-Host "[OK] 已注册 spraybook夜间检查（每天 $NightlyTime）"

Write-Host ''
Write-Host '手动触发验证：'
Write-Host '  Start-ScheduledTask spraybook每日备份'
Write-Host '  Start-ScheduledTask spraybook夜间检查'
