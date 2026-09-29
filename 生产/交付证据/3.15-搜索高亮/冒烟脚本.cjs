/*
 * 等价冒烟（`3.15` ＝【P2-8】HTML 导出）：验"发布件本身"能不能起来。
 *
 * 为什么不用 scripts/smoke-test.ps1：它内部用 `Start-Process`，而当前受限 shell 的
 * 环境里同时存在 `Path`/`PATH`（大小写重名），PowerShell 5.1 构造环境字典时会直接抛
 * 「已添加项。字典中的关键字:"Path"所添加的关键字:"PATH"」——
 * 这条限制**早就记在《生产日志》坑表里**（publish-exe.ps1 因此改用 node 跑 tauri）。
 * 该脚本不在【P2-3】的改动清单内，所以这里不去改它，改为做一份等价检查。
 *
 * 检查四件事（与 smoke-test.ps1 的口径一致）：
 *   ① 双击能起（进程活着）
 *   ② 真的画出了窗口（有可见的主窗口句柄，不是隐藏/空白）
 *   ③ 界面渲染出来了（能连上调试端口、页面里有内容）
 *   ④ stderr 里没有 panic / 托盘创建失败
 *
 * ⚠️ 与 `_verify-314.cjs` 分开跑、分开的数据目录 ——
 *    冒烟的对象是**发布件**（`发布\日记.exe`），界面验证这次也钉在发布件上。
 *
 * 本件是 `3.13` 那份冒烟的同口径复跑（唯一改动：数据目录 / 端口 / 版本注释）。
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = "D:\\Users\\Lenovo\\Desktop\\Diary";
const EXE = path.join(REPO, "发布", "日记.exe");
const DATA = path.join(REPO, "_ui-verify-315", "smoke-data");
const PORT = 9389;

function ps(script) {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  try {
    return execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return "PS_ERROR: " + String((e && e.message) || e).slice(0, 200);
  }
}
const PS_WIN = `
Add-Type -Namespace V -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);'
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const rec = (k, v) => {
  rows.push([k, v]);
  console.log(`  [${k}] ${JSON.stringify(v)}`);
};

const PS_EXE_STATE = `
$exe = '${EXE.replace(/'/g, "''")}'
$hits = @()
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
  try { if ($p.Path -eq $exe) { $hits += "$($p.Id):$($p.MainWindowHandle)" } } catch {}
}
($hits -join ',')
`;

(async () => {
  // 清残留
  ps(`
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*com.dsh.diary*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
  try { if ($p.Path -eq '${EXE}') { Stop-Process -Id $p.Id -Force } } catch {}
}
`);
  await sleep(600);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const exeSize = fs.statSync(EXE).size;
  rec("S0 发布件大小（B）", exeSize);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, DSH_DIARY_DATA_DIR: DATA },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (b) => (err += String(b)));

  // 等窗口出来
  let state = "";
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    state = ps(PS_EXE_STATE);
    if (state && state !== "" && !state.startsWith("PS_ERROR")) {
      const hwnd = state.split(":")[1];
      if (hwnd && hwnd !== "0") break;
    }
  }
  rec("S1 进程 + 主窗口（pid:hwnd）", state);
  const alive = !!(state && state !== "" && !state.startsWith("PS_ERROR"));
  const hwnd = alive ? String(state).split(",")[0].split(":")[1] : null;
  rec("S2 ⭐ 双击能起（进程活着）", alive);
  rec("S3 ⭐ 真的画出了主窗口（句柄非 0）", !!hwnd && hwnd !== "0");
  if (hwnd && hwnd !== "0") {
    rec("S4 ⭐ 窗口是可见的（不是隐藏的）", ps(`${PS_WIN}\n[V.W]::IsWindowVisible([IntPtr]${hwnd})`));
  }

  // 页面渲染出来了吗
  let pageOk = false;
  let title = null;
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = list.find((t) => t.type === "page" && t.url && t.url !== "about:blank");
      if (p) {
        title = p.title;
        pageOk = true;
        break;
      }
    } catch {}
    await sleep(400);
  }
  rec("S5 ⭐ 界面渲染出来了（调试端口上有页面）", pageOk);
  rec("S5b 页面标题", title);

  rec("S6 stderr（应无 panic / 托盘创建失败）", err.replace(/\s+$/, "").slice(0, 400) || "(空)");
  rec("S7 ⭐ stderr 里没有致命错误", !/panicked|托盘创建失败|托盘图标缺失/.test(err));

  const bad = rows.filter(([k, v]) => v === false).length;
  rec("S8 合计", `${rows.length} 条记录；判 false 的 ${bad} 条`);
  rec("S9 冒烟结论", bad === 0 ? "SMOKE PASS" : "SMOKE FAIL");

  try { child.kill(); } catch {}
  ps(`
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*com.dsh.diary*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
  try { if ($p.Path -eq '${EXE}') { Stop-Process -Id $p.Id -Force } } catch {}
}
`);
  process.exit(bad === 0 ? 0 : 1);
})();
