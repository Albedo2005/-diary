# Build a workspace binary reliably, with output redirected to files.
#
# Why Start-Process instead of "cargo build 1>> log":
#   PowerShell's ">>" append uses Out-File, which opens the file without sharing
#   and fails with "The process cannot access the file because it is being used
#   by another process" when several redirections target it. Start-Process
#   handles stdout/stderr to separate files cleanly.
#
# Also sources env.ps1 explicitly: a background job runs inside an already
# started shell, whose environment block was captured at ITS startup. The
# PowerShell profile only affects shells started afterwards, so relying on it
# here would be fragile.
#
# ASCII-only on purpose (PowerShell 5.1 + BOM-less UTF-8 = GBK misparse).

param(
    [string]$Bin = 'robust',
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
Set-Location 'D:\Users\Lenovo\Desktop\Diary'

# Make sure the toolchain is on PATH regardless of how this script was started.
$env:DSH_ENV_QUIET = '1'
. 'D:\Users\Lenovo\Desktop\Diary\scripts\env.ps1'
Remove-Item Env:\DSH_ENV_QUIET -ErrorAction SilentlyContinue

$outLog = 'D:\Users\Lenovo\Desktop\Diary\_build-out.log'
$errLog = 'D:\Users\Lenovo\Desktop\Diary\_build-err.log'
Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

$cargoArgs = @('build', '--release')
if ($Offline) { $cargoArgs += '--offline' }
if ($Bin)     { $cargoArgs += @('--bin', $Bin) }

Write-Output ("cargo {0}" -f ($cargoArgs -join ' '))
$sw = [Diagnostics.Stopwatch]::StartNew()

$p = Start-Process -FilePath 'cargo' -ArgumentList $cargoArgs `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$sw.Stop()
Write-Output ("exit={0}  elapsed={1:N0}s" -f $p.ExitCode, $sw.Elapsed.TotalSeconds)

# Report only meaningful lines; the linker emits thousands of harmless LNK4099.
$interesting = Get-Content $outLog -ErrorAction SilentlyContinue |
    Where-Object { $_ -match 'Compiling|Finished|^error|warning: unused' }
if ($interesting) {
    $interesting | Select-Object -Last 12 | ForEach-Object { Write-Output "  $_" }
}

$errLines = @(Get-Content $errLog -ErrorAction SilentlyContinue)
$realErr = $errLines | Where-Object { $_ -match '^error|error\[E' }
if ($realErr) {
    Write-Output 'REAL ERRORS:'
    $realErr | Select-Object -First 15 | ForEach-Object { Write-Output "  $_" }
} elseif ($errLines.Count -gt 0) {
    $pdb = ($errLines | Where-Object { $_ -match 'LNK4099' }).Count
    Write-Output ("stderr: {0} line(s), {1} are LNK4099 PDB warnings (harmless)" -f $errLines.Count, $pdb)
}

if ($p.ExitCode -eq 0) {
    Write-Output 'BUILD OK'
} else {
    Write-Output 'BUILD FAILED'
    exit 1
}
