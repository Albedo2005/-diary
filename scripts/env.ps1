# Rust build environment for the diary project.
#
# Modes:
#   1. Automatic: sourced by the PowerShell user profile (see
#      scripts\install-profile.ps1), so new terminals are ready to build.
#   2. Manual:    . <project>\scripts\env.ps1
#
# Toolchain layout (everything on D:, centralized under D:\toolchains):
#   D:\toolchains\rustup     RUSTUP_HOME
#   D:\toolchains\cargo      CARGO_HOME  (cargo/rustc shims live in cargo\bin)
#   D:\toolchains\perl       portable Strawberry Perl: perl.exe, gmake.exe, nasm.exe
#   D:\toolchains\mingw64    WinLibs GCC (kept OUT of PATH, see note below)
#
# ENCODING: this file contains a non-ASCII path (the project folder name), so it
# is saved as UTF-8 **with BOM**. Windows PowerShell 5.1 reads BOM-less files as
# ANSI/GBK, which would corrupt the path. With a BOM it parses correctly.
# Do not strip the BOM from this file.
#
# Why MINGW is deliberately NOT added to PATH:
#   The Rust targets here use the MSVC toolchain, and the C dependencies
#   (SQLCipher, OpenSSL) must be built with MSVC. Putting a MinGW gcc first on
#   PATH risks the `cc` crate picking gcc instead of cl.exe, which produces
#   binaries that fail at link time. MinGW is therefore opt-in only.

$ErrorActionPreference = 'Stop'

# --- toolchain homes ---
$env:RUSTUP_HOME = 'D:\toolchains\rustup'
$env:CARGO_HOME  = 'D:\toolchains\cargo'

$toolchain = 'D:\toolchains'
$perlBin   = Join-Path $toolchain 'perl\perl\bin'   # perl.exe
$perlCBin  = Join-Path $toolchain 'perl\c\bin'      # gmake.exe, nasm.exe

$missing = @()
foreach ($p in @($perlBin, $perlCBin, "$env:CARGO_HOME\bin")) {
    if (-not (Test-Path $p)) { $missing += $p }
}
if ($missing.Count -gt 0) {
    Write-Warning 'Rust build environment incomplete. Missing:'
    $missing | ForEach-Object { Write-Warning "  $_" }
    Write-Warning 'Re-extract portable Strawberry Perl to D:\toolchains\perl'
    return
}

# Prepend only if not already present, so repeated sourcing does not grow PATH.
$prepend = @("$env:CARGO_HOME\bin", $perlBin, $perlCBin)
$current = $env:Path -split ';'
foreach ($p in $prepend) {
    if ($current -notcontains $p) {
        $env:Path = "$p;$env:Path"
    }
}

# Quiet mode when sourced from the profile (no banner on every new terminal).
$quiet = $env:DSH_ENV_QUIET -eq '1'
if (-not $quiet) {
    Write-Host 'Rust build environment ready:' -ForegroundColor Green
    Write-Host ("  cargo : {0}" -f (& cargo --version))
    Write-Host ("  rustc : {0}" -f (& rustc --version))
    Write-Host ("  perl  : {0}" -f ((& perl -v) | Select-Object -Index 1))
    Write-Host ("  nasm  : {0}" -f (& nasm -v))
    Write-Host ("  gmake : {0}" -f ((& gmake --version) | Select-Object -First 1))
    Write-Host ''
    Write-Host 'Build artifacts land in target/ inside the project, which is on D:.' -ForegroundColor DarkGray
    Write-Host 'Do NOT set CARGO_TARGET_DIR to a new value: changing it invalidates' -ForegroundColor DarkGray
    Write-Host 'Cargo fingerprints and forces a full recompile of SQLCipher + OpenSSL.' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'First build of SQLCipher + OpenSSL takes ~12 min; later builds are fast.' -ForegroundColor Yellow
}
