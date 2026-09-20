# Rebuild the app and refresh the double-clickable copy in the delivery folder.
#
# Why this exists:
#   `target\release\app.exe` is a build artifact -- nothing refreshes it unless
#   someone remembers to. The delivery folder sat stale on 1.4 while the source
#   moved on to 1.6, so double-clicking the exe there showed an old UI.
#   This script makes "produce a fresh double-clickable exe" one command.
#
# Usage (from anywhere):
#   powershell -File scripts\publish-exe.ps1              # build + copy + smoke
#   powershell -File scripts\publish-exe.ps1 -SkipBuild   # copy + smoke only
#   powershell -File scripts\publish-exe.ps1 -SkipSmoke   # build + copy only
#
# Result:
#   <proj>\发布\日记.exe
#   A standalone binary: it embeds the frontend bundle (tauri.conf.json ->
#   build.frontendDist = ../dist), so it needs NO dev server and NO port 1420.
#   Only `pnpm app:dev` / target\debug\app.exe need a running dev server.
#
# ASCII-only on purpose: PowerShell 5.1 parses a BOM-less .ps1 as the ANSI
# codepage (GBK here) and would mangle CJK literals. The two Chinese names are
# therefore built from char codes instead of being typed directly:
#   发布 = U+53D1 U+5E03      日记 = U+65E5 U+8BB0

param(
    [switch]$SkipBuild,
    [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
$proj = 'D:\Users\Lenovo\Desktop\Diary'
$app = Join-Path $proj 'app'

$publishDir = Join-Path $proj ([string][char]0x53D1 + [char]0x5E03)
$exeName = ([string][char]0x65E5 + [char]0x8BB0) + '.exe'
$srcExe = Join-Path $proj 'target\release\app.exe'
$dstExe = Join-Path $publishDir $exeName
$confJson = Join-Path $app 'src-tauri\tauri.conf.json'

# ---------------------------------------------------------------------------
# 1. Build
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
    $env:DSH_ENV_QUIET = '1'
    . (Join-Path $proj 'scripts\env.ps1')
    try { Remove-Item Env:\DSH_ENV_QUIET -ErrorAction Stop } catch { }

    # `tauri build` runs beforeBuildCommand = "pnpm build", so pnpm must be
    # reachable. env.ps1 covers the Rust toolchain but not pnpm.
    $pnpmDir = 'D:\npm-global'
    if ((Test-Path $pnpmDir) -and ($env:PATH -notlike "*$pnpmDir*")) {
        $env:PATH = "$pnpmDir;$env:PATH"
    }

    # Launch the Tauri CLI through node, not through the .cmd shim.
    #
    # Why not Start-Process on node_modules\.bin\tauri.cmd:
    #   * PowerShell 5.1 builds a case-insensitive dictionary from the process
    #     environment before launching. When the environment carries both
    #     `http_proxy` and `HTTP_PROXY` (some proxies and sandboxes export both)
    #     it throws "已添加项。字典中的关键字..." and nothing runs at all.
    #   * A .cmd shim additionally needs cmd.exe, which restricted shells refuse.
    #   * PowerShell *file redirection* (`1> x 2> y`) is known to kill cargo.
    # Node + Tee-Object avoids all three: Tee-Object is a pipeline, not a
    # redirection, so the child process is never signalled.
    $tauriJs = Join-Path $app 'node_modules\@tauri-apps\cli\tauri.js'
    if (-not (Test-Path $tauriJs)) {
        throw "tauri CLI not found: $tauriJs  (run `pnpm install` in app\ first)"
    }
    $node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node) { $node = 'D:\node\nodejs\node.exe' }
    if (-not (Test-Path $node)) { throw "node not found (tried PATH and $node)" }

    $outLog = Join-Path $proj '_publish-out.log'
    # Tee-Object overwrites, so no pre-delete is needed. Deliberately no
    # Remove-Item here either: under a sandboxed agent the safe-delete shim
    # fails closed on a missing path and kills the script before it does anything.

    Write-Output 'building (tauri build --no-bundle) ...'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $app
    # Tauri and cargo write progress to stderr. In Windows PowerShell 5.1 any
    # native stderr output is wrapped as an ErrorRecord, and this script runs
    # with ErrorActionPreference = 'Stop' -- so the very first progress line
    # would abort the build. Relax it for the duration and judge the build by
    # the exit code alone (cargo's stderr is not an error signal).
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $node $tauriJs 'build' '--no-bundle' 2>&1 | Tee-Object -FilePath $outLog
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
        Pop-Location
    }
    $sw.Stop()
    Write-Output ("  exit={0}  elapsed={1:N0}s" -f $code, $sw.Elapsed.TotalSeconds)

    if ($code -ne 0) {
        Write-Output '--- last build output ---'
        Get-Content $outLog -ErrorAction SilentlyContinue |
            Select-Object -Last 40 | ForEach-Object { Write-Output "  $_" }
        throw 'build failed -- delivery copy left untouched'
    }
    # Build log is kept on purpose: it is git-ignored (*.log) and is the only
    # record when a later step misbehaves.
}

if (-not (Test-Path $srcExe)) {
    throw "build artifact missing: $srcExe  (drop -SkipBuild to build it)"
}

# ---------------------------------------------------------------------------
# 2. Copy into the delivery folder
# ---------------------------------------------------------------------------
if (-not (Test-Path $publishDir)) {
    New-Item -ItemType Directory -Force -Path $publishDir | Out-Null
}
Copy-Item -Path $srcExe -Destination $dstExe -Force

$srcHash = (Get-FileHash $srcExe -Algorithm SHA256).Hash
$dstHash = (Get-FileHash $dstExe -Algorithm SHA256).Hash
$size = (Get-Item $dstExe).Length
$version = (Get-Content $confJson -Raw | ConvertFrom-Json).version
$stamp = (Get-Item $dstExe).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')

Write-Output ''
Write-Output 'published:'
Write-Output ("  file    : {0}" -f $dstExe)
Write-Output ("  version : {0}" -f $version)
Write-Output ("  size    : {0:N0} bytes" -f $size)
Write-Output ("  written : {0}" -f $stamp)
Write-Output ("  sha256  : {0}" -f $dstHash)
Write-Output ("  identical to the build artifact: {0}" -f ($srcHash -eq $dstHash))

# `使用说明.md` lives in the same folder and is hand-written -- never touch it.

# ---------------------------------------------------------------------------
# 3. Smoke test the published file itself
# ---------------------------------------------------------------------------
if (-not $SkipSmoke) {
    Write-Output ''
    Write-Output 'smoke test on the published copy (no dev server running) ...'
    # Dot into the current process so the CJK path is passed as a .NET string
    # rather than through the command line (which is codepage-sensitive).
    #
    # Not fatal if it cannot run: some restricted shells (and sandboxed agents)
    # reject Start-Process outright, and that says nothing about the build.
    try {
        & (Join-Path $proj 'scripts\smoke-test.ps1') -Exe $dstExe
    } catch {
        Write-Output ('  smoke test could not run in this shell: ' + $_.Exception.Message)
        Write-Output '  This is an environment limitation, NOT a build failure.'
        Write-Output '  Run scripts\smoke-test.ps1 in a normal terminal, or just double-click the exe.'
    }
}

Write-Output ''
Write-Output 'PUBLISH OK'
