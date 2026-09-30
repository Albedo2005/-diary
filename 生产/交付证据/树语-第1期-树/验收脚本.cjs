/*
 * 树语 · 第一期 · **批次 2 —— 台子 ＋ 一棵树**
 *
 * ⭐ 本脚本是**从批次 1（`树语-第1期-探针/探针脚本.cjs`）整份拷过来再加一组**的
 *    （交付证据的通用规矩 2）。批次 1 验过的那几条**每跑一次都在被复跑**。
 *
 * 批次 2 新增要回答的问题：
 *   C. **「撑满」是不是真的撑满了** —— 页面不滚动、画布吃掉整个内容区宽高。
 *       （用户 2026-09-30 拍板：「撑满，而且全屏的时候也要等比例放大」。）
 *   F. **这棵树真的长出来了** —— 骨架规模 ＋ 显卡三角形数 ＋ ⭐ **像素交叉印证**。
 *   G. ⭐ **等比放大** —— 把视口改大，树在画面里的**相对位置不变**（＝跟着放大，
 *       而不是"变多"也不是"拉变形"）。
 *
 * 继承批次 1 的：
 *   A. 空库也要看得见「树语」（页内三个小切换在空库判断之外）。
 *   B. 画布存在、宽高 > 0、画面不是一片纯色。
 *   D. 画面真的在刷新（帧计数在涨）。
 *   E. ⭐ 切走真的停了；切回来又跑。
 *
 * ⚠️ 判据里那个「帧计数」只由**真的画了一帧**来加（`renderer.setAnimationLoop` 里），
 *    ⛔ 不是浏览器的动画帧 —— 那个即使 3D 停了也照样跳。
 *
 * ⚠️ 反例对照（铁律"没发生的断言要配一条能发生的"）—— 本脚本里有**三条**：
 *    ① E2 的"切走冻住" 配 E3 的"在跑时确实在涨"；
 *    ② F6 的"穿过树冠那一行的像素起伏大" 配 F7 的"树顶以上（纯天空）那一行起伏小"
 *       —— 两者量的是**同一张图的相邻几行**，一个该大一个该小（F8 判这对关系成立）；
 *    ③ G4 的"改大之后树顶相对位置不变" 配 G1 先证明"视口**确实**被改大了"
 *       —— 否则"没变"可能只是因为**根本没改成功**。
 *
 * ⚠️ **判据本身也要被验伪**（末尾 `selfTest`）：`rowStats` / `findTreeTop` 是
 *    本批新增的判断代码，它们要是写错了，上面 ② 那对断言会**一起错、还自洽**。
 *    所以用**人造图**（已知答案）先把这两个函数量一遍。
 *    ⚠️ 批次 1 的文件头也写了这句"末尾 selfTest"，**但脚本里根本没有那个函数**
 *       —— 属于空头支票。这一批补上真的。
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

/**
 * 量**某一行**的横向起伏。
 *
 * ⭐ 这是"画面上到底有没有东西"的干净判据，理由：
 *    · 天空是一张**竖直渐变** ⇒ 在纯天空的那一行上，颜色**横向几乎不变**；
 *    · 一行穿过树冠时，会横穿"天空 → 树枝 → 天空 → 树枝"⇒ 起伏很大。
 *    两者都量**同一张图**上的不同行 ⇒ 天然是一对反例对照。
 *
 * @param ratio 行位置（0 ＝ 最上面一行，1 ＝ 最下面一行）
 */
function rowStats(img, ratio) {
  const { width, height, channels, data } = img;
  const y = Math.max(0, Math.min(height - 1, Math.round((height - 1) * ratio)));
  const base = y * width * channels;
  let lo = 255;
  let hi = 0;
  let sum = 0;
  // 亮度（0.299R+0.587G+0.114B）—— 只关心明暗，不关心色相。
  for (let x = 0; x < width; x += 1) {
    const o = base + x * channels;
    const lum = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
    if (lum < lo) lo = lum;
    if (lum > hi) hi = lum;
    sum += lum;
  }
  return { y, lo: Math.round(lo), hi: Math.round(hi), span: Math.round(hi - lo), avg: Math.round(sum / width) };
}

