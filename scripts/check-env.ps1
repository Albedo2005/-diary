# Check which build tools are visible in a CLEAN session (no env.ps1 sourced).
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI/GBK.

$tools = @('rustc','cargo','perl','nasm','gmake','node','pnpm')
Write-Host '=== Tool visibility in a clean session ==='
foreach ($t in $tools) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if ($c) {
        Write-Host ("  {0,-8} OK       {1}" -f $t, $c.Source)
    } else {
        Write-Host ("  {0,-8} MISSING  <-- every new terminal fails on this" -f $t) -ForegroundColor Red
    }
}

Write-Host ''
Write-Host '=== Relevant user-level env vars (permanent) ==='
foreach ($k in @('RUSTUP_HOME','CARGO_HOME')) {
    $v = [Environment]::GetEnvironmentVariable($k, 'User')
    Write-Host ("  {0,-12} = {1}" -f $k, $(if ($v) { $v } else { '(not set)' }))
}
$up = [Environment]::GetEnvironmentVariable('Path', 'User')
Write-Host ("  Path contains cargo bin : {0}" -f ($up -like '*rust\cargo\bin*'))
Write-Host ("  Path contains perl bin  : {0}" -f ($up -like '*toolchain\perl*'))
Write-Host ''
Write-Host 'User Path entries:'
($up -split ';') | Where-Object { $_ } | ForEach-Object { Write-Host "  $_" }
