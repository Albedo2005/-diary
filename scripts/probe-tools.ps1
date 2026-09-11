# Probe script: report tool availability + env vars. Run via `powershell -File`.
# ASCII-only on purpose (PowerShell 5.1 + BOM-less UTF-8 = GBK misparse).

$tools = @('cargo','rustc','rustup','perl','nasm','gmake','node','pnpm')
foreach ($t in $tools) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if ($c) {
        Write-Output ("OK       {0,-7} -> {1}" -f $t, $c.Source)
    } else {
        Write-Output ("MISSING  {0,-7}" -f $t)
    }
}
Write-Output ("RUSTUP_HOME = {0}" -f $env:RUSTUP_HOME)
Write-Output ("CARGO_HOME  = {0}" -f $env:CARGO_HOME)
Write-Output ("perl on PATH: {0}" -f ($env:Path -like '*toolchain\perl*'))
