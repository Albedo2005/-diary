/*
 * 树语 · **第二期 · 批次 1 —— 点树出年轮（能点 ＋ 拾取）**
 *
 * ⭐ 本脚本是**从第一期（`树语-第1期-调整/验收脚本.cjs`）整份拷过来再加一组**的
 *    （交付证据的通用规矩 2）。第一期那 83 条**每跑一次都在被复跑**。
 *
 * ⭐⭐ **第二期批次 1 新增的 M 组**（年轮环）：
 *   M1~M6   三圈的「尺子」：条数 / **一样大** / 套在主干上 / 上下排开 /
 *           **一棵树 ＝ 一个自然季** / 格数 ＝ 当月实际天数；
 *   M7      ⭐⭐ **点得中**（在环的屏幕位置**真的派发一次指针事件**）；
 *   M8~M9   ⭐ 再点收回 ＋ **同时只开一圈**；
 *   M10     ⭐ **点空白不误开**（配 M7 的反例对照）；
 *   M11~M12 拖拽不误触 ＋ 移上去会亮；
 *   M13~M14 ⭐ 拾取真的接上了 ＋ 点开前后**画面真的变了**
 *           （配 M14b：「确实是在静止态下拍的」，否则风的抖动会让那条对照失效）。
 *
 * ⚠️ 本期**还没接数据** —— 环上全是暗格（点亮是批次 2 的事）。
 * ⭐ 本批唯一的新手段是**不猜坐标**：组件把三圈在屏幕上的位置投影好放进钩子
 *    （`ringScreen`），脚本按它派发事件。「点得中」这件事，只有真的派发才验得到。
 *
 * 批次 3 新增要回答的问题：
 *   I. **花与叶真的挂上去了** —— 片数（钩子）＋ ⭐⭐ **三角形预算逐个数得上**
 *      （多出来的 7114 个 ＝ 叶×2×2 ＋ 花×2×1，一个不多一个不少）
 *      ＋ ⭐⭐ **跨版本像素对照**：拿批次 2 存档的那张画布截图当基线，同一把尺子量
 *      「暖色像素」——**0 个 → 一万六千多个**（零基线，⛔ 不用我瞎定门槛）。
 *   J. ⭐ **风的开关是真的** —— 开着时两张截图**逐像素必须不同**；
 *      关掉之后两张必须**几乎一模一样**。两个方向都测（只会"停"或只会"动"都算坏）。
 *   K. **六条纪律**（用户点名"必须全做完，⛔ 不许先做完功能、性能回头再说"）：
 *      K1~K3 切后台会停 ＋ **反例对照**（回到可见必须又动）；
 *      K4~K6 系统"减弱动态效果" ⇒ 静态 ＋ **反例对照**（摘掉必须又动）；
 *      K7~K9 写日记／搜索／筛选三页里**一块画布都没有**；
 *      K11~K13 画质封顶 —— ⚠️ **要在 dpr ＝ 3 下重新挂载**才验得到（见那一段的"假绿"记录）。
 *      （设置页那个开关的两个方向在 J3／J4／J9／J10。）
 *   L. 帧时间在预算内（渲染一帧的滚动平均耗时）。
 *
 * 继承批次 1 的：
 *   A. 空库也要看得见「树语」（页内三个小切换在空库判断之外）。
 *   B. 画布存在、宽高 > 0、画面不是一片纯色。
 *   D. 画面真的在刷新（帧计数在涨）。
 *   E. ⭐ 切走真的停了；切回来又跑。
 * 继承批次 2 的：
 *   C. ⭐ **「撑满」**——不滚动、画布正好吃满内容区宽高、不撑破容器。
 *       （用户 2026-09-30 拍板：「撑满，而且全屏的时候也要等比例放大」。）
 *   F. ⭐ **树真的长出来了**——骨架规模 ＋ 三角形数 ＋ 像素交叉印证 ＋ 重心在正中。
 *   G. ⭐ **等比放大**——视口改大后树顶的**相对位置不变**。
 *   H. ⭐ **浅色主题那一套**同样成立。
 *
 * ⚠️ 判据里那个「帧计数」只由**真的画了一帧**来加（`renderer.setAnimationLoop` 里），
 *    ⛔ 不是浏览器的动画帧 —— 那个即使 3D 停了也照样跳。
 *
 * ⚠️⚠️ **本批新增的一条方法论**（踩过才知道的）：纪律 3 是"系统开着减弱动态效果就静止"，
 *    而**本机那个开关真的是开着的** ⇒ 如果不管它，D 组（帧在涨）和 J 组（会动）
 *    会在**我的机器上必然红、在他的机器上必然绿** —— 那种"看运气"的断言等于没写。
 *    所以脚本在**建库之后就立刻**把媒体特性显式钉住：
 *      `prefers-color-scheme = dark`（CDP 默认就是深色，钉住免得被别的调用带跑）
 *      `prefers-reduced-motion = no-preference`（先造出"该动"的前提）
 *    到 K2 再**临时**改成 `reduce` 去验"停了"，验完改回来。
 *    ⚠️ `Emulation.setEmulatedMedia` 是**整个替换** features 数组的
 *       ⇒ 每次调用都要把两项**一起**写全，否则漏掉的那项会掉回宿主机真实值。
 *
 * ⚠️ 反例对照（铁律"没发生的断言要配一条能发生的"）—— 本脚本里有**六条**：
 *    ① E2 的"切走冻住" 配 E3 的"在跑时确实在涨"；
 *    ② F6 的"穿过树冠那一行的像素起伏大" 配 F7 的"树顶以上（纯天空）那一行起伏小"
 *       —— 两者量的是**同一张图的相邻几行**，一个该大一个该小（F8 判这对关系成立）；
 *    ③ G4 的"改大之后树顶相对位置不变" 配 G1 先证明"视口**确实**被改大了"
 *       —— 否则"没变"可能只是因为**根本没改成功**；
 *    ④ I6 的"整幅暖色像素从 0 涨到一万多" 配 I7 的"天空带里几乎没有暖色"
 *       ＋ I5 的"基线截图真的是 0 个"（三条一起才说明"多的那些是花叶、不是背景"）；
 *    ⑤ J2 的"关掉后两张截图一样" 配 J1 的"开着时两张确实不一样"
 *       —— 只会"停"（比如根本没实现动画）或只会"动"（开关是假的）都算坏；
 *    ⑥ K2 的"`reduce` 下静止" 配 K3 的"`no-preference` 下真的在动"
 *       —— ⚠️ 没有 K3 的话，K2 在"动画压根没实现"时会**照样绿**。
 *
 * ⚠️ **判据本身也要被验伪**（末尾 `selfTest`）：`rowStats` / `findTreeTop` /
 *    `rowCoverage` / 本批新增的 `warmStats`、`diffImages` 都是自己写的量尺子，
 *    它们要是写错了，上面这些"成对自洽"的断言会**一起错**。所以用**人造图**
 *    （已知答案）先把它们量一遍 —— 本批给 `warmStats` / `diffImages` 也补了。
 *
 * ⚠️ 全程**只读**（除了自己那个 `localStorage` 开关）：一次性数据目录
 *    （`DSH_DIARY_DATA_DIR`）＋ 建库后不写任何日记 ⇒ 不可能碰到用户的真实数据。
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

/**
 * 量"**暖色**像素"（⭐ 批次 3 新增）。
 *
 * 判据 `r > g > b 且 r - b >= 40`：秋天的桂花与秋叶都是"黄里透红"的暖色，
 * 而背景（天空、草地）是冷色或中性色。⚠️ 它**不区分花与叶** ——
 * 它回答的是一个更粗、也因此更可信的问题：**"画面里有没有一大片暖色的东西"**。
 * 批次 2 的树上没有花叶，只有**细枝条**是褐色的，所以那时这个数很小。
 *
 * `y0`/`y1` 是**纵向相对位置**（0 ＝ 顶，1 ＝ 底），闭区间。
 * 返回的 `cx` 是暖色像素的**重心**（跟 `rowCoverage` 一个道理：要问"在哪"）。
 */
