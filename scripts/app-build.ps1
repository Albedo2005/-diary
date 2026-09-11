# Build/check script for the Tauri application crate.
#
# Why not just `cargo build` in app/src-tauri:
#   tauri-build's build script expects either CLI-provided config or a Windows
#   resource compiler. Using the Tauri CLI (`pnpm tauri ...`) is the supported
#   path and also wires up the frontend dev server.
#
# This script wraps `cargo check` for fast iteration on the Rust side, because a
# full Tauri bundle build is slow and unnecessary while developing.
#
# ASCII-only on purpose (PowerShell 5.1 + BOM-less UTF-8 = GBK misparse).

param(
    [ValidateSet('check', 'build', 'dev', 'test', 'example')]
    [string]$Task = 'check',
    [string]$Example = 'backup_probe'
)

$ErrorActionPreference = 'Stop'
Set-Location 'D:\Users\Lenovo\Desktop\Diary\app'

$env:DSH_ENV_QUIET = '1'
. 'D:\Users\Lenovo\Desktop\Diary\scripts\env.ps1'
Remove-Item Env:\DSH_ENV_QUIET -ErrorAction SilentlyContinue

$outLog = 'D:\Users\Lenovo\Desktop\Diary\_app-out.log'
$errLog = 'D:\Users\Lenovo\Desktop\Diary\_app-err.log'
Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

switch ($Task) {
    'check' {
        Write-Output 'cargo check (Rust side, fast)'
        $p = Start-Process -FilePath 'cargo' -ArgumentList @('check', '--manifest-path', 'src-tauri\Cargo.toml') `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    }
    'test' {
        Write-Output 'cargo test (Rust unit tests)'
        $p = Start-Process -FilePath 'cargo' -ArgumentList @('test', '--manifest-path', 'src-tauri\Cargo.toml') `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    }
    'build' {
        Write-Output 'pnpm tauri build (full bundle)'
        $p = Start-Process -FilePath 'pnpm' -ArgumentList @('tauri', 'build') `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    }
    'example' {
        Write-Output ("cargo run --release --example {0}" -f $Example)
        $p = Start-Process -FilePath 'cargo' -ArgumentList @('run', '--release', '--example', $Example, '--manifest-path', 'src-tauri\Cargo.toml') `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    }
    'dev' {
        Write-Output 'pnpm tauri dev (opens a window; Ctrl+C to stop)'
        & pnpm tauri dev
        exit $LASTEXITCODE
    }
}

Write-Output ("exit={0}" -f $p.ExitCode)

$interesting = Get-Content $outLog -ErrorAction SilentlyContinue |
    Where-Object { $_ -match 'Compiling app|Finished|^error|^warning: unused|error\[E|^===|^---|✓|✗|采用|方案' }
if ($interesting) { $interesting | Select-Object -Last 40 | ForEach-Object { Write-Output "  $_" } }

$errLines = @(Get-Content $errLog -ErrorAction SilentlyContinue)
$realErr = $errLines | Where-Object { $_ -match '^error|error\[E|panicked' }
if ($realErr) {
    Write-Output 'REAL ERRORS:'
    $realErr | Select-Object -First 40 | ForEach-Object { Write-Output "  $_" }
} elseif ($errLines.Count -gt 0) {
    # cargo writes progress to stderr; only report non-progress lines.
    $nonProgress = $errLines | Where-Object { $_ -notmatch '^\s+(Compiling|Checking|Finished|Downloaded|Downloading)' }
    if ($nonProgress) {
        Write-Output 'stderr (non-progress):'
        $nonProgress | Select-Object -First 20 | ForEach-Object { Write-Output "  $_" }
    }
}

if ($p.ExitCode -eq 0) { Write-Output 'APP BUILD OK' } else { Write-Output 'APP BUILD FAILED'; exit 1 }
