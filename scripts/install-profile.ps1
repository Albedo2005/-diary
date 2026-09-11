# Install the project's Rust environment into the PowerShell user profile.
#
# What this does:
#   Appends a clearly marked block to the PowerShell user profile that sources
#   scripts\env.ps1. Result: every NEW PowerShell terminal already has
#   cargo / rustc / perl / nasm / gmake available -- no manual step.
#
# Why a profile instead of the global user PATH:
#   The Perl directory also contains MinGW gcc 13.2.0. Putting it on the global
#   PATH would shadow other gcc installations on this machine. A profile keeps
#   the change scoped to PowerShell sessions and reversible.
#
# What a PowerShell profile IS:
#   A plain .ps1 file that PowerShell runs automatically at startup. It is the
#   standard way to configure a user's shell. `$PROFILE` prints its path.
#
# Uninstall: run this script with -Uninstall, or delete the marked block from
#   the profile file by hand.
#
# ASCII-only on purpose (PowerShell 5.1 + BOM-less UTF-8 = GBK misparse).

param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$beginMark = '# >>> dsh-diary rust env >>>'
$endMark   = '# <<< dsh-diary rust env <<<'
$block = @(
    $beginMark,
    '# Installed by D:\Users\Lenovo\Desktop\Diary\scripts\install-profile.ps1',
    '# Sets cargo/rustc/perl/nasm/gmake for the Rust + SQLCipher build.',
    '$env:DSH_ENV_QUIET = ''1''',
    'try { . "D:\Users\Lenovo\Desktop\Diary\scripts\env.ps1" } catch { Write-Warning "dsh-diary env.ps1 failed: $_" }',
    'Remove-Item Env:\DSH_ENV_QUIET -ErrorAction SilentlyContinue',
    $endMark
) -join "`r`n"

# Target both the version-specific profile (Windows PowerShell 5.1 and 7) and
# the all-hosts profile, so it works regardless of which shell is opened.
$targets = @(
    $PROFILE,
    $PROFILE.CurrentUserAllHosts
) | Where-Object { $_ } | Select-Object -Unique

foreach ($profilePath in $targets) {
    Write-Host "--- profile: $profilePath"

    $dir = Split-Path $profilePath -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Write-Host '    created directory'
    }

    $existing = if (Test-Path $profilePath) { Get-Content -Raw $profilePath } else { '' }

    # Strip any previously installed block first (idempotent re-install).
    if ($existing -match [regex]::Escape($beginMark)) {
        $pattern = "(?s)" + [regex]::Escape($beginMark) + ".*?" + [regex]::Escape($endMark) + "\r?\n?"
        $existing = [regex]::Replace($existing, $pattern, '')
        Write-Host '    removed previous block'
    }

    if ($Uninstall) {
        Set-Content -Path $profilePath -Value $existing -Encoding UTF8 -NoNewline
        Write-Host '    uninstalled' -ForegroundColor Yellow
        continue
    }

    $newContent = $existing.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
    Set-Content -Path $profilePath -Value $newContent -Encoding UTF8 -NoNewline
    Write-Host '    installed' -ForegroundColor Green
}

Write-Host ''
if ($Uninstall) {
    Write-Host 'Profile entry removed. Open a new terminal; cargo/perl will no longer be preset.' -ForegroundColor Yellow
} else {
    Write-Host 'Done. Open a NEW terminal and run:  cargo --version' -ForegroundColor Green
    Write-Host 'You should also be able to run:      perl -v ; nasm -v ; gmake --version'
    Write-Host ''
    Write-Host 'If you ever want to remove it:'
    Write-Host '  powershell -ExecutionPolicy Bypass -File D:\Users\Lenovo\Desktop\Diary\scripts\install-profile.ps1 -Uninstall'
}