/**
 * 从顶往下扫，找出**第一行"横向明显起伏"**的位置 —— 那就是树顶。
 *
 * 返回它在画面里的**相对高度**（0 ＝ 顶，1 ＝ 底）。
 * ⭐ G 组（等比放大）靠它：视口改大之后，这个相对位置**必须基本不变**。
 *    不变 ⇒ 树是跟着画面**等比放大**的；变小 ⇒ 树没长大（只是露出了更多天空）；
 *    变大 ⇒ 树被裁了或在被拉伸。
 *
 * ⚠️ 要连着几行都超阈值才算数（单行的噪点不至于把树顶提前好几行）。
 */
function findTreeTop(img, spanThreshold) {
  const { height } = img;
  const need = 3;
  let streak = 0;
  for (let i = 0; i < height; i += 1) {
    const r = rowStats(img, i / (height - 1));
    if (r.span >= spanThreshold) {
      streak += 1;
      if (streak >= need) return { ratio: (i - need + 1) / (height - 1), y: i - need + 1, span: r.span };
    } else {
      streak = 0;
    }
  }
  return { ratio: null, y: null, span: null };
}

/**
 * 量"这一行上的**树**在哪、占多宽"。
 *
 * ⭐ 判据用**偏离中位数**，⛔ 不是"比天空暗" —— 因为：
 *    · 浅色主题：树皮（~104）比白天（~222）**暗**；
 *    · 深色主题：树皮（~94）比夜空（~16~53）**亮**。
 *    写死一个方向的话，换个主题就整条判反（而且**不会报错、只会静默判错**）。
 *    天空占这一行的绝大部分 ⇒ 中位数就是"天空亮度"这个基准。
 *
 * 返回的 `cx` 是树像素的**重心**在行内的相对位置（0 ＝ 最左，0.5 ＝ 正中）。
 * 它要回答的是：「树是不是**在画面中间**」，而不只是「画面里有没有东西」——
 * 2026-09-30 那次画布撑破容器、树被裁到右下角，就是只有"有没有"这条看不出来。
 */
function rowCoverage(img, ratio, tol = 25) {
  const { width, height, channels, data } = img;
  const y = Math.max(0, Math.min(height - 1, Math.round((height - 1) * ratio)));
  const base = y * width * channels;
  const lums = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    const o = base + x * channels;
    lums[x] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
  }
  const sorted = Float64Array.from(lums).sort();
  const median = sorted[sorted.length >> 1];
  let hits = 0;
  let sumX = 0;
  let minX = width;
  let maxX = -1;
  for (let x = 0; x < width; x += 1) {
    if (Math.abs(lums[x] - median) > tol) {
      hits += 1;
      sumX += x;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return {
    y,
    median: Math.round(median),
    cover: hits / width,
    cx: hits > 0 ? sumX / hits / (width - 1) : null,
    spanX: hits > 0 ? (maxX - minX) / (width - 1) : null,
  };
}

/** 造一张人造图（答案已知）给下面的 `selfTest` 用。 */
function makeImage(w, h, painter) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b] = painter(x, y);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, channels: 4, data };
}

/**
 * ⭐ **判据自测：先证明"量尺子"本身是准的。**
 *
 * 为什么非要有这一段：F6/F7/F8 那对断言（树冠行走伏大、天空行走伏小）是**同一个
 * 函数**量出来的。如果 `rowStats` 或 `findTreeTop` 写错了，那对断言会**一起错、
 * 而且互相自洽** —— 全绿，却什么都没证明。
 * 所以这里拿**人造图**（每一处的正确答案都是我自己摆的）先量一遍。
 */
