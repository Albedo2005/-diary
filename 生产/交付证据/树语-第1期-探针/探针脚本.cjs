/*
 * 树语 · 第一期 · **批次 1 —— WebGL 探针验证**
 *
 * 本件要回答的问题只有一个：
 *   **3D（WebGL2）到底能不能在这个软件的 WebView2 里跑起来、切走之后会不会停。**
 * 整条"用 three.js 做一棵树"的路线赌在这一步 —— 跑不起来，后面全要重想。
 *
 * 本脚本验四条（外加一条结构性前提）：
 *   A. **空库也要看得见「树语」** —— 一篇日记都没有时，页内三个小切换照样在
 *      （这是本期改动的结构：切换被搬到了空库判断之外）。
 *   B. 画布真的出来了 —— 存在、宽高 > 0、**画面不是一片纯色**。
 *      ⭐ 像素判据只用 CDP 截**画布那一块**、在 Node 里解 PNG（见 `decodePng`）。
 *         ⛔ 不在页面里 `drawImage` 读（WebGL 不保留绘制缓冲 ⇒ 恒为黑）；
 *         ⛔ 也不用全页截图（界面本身的颜色会让"非纯色"恒真、什么也没验）。
 *   C. 画面真的在刷新 —— 帧计数**在涨**。
 *   D. ⭐ **切走真的停了** —— 切到「刻度」后帧计数**冻结**；切回来**又涨**。
 *
 * ⚠️ 判据里那个「帧计数」只由**真的画了一帧**来加（`renderer.setAnimationLoop` 里），
 *    ⛔ 不是浏览器的动画帧 —— 那个即使 3D 停了也照样跳。
 *
 * ⚠️ 反例对照（铁律"没发生的断言要配一条能发生的"）：
 *    · D 的"切走冻住"必须配 C 的"在跑时确实在涨"，否则"没涨"可能只是压根没跑；
 *    · 卡帧判据自己也要被喂"过期值"验伪（末尾 `selfTest`）。
 *
 * ⚠️ 全程**只读**：一次性数据目录（`DSH_DIARY_DATA_DIR`）＋ 建库后不写任何日记
 *    ⇒ 不可能碰到用户的真实数据。
 *
 * 铁律遵循（技能 `tauri-webview2-ui-verify`）：
 *   · 跑前清残留的 WebView2 进程树（否则调试端口**静默失效**）；
 *   · `localStorage` 不活在数据目录里 ⇒ 必须显式删键再 reload；
 *   · CDP 的 send 一律带超时（应用一退 WS 静默关闭，无超时的 Promise 永不 settle）；
 *   · 截图验色**解码像素**，⛔ 不信看图预览；
 *   · 起完 exe 要等"页面看得见东西"再断言，别拿空白页下结论。
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// --------------------------------------------------------------------------
// PNG 解码（只用标准库 zlib —— 本仓库前端"零额外依赖"的纪律，脚本也一样）
//
// 为什么要解码而不是在页面里 `drawImage` 读像素：
//   WebGL 画布默认 `preserveDrawingBuffer: false`，合成完就把绘制缓冲清掉了
//   ⇒ 页面里拷出来的永远是一片黑。**唯一可信的是合成后的真实像素**，
//   也就是 `Page.captureScreenshot` 拿到的那个 PNG。
// --------------------------------------------------------------------------
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("位深 " + bitDepth + " 暂不支持");
  if (interlace !== 0) throw new Error("隔行 PNG 暂不支持");
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch) throw new Error("颜色类型 " + colorType + " 暂不支持");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    // ⭐ Buffer.subarray 是**视图**不是拷贝 ⇒ 写进去就是写进 out 本体。
    //    （Python 的 bytearray 切片是拷贝，曾因此整张解成全黑。）
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (filter === 0) {
        /* 原样 */
      } else if (filter === 1) {
        v = (v + a) & 0xff;
      } else if (filter === 2) {
        v = (v + b) & 0xff;
      } else if (filter === 3) {
        v = (v + ((a + b) >> 1)) & 0xff;
      } else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      } else {
        throw new Error("未知行滤波 " + filter);
      }
      cur[x] = v;
    }
  }
  return { width, height, channels: ch, data: out };
}

