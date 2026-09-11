# Verify the persistent setup by launching a genuinely fresh PowerShell
# (WITH profile loading, unlike earlier tests which used -NoProfile).
# ASCII-only on purpose (PowerShell 5.1 + BOM-less UTF-8 = GBK misparse).

Write-Host '=== Fresh terminal (profile loads normally) ==='
Write-Host ''

$out = & powershell.exe -Command @'
$tools = @("cargo","rustc","rustup","perl","nasm","gmake")
foreach ($t in $tools) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if ($c) { "OK       $t  ->  " + $c.Source } else { "MISSING  $t" }
}
"RUSTUP_HOME = " + $env:RUSTUP_HOME
"CARGO_HOME  = " + $env:CARGO_HOME
'@ 2>&1

$out | ForEach-Object { Write-Host "  $_" }

Write-Host ''
Write-Host '=== Real build test in the fresh terminal ==='
Write-Host '  (forces a recompile of the probe crate to exercise rustc + cl.exe + link.exe)'
$build = & powershell.exe -Command @'
Set-Location D:\Users\Lenovo\Desktop\Diary\probe
& cargo build --release --offline --bin kdf 2>&1 | Select-String -Pattern "Finished|^error|error\[" | Select-Object -Last 3
'exit=' + $LASTEXITCODE
'@ 2>&1

$build | ForEach-Object { Write-Host "  $_" }