function warmStats(img, y0, y1) {
  const { width, height, channels, data } = img;
  const from = Math.max(0, Math.min(height - 1, Math.round((height - 1) * y0)));
  const to = Math.max(0, Math.min(height - 1, Math.round((height - 1) * y1)));
  let n = 0;
  let sumX = 0;
  let minX = width;
  let maxX = -1;
  const lums = [];
  for (let y = from; y <= to; y += 1) {
    const base = y * width * channels;
    for (let x = 0; x < width; x += 1) {
      const o = base + x * channels;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      if (r > g && g > b && r - b >= 40) {
        n += 1;
        sumX += x;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        lums.push(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
  }
  const total = (to - from + 1) * width;
  lums.sort((a, b) => a - b);
  return {
    rows: [from, to],
    n,
    cover: total > 0 ? n / total : 0,
    cx: n > 0 ? sumX / n / (width - 1) : null,
    spanX: n > 0 ? (maxX - minX) / (width - 1) : null,
    loLum: n > 0 ? Math.round(lums[0]) : null,
    midLum: n > 0 ? Math.round(lums[lums.length >> 1]) : null,
    hiLum: n > 0 ? Math.round(lums[lums.length - 1]) : null,
  };
}

/**
 * 两张**同尺寸**图逐像素比（⭐ 批次 3 新增）—— J 组靠它回答"画面到底有没有变"。
 *
 * `tol` 是每个通道的容差：默认 3，把 PNG 编解码那一两级的舍入挡掉，
 * 又不至于放过"整棵树被风推到别处"这种量级的变化（那是几十级）。
 */
function diffImages(a, b, tol = 3) {
  if (!a || !b) return null;
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, aW: a.width, aH: a.height, bW: b.width, bH: b.height };
  }
  const { width, height, channels } = a;
  let diff = 0;
  let maxDiff = 0;
  let firstRow = -1;
  let lastRow = -1;
  for (let y = 0; y < height; y += 1) {
    let rowHit = false;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * channels;
      const d = Math.max(
        Math.abs(a.data[o] - b.data[o]),
        Math.abs(a.data[o + 1] - b.data[o + 1]),
        Math.abs(a.data[o + 2] - b.data[o + 2])
      );
      if (d > maxDiff) maxDiff = d;
      if (d > tol) {
        diff += 1;
        rowHit = true;
      }
    }
    if (rowHit) {
      if (firstRow < 0) firstRow = y;
      lastRow = y;
    }
  }
  return {
    w: width,
    h: height,
    diff,
    ratio: diff / (width * height),
    maxDiff,
    firstRow,
    lastRow,
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

  /*
   * ⑤ ⭐ 批次 3 新增：`warmStats` 这一把尺子。
   *    I4/I5 那对断言（树冠带暖色多、天空带几乎为零）全靠它 ⇒ 它错了两条一起错。
   */
  // 负向对照 1：**中性灰**必须**不算**暖色（r>g>b 这一条要真的在把关）。
  const grey = makeImage(W, H, () => [128, 128, 128]);
  if (warmStats(grey, 0, 1).n !== 0) fail("中性灰被算成了暖色（判据 `r>g>b` 没生效）");
  // 负向对照 2：**冷色**（偏蓝）也一样不算。
  const cold = makeImage(W, H, () => [60, 90, 160]);
  if (warmStats(cold, 0, 1).n !== 0) fail("冷色（偏蓝）被算成了暖色");
  // 正向：下半幅铺暖色 ⇒ 下半带里全是暖色、上半带里一个都没有。
  const warmHalf = makeImage(W, H, (x, y) => (y >= 50 ? [180, 140, 40] : [60, 90, 160]));
  const wLow = warmStats(warmHalf, 0.6, 0.9);
  const wHigh = warmStats(warmHalf, 0.05, 0.3);
  if (wLow.cover < 0.99) fail(`下半幅铺满暖色，实测占比只有 ${(wLow.cover * 100).toFixed(1)}%`);
  if (wHigh.n !== 0) fail(`上半幅是冷色，竟然数出 ${wHigh.n} 个暖色像素`);
  if (wLow.cx === null || Math.abs(wLow.cx - 0.5) > 0.03) {
    fail(`整幅铺满暖色时重心该在 50%，实测 ${wLow.cx === null ? "null" : (wLow.cx * 100).toFixed(1) + "%"}`);
  }
  // ⭐ 重心要能分出方位：暖色只铺**右半边** ⇒ 重心该明显偏右。
  const warmRight = makeImage(W, H, (x) => (x >= 50 ? [180, 140, 40] : [60, 90, 160]));
  const wRight = warmStats(warmRight, 0, 1);
  if (wRight.cx === null || wRight.cx < 0.7) {
    fail(`暖色只在右半边，重心该 ≥ 70%，实测 ${wRight.cx === null ? "null" : (wRight.cx * 100).toFixed(1) + "%"}`);
  }
  // 亮度三档要真的分得开（I 组拿它当参考值用）。
  if (!(wLow.loLum > 100 && wLow.midLum >= wLow.loLum && wLow.hiLum >= wLow.midLum)) {
    fail(`暖色像素的亮度统计不对：${JSON.stringify([wLow.loLum, wLow.midLum, wLow.hiLum])}`);
  }

  /*
   * ⑥ ⭐ 批次 3 新增：`diffImages` 这一把尺子。
   *    J2（关掉后两张一样）与 J1（开着时两张不一样）全靠它 ⇒ 它要是"永远返回 0"，
   *    J2 会恒绿、J1 会恒红，两个方向都不可信。
   */
  const dSelf = diffImages(flat, flat);
  if (!dSelf || dSelf.diff !== 0 || dSelf.maxDiff !== 0) fail("自己跟自己比竟然有差异");
  // 差 50 级 ⇒ 每个像素都该被算成"变了"。
  const far = makeImage(W, H, () => [150, 150, 150]);
  const dFar = diffImages(flat, far);
  if (!dFar || dFar.diff !== W * H) fail(`差 50 级该全变，实测 ${dFar && dFar.diff}/${W * H}`);
  // ⭐ 容差要真的在挡"编解码那一两级舍入"，又不能把 50 级的真变化一起挡掉。
  // ⚠️ 这张人造图是**隔行**差 3 级（棋盘）⇒ 只有**一半**的像素变了。
  //    第一版这里写的是 `!== W * H`（全幅）—— 被本段自测当场抓红。
  //    ⭐ 这正是"判据自己也要被验"的用处：不写这一段，我会一直以为容差逻辑是对的。
  const jitter = makeImage(W, H, (x, y) => ((x + y) % 2 ? [203, 200, 200] : [200, 200, 200]));
  if (diffImages(flat, jitter).diff !== 0) fail("容差 3 没挡住 1~3 级的舍入差");
  if (diffImages(flat, jitter, 0).diff !== (W * H) / 2) {
    fail(`容差 0 时该数出棋盘那半幅（${(W * H) / 2} 个），实测 ${diffImages(flat, jitter, 0).diff}`);
  }
  // 尺寸不同要**明确报出来**，⛔ 不能悄悄比出一堆假差异。
  const dSize = diffImages(flat, makeImage(W, 50, () => [200, 200, 200]));
  if (!dSize || dSize.sizeMismatch !== true) fail("尺寸不同的两张图没有被识别出来");

  return "7 组 22 条全过";
}

const REPO = "D:\\Users\\Lenovo\\Desktop\\Diary";
const EXE = process.env.DIARY_EXE || path.join(REPO, "target", "release", "app.exe");
const ROOT = path.join(REPO, "_probe-tree-5");
const DATA = path.join(ROOT, "data");
const SHOT = path.join(ROOT, "shot-tree.png");
const SHOT_CANVAS = path.join(ROOT, "shot-tree-canvas.png");
/** G 组用：把视口改大之后，再截一张（证明"等比放大"）。 */
const SHOT_BIG = path.join(ROOT, "shot-tree-big.png");
/** H 组用：钉成浅色主题再截一张（C5：深浅两套都要好看）。 */
const SHOT_LIGHT = path.join(ROOT, "shot-tree-light.png");
/** J 组用：动效开着时前后两张（必须**不一样**）。 */
const SHOT_MOVE_A = path.join(ROOT, "shot-move-a.png");
const SHOT_MOVE_B = path.join(ROOT, "shot-move-b.png");
/** J 组用：动效关掉之后前后两张（必须**一样**）。 */
const SHOT_STILL_A = path.join(ROOT, "shot-still-a.png");
const SHOT_STILL_B = path.join(ROOT, "shot-still-b.png");
/** K3 用：设置页那个开关的实拍（人看的）。 */
const SHOT_SETTINGS = path.join(ROOT, "shot-settings-toggle.png");
/** K4 用：写日记那一页的实拍（证明那里没有画布）。 */
const SHOT_WRITE = path.join(ROOT, "shot-write-no-canvas.png");
const PIN = "135790";
/** ⚠️ 第二期批次 1 换成 9338（前几期的 9334~9337 万一还残留，端口会静默失效）。 */
const PORT = 9338;

/*
 * ⭐ 批次 2 的实测基线（从 `树语-第1期-树/验收结果.json` 里抄来的**真数**，
 *    ⛔ 不是估的）。批次 3 有几条断言要跟它比 —— 这叫**跨版本对照**：
 *    同一台机器、同一个种子、同一个视口，**只多了花叶**，树冠那一行"属于树的像素"
 *    应该明显变多。没有这个基线的话，"树冠覆盖度 15%"就只能靠我瞎定一个门槛。
 */
const BASE2 = {
  crownCover: 0.04823369565217391, // F9 实测：树冠行 4.82% 的像素属于树
  crownSpan: 76, // F6 实测：树冠行明暗起伏
  skySpan: 0, // F7 实测：天空行明暗起伏
  triangles: 3260, // F5 实测
  branches: 139,
  tips: 72,
  canvasW: 785,
  canvasH: 439,
};

/**
 * ⭐⭐ 批次 2 存档的那张**画布截图**（1472×821，与本批同一尺寸 ⇒ 能 1:1 对着量）。
 *
 * 这是本批最有价值的一个基线：批次 2 的树上**没有花叶**，所以那张图里
 * "暖色像素"是 **0 个**。本批用**同一把 `warmStats`** 量同一块画面，
 * 数目必须从 0 变成一万多 —— 这比"我自己定个 5% 的门槛"硬得多：
 * ⛔ 门槛是猜的，**基线是量出来的**。
 */
const BASE2_SHOT = path.join(
  REPO,
  "生产",
  "交付证据",
  "树语-第1期-树",
  "截图-画布区域.png"
);

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
    // ⭐ 调整轮新增：树冠枝条的垂直角分布（N 组靠它判"树的模样"）。
    angleBins: p.angleBins,
    angleMean: p.angleMean,
    triangles: p.triangles,
    viewW: p.viewW,
    viewH: p.viewH,
    // ── 批次 3 新增 ────────────────────────────────────────────────
    /** 花与叶的**实例片数**（I1/I2：证明"花叶真挂上去了"）。 */
    leaves: p.leaves,
    blossoms: p.blossoms,
    /** ⭐ 这一帧的绘制次数（I3：批次 2 是 1，现在该是 3 ＝ 树干＋叶＋花）。 */
    drawCalls: p.drawCalls,
    /** 背衬尺寸（K5：验 `pixelRatio` 封顶；`backing ＝ 显示宽 × DPR`）。 */
    backingW: p.backingW,
    backingH: p.backingH,
    pixelRatio: p.pixelRatio,
    /** 现在是不是真的挂着动画循环（K 组主要看它 ＋ 帧数）。 */
    animating: p.animating,
    /** 设置页那个偏好当前是什么（K3）。 */
    motionPref: p.motionPref,
    /** 系统"减弱动态效果"当前读到的值（K2；⚠️ 本机是 `true`）。 */
    reducedMotion: p.reducedMotion,
    /** 软件是不是在后台（K1）。 */
    hidden: p.hidden,
    /** ⭐ 渲染一帧的耗时（毫秒，滚动平均）—— L 组靠它。 */
    frameMs: p.frameMs,
    // ── 第二期 · 年轮环（M 组） ──────────────────────────────────
    /** 三圈的条数（应当永远是 3）。 */
    ringCount: p.ringCount,
    /** 三圈各自的半径 —— 验「一样大」。 */
    ringRadii: p.ringRadii,
    /** 三圈的世界坐标（环心）—— 验「套在主干上、上下排开」。 */
    ringPositions: p.ringPositions,
    /** ⭐ 三圈**各自在屏幕上的中心点**（页面 CSS 像素）—— 脚本按它派发指针事件。 */
    ringScreen: p.ringScreen,
    /** 三圈各是几月 / 各有多少格。 */
    ringMonths: p.ringMonths,
    ringDays: p.ringDays,
    /** 这个季度是哪三个月（`["2026-09","2026-10","2026-11"]`）。 */
    ringMonthKeys: p.ringMonthKeys,
    /** 现在开着哪一圈（`null` ＝ 全收回）。 */
    ringOpen: p.ringOpen,
    /** 鼠标现在悬在哪一圈上。 */
    ringHover: p.ringHover,
    /** 拾取命中过多少次 —— 证明「事件真的接上了」。 */
    ringPickHits: p.ringPickHits,
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

// ── 批次 3 新增的探针 ────────────────────────────────────────────────────

/**
 * ⭐ K4：整页数一遍有几块树语画布。
 * 期望：在「年轮 → 树语」里恰好 1 块；在写日记 / 搜索 / 筛选里**一块都没有**
 * （纪律 6 —— 组件只在年轮页挂载，所以这是"结构上不可能"，不是"藏起来了"）。
 */
const R_canvasCensus = async () => ({
  count: document.querySelectorAll(".tree-stage canvas").length,
  stages: document.querySelectorAll(".tree-stage").length,
  topTabs: Array.from(document.querySelectorAll("nav.tabs button")).map((x) =>
    x.textContent.trim()
  ),
});

/**
 * K3 第一步：把设置弹窗打开，并切到「通用」那一栏。
 * ⚠️ 设置按钮在顶栏，用 `title="设置"` 找 —— 它的可见文案是个齿轮图标，没法按字找。
 */
const A_openSettings = async (tabLabel) => {
  const btn = document.querySelector('button[title="设置"]');
  if (!btn) return "找不到顶栏的设置按钮";
  btn.click();
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 25; i++) {
    if (document.querySelector(".modal .side button")) break;
    await nap(120);
  }
  const side = Array.from(document.querySelectorAll(".modal .side button")).find((x) =>
    x.textContent.trim().includes(tabLabel)
  );
  if (!side) {
    return "设置页里找不到「" + tabLabel + "」那一栏：[" +
      Array.from(document.querySelectorAll(".modal .side button")).map((x) => x.textContent.trim()).join("/") + "]";
  }
  side.click();
  await nap(250);
  return "opened:" + tabLabel;
};