/** 数一张图里有多少种颜色（按 5 位量化）＋ 平均色 ＋ 头部颜色占比。 */
function colorStats(img) {
  const { width, height, channels, data } = img;
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 8000));
  const seen = new Map();
  let rS = 0;
  let gS = 0;
  let bS = 0;
  let n = 0;
  for (let i = 0; i < total; i += step) {
    const o = i * channels;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const k = `${r >> 3},${g >> 3},${b >> 3}`;
    seen.set(k, (seen.get(k) || 0) + 1);
    rS += r;
    gS += g;
    bS += b;
    n++;
  }
  const top = Array.from(seen.entries())
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([k, c]) => {
      const [r, g, b] = k.split(",").map((x) => (Number(x) << 3) + 4);
      return `(${r},${g},${b})×${((c / n) * 100).toFixed(1)}%`;
    });
  return {
    w: width,
    h: height,
    colors: seen.size,
    avg: [Math.round(rS / n), Math.round(gS / n), Math.round(bS / n)],
    top,
  };
}

const REPO = "D:\\Users\\Lenovo\\Desktop\\Diary";
const EXE = process.env.DIARY_EXE || path.join(REPO, "target", "release", "app.exe");
const ROOT = path.join(REPO, "_probe-tree-1");
const DATA = path.join(ROOT, "data");
const SHOT = path.join(ROOT, "shot-tree.png");
const SHOT_CANVAS = path.join(ROOT, "shot-tree-canvas.png");
const PIN = "135790";
const PORT = 9334;

const results = [];
function rec(k, v) {
  results.push([k, v]);
  console.log(`  [${k}] ${typeof v === "string" ? v : JSON.stringify(v)}`);
}
let bad = 0;
function ok(cond, k, v) {
  if (!cond) bad++;
  rec(`${cond ? "OK  " : "FAIL"} ${k}`, v);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(script) {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  try {
    return execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return `PS_ERROR: ${String((e && e.message) || e).slice(0, 200)}`;
  }
}

/** 清掉本应用残留的 WebView2 进程树（铁律 13：不清，调试端口会静默失效）。 */
function killLeftovers() {
  return ps(`
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*com.dsh.diary*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++ } catch {} }
$exe = '${EXE}'
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
  try { if ($p.Path -eq $exe) { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed++ } } catch {}
}
"killed=$killed"
`);
}

async function findTarget(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(
        (t) => t.type === "page" && t.url && t.url !== "about:blank" && !t.url.startsWith("devtools")
      );
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`端口 ${port} 上始终没有可用的 page 目标`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    let closed = false;
    const failAll = (why) => {
      closed = true;
      for (const [, { rej }] of pending) rej(new Error(why));
      pending.clear();
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      }
    };
    ws.onerror = () => reject(new Error("WebSocket 连接失败"));
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            if (closed) return rej(new Error("CDP 已关闭（应用可能已退出）"));
            const i = ++id;
            let done = false;
            const timer = setTimeout(() => {
              if (done) return;
              done = true;
              pending.delete(i);
              rej(new Error(`CDP 超时未回包: ${method}`));
            }, 6000);
            pending.set(i, {
              res: (v) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                res(v);
              },
              rej: (e) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                rej(e);
              },
            });
            try {
              ws.send(JSON.stringify({ id: i, method, params }));
            } catch (e) {
              done = true;
              clearTimeout(timer);
              pending.delete(i);
              rej(new Error(`CDP 发送失败: ${String((e && e.message) || e)}`));
            }
          });
        },
        isClosed: () => closed,
        close: () => ws.close(),
      });
    ws.onclose = () => failAll("CDP 连接已关闭（应用可能已退出）");
  });
}

async function evalFn(client, fn, ...args) {
  const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await client.send("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result ? r.result.value : null;
    } catch (e) {
      lastErr = e;
      await sleep(400);
    }
  }
  throw lastErr;
}

async function waitFor(client, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = null;
    try {
      v = await evalFn(client, fn);
    } catch {
      /* 页面可能正忙 */
    }
    if (v) return { ok: true, value: v, ms: Date.now() - t0 };
    await sleep(300);
  }
  return { ok: false, value: null, ms: Date.now() - t0 };
}

