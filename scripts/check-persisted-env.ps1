# Read the TRUE persisted user environment from the registry (HKCU\Environment).
# A child process inherits its parent's env block, so testing from an old
# terminal gives a false negative. The registry is the source of truth for what
# a NEW terminal will receive.
#
# ASCII-only on purpose (PowerShell 5.1 + BOM-less UTF-8 = GBK misparse).

$key = 'HKCU:\Environment'
$props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue

# Read raw (unexpanded) values so we see exactly what is stored.
$raw = Get-Item -Path $key -ErrorAction SilentlyContinue

function Get-RawValue($name) {
    if (-not $raw) { return $null }
    try { return $raw.GetValue($name, '', 'DoNotExpandEnvironmentNames') } catch { return $null }
}

Write-Host '=== TRUE persisted user env vars (HKCU\Environment) ==='
foreach ($k in @('RUSTUP_HOME','CARGO_HOME')) {
    $v = Get-RawValue $k
    Write-Host ("  {0,-12} = {1}" -f $k, $(if ($v) { $v } else { '(not set)' }))
}

$userPath = Get-RawValue 'Path'
Write-Host ''
Write-Host '=== TRUE persisted user Path ==='
if (-not $userPath) {
    Write-Host '  <empty or unreadable>' -ForegroundColor Red
} else {
    ($userPath -split ';') | Where-Object { $_ } | ForEach-Object { Write-Host "  $_" }
}

Write-Host ''
Write-Host '=== What a NEW terminal will find (resolved against persisted Path) ==='
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$all = @(($userPath -split ';') | Where-Object { $_ }) + @(($machinePath -split ';') | Where-Object { $_ })

foreach ($t in @('rustc','cargo','rustup','perl','nasm','gmake','node','pnpm','git')) {
    $found = $null
    foreach ($e in $all) {
        $expanded = [Environment]::ExpandEnvironmentVariables($e)
        foreach ($ext in @('.exe','.cmd','.bat','.ps1')) {
            $cand = Join-Path $expanded "$t$ext"
            if (Test-Path $cand -PathType Leaf) { $found = $cand; break }
        }
        if ($found) { break }
    }
    if ($found) {
        Write-Host ("  {0,-8} OK       {1}" -f $t, $found) -ForegroundColor Green
    } else {
        Write-Host ("  {0,-8} MISSING  <-- a new terminal cannot use this" -f $t) -ForegroundColor Red
    }
}
