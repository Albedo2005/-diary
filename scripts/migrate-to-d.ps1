# Move the Rust toolchain and pnpm store from C: to D:.
#
# Why: C: has little free space (~24 GB); D: is roomy (~283 GB).
#
# What moves:
#   %USERPROFILE%\.rustup                    -> D:\rust\rustup   (~1.3 GB)
#   %USERPROFILE%\.cargo                     -> D:\rust\cargo    (~0.3 GB)
#   %LOCALAPPDATA%\pnpm\store                -> D:\pnpm-store    (~0.4 GB)
#
# How: rustup and cargo both support relocation via the RUSTUP_HOME and
# CARGO_HOME environment variables. That is the officially supported way;
# PATH keeps pointing at <CARGO_HOME>\bin.
#
# Usage:  powershell -ExecutionPolicy Bypass -File D:\Users\Lenovo\Desktop\Diary\scripts\migrate-to-d.ps1
#
# NOTE: This script is deliberately ASCII-only. Windows PowerShell 5.1 reads
#       BOM-less .ps1 files as ANSI/GBK, which corrupts non-ASCII comments and
#       breaks parsing. Keep it ASCII to stay encoding-proof.
#
# Safety: this script only COPIES. It never deletes the originals. Verify the
#         new location works, then delete the old directories yourself.

$ErrorActionPreference = 'Stop'
$user = $env:USERPROFILE

$moves = @(
    @{ name = 'rustup'; src = "$user\.rustup";                dst = 'D:\rust\rustup' },
    @{ name = 'cargo';  src = "$user\.cargo";                 dst = 'D:\rust\cargo' },
    @{ name = 'pnpm';   src = "$env:LOCALAPPDATA\pnpm\store"; dst = 'D:\pnpm-store' }
)

Write-Host '=== Disk free space BEFORE ===' -ForegroundColor Cyan
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -in 'C','D' } |
    Select-Object Name, @{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize

foreach ($m in $moves) {
    Write-Host "--- $($m.name) ---" -ForegroundColor Cyan
    if (-not (Test-Path $m.src)) { Write-Host "  SKIP: source missing: $($m.src)"; continue }
    if (Test-Path $m.dst)        { Write-Host "  SKIP: destination already exists: $($m.dst)"; continue }

    New-Item -ItemType Directory -Force -Path (Split-Path $m.dst -Parent) | Out-Null
    Write-Host "  copying $($m.src)"
    Write-Host "       -> $($m.dst)"

    # /E copy subdirs incl. empty, /MT:16 multithread, /NFL /NDL /NJH /NJS quiet
    $rc = Start-Process robocopy -ArgumentList @("`"$($m.src)`"", "`"$($m.dst)`"", '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:2') -Wait -PassThru -NoNewWindow
    # robocopy exit codes below 8 mean success
    if ($rc.ExitCode -ge 8) { throw "robocopy failed with exit code $($rc.ExitCode)" }
    Write-Host "  done (robocopy exit=$($rc.ExitCode))" -ForegroundColor Green
}

Write-Host '=== Setting user-level environment variables ===' -ForegroundColor Cyan
[Environment]::SetEnvironmentVariable('RUSTUP_HOME', 'D:\rust\rustup', 'User')
[Environment]::SetEnvironmentVariable('CARGO_HOME',  'D:\rust\cargo',  'User')
Write-Host '  RUSTUP_HOME = D:\rust\rustup'
Write-Host '  CARGO_HOME  = D:\rust\cargo'

# PATH: drop any old .cargo\bin entry, put the new one first.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries  = $userPath -split ';' | Where-Object { $_ -ne '' }
$desired  = 'D:\rust\cargo\bin'
$filtered = $entries | Where-Object { $_ -ne $desired -and $_ -notlike '*\.cargo\bin*' }
[Environment]::SetEnvironmentVariable('Path', ((@($desired) + $filtered) -join ';'), 'User')
Write-Host "  PATH updated (removed old .cargo\bin, added $desired)"

Write-Host '=== Verification ===' -ForegroundColor Cyan
if (Test-Path 'D:\rust\cargo\bin\rustc.exe') { Write-Host '  rustc at new location: OK' } else { Write-Host '  rustc at new location: MISSING' -ForegroundColor Red }
if (Test-Path 'D:\rust\rustup\toolchains')   { Write-Host '  rustup toolchains:     OK' } else { Write-Host '  rustup toolchains:     MISSING' -ForegroundColor Red }

Write-Host '=== Disk free space AFTER ===' -ForegroundColor Cyan
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -in 'C','D' } |
    Select-Object Name, @{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize

Write-Host 'Copy finished. Originals on C: were NOT deleted.' -ForegroundColor Yellow
Write-Host 'After confirming the new location works, delete these to free C: space:' -ForegroundColor Yellow
foreach ($m in $moves) { if (Test-Path $m.src) { Write-Host "  Remove-Item -Recurse -Force `"$($m.src)`"" } }
Write-Host ''
Write-Host 'WARNING: open a NEW terminal and run  rustc --version  before deleting anything.' -ForegroundColor Yellow
