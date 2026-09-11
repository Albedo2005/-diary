# Launch the app in Tauri dev mode and wait for its window to appear.
#
# Why call node_modules\.bin\tauri.cmd instead of `pnpm tauri dev`:
#   pnpm on this machine is a PowerShell script (D:\npm-global\pnpm.ps1), and
#   Start-Process cannot execute a .ps1 as a program ("%1 is not a valid Win32
#   application"). Calling the CLI's .cmd shim directly avoids the wrapper.
#
# ASCII-only on purpose (PowerShell 5.1 + BOM-less UTF-8 = GBK misparse).

param(
    [int]$TimeoutSec = 300,
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
Set-Location 'D:\Users\Lenovo\Desktop\Diary\app'

$env:DSH_ENV_QUIET = '1'
. 'D:\Users\Lenovo\Desktop\Diary\scripts\env.ps1'
Remove-Item Env:\DSH_ENV_QUIET -ErrorAction SilentlyContinue

$out = 'D:\Users\Lenovo\Desktop\Diary\_dev-out.log'
$err = 'D:\Users\Lenovo\Desktop\Diary\_dev-err.log'
Remove-Item $out, $err -ErrorAction SilentlyContinue

Write-Output 'Starting: tauri dev'
$p = Start-Process -FilePath 'node_modules\.bin\tauri.cmd' -ArgumentList @('dev') `
    -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Write-Output ("  pid = {0}" -f $p.Id)

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$found = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
        Write-Output "  process exited with code $($p.ExitCode)"
        break
    }
    $win = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '日记' }
    if ($win) { $found = $win; break }
}

Write-Output ''
if ($found) {
    Write-Output 'WINDOW APPEARED:'
    $found | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 100 | Write-Output
} else {
    Write-Output 'WINDOW NOT DETECTED'
}

Write-Output '--- stdout (tail) ---'
Get-Content $out -ErrorAction SilentlyContinue | Select-Object -Last 15 | ForEach-Object { Write-Output "  $_" }
Write-Output '--- stderr (meaningful lines) ---'
Get-Content $err -ErrorAction SilentlyContinue |
    Where-Object { $_ -notmatch 'LNK4099|^\s*(Compiling|Checking|Downloading|Downloaded|Updating|Locking)' -and $_.Trim() -ne '' } |
    Select-Object -Last 20 | ForEach-Object { Write-Output "  $_" }

if (-not $KeepRunning) {
    Write-Output ''
    Write-Output 'Stopping dev processes...'
    # Kill the whole tree: tauri spawns cargo, which spawns the app exe.
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -in @('tauri','cargo','app','node') -and $_.Id -ne $PID } |
        ForEach-Object {
            try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    Start-Sleep -Seconds 2
    $left = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '日记' }
    if ($left) { Write-Output '  WARNING: app window still present' } else { Write-Output '  stopped' }
}
