# ============================================================
#  nightly-check.ps1 — 夜间常驻检查（E3，用户裁决 2026-10-16 计划）
#
#  每晚跑三件：全量测试 + reconcile C1-C7 + 零外链守门 grep，
#  输出 logs/nightly-YYYYMMDD.log；任一项失败退出码非 0。
#
#  用法（手动跑一次验证）:
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\nightly-check.ps1
#  计划任务注册: scripts\register-tasks.ps1
# ============================================================

[CmdletBinding()]
param()

$NodeExe = 'D:\nodejs\node.exe'   # 本机 Node 绝对路径（不进 PATH，HANDOFF 坑#5）
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$LogDir = Join-Path $ProjectRoot 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$Log = Join-Path $LogDir ("nightly-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

function Write-Log([string]$Text) {
    $Text | Out-File -FilePath $Log -Append -Encoding utf8
}

$failures = @()
Write-Log ("===== spraybook 夜间检查 {0} =====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# ---------- 1/3 全量测试 ----------
Write-Log ''
Write-Log '--- 1/3 全量测试（node --test） ---'
& $NodeExe --test "tests/server/*.test.js" tests/calc.test.js tests/sync.test.js tests/ledger-core.test.js 2>&1 |
    ForEach-Object { "$_" } | Out-File -FilePath $Log -Append -Encoding utf8
if ($LASTEXITCODE -eq 0) { Write-Log '[OK] 全量测试通过' }
else { Write-Log ('[FAIL] 全量测试退出码 ' + $LASTEXITCODE); $failures += 'tests' }

# ---------- 2/3 reconcile C1-C7（真库只读） ----------
Write-Log ''
Write-Log '--- 2/3 reconcile C1-C7 ---'
& $NodeExe server/db/reconcile.js 2>&1 |
    ForEach-Object { "$_" } | Out-File -FilePath $Log -Append -Encoding utf8
if ($LASTEXITCODE -eq 0) { Write-Log '[OK] reconcile 全部硬检查通过' }
else { Write-Log ('[FAIL] reconcile 退出码 ' + $LASTEXITCODE); $failures += 'reconcile' }

# ---------- 3/3 零外链守门 grep（口径=tests/server/p10-r3.test.js 外链守门，扩展到根计算器文件） ----------
Write-Log ''
Write-Log '--- 3/3 零外链守门 grep（ledger/ 全目录 + 根计算器运行时文件） ---'
$AllowNs = 'w3\.org/(1999/xlink|2000/svg|2000/xmlns|XML/1998/namespace)'   # XML/SVG 命名空间标识，非网络请求
$AllowUrl = '^(https?://(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.))' # 私网/本机地址=配置示例文本，非外部依赖
$LicenseLine = 'license|copyright|\(c\)\s*20|©'
$targets = @()
$targets += Get-ChildItem -Path (Join-Path $ProjectRoot 'ledger') -Recurse -File |
    Where-Object { $_.Name -notmatch 'license' -and $_.Extension -match '^\.(js|css|html|json|txt)$' }
foreach ($rel in @('js', 'css')) {
    $targets += Get-ChildItem -Path (Join-Path $ProjectRoot $rel) -Recurse -File |
        Where-Object { $_.Extension -match '^\.(js|css|html|json)$' }
}
foreach ($f in @('index.html', 'sw.js', 'manifest.json')) {
    $p = Join-Path $ProjectRoot $f
    if (Test-Path $p) { $targets += Get-Item $p }
}
$offenders = foreach ($t in $targets) {
    $lines = Get-Content -LiteralPath $t.FullName -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match $LicenseLine) { continue }         # vendor license banner 豁免
        foreach ($m in [regex]::Matches($line, 'https?://[^\s"''<>)\]]+')) {
            if ($m.Value -match $AllowNs) { continue }
            if ($m.Value -match $AllowUrl) { continue }
            '{0}:{1} {2}' -f $t.FullName.Substring($ProjectRoot.Length + 1), ($i + 1), $m.Value
        }
    }
}
$offenders = @($offenders)
if ($offenders.Count -eq 0) { Write-Log ('[OK] 零外链（扫描 {0} 个文件）' -f $targets.Count) }
else {
    Write-Log ('[FAIL] 发现外链 {0} 处：' -f $offenders.Count)
    $offenders | Select-Object -First 20 | ForEach-Object { Write-Log ('  ' + $_) }
    $failures += 'external-links'
}

# ---------- 汇总 ----------
Write-Log ''
if ($failures.Count -eq 0) {
    Write-Log '===== 夜间检查全部通过 ====='
    Write-Host "夜间检查全部通过：$Log"
    exit 0
} else {
    Write-Log ('===== 夜间检查失败项：' + ($failures -join ', ') + ' =====')
    Write-Host "夜间检查失败（$($failures -join ', ')）：$Log"
    exit 1
}