function selfTest() {
  const W = 100;
  const H = 100;
  const fail = (msg) => {
    throw new Error(`判据自测没过：${msg}`);
  };

  // ① 纯色图：任何一行都该是"零起伏"，而且**找不到**树顶。
  const flat = makeImage(W, H, () => [200, 200, 200]);
  if (rowStats(flat, 0.4).span !== 0) fail("纯色图却有起伏");
  // ⭐ 这条是负向对照：没有它，`findTreeTop` 哪怕"永远返回一个数"也看不出来。
  if (findTreeTop(flat, 30).ratio !== null) fail("纯色图里竟然找到了树顶");

  // ② 人造"树"：30%~90% 行、正中 40~60 列是一根深色的杆，其余是亮背景。
  const tree = makeImage(W, H, (x, y) =>
    y >= 30 && y < 90 && x >= 40 && x < 60 ? [40, 40, 40] : [220, 220, 220]
  );
  const skyRow = rowStats(tree, 0.06);
  const crownRow = rowStats(tree, 0.4);
  if (skyRow.span > 2) fail(`天空那一行本该几乎平，实测起伏 ${skyRow.span}`);
  if (crownRow.span < 150) fail(`树冠那一行本该有大起伏，实测只有 ${crownRow.span}`);
  if (crownRow.span < skyRow.span * 3) fail("树冠行的起伏没有明显大于天空行");

  // ③ 树顶定位：正确答案是第一处"连续 3 行都有起伏"的地方 ＝ 第 30 行。
  const top = findTreeTop(tree, 30);
  if (top.ratio === null) fail("人造图里没找到树顶");
  if (Math.abs(top.ratio - 0.3) > 0.05) {
    fail(`树顶该在第 30% 附近，实测 ${(top.ratio * 100).toFixed(1)}%`);
  }

  // ④ 重心：把杆**挪到画面正中间**，重心就该在 50% 附近；杆在左边就该偏左。
  //    ⭐ 这条同时验了"判据能分出方位"，而不只是"能不能发现有点西"。
  const centered = makeImage(W, H, (x, y) =>
    y >= 30 && y < 90 && x >= 40 && x < 60 ? [40, 40, 40] : [200, 200, 200]
  );
  const cCov = rowCoverage(centered, 0.4);
  if (Math.abs(cCov.cx - 0.5) > 0.06) {
    fail(`正中那根杆的重心该在 50% 附近，实测 ${(cCov.cx * 100).toFixed(1)}%`);
  }
  if (cCov.cover < 0.15 || cCov.cover > 0.25) {
    fail(`那根杆占 20/100＝20% 宽，实测 ${(cCov.cover * 100).toFixed(1)}%`);
  }
  const lefty = makeImage(W, H, (x, y) =>
    y >= 30 && y < 90 && x >= 5 && x < 25 ? [40, 40, 40] : [200, 200, 200]
  );
  const lCov = rowCoverage(lefty, 0.4);
  if (lCov.cx >= 0.4) fail(`靠左那根杆的重心该明显偏左，实测 ${(lCov.cx * 100).toFixed(1)}%`);
  // ⭐ 反例对照：纯色图上"属于东西的像素"必须是 0（否则门槛形同虚设）。
  if (rowCoverage(flat, 0.4).cover !== 0) fail("纯色图里竟然量出了'属于东西的像素'");

  return "5 组 12 条全过";
}

const REPO = "D:\\Users\\Lenovo\\Desktop\\Diary";
const EXE = process.env.DIARY_EXE || path.join(REPO, "target", "release", "app.exe");
const ROOT = path.join(REPO, "_probe-tree-2");
const DATA = path.join(ROOT, "data");
const SHOT = path.join(ROOT, "shot-tree.png");
const SHOT_CANVAS = path.join(ROOT, "shot-tree-canvas.png");
/** G 组用：把视口改大之后，再截一张（证明"等比放大"）。 */
const SHOT_BIG = path.join(ROOT, "shot-tree-big.png");
/** H 组用：钉成浅色主题再截一张（C5：深浅两套都要好看）。 */
const SHOT_LIGHT = path.join(ROOT, "shot-tree-light.png");
const PIN = "135790";
const PORT = 9335;

