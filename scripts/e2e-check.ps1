# End-to-end check in a fresh terminal: build the probe crate and run it.
# Linker PDB warnings (LNK4099) are harmless: OpenSSL's prebuilt objects carry
# no debug info. We redirect to files so PowerShell does not treat a stderr
# warning as a failure.
# ASCII-only on purpose (PowerShell 5.1 + BOM-less UTF-8 = GBK misparse).

$ErrorActionPreference = 'Continue'
Set-Location 'D:\Users\Lenovo\Desktop\Diary\probe'

$outLog = "$env:TEMP\dsh-e2e-out.txt"
$errLog = "$env:TEMP\dsh-e2e-err.txt"

Write-Output '--- cargo build (incremental) ---'
& cargo build --release --offline --bin robust 1> $outLog 2> $errLog
$buildExit = $LASTEXITCODE
Write-Output ("  cargo exit code = {0}" -f $buildExit)

# Show only meaningful lines.
Get-Content $outLog -ErrorAction SilentlyContinue |
    Where-Object { $_ -match 'Compiling|Finished|error' } |
    Select-Object -Last 4 | ForEach-Object { Write-Output "  $_" }

$errCount = (Get-Content $errLog -ErrorAction SilentlyContinue | Measure-Object).Count
if ($errCount -gt 0) {
    $realErrors = Get-Content $errLog | Where-Object { $_ -match '^error' }
    if ($realErrors) {
        Write-Output '  stderr contains real errors:'
        $realErrors | Select-Object -First 5 | ForEach-Object { Write-Output "    $_" }
    } else {
        Write-Output ("  stderr has {0} line(s): all linker PDB warnings (LNK4099), harmless" -f $errCount)
    }
}

if ($buildExit -ne 0) {
    Write-Output 'BUILD FAILED'
    exit 1
}

Write-Output ''
Write-Output '--- run the built binary (proves SQLCipher is linked and executes) ---'
& '.\target\release\robust.exe' 1> $outLog 2> $errLog
$runExit = $LASTEXITCODE
Write-Output ("  run exit code = {0}" -f $runExit)
Get-Content $outLog | Select-Object -First 16 | ForEach-Object { Write-Output "  $_" }

Write-Output ''
if ($buildExit -eq 0 -and $runExit -eq 0) {
    Write-Output 'E2E CHECK PASSED: fresh terminal can build and run.'
} else {
    Write-Output 'E2E CHECK FAILED'
    exit 1
}