// --------------------------------------------------------------------------
// 页面侧探针
// --------------------------------------------------------------------------

/** 建库 / 解锁（新数据目录 ⇒ 走"设密码建库"那条路）。 */
const P_init = async (pin) => {
  const out = [];
  const rec = (k, v) => out.push([k, v]);
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  if (q("input.pin-input")) {
    const ins = qa("input.pin-input");
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      s.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    if (ins.length >= 2) {
      set(ins[0], pin);
      set(ins[1], pin);
      await nap(400);
      const b = qa("button").find((x) => /创建日记|解锁|进入/.test(x.textContent));
      if (b) b.click();
      rec("path", "建库（两个输入框）");
    } else {
      set(ins[0], pin);
      await nap(400);
      const b = qa("button").find((x) => /解锁|进入/.test(x.textContent));
      if (b) b.click();
      rec("path", "解锁（一个输入框）");
    }
  } else {
    rec("path", "无锁屏");
  }

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (q(".topbar")) {
      rec("boot", `顶栏出现（${Date.now() - t0}ms）`);
      return out;
    }
    await nap(400);
  }
  rec("boot", "顶栏始终没出现");
  return out;
};

/** 读探针钩子（帧计数 ＋ 停没停）。 */
const R_probe = async () => {
  const p = window.__treeProbe;
  if (!p) return null;
  return { frames: p.frames, stopped: p.stopped, stopFrame: p.stopFrame };
};

/** 画布尺寸（在不在、多大）。像素判定不在这里做 —— 见 R_rect 的注释。 */
const R_canvas = async () => {
  const c = document.querySelector(".tree-stage canvas");
  if (!c) return null;
  return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight };
};

/**
 * 画布在视口里的位置（CSS 像素）。
 * 交给 CDP `Page.captureScreenshot` 的 `clip` 用 —— 只截**画布那一块**。
 * ⚠️ 全页截图里有一堆界面本身的颜色，"不是纯色"这种断言在全页上恒真、什么也没验，
 *    所以必须裁到画布区域。
 */