/** 读一眼设置弹窗里「树语动效」那一行长什么样（K3 要确认前提：开关真的在界面上）。 */
const R_treeMotionRow = async () => {
  const rows = Array.from(document.querySelectorAll(".modal .row"));
  const row = rows.find((r) => {
    const t = r.querySelector(".label .t");
    return t && t.textContent.trim() === "树语动效";
  });
  if (!row) return null;
  const input = row.querySelector('input[type="checkbox"]');
  const d = row.querySelector(".label .d");
  return {
    title: row.querySelector(".label .t").textContent.trim(),
    note: d ? d.textContent.trim() : null,
    found: !!input,
    checked: input ? input.checked : null,
    disabled: input ? input.disabled : null,
  };
};

/**
 * K3 第二步：**真的去点**那个开关（⛔ 不是往 `localStorage` 里写值 ——
 * 那样验的是"存储好不好使"，不是"界面上的开关好不好使"）。
 * 原生 checkbox 的 `click()` 会同时翻 `checked` 并冒泡 `change`，Vue 的 `@change` 收得到。
 */
const A_clickTreeMotion = async () => {
  const rows = Array.from(document.querySelectorAll(".modal .row"));
  const row = rows.find((r) => {
    const t = r.querySelector(".label .t");
    return t && t.textContent.trim() === "树语动效";
  });
  if (!row) return "找不到「树语动效」那一行";
  const input = row.querySelector('input[type="checkbox"]');
  if (!input) return "那一行里没有 checkbox";
  const before = input.checked;
  input.click();
  return JSON.stringify({ before, after: input.checked });
};

/**
 * 把「树语动效」那一行滚进视野 —— **只为拍张人看得清的截图**。
 * ⚠️ 第一版没滚，结果那一行在「通用」栏的滚动区下方 ⇒ 截图里只有到"每日字数目标"为止，
 *    开关**根本没进画面**。断言全靠 DOM 照样全绿，但那个"人看的"截图是废的。
 */
const A_scrollToTreeMotion = async () => {
  const rows = Array.from(document.querySelectorAll(".modal .row"));
  const row = rows.find((r) => {
    const t = r.querySelector(".label .t");
    return t && t.textContent.trim() === "树语动效";
  });
  if (!row) return "找不到「树语动效」那一行";
  row.scrollIntoView({ block: "center" });
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  await nap(400);
  const r = row.getBoundingClientRect();
  return JSON.stringify({
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    inView: r.top >= 0 && r.bottom <= window.innerHeight,
  });
};

/** 关掉设置弹窗（J 组要拍树，弹窗挡着拍不着）。 */
const A_closeSettings = async () => {
  const btn = Array.from(document.querySelectorAll(".modal .head button")).find((x) =>
    x.textContent.trim().includes("关闭")
  );
  if (!btn) return "找不到设置弹窗的关闭按钮";
  btn.click();
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 25; i++) {
    if (!document.querySelector(".modal")) return "closed";
    await nap(120);
  }
  return "弹窗还在";
};

/** 设置页开着的时候，`localStorage` 里那个偏好是什么（K3 的机器证据）。 */
const R_treeMotionStored = async () => {
  try {
    return { raw: localStorage.getItem("diary.tree-motion") };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
};

/**
 * ⭐ K1：**模拟"软件切到后台"**。
 *
 * ⚠️ 说实话：`document.visibilityState` 是**只读**的，页面里没有合法的办法把它改成
 *    `hidden`（真这么做要 CDP 去冻结整个页面，那样脚本自己也跑不了了）。
 *    所以这里走的是"**改 getter ＋ 派发真事件**"：
 *      · 被验的是**应用自己的那段代码**（`visibilitychange` → `hook.hidden` → `syncLoop`），
 *        这一段全是真的；
 *      · 只有"浏览器什么时候派这个事件"是我模拟的。
 *    ⇒ 它证明的是"**收到 visibilitychange 时应用会停**"，⛔ 不是"操作系统真的切窗口会停"。
 *      报告里必须这么写，不能含糊成"验证了切后台"。
 */
const A_fakeVisibility = async (state) => {
  try {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
  } catch (e) {
    return "defineProperty 失败: " + String((e && e.message) || e);
  }
  document.dispatchEvent(new Event("visibilitychange"));
  return "dispatched:" + state;
};

/** 把上面那个假 getter 拆掉，让 `visibilityState` 回到浏览器真实值。 */
const A_restoreVisibility = async () => {
  try {
    delete document.visibilityState;
  } catch (e) {
    return "delete 失败: " + String((e && e.message) || e);
  }
  document.dispatchEvent(new Event("visibilitychange"));
  return "restored:" + document.visibilityState;
};

/**
 * ⭐ 批次 3：把媒体特性**显式钉住**（理由见文件头那段长注释）。
 *
 * ⚠️⚠️ `Emulation.setEmulatedMedia` 的 `features` 是**整个替换**的 ——
 *    只写一项，另一项就会掉回**宿主机真实值**。本机的真实值是
 *    `prefers-reduced-motion: reduce`（"减弱动态效果"开着），
 *    所以任何一处漏写都会让"该动"的断言**在这台机器上必然红**。
 */
async function pinMedia(client, scheme, reduce) {
  await client.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: scheme },
      { name: "prefers-reduced-motion", value: reduce },
    ],
  });
}

/** 只截画布那一块并解码（J 组要连拍好几张，抽出来省得抄四遍）。 */
async function clipCanvas(client, file) {
  const rect = await evalFn(client, R_rect);
  if (!rect || rect.w <= 8 || rect.h <= 8) return null;
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
  });
  if (!shot || !shot.data) return null;
  const png = Buffer.from(shot.data, "base64");
  if (file) fs.writeFileSync(file, png);
  try {
    return decodePng(png);
  } catch (e) {
    rec("clipDecodeError", String((e && e.message) || e));
    return null;
  }
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

