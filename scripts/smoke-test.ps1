# 确认应用能真正启动，且没有运行时报错。
#
# 为什么需要这个脚本：有些 bug 编译期查不出来，只有启动才暴露。
# 例如本次真实发生过的：
#   "state not managed for field `state` on command `app_status`"
#   —— 原因是给 Tauri 注册了 Arc<VaultState> 而不是 VaultState。
#   cargo check 完全通过，但一启动前端就报错。
#
# 本脚本做两件事：
#   1. 启动 release exe，确认窗口出现并稳定存活（不是闪退）
#   2. 检查是否有"致命错误"输出（数据目录解析失败等）
#
# 用法:  powershell -File scripts/smoke-test.ps1
#
# ASCII-only on purpose（PowerShell 5.1 对无 BOM 文件的处理不可靠）。

param(
    [int]$TimeoutSec = 45
)

$ErrorActionPreference = 'Stop'
$proj = 'D:\Users\Lenovo\Desktop\Diary'
$exe = Join-Path $proj 'target\release\app.exe'

if (-not (Test-Path $exe)) {
    Write-Host "FAIL: exe not found: $exe" -ForegroundColor Red
    Write-Host 'Run: pnpm tauri build  (from the app/ directory)'
    exit 1
}

Write-Host ("Launching: {0}" -f $exe)
$proc = Start-Process -FilePath $exe -PassThru -RedirectStandardError "$proj\_smoke-err.log" -RedirectStandardOutput "$proj\_smoke-out.log"
Write-Host ("  pid = {0}" -f $proc.Id)

$windowSeen = $false
$deadline = (Get-Date).AddSeconds($TimeoutSec)

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 600
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $p) {
        Write-Host ("FAIL: process exited early (exit code {0})" -f $proc.ExitCode) -ForegroundColor Red
        break
    }
    if ($p.MainWindowTitle) {
        $windowSeen = $true
        Write-Host ("  window shown: '{0}'" -f $p.MainWindowTitle) -ForegroundColor Green
        break
    }
}

if ($windowSeen) {
    # 让窗口停留一会儿，确认不是"出现后立刻崩"
    Start-Sleep -Seconds 6
    $still = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($still) {
        Write-Host '  still alive after 6s: OK' -ForegroundColor Green
        Stop-Process -Id $proc.Id -Force
        Write-Host '  stopped test process'
    } else {
        Write-Host 'FAIL: window appeared then the process died' -ForegroundColor Red
    }
}

Write-Host ''
Write-Host '--- stderr ---'
$errText = Get-Content "$proj\_smoke-err.log" -ErrorAction SilentlyContinue
if ($errText) {
    $errText | ForEach-Object { Write-Host "  $_" }
    $fatal = $errText | Where-Object { $_ -match 'unmanaged|not managed|致命错误|panicked' }
    if ($fatal) {
        Write-Host 'FAIL: runtime error detected in stderr' -ForegroundColor Red
    }
} else {
    Write-Host '  (empty - good)'
}

Remove-Item "$proj\_smoke-err.log", "$proj\_smoke-out.log" -ErrorAction SilentlyContinue

Write-Host ''
if ($windowSeen) {
    Write-Host 'SMOKE TEST PASSED' -ForegroundColor Green
} else {
    Write-Host 'SMOKE TEST FAILED' -ForegroundColor Red
    exit 1
}