const results = [];
/*
 * ⚠️ `rec()` 有两个来源：**断言**（`ok()` 调它）和**纯信息**（pid / CDP 目标 /
 * 截图落盘路径 / 几何快照…）。它们都进同一个数组，所以
 * `results.length` **不等于断言条数**。
 * ⭐ 批次 1 的 README 把 `results.length` 直接当成了"26 条断言" —— 那个数
 *    其实掺了信息行，**偏大**。这里分开数，报告时两个都给，别再含混。
 */
let nAssert = 0;
function rec(k, v) {
  results.push([k, v]);
  console.log(`  [${k}] ${typeof v === "string" ? v : JSON.stringify(v)}`);
}
let bad = 0;
function ok(cond, k, v) {
  nAssert++;
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

/** 读舞台钩子（帧计数 ＋ 停没停 ＋ 这棵树的骨架规模）。 */
const R_stage = async () => {
  const p = window.__treeStage;
  if (!p) return null;
  return {
    frames: p.frames,
    stopped: p.stopped,
    stopFrame: p.stopFrame,
    branches: p.branches,
    tips: p.tips,
    height: p.height,
    crownWidth: p.crownWidth,
    triangles: p.triangles,
    viewW: p.viewW,
    viewH: p.viewH,
  };
};

/**
 * 「撑满」查什么：内容区还剩多少可用空间、画布占了其中多少、页面滚不滚。
 *
 * ⚠️ 用 `boundingClientRect` ＋ 计算出的 `padding` 去算"可用空间"，
 *    ⛔ 不是拿 `window.innerWidth` 去猜 —— 后者跟留白、顶栏全都对不上。
 */
const R_fill = async () => {
  const wrap = document.querySelector(".stats-wrap");
  const stage = document.querySelector(".tree-stage");
  const canvas = document.querySelector(".tree-stage canvas");
  if (!wrap || !stage || !canvas) return null;
  const cs = getComputedStyle(wrap);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const wr = wrap.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const cr = canvas.getBoundingClientRect();
  const R = (v) => Math.round(v * 10) / 10;
  return {
    wrapW: Math.round(wr.width),
    wrapH: Math.round(wr.height),
    availW: Math.round(wr.width - padX),
    availH: Math.round(wr.height - padY),
    stageW: R(sr.width),
    stageH: R(sr.height),
    canvasW: Math.round(cr.width),
    canvasH: Math.round(cr.height),
    /*
     * ⭐ **画布有没有撑破容纳它的那一格**（2026-09-30 栽过的那一跤）。
     * 当时画布拿"背衬尺寸"当自己的 CSS 尺寸（＝可用宽 × 屏密度），
     * 于是 1471px 的画布塞进 785px 的格子里、被 `overflow:hidden` 裁掉，
     * 树被挤到右下角只剩一角 —— 而所有别的断言**照样全绿**。
     * ⇒ 这一条就是要让那种情形**必红**。
     */
    canvasOverflowsStage: R(cr.width) > R(sr.width) + 1 || R(cr.height) > R(sr.height) + 1,
    // 画布是不是整块都在内容区里（往外冒一点点都算溢出）。
    canvasOutsideWrap:
      R(cr.right) > R(wr.right - parseFloat(cs.paddingRight)) + 1 ||
      R(cr.bottom) > R(wr.bottom - parseFloat(cs.paddingBottom)) + 1,
    // 页面有没有出现滚动条（撑满的那一栏不该有）。
    scrollable: wrap.scrollHeight - wrap.clientHeight > 1,
    overflowY: cs.overflowY,
  };
};

/** 视口尺寸（G 组验"等比放大"要对比改前改后）。 */
const R_viewport = async () => ({
  vw: window.innerWidth,
  vh: window.innerHeight,
  dpr: window.devicePixelRatio,
});

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
  console.log("=== 树语 · 第一期 · 批次 2 —— 台子 ＋ 一棵树 ===");
  console.log("EXE =", EXE);

  // ⭐ 先验"量尺子"本身（见 selfTest 的注释）—— 它没过，后面的像素断言全都不可信。
  try {
    rec("selfTest", selfTest());
  } catch (e) {
    ok(false, "0. 判据自测（`rowStats` / `findTreeTop` 用已知答案的人造图验）", String((e && e.message) || e));
    console.log("");
    console.log(
      `=== 结果：断言 ${nAssert} 条，失败 ${bad} 条 ｜ 另附信息 ${results.length - nAssert} 条（判据自己就是坏的，后面的断言没有意义，不再往下跑）===`
    );
    process.exit(3);
  }

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
  /** 画布那一块的解码结果 —— B3 与 F4/F5/F6 共用同一张图（一次截图多处用）。 */
  let canvasImg = null;
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
          canvasImg = decodePng(png);
          cs = colorStats(canvasImg);
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
    // ── C. ⭐ 「撑满」（用户 2026-09-30 拍板：撑满 ＋ 全屏等比例放大） ──────
    const fill = await evalFn(client, R_fill);
    rec("fill", JSON.stringify(fill));
    ok(!!fill, "C1. 量得到内容区与画布的几何关系", JSON.stringify(fill));
    ok(
      !!fill && fill.scrollable === false,
      "C2. ⭐ 页面不出现滚动条（撑满的第一层意思）",
      fill ? `可滚动=${fill.scrollable} overflow-y=${fill.overflowY}` : "量不到"
    );
    // ⚠️⚠️ 这两条是 2026-09-30 那一跤之后加的：原来写的是 `canvasW >= availW - 2`，
    //    于是"画布撑到 1471px、把容器撑破"**照样绿**。
    //    "吃满"是**等于**（±2px 容差），不是"大于等于"。
    ok(
      !!fill && Math.abs(fill.canvasW - fill.availW) <= 2,
      "C3. ⭐ 画布**正好吃满**内容区宽度（不是「至少」，是「等于」 —— 松开了 820 上限、也没撑破）",
      fill ? `画布 ${fill.canvasW} / 可用 ${fill.availW}（差 ${fill.canvasW - fill.availW}）` : "量不到"
    );
    ok(
      !!fill && fill.canvasH <= fill.availH + 1 && fill.canvasH >= fill.availH * 0.5,
      "C4. ⭐ 画布高度在可用高度之内、且吃掉大头（不再是那条约 62vh 的横条）",
      fill ? `画布高 ${fill.canvasH} / 可用高 ${fill.availH}（占 ${Math.round((fill.canvasH / fill.availH) * 100)}%）` : "量不到"
    );
    // ⭐ 专门盯"撑破容器"的那一条 —— 见 `R_fill` 里 `canvasOverflowsStage` 的注释。
    ok(
      !!fill && fill.canvasOverflowsStage === false,
      "C5. ⭐ 画布**没有撑破**容纳它的格子（撑破 ⇒ 树会被裁到角落，而别的断言看不出来）",
      fill ? `格子 ${fill.stageW}×${fill.stageH} / 画布 ${fill.canvasW}×${fill.canvasH}` : "量不到"
    );
    ok(
      !!fill && fill.canvasOutsideWrap === false,
      "C6. 画布整块都在内容区里（没有往外冒）",
      fill ? `溢出=${fill.canvasOutsideWrap}` : "量不到"
    );

    // ── D. 画面真的在刷新 ───────────────────────────────────────────────
    const p1 = await evalFn(client, R_stage);
    ok(!!p1, "D1. 帧计数钩子在", JSON.stringify(p1));
    await sleep(1200);
    const p2 = await evalFn(client, R_stage);
    ok(
      !!p1 && !!p2 && p2.frames > p1.frames,
      "D2. 帧计数在涨（画面真在刷新）",
      `${p1 && p1.frames} → ${p2 && p2.frames}`
    );

    // ── E. ⭐ 切走真的停了 ─────────────────────────────────────────────
    // ⚠️ 反例对照要在**切走之前**采到：证明"就在切走前一瞬它还在涨"，
    //    这样 E2 的"冻住"才是真停，而不是"压根没跑/早就停了"。
    //    （批次 1 第一版把基线采在切走之后，两边都是同一个数 415 → 报假红。）
    await sleep(1200);
    const beforeLeave = await evalFn(client, R_stage);
    rec("E_sub", JSON.stringify(await evalFn(client, A_subTab, "刻度")));
    await sleep(600); // 让组件卸载、onBeforeUnmount 跑完
    const d1 = await evalFn(client, R_stage);
    await sleep(1800); // 空等一段
    const d2 = await evalFn(client, R_stage);

    ok(!!d1 && d1.stopped === true, "E1. 切走后组件报了'已停'", JSON.stringify(d1));
    ok(
      !!d1 && !!d2 && d2.frames === d1.frames,
      "E2. ⭐ 切走后帧计数真的冻住了",
      `${d1 && d1.frames} → ${d2 && d2.frames}（切走前 ${beforeLeave && beforeLeave.frames}）`
    );
    ok(
      !!beforeLeave && !!p2 && beforeLeave.frames >= p2.frames + 4,
      "E3. 反例对照：切走前它确实在涨（所以 E2 的'没涨'是真停，不是压根没跑）",
      `${p2 && p2.frames} → ${beforeLeave && beforeLeave.frames}`
    );

    // ── F. ⭐ 这棵树真的长出来了（切回来再看） ─────────────────────────
    rec("F_sub", JSON.stringify(await evalFn(client, A_subTab, "树语")));
    const cv2 = await waitFor(client, () => !!document.querySelector(".tree-stage canvas"), 12000);
    ok(cv2.ok, "F1. 切回来画布重新挂出来", `等待 ${cv2.ms}ms`);
    await sleep(900);
    const f1 = await evalFn(client, R_stage);
    await sleep(900);
    const f2 = await evalFn(client, R_stage);
    ok(!!f1 && !!f2 && f2.frames > f1.frames, "F2. 切回来后帧计数又涨", `${f1 && f1.frames} → ${f2 && f2.frames}`);

    const sh = await evalFn(client, R_stage);
    ok(
      !!sh && sh.branches >= 50 && sh.tips >= 20,
      "F3. 骨架规模够了（不是一根光杆）",
      sh ? `枝条 ${sh.branches} 根 / 枝梢 ${sh.tips} 个` : "没钩子"
    );
    ok(
      !!sh && sh.crownWidth >= sh.height * 0.5,
      "F4. ⭐ 树冠真的横向铺开了（冠幅至少是树高的一半 ⇒ 不是一根杆）",
      sh ? `冠幅 ${sh.crownWidth.toFixed(2)} / 树高 ${sh.height.toFixed(2)}（比 ${(sh.crownWidth / sh.height).toFixed(2)}）` : "没钩子"
    );
    ok(
      !!sh && sh.triangles >= 3000,
      "F5. 显卡这一帧真的画了上千个三角形（不是空场景）",
      sh ? `${sh.triangles} 个三角形` : "没钩子"
    );

    // ⭐⭐ F6/F7 —— 像素层面的交叉印证，不用信骨架数字
    const skyRow = canvasImg ? rowStats(canvasImg, 0.06) : null;
    const crownRow = canvasImg ? rowStats(canvasImg, 0.4) : null;
    ok(
      !!crownRow && crownRow.span >= 30,
      "F6. ⭐ 穿过树冠那一行的明暗起伏很大（画面里真的有东西）",
      JSON.stringify(crownRow)
    );
    ok(
      !!skyRow && skyRow.span <= 16,
      "F7. ⭐ 反例对照：树顶以上那一行（纯天空）起伏很小",
      JSON.stringify(skyRow)
    );
    ok(
      !!skyRow && !!crownRow && crownRow.span >= Math.max(24, skyRow.span * 3),
      "F8. ⭐ 对照成立：树冠行的起伏 ≥ 天空行的 3 倍（所以 F6 不是噪声）",
      `天空 ${skyRow && skyRow.span} vs 树冠 ${crownRow && crownRow.span}`
    );

    /*
     * ⭐⭐ F9/F10 —— 「树**在不在画面中间**」。
     * 这一对是 2026-09-30 那一跤的直接产物：当时画布撑破容器、树被裁到右下角，
     * 而 F6/F7/F8 全绿（"这一行有起伏"只证明"画面里有东西"，不证明**它在哪**）。
     */
    const crownCov = canvasImg ? rowCoverage(canvasImg, 0.4) : null;
    const skyCov = canvasImg ? rowCoverage(canvasImg, 0.06) : null;
    ok(
      !!crownCov && crownCov.cover >= 0.02,
      "F9. 穿过树冠那一行里，属于树的像素占了 2% 以上（树真的在）",
      JSON.stringify(crownCov)
    );
    ok(
      !!crownCov && crownCov.cx !== null && crownCov.cx >= 0.37 && crownCov.cx <= 0.63,
      "F10. ⭐⭐ 树冠像素的**重心落在画面正中**（±13%）⇒ 树没被裁到角上",
      crownCov ? `重心 x ＝ ${(crownCov.cx * 100).toFixed(1)}%（50% 为正中）` : "量不到"
    );
    ok(
      !!skyCov && skyCov.cover <= 0.01,
      "F11. ⭐ 反例对照：树顶以上那一行「属于树的像素」几乎没有（所以 F9 的 2% 不是噪声门槛太低）",
      JSON.stringify(skyCov)
    );

    // ── G. ⭐ 等比放大（用户点名的"全屏的时候也要等比例放大"） ─────────
    const vp = await evalFn(client, R_viewport);
    const topBefore = canvasImg ? findTreeTop(canvasImg, 30) : null;
    rec("G_before", JSON.stringify({ vp, top: topBefore }));

    const bigW = Math.round(vp.vw * 1.5);
    const bigH = Math.round(vp.vh * 1.5);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: bigW,
      height: bigH,
      deviceScaleFactor: vp.dpr,
      mobile: false,
    });
    await sleep(1400); // 等 ResizeObserver + 重新取景
    const vp2 = await evalFn(client, R_viewport);
    // ⚠️ 反例对照：先证明"视口**确实**变了"，否则下面那句"没变"可能只是因为压根没改成。
    ok(
      !!vp2 && vp2.vw > vp.vw * 1.2,
      "G1. 反例对照的前半：视口**确实**被改大了（否则 G2 的'没变'没有意义）",
      `${vp && vp.vw}×${vp && vp.vh} → ${vp2 && vp2.vw}×${vp2 && vp2.vh}`
    );

    const rect2 = await evalFn(client, R_rect);
    const fill2 = await evalFn(client, R_fill);
    let bigImg = null;
    if (rect2 && rect2.w > 8 && rect2.h > 8) {
      const shot2 = await client.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: rect2.x, y: rect2.y, width: rect2.w, height: rect2.h, scale: 1 },
      });
      if (shot2 && shot2.data) {
        const png2 = Buffer.from(shot2.data, "base64");
        fs.writeFileSync(SHOT_BIG, png2);
        try {
          bigImg = decodePng(png2);
        } catch (e) {
          rec("G_decodeError", String((e && e.message) || e));
        }
      }
    }
    rec("G_after", JSON.stringify({ fill: fill2, size: bigImg ? [bigImg.width, bigImg.height] : null }));

    ok(
      !!fill2 && !!fill && fill2.canvasW > fill.canvasW && fill2.canvasH > fill.canvasH,
      "G2. 画布跟着视口一起变大了",
      fill && fill2 ? `${fill.canvasW}×${fill.canvasH} → ${fill2.canvasW}×${fill2.canvasH}` : "量不到"
    );

    const topAfter = bigImg ? findTreeTop(bigImg, 30) : null;
    ok(
      !!topBefore && topBefore.ratio !== null && !!topAfter && topAfter.ratio !== null,
      "G3. 两次都找得到树顶（判据本身没瞎）",
      `改前 ${topBefore && topBefore.ratio} / 改后 ${topAfter && topAfter.ratio}`
    );
    ok(
      !!topBefore &&
        !!topAfter &&
        topBefore.ratio !== null &&
        topAfter.ratio !== null &&
        Math.abs(topAfter.ratio - topBefore.ratio) <= 0.045,
      "G4. ⭐ 树顶在画面里的**相对位置基本没变** ⇒ 树是跟着画面**等比放大**的",
      topBefore && topAfter
        ? `改前 ${(topBefore.ratio * 100).toFixed(1)}% → 改后 ${(topAfter.ratio * 100).toFixed(1)}%（差 ${(Math.abs(topAfter.ratio - topBefore.ratio) * 100).toFixed(1)} 个百分点）`
        : "量不到"
    );

    await client.send("Emulation.clearDeviceMetricsOverride");

    // ── H. ⭐ 浅色主题那一套（C5 拍板："深浅两套都要好看"） ─────────────
    // ⚠️ 上面 A~G 全是**深色**下量的（CDP 默认就是深色，见铁律 4）——
    //    而树语的颜色全部走 `--tree-*` 变量、`applyTheme()` 会重画贴图与光色。
    //    这一组就是把主题**显式钉成浅色**再量一遍，证明那套变量真的成立。
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await sleep(1600); // 等 applyTheme() 把天空/地面/树皮/光色整套重做
    const rectL = await evalFn(client, R_rect);
    let lightImg = null;
    if (rectL && rectL.w > 8 && rectL.h > 8) {
      const shotL = await client.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: rectL.x, y: rectL.y, width: rectL.w, height: rectL.h, scale: 1 },
      });
      if (shotL && shotL.data) {
        const pngL = Buffer.from(shotL.data, "base64");
        fs.writeFileSync(SHOT_LIGHT, pngL);
        try {
          lightImg = decodePng(pngL);
        } catch (e) {
          rec("H_decodeError", String((e && e.message) || e));
        }
      }
    }
    const darkSky = canvasImg ? rowStats(canvasImg, 0.06) : null;
    const lightSky = lightImg ? rowStats(lightImg, 0.06) : null;
    ok(
      !!lightImg && lightImg.width === (canvasImg && canvasImg.width),
      "H1. 浅色下也截到了画布那一块（尺寸和深色那张一致 ⇒ 确实换的是主题、不是换了取景）",
      lightImg && canvasImg ? `深色 ${canvasImg.width}×${canvasImg.height} / 浅色 ${lightImg.width}×${lightImg.height}` : "量不到"
    );
    ok(
      !!darkSky && !!lightSky && lightSky.avg > darkSky.avg + 60,
      "H2. 反例对照的前半：切浅色后**天空真的变亮了**（否则 H3/H4 是在量同一张图）",
      `深色天空亮度 ${darkSky && darkSky.avg} → 浅色 ${lightSky && lightSky.avg}`
    );
    const lightCrown = lightImg ? rowCoverage(lightImg, 0.4) : null;
    // ⭐ 这一条同时验了"判据的方向没写反"：`rowCoverage` 用的是**偏离中位数**，
    //    而不是"比天空暗"。浅色下树皮比天空暗、深色下比天空亮 —— 两套都得认出来。
    ok(
      !!lightCrown && lightCrown.cover >= 0.02,
      "H3. 浅色主题下树冠行同样认得出树的像素（判据方向没写反）",
      JSON.stringify(lightCrown)
    );
    ok(
      !!lightCrown && lightCrown.cx !== null && lightCrown.cx >= 0.37 && lightCrown.cx <= 0.63,
      "H4. ⭐ 浅色主题下树**同样落在画面正中**",
      lightCrown ? `重心 x ＝ ${(lightCrown.cx * 100).toFixed(1)}%（50% 为正中）` : "量不到"
    );
    await client.send("Emulation.setEmulatedMedia", { features: [] });
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
              stage: window.__treeStage ? { ...window.__treeStage } : null,
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
  console.log(
    `=== 结果：断言 ${nAssert} 条，失败 ${bad} 条 ｜ 另附信息 ${results.length - nAssert} 条 ===`
  );
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