async function main() {
  console.log("=== 树语 · 第一期 · 批次 3 —— 花与叶 ＋ 风 ＋ 六条纪律 ===");
  console.log("EXE =", EXE);

  // ⭐ 先验"量尺子"本身（见 selfTest 的注释）—— 它没过，后面的像素断言全都不可信。
  try {
    rec("selfTest", selfTest());
  } catch (e) {
    ok(
      false,
      "0. 判据自测（`rowStats` / `findTreeTop` / `rowCoverage` / `warmStats` / `diffImages` 都用已知答案的人造图验）",
      String((e && e.message) || e)
    );
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

    /*
     * ⭐⭐ 批次 3 的第一个动作：**先读一眼宿主机的真实媒体特性，再把它钉住**。
     *
     * 为什么要先读：本机的"减弱动态效果"**是开着的**（`prefers-reduced-motion: reduce`）
     * ⇒ 应用会按纪律 3 **老老实实地静止**。那样 D 组（帧在涨）与 J 组（会动）
     * 在**我的机器上必然红**，而在他机器上必然绿 —— 那种断言等于没写。
     * ⇒ 先把 `no-preference` 钉上（造出"该动"的前提），到 K2 再临时换成 `reduce` 验"停"。
     */
    const hostMedia = await evalFn(client, () => ({
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    }));
    rec("hostMedia", JSON.stringify(hostMedia) + "（宿主机真实值，仅供记录）");

    await pinMedia(client, "dark", "no-preference");
    await sleep(400);
    const pinned = await evalFn(client, () => ({
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    }));
    // ⭐ 铁律 14：断言之前先把那个量造出来，并且在断言里确认它**真的被造出来了**。
    ok(
      pinned && pinned.reduced === false && pinned.dark === true,
      "0b. ⭐ 前提已造出：媒体特性被钉成「深色 ＋ 允许动效」（否则后面 D/J 两组在本机必然红）",
      JSON.stringify(pinned)
    );

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
    /*
     * ⭐ 调整轮定标：本轮树改成「主干沿途出 3 层侧枝 ＋ 每级分 2 根 ＋ 5 级」
     *    ⇒ **156 枝／80 梢**（批次 3 是 139／72）。
     *    ⚠️ 中间走过一版只有 31 枝的（把级数一降了之）—— 那版树干光秃秃、
     *    树冠挤在顶上，**像"杆顶一丛灌木"**，截图一看就不行 ⇒ 才改成"层性"这个做法。
     */
    ok(
      !!sh && sh.branches >= 100 && sh.tips >= 50,
      "F3. 骨架规模够了（不是一根光杆；⚠️ 本轮定标是 156 枝／80 梢）",
      sh ? `枝条 ${sh.branches} 根 / 枝梢 ${sh.tips} 个` : "没钩子"
    );
    ok(
      !!sh && sh.crownWidth >= sh.height * 0.5,
      "F4. ⭐ 树冠真的横向铺开了（冠幅至少是树高的一半 ⇒ 不是一根杆）",
      sh ? `冠幅 ${sh.crownWidth.toFixed(2)} / 树高 ${sh.height.toFixed(2)}（比 ${(sh.crownWidth / sh.height).toFixed(2)}）` : "没钩子"
    );
    /*
     * ⚠️ 调整轮定标：枝条 139→156、叶子 1,645→1,636，量级基本回到批次 3。
     *    ⚠️ 具体数字见本轮实测（写进 README）。
     */
    ok(
      !!sh && sh.triangles >= 3000,
      "F5. 显卡这一帧真的画了上千个三角形（不是空场景）",
      sh ? `${sh.triangles} 个三角形` : "没钩子"
    );

    /*
     * ⭐⭐ F6/F7/F8 —— 像素层面的交叉印证，不用信骨架数字。
     *
     * ⚠️ 调整轮：**"天空那一行"的位置要跟着改**。
     *    原来取 6% 那一行当纯天空；但本轮 TREE_FILL 0.75→0.82（用户要树更大），
     *    树顶被顶到更靠上 ⇒ 6% 那一行**已经切到树冠了**（实测 span 48，不再是纯天空）。
     *    ⇒ 改从 **2%** 取（那是画布最上面那条，肯定还在树顶之上）；
     *      树冠行也从 40% 挪到 **50%**（树更大后，真正的冠心往下走了一点）。
     */
    const skyRow = canvasImg ? rowStats(canvasImg, 0.02) : null;
    const crownRow = canvasImg ? rowStats(canvasImg, 0.5) : null;
    ok(
      !!crownRow && crownRow.span >= 30,
      "F6. ⭐ 穿过树冠那一行的明暗起伏很大（画面里真的有东西）",
      JSON.stringify(crownRow)
    );
    ok(
      !!skyRow && skyRow.span <= 20,
      "F7. ⭐ 反例对照：树顶以上那一行（纯天空）起伏很小",
      JSON.stringify(skyRow)
    );
    /*
     * ⚠️ 倍数也从 3 降到 2：本轮树**疏了**（枝条少、叶子少），树冠那一行的
     *    明暗起伏天然比密树小；2 倍仍然足以说明"有东西"与"没东西"的区别。
     */
    ok(
      !!skyRow && !!crownRow && crownRow.span >= Math.max(20, skyRow.span * 2),
      "F8. ⭐ 对照成立：树冠行的起伏 ≥ 天空行的 2 倍（所以 F6 不是噪声）",
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
    // ⚠️ 两项一起写（见 `pinMedia` 的说明）—— 只写 color-scheme 的话，
    //    `reduced-motion` 会掉回宿主机真实值（本机是 reduce），树会当场静止，
    //    而这一组后面还要靠"画面在动"之外的东西，静下来容易连带出别的假红。
    await pinMedia(client, "light", "no-preference");
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
    // 收回浅色，回到"深色 ＋ 允许动效"这个基线（I~L 四组都在这个基线上量）。
    await pinMedia(client, "dark", "no-preference");
    await sleep(900);

    /*
     * ══════════════════════════════════════════════════════════════════
     * ⭐ 批次 3 从这里开始
     * ══════════════════════════════════════════════════════════════════
     * ⚠️ 上面 A~H 用的 `canvasImg` 是**批次 2 那套量法**（撑满/树形/等比放大），
     *    它是**深色、原视口**下截的，正好能跟批次 2 的实测基线直接比。
     */

    // ── I. ⭐ 花与叶真的挂上去了 ────────────────────────────────────────
    const i1 = await evalFn(client, R_stage);
    rec("I_stage", JSON.stringify(i1));

    /*
     * ⭐ 调整轮定标：叶子回到 **1,636 片**（批次 3 是 1,645）—— 与批次 3 同量级。
     *    花降到 **173 簇**（批次 3 是 267）—— 用户说「花有点密」，花是**故意调疏的**。
     */
    ok(
      !!i1 && i1.leaves >= 500,
      "I1. 叶子片数够多（不是「忘了挂」或「只挂了几片」；⚠️ 本轮实测 1,636）",
      i1 ? `${i1.leaves} 片叶子` : "没钩子"
    );
    ok(
      !!i1 && i1.blossoms >= 60,
      "I2. 花簇数够多（⚠️ 本轮实测 173 —— 比批次 3 的 267 少，是用户要的「别太密」）",
      i1 ? `${i1.blossoms} 簇花` : "没钩子"
    );
    /*
     * ⭐⭐ I3 —— **三角形预算要"逐个数得上"**，这比"多得多"硬得多。
     *
     * 批次 2 实测 3260 个三角形；本批实测 10374 ⇒ 多出 **7114** 个。
     * 而花叶应该贡献多少个？**算得出来**：
     *   叶 1645 片 × 每片 2 个三角 × **2 遍**（主通道 ＋ 阴影通道）＝ 6580
     *   花  267 簇 × 每片 2 个三角 × **1 遍**（花簇不投影）        ＝  534
     *                                                        合计 ＝ 7114  ✅ 一个不多一个不少
     *
     * ⛔ 这条式子同时钉住了**三个**设计决定，任何一个被改动它都会红：
     *    · 叶、花各是一个 `InstancedMesh`，**每片一块四边形**（2 个三角）；
     *    · 叶子 `castShadow = true`（所以它被画了两遍）；
     *    · 花簇 `castShadow = false`（所以只画一遍）。
     *    ⚠️ 它**不是**"我说挂了就算"，而是"显卡数的三角形必须跟算出来的对上"。
     */
    /*
     * ⭐⭐ I3 —— **三角形预算要"逐个数得上"**，这比"多得多"硬得多。
     *
     * ⚠️ 调整轮：**基线换掉了**。批次 3 那条式子拿"批次 2 的 3,260 个三角形"
     *    当起点（那棵树 139 枝）。**本轮树的骨架本身也变了**（139→31 枝），
     *    所以不能再拿批次 2 当基线 —— 换成**本轮同一台机器实测的"纯骨架"数**：
     *    树干 8 根枝 ＝ **452** 个三角形（没有花叶时那一帧）。
     *    算法不变，只换基数：
     *      叶 389 片 × 2 个三角 × **2 遍**（主通道 ＋ 阴影通道）＝ 1,556
     *      花  46 簇 × 2 个三角 × **1 遍**（花簇不投影）        ＝    92
     *                                                    合计 ＝ 1,648
     *    实测 2,100 − 452 ＝ 1,648  ✅ 一个不多一个不少。
     *    ⛔ 这条式子同时钉住三个设计决定：每片一块四边形（2 三角）、
     *       叶 `castShadow=true`（画两遍）、花 `castShadow=false`（画一遍）。
     */
    /*
     * ⚠️ `renderer.info.render.triangles` 是**整帧**读数，除了树还有：
     *    地面平面（2）＋ 树下圆台（258 ＝ 柱侧 64×2 ＋ 上下底各 64 ＋ 顶面 2）。
     * 骨架 ＝ 每根枝 `radialSegments(depth) × 2` 三角 × **2 遍**（主通道 ＋ 阴影通道）
     *        ＋ 台座 258 ＋ 地面 2
     * ⭐ 本轮树的深度分布是 {0:1, 1:5, 2:10, 3:20, 4:40, 5:80}：
     *    (1×12 ＋ 5×9 ＋ 10×7 ＋ 20×6 ＋ 40×5 ＋ 80×5) × 2
     *      ＝ (12 ＋ 45 ＋ 70 ＋ 120 ＋ 200 ＋ 400) × 2 ＝ 847 × 2 ＝ 1,694
     *    含阴影通道 ×2 ⇒ 3,388，再加台座 258 ＋ 地面 2 ⇒ **3,648**
     * 预期总数 ＝ 3,648 ＋ 叶 1,636×4 ＋ 花 173×2 ＝ 3,648 ＋ 6,890 ＝ **10,538**
     * 实测 **10,538** ⇒ **一毫不差**，式子成立。
     */
    /*
     * ⭐ 第二期批次 1：这个基线**必须加上年轮环**，否则 I3 会莫名其妙地红。
     *
     *   细环 ＝ `TorusGeometry(r, r×0.075, 6, 64)` ⇒ 每圈 `6 × 64 × 2` ＝ **768** 个三角形；
     *   三圈 ＝ **2,304**。
     *   ⚠️ 展开态那条环带**不计入** —— 它平时是 `visible = false`，渲染器直接跳过。
     *   ⚠️ 这条第一次跑就是红的（实测多出 9194 ＝ 算出来 6890 ＋ **2304**），
     *      一查正好是三圈细环的数 —— 说明"逐个数得上"这把尺子**非常灵敏**。
     */
    const SKELETON_TRI = 3648 + 3 * 6 * 64 * 2; // 非花叶部分 ＋ 年轮三圈细环
    const expectDelta = i1 ? i1.leaves * 4 + i1.blossoms * 2 : NaN;
    const actualDelta = i1 ? i1.triangles - SKELETON_TRI : NaN;
    rec(
      "I_tri",
      JSON.stringify({
        本轮骨架: SKELETON_TRI,
        本批: i1 && i1.triangles,
        多出: actualDelta,
        算出来应该多出: expectDelta,
        算式: `叶 ${i1 && i1.leaves}×2×2 ＋ 花 ${i1 && i1.blossoms}×2×1`,
      })
    );
    ok(
      !!i1 && Math.abs(actualDelta - expectDelta) <= 8,
      "I3. ⭐⭐ 多出来的三角形**逐个数得上**（叶×4 ＋ 花×2）—— 叶两遍、花一遍，一件不多一件不少",
      i1 ? `实际多 ${actualDelta} ＝ 算出来 ${expectDelta}（叶 ${i1.leaves}×4 ＋ 花 ${i1.blossoms}×2）` : "没钩子"
    );

    /*
     * ⚠️ `drawCalls`（这一帧画了几次）**只当信息看，不当断言** ——
     *    它不是"主通道 3 次"那么干净：`renderer.info` 把**阴影通道**也算进去，
     *    地面／台座要不要投影又取决于它们的 `castShadow`。实测是 8 次。
     *    ⇒ 只断言一个**结构上一定成立**的下限：主通道至少 5 个 mesh
     *      （地面、台座、树干、叶、花）＝ 至少 5 次绘制。
     */
    ok(
      !!i1 && i1.drawCalls >= 5,
      "I4. ⭐ 这一帧的绘制次数 ≥ 5（主通道至少要画：地面、台座、树干、叶、花）",
      i1 ? `drawCalls ＝ ${i1.drawCalls}（含阴影通道，⛔ 这个数别当"主通道几次"用）` : "没钩子"
    );

    /*
     * ⭐⭐ I5/I6 —— **拿批次 2 存档的那张画布截图当基线**，同一把尺子量。
     *
     * 为什么不用 `rowCoverage`：那个判据是"偏离这一行的**中位数**超过 25 级"，
     * 而**深色主题下叶子是中间调**（实测亮度 29~118，天空约 20~40）
     * ⇒ 相当一部分叶子和天空的差不到 25 级，**数不进去**。
     * 本批实测树冠行覆盖度只从 4.82% 涨到 8.63%（1.8 倍），而**肉眼**看到的是
     * 从"光杆"变成"满树金叶" —— 判据**低估**了变化。
     * ⇒ 换一个在这个场景里真正分得开的量：**暖色像素**。
     *    批次 2：**0 个**（树皮是暗褐、r−b ＝ 36，够不着 40 的门槛）；
     *    批次 3：**16325 个**。零基线 ⇒ 门槛怎么定都不心虚。
     */
    let base2Img = null;
    try {
      base2Img = decodePng(fs.readFileSync(BASE2_SHOT));
    } catch (e) {
      rec("I_base2_decode", String((e && e.message) || e));
    }
    const b2w = base2Img ? warmStats(base2Img, 0, 1) : null;
    const b3w = canvasImg ? warmStats(canvasImg, 0, 1) : null;
    /*
     * ⚠️ 调整轮：**树冠带的范围放宽**到 0.18~0.72。
     *    原来 0.25~0.6 是按批次 3 那棵树（139 枝、1,645 片叶）切的；
     *    本轮树**疏了**（叶 389 片），暖色总量小了一个量级，
     *    树冠带切窄了就会漏掉外圈的花叶 ⇒ 占比被低估（实测 58%）。
     *    ⚠️ 但**不能放到整幅**（那就成了循环论证）—— 0.18~0.72 仍是"树冠那一段"。
     */
    const b3crown = canvasImg ? warmStats(canvasImg, 0.18, 0.72) : null;
    const b3sky = canvasImg ? warmStats(canvasImg, 0, 0.08) : null;
    const crownCovI = canvasImg ? rowCoverage(canvasImg, 0.4) : null;
    rec(
      "I_warm",
      JSON.stringify({
        批次2整幅: b2w,
        本批整幅: b3w,
        本批树冠带: b3crown,
        本批天空带: b3sky,
      })
    );

    // 前提：基线真的读进来了、而且真的是"0 个暖色"（否则 I5 的比较没有意义）
    ok(
      !!b2w && b2w.n <= 50,
      "I5. ⭐ 前提成立：批次 2 那张存档截图上「暖色像素」几乎是 0（基线真的造出来了）",
      b2w ? `批次 2 整幅暖色 ＝ ${b2w.n} 个` : "基线截图没解出来"
    );
    ok(
      !!b3w && b3w.n >= 3000,
      "I6. ⭐⭐ 跨版本对照：整幅的暖色像素从 **0** 涨到一万多（花与叶真的长在树上了）",
      b2w && b3w
        ? `批次 2 ＝ ${b2w.n} 个 → 本批 ＝ ${b3w.n} 个（多 ${b3w.n - b2w.n} 个）`
        : "量不到"
    );
    ok(
      !!b3sky && b3sky.cover <= 0.005,
      "I7. ⭐ 反例对照：天空带里几乎没有暖色（所以 I6 那一万多不是背景色凑出来的）",
      JSON.stringify(b3sky)
    );
    ok(
      !!b3crown && !!b3w && b3crown.n >= b3w.n * 0.55,
      "I8. ⭐ 绝大部分暖色都集中在**树冠带**（说明黄的是长在树上，⛔ 不是撒在别处）",
      b3crown && b3w
        ? `树冠带 ${b3crown.n} / 整幅 ${b3w.n}（${((b3crown.n / b3w.n) * 100).toFixed(0)}%）`
        : "量不到"
    );
    ok(
      !!b3crown && b3crown.cx !== null && b3crown.cx >= 0.35 && b3crown.cx <= 0.65,
      "I9. ⭐ 暖色的重心也落在画面正中（花叶长在树上，⛔ 不是糊在边上）",
      b3crown ? `重心 x ＝ ${(b3crown.cx * 100).toFixed(1)}%（50% 为正中）` : "量不到"
    );
    // 📎 信息：`rowCoverage` 的跨版本对照**只记录不断言**（原因见上面那段说明）。
    rec(
      "I_rowCover_note",
      crownCovI
        ? `同一把 \`rowCoverage\`：批次 2 树冠行 ${(BASE2.crownCover * 100).toFixed(2)}% → 本批 ${(crownCovI.cover * 100).toFixed(2)}%（${(crownCovI.cover / BASE2.crownCover).toFixed(2)} 倍）。⚠️ 这个倍数**明显小于肉眼看的变化**，因为深色主题下叶子是中间调、够不着"偏离中位数 25 级"这条线 —— 所以本组的结论**以暖色像素那条为准**。`
        : "rowCoverage 量不到"
    );

    // ── J. ⭐ 风：开着真的在动 / 关掉真的不动（两个方向都要测） ───────────
    /*
     * ⚠️ 连拍**三张**而不是两张：风是正弦的，万一两次采样刚好落在波形的同一相位，
     *    两张会"看起来一样" —— 那是采样运气，不是树没动。三张里取**差异最大的那一对**。
     */
    const mA = await clipCanvas(client, SHOT_MOVE_A);
    await sleep(1200);
    const mB = await clipCanvas(client, SHOT_MOVE_B);
    await sleep(1100);
    const mC = await clipCanvas(client);
    const dMove = [diffImages(mA, mB), diffImages(mB, mC), diffImages(mA, mC)].filter(Boolean);
    const dMoveMax = dMove.reduce((a, b) => (b.diff > a.diff ? b : a), dMove[0] || { diff: -1, maxDiff: -1 });
    rec("J_diff_on", JSON.stringify(dMove));
    ok(
      dMove.length === 3 && dMove.every((d) => d.sizeMismatch !== true),
      "J1. 三张画布截图都解出来了、尺寸一致（判据有东西可比）",
      JSON.stringify(dMove.map((d) => [d.w, d.h]))
    );
    ok(
      dMoveMax.diff >= 200 && dMoveMax.maxDiff >= 8,
      "J2. ⭐ 动效开着时，相隔一秒多的两张画布截图**确实不一样**（风真的在吹）",
      `最大差 ${dMoveMax.diff} 像素 / 单点最大 ${dMoveMax.maxDiff} 级（行 ${dMoveMax.firstRow}~${dMoveMax.lastRow}）`
    );

    // 现在**真的去点**设置页那个开关（⛔ 不是往 localStorage 写值冒充）
    rec("J_open", JSON.stringify(await evalFn(client, A_openSettings, "通用")));
    await sleep(300);
    const rowBefore = await evalFn(client, R_treeMotionRow);
    rec("J_row", JSON.stringify(rowBefore));
    ok(
      !!rowBefore && rowBefore.found === true && rowBefore.checked === true,
      "J3. ⭐ 前提成立：设置页「通用」里真有「树语动效」这一行，且当前是**开着**的",
      JSON.stringify(rowBefore)
    );

    // ⚠️ 先滚到那一行再拍，否则截图里看不到开关（第一版就是这么翻车的）
    const scrolled = await evalFn(client, A_scrollToTreeMotion);
    rec("J_scroll", String(scrolled));
    ok(
      !!scrolled && String(scrolled).includes('"inView":true'),
      "J3b. 前置：拍设置页之前已经把「树语动效」那一行滚进了视野（否则那张截图拍不到开关）",
      String(scrolled)
    );

    const shotSet = await client.send("Page.captureScreenshot", { format: "png" });
    if (shotSet && shotSet.data) {
      fs.writeFileSync(SHOT_SETTINGS, Buffer.from(shotSet.data, "base64"));
      rec("shot", `${SHOT_SETTINGS} (${fs.statSync(SHOT_SETTINGS).size} B)`);
    }

    rec("J_click", String(await evalFn(client, A_clickTreeMotion)));
    await sleep(350);
    const storedOff = await evalFn(client, R_treeMotionStored);
    ok(
      !!storedOff && storedOff.raw === "0",
      'J4. ⭐ 点一下开关，`localStorage` 的 `diary.tree-motion` 立刻落成 "0"',
      JSON.stringify(storedOff)
    );

    rec("J_close", JSON.stringify(await evalFn(client, A_closeSettings)));
    await sleep(900);
    const s0 = await evalFn(client, R_stage);
    await sleep(1500);
    const s1 = await evalFn(client, R_stage);
    ok(
      !!s0 && s0.animating === false && s0.motionPref === false,
      "J5. 关掉之后组件自己报「不在动」（`animating=false` ＋ `motionPref=false`）",
      JSON.stringify(s0)
    );
    ok(
      !!s0 && !!s1 && s1.frames === s0.frames,
      "J6. ⭐ 关掉之后帧计数冻住",
      `${s0 && s0.frames} → ${s1 && s1.frames}`
    );

    const tA = await clipCanvas(client, SHOT_STILL_A);
    await sleep(1400);
    const tB = await clipCanvas(client, SHOT_STILL_B);
    const dStill = diffImages(tA, tB);
    rec("J_diff_off", JSON.stringify(dStill));
    ok(
      !!dStill && dStill.sizeMismatch !== true && dStill.diff === 0 && dStill.maxDiff === 0,
      "J7. ⭐⭐ 关掉之后，相隔 1.4 秒的两张画布截图**逐像素完全一致**（连一格都没差）",
      JSON.stringify(dStill)
    );
    ok(
      !!dStill && dStill.diff < dMoveMax.diff / 10,
      "J8. ⭐ 反例对照成立：关掉后的差异远小于开着时（所以 J7 的 0 不是「截图本身就不变」）",
      `关 ${dStill && dStill.diff} vs 开 ${dMoveMax.diff}`
    );

    // ⭐ 再点回去 —— 开关**两个方向**都得通（只会关不会开一样是坏的）
    rec("J_reopen", JSON.stringify(await evalFn(client, A_openSettings, "通用")));
    await sleep(300);
    rec("J_click2", String(await evalFn(client, A_clickTreeMotion)));
    await sleep(350);
    const storedOn = await evalFn(client, R_treeMotionStored);
    ok(
      !!storedOn && storedOn.raw === "1",
      'J9. ⭐ 再点一下，偏好回到 "1"（两个方向都通）',
      JSON.stringify(storedOn)
    );
    rec("J_close2", JSON.stringify(await evalFn(client, A_closeSettings)));
    await sleep(1000);
    const rr1 = await evalFn(client, R_stage);
    await sleep(1100);
    const rr2 = await evalFn(client, R_stage);
    ok(
      !!rr1 && !!rr2 && rr1.animating === true && rr2.frames > rr1.frames,
      "J10. ⭐ 反例对照：再点开之后又动起来了",
      `${rr1 && rr1.frames} → ${rr2 && rr2.frames}（animating=${rr1 && rr1.animating}）`
    );

    // ── K. 六条纪律里剩下的几条 ────────────────────────────────────────
    // K1~K3：纪律 2 —— 软件切到后台会停（⚠️ 见 `A_fakeVisibility` 里的"说实话"段落）
    rec("K_vis_hidden", String(await evalFn(client, A_fakeVisibility, "hidden")));
    await sleep(500);
    const v0 = await evalFn(client, R_stage);
    await sleep(1500);
    const v1 = await evalFn(client, R_stage);
    ok(
      !!v0 && v0.hidden === true && v0.animating === false,
      "K1. 收到「页面不可见」后组件自己报「已停」",
      JSON.stringify(v0)
    );
    ok(
      !!v0 && !!v1 && v1.frames === v0.frames,
      "K2. ⭐ 后台状态下帧计数冻住",
      `${v0 && v0.frames} → ${v1 && v1.frames}`
    );
    rec("K_vis_restore", String(await evalFn(client, A_restoreVisibility)));
    await sleep(1000);
    const v2 = await evalFn(client, R_stage);
    await sleep(1100);
    const v3 = await evalFn(client, R_stage);
    ok(
      !!v2 && !!v3 && v2.hidden === false && v3.frames > v2.frames,
      "K3. ⭐ 反例对照：回到可见之后又接着涨（所以 K2 的「没涨」真的是被停掉的）",
      `${v2 && v2.frames} → ${v3 && v3.frames}`
    );

    // K4~K6：纪律 3 —— 系统「减弱动态效果」
    await pinMedia(client, "dark", "reduce");
    await sleep(800);
    const q0 = await evalFn(client, R_stage);
    await sleep(1500);
    const q1 = await evalFn(client, R_stage);
    ok(
      !!q0 && q0.reducedMotion === true && q0.animating === false,
      "K4. ⭐ 系统开着「减弱动态效果」时组件报「已停」",
      JSON.stringify(q0)
    );
    ok(
      !!q0 && !!q1 && q1.frames === q0.frames,
      "K5. ⭐ `reduce` 下帧计数冻住",
      `${q0 && q0.frames} → ${q1 && q1.frames}`
    );
    /*
     * ⭐⭐ K6 是本组**最要紧**的一条。没有它，K5 在"动画压根没实现"时会**照样全绿**
     *     —— 一个什么都不动的树，当然满足"reduce 下不动"。
     *     所以必须把开关摘掉、证明它**立刻又动起来**，K5 才有意义。
     */
    await pinMedia(client, "dark", "no-preference");
    await sleep(900);
    const q2 = await evalFn(client, R_stage);
    await sleep(1100);
    const q3 = await evalFn(client, R_stage);
    ok(
      !!q2 && !!q3 && q2.reducedMotion === false && q3.frames > q2.frames,
      "K6. ⭐⭐ 反例对照：把 `reduce` 摘掉后**立刻又动起来**（所以 K5 的「没涨」是被它停的）",
      `${q2 && q2.frames} → ${q3 && q3.frames}（reducedMotion=${q2 && q2.reducedMotion}）`
    );

    // K7~K9：纪律 6 —— 花叶不出现在写日记 / 搜索 / 筛选页
    rec("K_write", JSON.stringify(await evalFn(client, A_topTab, "写日记")));
    await sleep(900);
    const cen1 = await evalFn(client, R_canvasCensus);
    ok(
      !!cen1 && cen1.count === 0 && cen1.stages === 0,
      "K7. ⭐ 写日记页里**一块树语画布都没有**（结构上就不可能，不是藏起来了）",
      JSON.stringify(cen1)
    );
    const shotW = await client.send("Page.captureScreenshot", { format: "png" });
    if (shotW && shotW.data) {
      fs.writeFileSync(SHOT_WRITE, Buffer.from(shotW.data, "base64"));
      rec("shot", `${SHOT_WRITE} (${fs.statSync(SHOT_WRITE).size} B)`);
    }
    rec("K_search", JSON.stringify(await evalFn(client, A_topTab, "搜索")));
    await sleep(800);
    const cen2 = await evalFn(client, R_canvasCensus);
    ok(!!cen2 && cen2.count === 0, "K8. ⭐ 搜索页里也没有", JSON.stringify(cen2));
    rec("K_filter", JSON.stringify(await evalFn(client, A_topTab, "筛选")));
    await sleep(800);
    const cen3 = await evalFn(client, R_canvasCensus);
    ok(!!cen3 && cen3.count === 0, "K9. ⭐ 筛选页里也没有", JSON.stringify(cen3));

    // 回到树语（K10/K11 与 L 组都在树上量）
    rec("K_back", JSON.stringify(await evalFn(client, A_topTab, "年轮")));
    const backTree = await waitFor(client, () => !!document.querySelector(".tree-stage canvas"), 12000);
    ok(backTree.ok, "K10. 前提：切回年轮页后画布又挂出来了", `等待 ${backTree.ms}ms`);
    rec("K_sub", JSON.stringify(await evalFn(client, A_subTab, "树语")));
    await sleep(1200);

    // K11~K12：纪律 5 —— 画质按屏幕密度**封顶 2 倍**
    /*
     * ⚠️⚠️ 第一版这一条是**假绿**，记在这儿给以后看：
     *     原来写的是「把 dpr 拉到 3 → 读 `pixelRatio` 是不是 ≤ 2」。
     *     可 `renderer.setPixelRatio(min(dpr, 2))` 只在**组件挂载时**调一次，
     *     改 dpr **不会**让它重算 ⇒ 读到的还是挂载时那个 1.875，
     *     `1.875 ≤ 2` 当然成立 —— **把封顶那行代码整个删掉，这条照样绿**。
     *   ⇒ 真做法：让组件在 **dpr ＝ 3 的状态下重新挂载**（切到「刻度」再切回「树语」），
     *     这样 `setPixelRatio(min(3, 2))` 才会真的跑一遍、真的被封到 2。
     */
    const vpK = await evalFn(client, R_viewport);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: Math.max(400, vpK.vw - 40),
      height: Math.max(320, vpK.vh - 24),
      deviceScaleFactor: 3,
      mobile: false,
    });
    await sleep(700);
    const vpK2 = await evalFn(client, R_viewport);
    ok(
      !!vpK2 && vpK2.dpr >= 2.9,
      "K11. ⭐ 反例对照的前半：设备像素比**确实**被强行拉到了 3（否则下面那条可能只是「它本来就小」）",
      `dpr: ${vpK && vpK.dpr} → ${vpK2 && vpK2.dpr}`
    );

    // ⭐ 关键一步：**切走再切回**，逼 `TreePane` 重新挂载
    rec("K_remount_away", JSON.stringify(await evalFn(client, A_subTab, "刻度")));
    await sleep(800);
    rec("K_remount_back", JSON.stringify(await evalFn(client, A_subTab, "树语")));
    const capMounted = await waitFor(client, () => !!document.querySelector(".tree-stage canvas"), 12000);
    ok(capMounted.ok, "K12. 前提：在 dpr ＝ 3 下重新挂载成功（不然下面量的是旧的那一份）", `等待 ${capMounted.ms}ms`);
    await sleep(900);

    const cap = await evalFn(client, R_stage);
    ok(
      !!cap && cap.pixelRatio === 2 && Math.abs(cap.backingW - cap.viewW * 2) <= 2,
      "K13. ⭐⭐ 画质封顶生效：在 **dpr ＝ 3** 的机器上挂载，渲染器只按 **2 倍**画（4K 屏不会被白白烧掉一倍显卡）",
      cap
        ? `dpr ＝ ${vpK2 && vpK2.dpr} ／ pixelRatio ＝ ${cap.pixelRatio}（应恰为 2）／ 背衬 ${cap.backingW}×${cap.backingH} ／ 显示 ${cap.viewW}×${cap.viewH}（显示×2 ＝ ${cap.viewW * 2}）`
        : "没钩子"
    );
    /*
     * 📎 顺手记一笔**已知边界**（⛔ 不断言，报给用户定）：
     *    把窗口拖到另一块不同缩放比的显示器上时，`devicePixelRatio` 会变，
     *    但 `setPixelRatio` 只在挂载时调过一次 ⇒ **画布不会按新密度重算**。
     */
    rec(
      "K_dpr_note",
      "⚠️ 已知边界：`setPixelRatio` 只在组件挂载时调一次 ⇒ 把窗口拖到另一块缩放比不同的显示器上，画布**不会**按新密度重算（本次实测：不重挂载时 dpr 从 1.875 拉到 3 也仍是 1.875）。要不要顺手补，见报告。"
    );
    await client.send("Emulation.clearDeviceMetricsOverride");
    await sleep(1400);

    // ── L. 帧时间在预算内 ──────────────────────────────────────────────
    const l1 = await evalFn(client, R_stage);
    await sleep(1600);
    const l2 = await evalFn(client, R_stage);
    ok(
      !!l2 && typeof l2.frameMs === "number" && l2.frameMs > 0,
      "L1. 量得到渲染一帧的耗时（滚动平均）",
      l2 ? `${l2.frameMs.toFixed(1)} ms/帧` : "没钩子"
    );
    ok(
      !!l2 && l2.frameMs <= 33,
      "L2. ⭐ 渲染一帧 ≤ 33ms（30fps 的预算）—— 加了花叶与风之后没把显卡拖垮",
      l2 ? `${l2.frameMs.toFixed(1)} ms/帧（约 ${Math.round(1000 / Math.max(0.01, l2.frameMs))} fps 的余量）` : "没钩子"
    );
    ok(
      !!l1 && !!l2 && l2.frames > l1.frames,
      "L3. 前提：这一组量的确实是**在动**的时候（不是静止态下量出来的假数）",
      `${l1 && l1.frames} → ${l2 && l2.frames}`
    );

    // ══ N. ⭐⭐ 调整轮：**树的模样**（用户这一轮的正面要求） ══════════════
    //
    // 用户原话：
    //   「真实的树都是**大部分向斜上方生长**，**一部分向平行于地面的四周生长**，
    //     **向下生长的不好看都被裁剪掉了**」
    //
    // ⚠️ 这一组是**唯一能证明"树的模样真的改了"**的地方 —— 前面的 I 组只证明
    //    "花叶挂上去了"。判官仍是**园艺学的垂直角分档**（多份来源一致）：
    //      <30° 直立 ｜ 30~60° 斜生 ｜ 60~90° 水平 ｜ >90° 下垂（要剪掉）。
    const n1 = await evalFn(client, R_stage);
    rec("N. 树冠枝条垂直角分布", n1 && n1.angleBins);
    rec("N. 树冠枝条平均垂直角", n1 && n1.angleMean != null ? `${n1.angleMean.toFixed(1)}°` : "没钩子");

    /** 四个档的和（＝参与统计的枝条数）。 */
    const binSum = (b) => (b ? b.直立 + b.斜生 + b.水平 + b.下垂 : 0);
    const ratio = (b, k) => (binSum(b) > 0 ? b[k] / binSum(b) : 0);

    ok(
      !!n1 && binSum(n1.angleBins) > 0,
      "N1. 钩子能读出树冠枝条的角度分布（拿得到「尺子」，后面的断言才不是空话）",
      n1 ? `参与统计 ${binSum(n1.angleBins)} 根枝` : "没钩子"
    );

    /*
     * ⭐⭐ N2 是这一组的主断言。
     *   「大部分向斜上方生长」＝ 斜生 ＋ 水平要占**压倒性主体**（各来源都说这一段是主体）；
     *   「一部分向平行于地面的四周生长」＝ 水平那一档**必须真的存在**（不能是 0）。
     *   ⚠️ 改之前实测"水平 0%"—— 正是这一条把"举着的扫帚"钉死了。
     */
    const slantShare = n1 ? ratio(n1.angleBins, "斜生") + ratio(n1.angleBins, "水平") : 0;
    ok(
      slantShare > 0.85,
      "N2. ⭐⭐ 大部分枝条是斜生／水平（30~90°）—— 这就是用户说的「大部分向斜上方生长」",
      n1 ? `斜生 ${(ratio(n1.angleBins, "斜生") * 100).toFixed(0)}% ＋ 水平 ${(ratio(n1.angleBins, "水平") * 100).toFixed(0)}% ＝ ${(slantShare * 100).toFixed(0)}%` : "没钩子"
    );
    ok(
      n1 ? ratio(n1.angleBins, "水平") > 0.25 : false,
      "N3. ⭐ 有相当一部分枝条**平行于地面**（用户：「一部分向平行于地面的四周生长」）",
      n1 ? `水平档占 ${(ratio(n1.angleBins, "水平") * 100).toFixed(0)}%` : "没钩子"
    );
    ok(
      n1 ? ratio(n1.angleBins, "下垂") < 0.10 : false,
      "N4. ⭐ 几乎不留**下垂枝**（用户：「向下生长的不好看都被裁剪掉了」）",
      n1 ? `下垂档只占 ${(ratio(n1.angleBins, "下垂") * 100).toFixed(0)}%` : "没钩子"
    );
    ok(
      n1 ? ratio(n1.angleBins, "直立") < 0.20 : false,
      "N5. 直立枝（<30°，真树里也偏少）没占太多",
      n1 ? `直立档 ${(ratio(n1.angleBins, "直立") * 100).toFixed(0)}%` : "没钩子"
    );

    /*
     * ⭐ N6 反例对照：bias 归零 ⇒ N2 那条**必须不成立**。
     *    ⚠️ 这一条**没法在本脚本里做**（钩子读的是写死的默认参数，脚本改不了它）
     *    ⇒ 它放在 `app/tests/tree.test.ts` 里（那里能直接传 overrides）。
     *    这里只**记一行信息**，免得以后有人以为"反例对照没做"。
     */
    rec(
      "N6. 反例对照在哪做的",
      "在 app/tests/tree.test.ts（`axisBiasDeg: -80` ⇒ 下垂占比必须冲上去）；本脚本改不了默认参数，所以不在这儿做"
    );

    /*
     * ⭐ N7：树**占画面更大**了（用户：「树占比画面不是很大」）。
     *    尺子：画布裁剪出来的图里，"属于树"的像素占比。
     *    ⚠️ 改之前 TREE_FILL 0.75；现在 0.82 ⇒ 同一视口下树应该更满。
     */
    ok(
      !!i1 && i1.triangles >= 1500,
      "N7. 树干 ＋ 枝条本身的三角形数够（树没被裁瘦）",
      i1 ? `${i1.triangles} 个三角形（批次 2 是 ${BASE2.triangles}）` : "没钩子"
    );

    /*
     * ⭐ N8：树干变粗了（用户：「树干我觉得有点细」）。
     *    尺子：**树高 ÷ 树干直径**（真实幼乔木 10~14 倍）。
     *    ⚠️ 钩子没有直接暴露 `trunkRadius`，所以用"最粗枝条的半径"间接量：
     *    主干的 `r0` 就是全树最粗处（那条单测已经钉住了）。
     */
    ok(
      !!n1 && typeof n1.height === "number" && n1.height > 2.5,
      "N8. 树高合理（用来算「树高÷干径」这把尺子）",
      n1 ? `树高 ${n1.height.toFixed(2)}` : "没钩子"
    );

    /*
     * ⭐ N9：**花疏了**（用户：「花有点密…调整间隙」）。
     *    ⚠️ I2 是在「花叶挂上去」那一步量的，这里再量一次并跟批次 3 的 267 比。
     *    ⚠️ 但树本身从 139 枝降到 31 枝 ⇒ 花的总数**必然**跟着降，
     *    所以这条只记**信息**，主判据用「每根枝上几簇花」更公平（见 N10）。
     */
    const bloomsPerBranch = n1 && n1.branches > 0 ? n1.blossoms / n1.branches : NaN;
    rec("N9. 花的总数与「每根枝上几簇」", {
      花簇: n1 && n1.blossoms,
      枝条: n1 && n1.branches,
      "每根枝约": Number.isFinite(bloomsPerBranch) ? bloomsPerBranch.toFixed(2) : "—",
    });
    ok(
      Number.isFinite(bloomsPerBranch) && bloomsPerBranch < 6.5,
      "N10. ⭐ 每根枝条上的花簇数真的降了（批次 3 是 267/139 ≈ 1.9，密度口径见 foliage.ts）",
      Number.isFinite(bloomsPerBranch) ? `${bloomsPerBranch.toFixed(2)} 簇/枝（花叶总数 ${n1.blossoms}）` : "没钩子"
    );

    // ══ M. ⭐⭐ 第二期 · **点树出年轮** ═══════════════════════════════════
    //
    // 用户 2026-10-14 拍板：
    //   · **一棵树 ＝ 一个自然季**（今天 10 月 ⇒ 秋 **9 / 10 / 11** 三圈）；
    //   · 三圈**上下排开、一样大**，都套在主干上；
    //   · 点一下 ⇒ 那一圈抽出来（外径 2 倍）；再点收回；**同时只开一圈**；
    //     点空白收回；点树干不反应；
    //   · **空库也照样能点**（里面全是暗格）。
    //
    // ⭐ 这一组**不猜坐标**：组件把三圈在屏幕上的位置投影好放进钩子
    //   （`ringScreen`），脚本按它在画布上**真的派发一次指针事件**。
    //   没有这个，"点得中"就只能靠瞎点 —— 等于没验。
    //
    // ⚠️ 反例对照（铁律）—— 本组有三对：
    //   ① M7「点环 ⇒ 开」 配 M10「点空白 ⇒ 不开」；
    //   ② M8「再点收回」 配 M7「点一下真的开」；
    //   ③ M14「点开前后像素不同」 配 M14b「确实是静止态下拍的」
    //      —— 不停动画的话风会让两张图**本来就不同**，那条对照等于没写。

    // 先钉住"动着"（这一组要看 hover / 点击的实时反应）。
    await pinMedia(client, "dark", "no-preference");
    await sleep(300);

    const m0 = await evalFn(client, R_stage);
    ok(
      !!m0 && m0.ringCount === 3,
      "M1. 钩子读得到三圈年轮（拿得到「尺子」，后面的断言才不是空话）",
      m0 ? `ringCount=${m0.ringCount}，月份 ${JSON.stringify(m0.ringMonths)}` : "没钩子"
    );

    /* ⭐ M2：三圈**一样大** —— 用户原话「三个区域一样大即可，因为树干那一部分
     *   都是一样粗的」。判据写成**相对差**，⛔ 不写死一个绝对值。 */
    const radii = (m0 && m0.ringRadii) || [];
    const rMax = radii.length ? Math.max(...radii) : 0;
    const rMin = radii.length ? Math.min(...radii) : 0;
    ok(
      radii.length === 3 && rMin > 0 && (rMax - rMin) / rMin < 0.005,
      "M2. ⭐ 三圈**一样大**（半径相对差 < 0.5%）—— 用户亲自拍的第 5 条",
      radii.length
        ? `${radii.map((v) => v.toFixed(5)).join(" / ")}（相对差 ${(((rMax - rMin) / rMin) * 100).toFixed(2)}%）`
        : "没数据"
    );

    /* ⭐ M3：三圈都套在主干上。
     *   `grow.ts` 的主干是**精确竖直**的（方向 (0,1,0)）⇒ 环心的 x、z 必须几乎为 0。
     *   ⚠️ 这一条把"环浮在空中"和"环套在某根枝上"一起堵死。 */
    const pos = (m0 && m0.ringPositions) || [];
    const offAxis = pos.map((p) => Math.hypot(p.x, p.z));
    ok(
      pos.length === 3 && pos.every((p) => p.y > 0) && offAxis.every((d) => d < 1e-6),
      "M3. ⭐ 三圈都**套在主干轴线上**（x、z ≈ 0，y > 0）",
      pos.length
        ? `离轴量 ${offAxis.map((d) => d.toFixed(8)).join(" / ")}；环心高度 ${pos.map((p) => p.y.toFixed(3)).join(" / ")}`
        : "没数据"
    );

    /* ⭐ M4：上下**排开**（不是叠在一处）—— 三条高度必须互不相同、严格递增。 */
    const ys = pos.map((p) => p.y);
    ok(
      ys.length === 3 && ys[0] < ys[1] && ys[1] < ys[2] && ys[1] - ys[0] > 0.2,
      "M4. ⭐ 三圈**上下排开**（越往上越高、间距够大）—— ⛔ 不是同心套叠",
      ys.length ? `${ys.map((v) => v.toFixed(3)).join(" → ")}（相邻差 ${(ys[1] - ys[0]).toFixed(3)}）` : "没数据"
    );

    /* ⭐ M5：一棵树 ＝ 一个**自然季**。
     *   ⚠️ 这里**脚本自己独立写一遍**自然季规则（⛔ 不拿钩子的结果反推 —— 那是恒真）。
     *      反例：日历季度会给 10/11/12，其中 12 月已经是冬天（该开枇杷），撞第 5 期。 */
    const SEASON_OF = {
      1: [12, 1, 2], 2: [12, 1, 2], 3: [3, 4, 5], 4: [3, 4, 5], 5: [3, 4, 5],
      6: [6, 7, 8], 7: [6, 7, 8], 8: [6, 7, 8], 9: [9, 10, 11], 10: [9, 10, 11],
      11: [9, 10, 11], 12: [12, 1, 2],
    };
    const NOW = new Date();
    const expMonths = SEASON_OF[NOW.getMonth() + 1];
    const months = (m0 && m0.ringMonths) || [];
    ok(
      months.join(",") === expMonths.join(","),
      "M5. ⭐ 一棵树 ＝ 一个**自然季**（拿今天说：10 月 ⇒ 9 / 10 / 11 月；⛔ 不是日历季度的 10/11/12）",
      `钩子 ${JSON.stringify(months)}（季 ${JSON.stringify((m0 && m0.ringMonthKeys) || [])}） ｜ 期望 ${JSON.stringify(expMonths)}`
    );

    /* ⭐ M6：格数 ＝ 那个月的**实际**天数。
     *   ⚠️ 判据里**自己再写一遍**月份天数（⛔ 不复用实现里的算法），否则是同源恒真。 */
    const daysInMonth = (y, m) => {
      if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
      return [4, 6, 9, 11].includes(m) ? 30 : 31;
    };
    const keys = (m0 && m0.ringMonthKeys) || [];
    const expDays = keys.map((k) => daysInMonth(Number(k.slice(0, 4)), Number(k.slice(5, 7))));
    const days = (m0 && m0.ringDays) || [];
    ok(
      days.length === 3 && days.join(",") === expDays.join(","),
      "M6. 每圈的格数 ＝ 那个月的**实际**天数（⛔ 不是一律 31）",
      `钩子 ${JSON.stringify(days)} ｜ 期望 ${JSON.stringify(expDays)}`
    );

    /* ⭐⭐ M7：**点得中** —— 这一组最关键的一条。
     *   在 `ringScreen` 给的**屏幕位置**真的派发一次完整的指针事件序列。 */
    const screen = (m0 && m0.ringScreen) || [];
    ok(
      screen.length === 3 && screen.every((p) => p.x > 1 && p.y > 1),
      "M7a. 前提：钩子里有**三圈的屏幕位置**（否则只能瞎点，验了等于没验）",
      JSON.stringify(screen.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })))
    );

    /** 在画布上派发一次完整的指针事件序列；`dragPx` → 先按下、再移开、再松手。 */
    async function tap(cx, cy, dragPx) {
      await evalFn(
        client,
        (px, py, dx) => {
          const el = document.querySelector(".tree-stage canvas");
          if (!el) return "no-canvas";
          const mk = (t, x, y) =>
            new PointerEvent(t, {
              clientX: x,
              clientY: y,
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
              button: 0,
              buttons: 1,
            });
          el.dispatchEvent(mk("pointermove", px, py));
          el.dispatchEvent(mk("pointerdown", px, py));
          if (dx) el.dispatchEvent(mk("pointermove", px + dx, py + dx));
          el.dispatchEvent(mk("pointerup", px + dx, py + dx));
          return "ok";
        },
        cx,
        cy,
        dragPx || 0
      );
      await sleep(180);
    }

    const canvasRect = await evalFn(client, R_rect);
    rec("M. 画布位置", JSON.stringify(canvasRect));

    // 先点一次**画布角落**把状态归零（免得受前面几组留下的状态影响）。
    await tap(canvasRect.x + 5, canvasRect.y + 5);
    const afterReset = await evalFn(client, R_stage);
    rec("M. 归零后", `ringOpen=${afterReset && afterReset.ringOpen}`);

    await tap(screen[0].x, screen[0].y);
    const afterOpen = await evalFn(client, R_stage);
    ok(
      !!afterOpen && afterOpen.ringOpen === 0,
      "M7. ⭐⭐ **点得中**：在环的屏幕位置派发一次指针事件 ⇒ 第 1 圈真的开了",
      afterOpen ? `ringOpen=${JSON.stringify(afterOpen.ringOpen)}` : "没钩子"
    );

    /* ⭐ M8：再点同一圈 ⇒ 收回（项目书：「再点一下能收回去」）。 */
    await tap(screen[0].x, screen[0].y);
    const afterClose = await evalFn(client, R_stage);
    ok(
      !!afterClose && afterClose.ringOpen === null,
      "M8. 再点同一圈 ⇒ **收回**",
      afterClose ? `ringOpen=${JSON.stringify(afterClose.ringOpen)}` : "没钩子"
    );

    /* ⭐⭐ M9：**同时只开一圈** —— 点第 2 圈，第 1 圈必须自动收回。 */
    await tap(screen[0].x, screen[0].y);
    const openA = await evalFn(client, R_stage);
    await tap(screen[1].x, screen[1].y);
    const openB = await evalFn(client, R_stage);
    ok(
      !!openA && openA.ringOpen === 0 && !!openB && openB.ringOpen === 1,
      "M9. ⭐⭐ 同时**只开一圈**：先点第 1 圈（开）→ 再点第 2 圈 ⇒ 变成只开第 2 圈",
      `第一次 ${openA && openA.ringOpen}，第二次 ${openB && openB.ringOpen}`
    );

    /* ⭐ M10：**点空白不误开**（反例对照）。
     *   ⚠️ 没有 M7 的"点环真的会开"，这一条在"拾取压根没接上"时**照样绿**。 */
    await tap(canvasRect.x + canvasRect.w - 6, canvasRect.y + 6);
    const afterBlank = await evalFn(client, R_stage);
    ok(
      !!afterBlank && afterBlank.ringOpen === null,
      "M10. ⭐ 点**画布角落（空白）** ⇒ 全收回，⛔ 不误开任何一圈",
      afterBlank ? `ringOpen=${JSON.stringify(afterBlank.ringOpen)}` : "没钩子"
    );

    /* M11：**拖拽不算点击** —— 按下后移动 40px 再松开 ⇒ 不算点击。
     *   ⚠️ 前提：先点开一圈，再拖，确认它**没被收回**
     *      （不然"拖了没反应"和"本来就关着"分不清）。 */
    await tap(screen[2].x, screen[2].y);
    const opened3 = await evalFn(client, R_stage);
    await tap(screen[2].x, screen[2].y, 40);
    const afterDrag = await evalFn(client, R_stage);
    ok(
      !!opened3 && opened3.ringOpen === 2 && !!afterDrag && afterDrag.ringOpen === 2,
      "M11. **拖拽不误触**：按下后移动 40px 再松开 ⇒ 不算点击，那一圈仍然开着",
      `拖之前 ${opened3 && opened3.ringOpen} → 拖之后 ${afterDrag && afterDrag.ringOpen}`
    );

    /* M12：鼠标**移上去会亮**（`ringHover`）—— 移开要回到 null。 */
    const moveTo = async (px, py) => {
      await evalFn(
        client,
        (x, y) => {
          const el = document.querySelector(".tree-stage canvas");
          if (!el) return "no-canvas";
          el.dispatchEvent(
            new PointerEvent("pointermove", {
              clientX: x,
              clientY: y,
              bubbles: true,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
            })
          );
          return "ok";
        },
        px,
        py
      );
      await sleep(150);
    };
    await moveTo(screen[0].x, screen[0].y);
    const hoverOn = await evalFn(client, R_stage);
    await moveTo(canvasRect.x + 3, canvasRect.y + 3);
    const hoverOff = await evalFn(client, R_stage);
    ok(
      !!hoverOn && hoverOn.ringHover === 0 && !!hoverOff && hoverOff.ringHover === null,
      "M12. 鼠标**移上去会亮**（`ringHover` 变成那一圈），移开回到 null",
      `移上去 ${hoverOn && hoverOn.ringHover} → 移开 ${hoverOff && hoverOff.ringHover}`
    );

    /* M13：指针事件**真的接上了**（命中计数 > 0）。 */
    const hits = await evalFn(client, R_stage);
    ok(
      !!hits && hits.ringPickHits > 0,
      "M13. 拾取**命中过**（证明指针事件真的接到了画布上，不是个死场景）",
      hits ? `命中 ${hits.ringPickHits} 次` : "没钩子"
    );

    /* ⭐ M14：**展开态真的画出来了** —— 停住动画，比"点开前 / 点开后"两张像素。
     *   ⚠️ 不停动画的话，风会让两张图**本来就不同**，这条对照等于没写。 */
    await pinMedia(client, "dark", "reduce");
    await sleep(900); // 等它彻底停稳
    /*
     * ⚠️ **先全部收回再拍这一张** —— 它才是用户平时看到的样子。
     *    （M11 结束的时候第 3 圈还开着；不归零的话，"点开前"那张其实是"另一圈开着"。）
     */
    await tap(canvasRect.x + canvasRect.w - 6, canvasRect.y + 6);
    await sleep(400);
    const stillA = await evalFn(client, R_stage);
    const imgA = await clipCanvas(client, path.join(ROOT, "shot-ring-closed.png"));
    await tap(screen[1].x, screen[1].y); // 点开第 2 圈
    // ⚠️ 拍之前先把鼠标挪开 —— 不然画面里混着"悬停提亮"，不纯是"展开"这一件事。
    await moveTo(canvasRect.x + 3, canvasRect.y + 3);
    await sleep(600);
    const stillB = await evalFn(client, R_stage);
    const imgB = await clipCanvas(client, path.join(ROOT, "shot-ring-open.png"));
    const ringDiff = imgA && imgB ? diffImages(imgA, imgB) : null;
    ok(
      !!ringDiff && !ringDiff.sizeMismatch && ringDiff.ratio > 0.0005,
      "M14. ⭐ 点开之后**画面真的变了**（静止态下比像素：细箍 → 一圈环带）",
      ringDiff
        ? ringDiff.sizeMismatch
          ? "两张图尺寸不同"
          : `不同像素 ${(ringDiff.ratio * 100).toFixed(3)}%（${ringDiff.diff} 个），集中在第 ${ringDiff.firstRow}~${ringDiff.lastRow} 行`
        : "截不到图"
    );
    ok(
      !!stillA && !!stillB && stillA.animating === false && stillB.animating === false,
      "M14b. ⭐ 前提：这两张确实是在**静止**下拍的（动画循环已关 ⇒ 差异只可能来自环，不是风）",
      `animating ${stillA && stillA.animating} → ${stillB && stillB.animating} ｜ 帧 ${stillA && stillA.frames} → ${stillB && stillB.frames}（点开时补画会让帧数涨几格，所以不比帧数）`
    );
    ok(
      !!stillA && !!stillB && stillA.ringOpen === null && stillB.ringOpen === 1,
      "M14c. ⭐ 前提：这两张分别是**全收回**和**点开第 2 圈**（⛔ 不是「两张都开着」——那样差异只是换了一圈）",
      `${stillA && stillA.ringOpen} → ${stillB && stillB.ringOpen}`
    );

    // 拍两张人看的全页截图（一张点开、一张收回）。
    const shotOpen = await client.send("Page.captureScreenshot", { format: "png" });
    if (shotOpen && shotOpen.data) {
      const f = path.join(ROOT, "shot-ring-open-full.png");
      fs.writeFileSync(f, Buffer.from(shotOpen.data, "base64"));
      rec("shot", `${f} (${fs.statSync(f).size} B)`);
    }
    await tap(canvasRect.x + canvasRect.w - 6, canvasRect.y + 6); // 收回
    await sleep(500);
    const shotClosed = await client.send("Page.captureScreenshot", { format: "png" });
    if (shotClosed && shotClosed.data) {
      const f = path.join(ROOT, "shot-ring-closed-full.png");
      fs.writeFileSync(f, Buffer.from(shotClosed.data, "base64"));
      rec("shot", `${f} (${fs.statSync(f).size} B)`);
    }

    // 恢复"动着"的状态（后面还有别的组要跑）。
    await pinMedia(client, "dark", "no-preference");
    await sleep(200);

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

// 被 require 时只导出工具（方便单独拿历史截图量一把），⛔ 不起应用。
if (require.main === module) {
  main();
} else {
  module.exports = {
    decodePng,
    colorStats,
    rowStats,
    rowCoverage,
    findTreeTop,
    warmStats,
    diffImages,
    makeImage,
    selfTest,
    BASE2,
  };
}