const R_rect = async () => {
  const c = document.querySelector(".tree-stage canvas");
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** 切顶栏整屏（写日记 / 搜索 / 年轮 / 筛选）。 */
const A_topTab = async (name) => {
  const b = Array.from(document.querySelectorAll("nav.tabs button")).find((x) =>
    x.textContent.includes(name)
  );
  if (!b) return "找不到顶栏按钮: " + name;
  b.click();
  return "clicked";
};

/** 切页内小切换（刻度 / 旧影 / 树语）。 */
const A_subTab = async (name) => {
  const b = Array.from(document.querySelectorAll(".subtabs button")).find((x) =>
    x.textContent.includes(name)
  );
  if (!b) return "找不到页内按钮: " + name;
  b.click();
  return "clicked";
};

/** 页内三个小切换的文案（用来断言"空库也看得见"）。 */
const R_subtabs = async () => {
  const bs = Array.from(document.querySelectorAll(".subtabs button"));
  return bs.map((x) => x.textContent.trim());
};

/** 「刻度」那一屏的原话（用来确认"这真的是个空库"）。 */
const R_scaleText = async () => {
  const el = document.querySelector(".stats");
  return el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : null;
};

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

async function main() {
  console.log("=== 树语 · 第一期 · 批次 1 探针验证 ===");
  console.log("EXE =", EXE);

  if (!fs.existsSync(EXE)) {
    console.log("EXE_NOT_FOUND");
    process.exit(2);
  }

  // ⚠️ 只清"我们自己的"临时目录 —— ⛔ 绝不清脚本自己所在的目录。
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch {
    /* 第一次跑就没有 */
  }
  fs.mkdirSync(DATA, { recursive: true });

  rec("leftovers", killLeftovers());

  const child = spawn(EXE, [], {
    stdio: "ignore",
    windowsHide: false,
    env: {
      ...process.env,
      DSH_DIARY_DATA_DIR: DATA,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
  });
  rec("pid", child.pid);

  let client = null;
  let quit = 0;
  try {
    const target = await findTarget(PORT);
    rec("cdp", `page target: ${String(target.url).slice(0, 60)}`);
    client = await connect(target.webSocketDebuggerUrl);

    // 等"页面看得见东西"再动手（铁律 16）：锁屏或顶栏，二者出现其一。
    const ready = await waitFor(
      client,
      () => !!document.querySelector(".topbar") || document.querySelectorAll("input.pin-input").length > 0,
      25000
    );
    ok(ready.ok, "0. 页面起得来（锁屏或主界面）", `等待 ${ready.ms}ms`);

    rec("init", JSON.stringify(await evalFn(client, P_init, PIN)));

    // ⭐ 铁律 22：localStorage 不活在数据目录里 ⇒ 必须显式删键再 reload。
    await evalFn(client, () => {
      try {
        localStorage.clear();
      } catch {
        /* 没有就算了 */
      }
      return true;
    });
    await client.send("Page.reload");
    const back = await waitFor(client, () => !!document.querySelector(".topbar"), 25000);
    ok(back.ok, "1. 重载后回到主界面", `等待 ${back.ms}ms`);

    // ── A. 空库也要看得见「树语」 ────────────────────────────────────────
    rec("A_top", JSON.stringify(await evalFn(client, A_topTab, "年轮")));
    const hasSubtabs = await waitFor(client, () => document.querySelectorAll(".subtabs button").length > 0, 12000);
    ok(hasSubtabs.ok, "A1. 年轮页出现页内小切换", `等待 ${hasSubtabs.ms}ms`);

    const subTabs = await evalFn(client, R_subtabs);
    ok(
      Array.isArray(subTabs) && subTabs.join("/") === "刻度/旧影/树语",
      "A2. 三个切换齐全（刻度/旧影/树语）",
      JSON.stringify(subTabs)
    );

    // 先确认"这确实是个空库"—— 否则 A 组的"空库也能看"就没被验到。
    rec("A_sub", JSON.stringify(await evalFn(client, A_subTab, "刻度")));
    await sleep(500);
    const scaleText = await evalFn(client, R_scaleText);
    ok(
      typeof scaleText === "string" && scaleText.includes("还没有写过日记"),
      "A3. 前提成立：这真的是个空库（刻度页说'还没有写过日记'）",
      scaleText
    );

    // ── B. 画布真的出来了 ───────────────────────────────────────────────
    rec("B_sub", JSON.stringify(await evalFn(client, A_subTab, "树语")));
    const cv = await waitFor(client, () => !!document.querySelector(".tree-stage canvas"), 12000);
    ok(cv.ok, "B1. 画布挂出来了", `等待 ${cv.ms}ms`);

    await sleep(1200); // 让它画几帧再看
    const c1 = await evalFn(client, R_canvas);
    ok(!!c1 && c1.w > 0 && c1.h > 0, "B2. 画布尺寸 > 0", JSON.stringify(c1));

    // 全页截图存档（人看的）
    const shotData = await client.send("Page.captureScreenshot", { format: "png" });
    if (shotData && shotData.data) {
      fs.writeFileSync(SHOT, Buffer.from(shotData.data, "base64"));
      rec("shot", `${SHOT} (${fs.statSync(SHOT).size} B)`);
    }

    // ⭐ 只截画布那一块，然后在 Node 里解像素 —— 这才是"合成后真实画面"的证据
    const rect = await evalFn(client, R_rect);
    let cs = null;
    if (rect && rect.w > 8 && rect.h > 8) {
      const clipped = await client.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
      });
      if (clipped && clipped.data) {
        const png = Buffer.from(clipped.data, "base64");
        fs.writeFileSync(SHOT_CANVAS, png);
        try {
          cs = colorStats(decodePng(png));
        } catch (e) {
          cs = { decodeError: String((e && e.message) || e) };
        }
      }
    }
    ok(
      !!cs && typeof cs.colors === "number" && cs.colors >= 8,
      "B3. 画面不是一片纯色（解画布区域的真实像素）",
      JSON.stringify(cs)
    );
    // ── C. 画面真的在刷新 ───────────────────────────────────────────────
    const p1 = await evalFn(client, R_probe);
    ok(!!p1, "C1. 帧计数钩子在", JSON.stringify(p1));
    await sleep(1200);
    const p2 = await evalFn(client, R_probe);
    ok(
      !!p1 && !!p2 && p2.frames > p1.frames,
      "C2. 帧计数在涨（画面真在刷新）",
      `${p1 && p1.frames} → ${p2 && p2.frames}`
    );

    // ── D. ⭐ 切走真的停了 ─────────────────────────────────────────────
    // ⚠️ 反例对照要在**切走之前**采到：证明"就在切走前一瞬它还在涨"，
    //    这样 D2 的"冻住"才是真停，而不是"压根没跑/早就停了"。
    //    （上一版把基线采在切走之后，两边都是同一个数 415 → 报假红。）
    await sleep(1200);
    const beforeLeave = await evalFn(client, R_probe);
    rec("D_sub", JSON.stringify(await evalFn(client, A_subTab, "刻度")));
    await sleep(600); // 让组件卸载、onBeforeUnmount 跑完
    const d1 = await evalFn(client, R_probe);
    await sleep(1800); // 空等一段
    const d2 = await evalFn(client, R_probe);

    ok(!!d1 && d1.stopped === true, "D1. 切走后组件报了'已停'", JSON.stringify(d1));
    ok(
      !!d1 && !!d2 && d2.frames === d1.frames,
      "D2. ⭐ 切走后帧计数真的冻住了",
      `${d1 && d1.frames} → ${d2 && d2.frames}（切走前 ${beforeLeave && beforeLeave.frames}）`
    );
    ok(
      !!beforeLeave && !!p2 && beforeLeave.frames >= p2.frames + 4,
      "D3. 反例对照：切走前它确实在涨（所以 D2 的'没涨'是真停，不是压根没跑）",
      `${p2 && p2.frames} → ${beforeLeave && beforeLeave.frames}`
    );

    // ── E. 切回来又能跑 ────────────────────────────────────────────────
    rec("E_sub", JSON.stringify(await evalFn(client, A_subTab, "树语")));
    const cv2 = await waitFor(client, () => !!document.querySelector(".tree-stage canvas"), 12000);
    ok(cv2.ok, "E1. 切回来画布重新挂出来", `等待 ${cv2.ms}ms`);
    await sleep(900);
    const e1 = await evalFn(client, R_probe);
    await sleep(900);
    const e2 = await evalFn(client, R_probe);
    ok(!!e1 && !!e2 && e2.frames > e1.frames, "E2. 切回来后帧计数又涨", `${e1 && e1.frames} → ${e2 && e2.frames}`);
  } catch (e) {
    bad++;
    rec("EXCEPTION", String((e && e.message) || e));
    try {
      if (client && !client.isClosed()) {
        rec(
          "diag",
          JSON.stringify(
            await evalFn(client, () => ({
              topbar: !!document.querySelector(".topbar"),
              subtabs: Array.from(document.querySelectorAll(".subtabs button")).map((x) => x.textContent.trim()),
              canvas: !!document.querySelector(".tree-stage canvas"),
              probe: window.__treeProbe ? { ...window.__treeProbe } : null,
            }))
          )
        );
      }
    } catch {
      /* 诊断本身失败就算了 */
    }
    quit = 1;
  } finally {
    try {
      if (client) client.close();
    } catch {
      /* 已关 */
    }
    try {
      child.kill();
    } catch {
      /* 已退 */
    }
    await sleep(800);
    rec("cleanup", killLeftovers());
  }

  console.log("");
  console.log(`=== 结果：共 ${results.length} 条，失败 ${bad} 条 ===`);
  fs.writeFileSync(
    path.join(ROOT, "probe-result.json"),
    JSON.stringify({ total: results.length, failed: bad, results }, null, 2)
  );
  process.exit(quit || (bad > 0 ? 1 : 0));
}

// 被 require 时只导出工具（方便单独自测 PNG 解码），⛔ 不起应用。
if (require.main === module) {
  main();
} else {
  module.exports = { decodePng, colorStats };
}
