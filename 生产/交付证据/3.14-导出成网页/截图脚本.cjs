// 【P2-8】交付截图：设置页「数据与备份」栏里的「导出格式」那一行，浅色 / 深色两态。
// 结构照搬 _ui-verify-313\\_shoot2.cjs（那个跑通过），只改端口 / 目录 / 步骤。
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXE = "D:\\Users\\Lenovo\\Desktop\\Diary\\发布\\日记.exe"; // ⭐ 验发布件本身
const PORT = 9455;
const OUT = "D:\\Users\\Lenovo\\Desktop\\Diary\\_ui-verify-314";
const DATA = path.join(OUT, "shootdata");
const PIN = "123456";

function killLeftovers() {
  try {
    const ps = [
      "$out = @(Get-CimInstance Win32_Process -Filter \"Name='日记.exe'\" |",
      "  Where-Object { $_.CommandLine -like '*com.dsh.diary*' } |",
      "  ForEach-Object { $_.ProcessId })",
      "if ($out.Count -gt 0) { $out -join ',' }",
    ].join(" ");
    const r = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000,
    }).trim();
    if (!r) return;
    for (const id of r.split(",")) {
      if (/^\d+$/.test(id.trim())) {
        try { execSync(`taskkill /PID ${id.trim()} /F /T`, { stdio: "ignore" }); } catch {}
      }
    }
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("找不到调试目标");
}

let WS = null;
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("连 CDP 超时")), 8000);
    ws.onopen = () => { clearTimeout(timer); WS = ws; resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP 连接错误")); };
  });
}
let msgId = 0;
const pending = new Map();
function send(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!WS) return reject(new Error("WS 已关"));
    const id = ++msgId;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`超时: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, t });
    try { WS.send(JSON.stringify({ id, method, params })); }
    catch (e) { clearTimeout(t); pending.delete(id); reject(e); }
  });
}
function wire() {
  WS.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  };
  WS.onclose = () => {
    for (const [id, p] of pending) { clearTimeout(p.t); p.reject(new Error("WS 关闭")); pending.delete(id); }
  };
}
async function evalFn(fn, ...args) {
  const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + ((r.result && r.result.description) || ""));
  return r.result.value;
}
async function waitFor(fn, desc, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await evalFn(fn);
    if (v) return v;
    await sleep(200);
  }
  throw new Error("等待超时: " + desc);
}
async function screenshot(file) {
  // ⚠️ 截图前必须**逼它重绘一轮**：窗口不在前台 / 被遮挡时合成器不产新帧，
  //    `Page.captureScreenshot` 会拿到**上一帧**（踩过：切了深色主题、图却还是白的）。
  try { await send("Page.bringToFront"); } catch {}
  await evalFn(() => {
    const b = document.querySelector(".settings-body") || document.querySelector(".rich-body");
    if (b) { b.scrollTop = b.scrollTop + 1; b.scrollTop = b.scrollTop - 1; }
    return true;
  });
  await sleep(900);
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("  拍下 " + file + " (" + fs.statSync(file).size + " B)");
}
async function setTheme(mode) {
  await send("Emulation.setEmulatedMedia", {
    media: "", features: [{ name: "prefers-color-scheme", value: mode }],
  });
  await sleep(600);
  const bg = await evalFn(() => {
    const p = document.querySelector(".modal .panel") || document.querySelector(".paper");
    return p ? getComputedStyle(p).backgroundColor : "(no panel)";
  });
  console.log(`  主题=${mode} 面板底色=${bg}`);
}

(async () => {
  console.log("=== 出图：P2-8 导出格式那一行 ===");
  killLeftovers();
  await sleep(600);
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const child = spawn(EXE, [], {
    env: { ...process.env, DSH_DIARY_DATA_DIR: DATA, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    detached: false, stdio: "ignore",
  });
  await sleep(2500);
  const target = await findTarget();
  await connect(target.webSocketDebuggerUrl);
  wire();
  await send("Runtime.enable");
  await send("Page.enable");
  console.log("CDP 就绪");
  await sleep(1500);

  console.log("建库…");
  await waitFor(() => !!document.querySelector("input.pin-input"), "锁屏 PIN 输入框");
  await evalFn((pin) => {
    const ins = document.querySelectorAll("input.pin-input");
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(ins[0], pin); set(ins[1], pin);
    return ins.length;
  }, PIN);
  await sleep(500);
  await evalFn(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("创建日记")); if (b) b.click(); return !!b; });
  await sleep(3000);
  await waitFor(() => !!document.querySelector(".topbar"), "顶栏出现", 30000);
  console.log("  建库 OK");

  await setTheme("light");

  console.log("打开设置…");
  await evalFn(() => {
    const b = document.querySelector('button[title="设置"]') || [...document.querySelectorAll("button")].find((x) => x.textContent.includes("设置"));
    if (b) b.click();
    return !!b;
  });
  await waitFor(() => !!document.querySelector("nav.side"), "设置分类导航", 10000);
  await sleep(500);
  await evalFn(() => {
    const b = [...document.querySelectorAll("nav.side button")].find((x) => x.textContent.includes("数据与备份"));
    if (b) b.click();
    return !!b;
  });
  await sleep(1200);
  const row = await evalFn(() => {
    const sel = document.querySelector('select[aria-label="导出格式"]');
    if (!sel) return { ok: false };
    const r = sel.closest(".row");
    if (r) r.scrollIntoView({ block: "center" });
    return {
      ok: true,
      format: sel.value,
      options: [...sel.options].map((o) => o.textContent),
      hasPath: !!(r && r.querySelector("input.path-input")),
      hasBtn: !!(r && r.querySelector("button.btn")),
      text: r ? r.innerText.replace(/\s+/g, " ").trim().slice(0, 160) : "",
    };
  });
  console.log("导出那一行 = " + JSON.stringify(row));
  await sleep(700);

  await setTheme("light");
  await screenshot(path.join(OUT, "look-light.png"));
  await setTheme("dark");
  await screenshot(path.join(OUT, "look-dark.png"));

  try { WS.close(); } catch {}
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
  killLeftovers();
  console.log("=== 完成 ===");
  process.exit(0);
})().catch((e) => {
  console.error("!! 失败:", e.message);
  try { WS && WS.close(); } catch {}
  process.exit(1);
});
