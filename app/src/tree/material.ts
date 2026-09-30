/**
 * 树语 · 材质与贴图 —— **全部现场算，⛔ 不下载任何素材**。
 *
 * ⭐ 这是 A 段拍过板的一条（"自己写算法生成"的连带）：树皮、叶子、草地的
 *    花纹都用 `<canvas>` 现画一张图当贴图（`CanvasTexture`）。
 *    好处是零素材文件、零体积增加，换主题还能跟着换色。
 *
 * ⛔ **这里一个色号都不许写死** —— 一律从 CSS 变量取（见 `主题色()`）。
 *    这个软件是深浅两套主题，写死色的地方换主题时会变成一块突兀的窟窿
 *    （热力图早年栽过，见 `global.css` 里 --heat-* 那段的注释）。
 */
import * as THREE from "three";

/** 本模块要用的主题色清单（都定义在 `global.css` 的 `:root` / 深色块里）。 */
export const TREE_COLORS = {
  skyTop: ["--tree-sky-top", "#cfe3f2"],
  skyBottom: ["--tree-sky-bottom", "#f3f7f6"],
  ground: ["--tree-ground", "#b9c8ac"],
  groundFar: ["--tree-ground-far", "#cfd8c6"],
  disc: ["--tree-disc", "#a9b8a0"],
  bark: ["--tree-bark", "#7a6551"],
  barkDark: ["--tree-bark-dark", "#4f4235"],
  /** 那束投影的直射光的颜色（浅色下偏暖白，深色下偏冷月白）。 */
  sun: ["--tree-sun", "#fff3e0"],
  foliage: ["--tree-foliage", "#c9a227"],
} as const;

export type TreeColorName = keyof typeof TREE_COLORS;
export type TreePalette = Record<TreeColorName, string>;

/**
 * 取一个界面颜色的原始值。
 *
 * ⚠️ **返回的是字符串**（`#rrggbb` 或 `rgb(...)`），⛔ 不返回 three 的 `Color` ——
 *    因为下面画贴图时要按 8 位整数算像素，中间过一道"线性空间"反而容易搞错。
 */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 把当前主题下树语要用的颜色一次性取出来。 */
export function readPalette(): TreePalette {
  const out = {} as TreePalette;
  for (const key of Object.keys(TREE_COLORS) as TreeColorName[]) {
    const [name, fallback] = TREE_COLORS[key];
    out[key] = cssVar(name, fallback);
  }
  return out;
}

/** 只认 `#rgb` / `#rrggbb` / `rgb()` / `rgba()` —— 我们自己的变量都是这几个形式。 */
export function parseCssColor(s: string): [number, number, number] {
  const t = s.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(t);
  if (rgb) return [Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3]))];
  return [128, 128, 128];
}

/** [r,g,b] → `#rrggbb`（画布上用）。 */
const hex = ([r, g, b]: [number, number, number]): string =>
  "#" +
  [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/** 往 `k` 方向调明暗：`k < 1` 变暗、`k > 1` 变亮（1.6 就接近纯白）。 */
export const shade = (c: [number, number, number], k: number): [number, number, number] => [
  c[0] * k + (k > 1 ? (255 - c[0]) * (k - 1) * 0.35 : 0),
  c[1] * k + (k > 1 ? (255 - c[1]) * (k - 1) * 0.35 : 0),
  c[2] * k + (k > 1 ? (255 - c[2]) * (k - 1) * 0.35 : 0),
];

/** 造一张干净的 2D 画布。 */
function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("拿不到 2D 画布上下文");
  return [c, ctx];
}

/**
 * 打一层细噪点。
 *
 * ⭐ 它是"像不像真的"里很便宜的一招：纯色面在高光下会像塑料，
 *    加一点逐像素的明暗扰动，肉眼立刻觉得是"有材质的东西"。
 */
function speckle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  amount: number,
  alpha: number
): void {
  for (let i = 0; i < amount; i += 1) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = Math.random() * 1.6 + 0.3;
    ctx.fillStyle = `rgba(${Math.random() > 0.5 ? 255 : 0},${
      Math.random() > 0.5 ? 255 : 0
    },${Math.random() > 0.5 ? 255 : 0},${alpha * Math.random()})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * 树皮：底色 ＋ **竖向木纹** ＋ 噪点。
 *
 * ⚠️ 竖纹要**沿贴图的 v 方向**（圆柱的轴向）才像树皮 —— 横着就成了竹节。
 *    `makeBranchGeometry()` 那边会把 v 按枝条长度缩放，所以这里只要画竖条，
 *    密度自然会跟着枝条长短走。
 */
export function makeBarkTexture(base: string, dark: string): THREE.CanvasTexture {
  const W = 256;
  const H = 256;
  const [cv, ctx] = canvas2d(W, H);
  const b = parseCssColor(base);
  const d = parseCssColor(dark);

  ctx.fillStyle = hex(b);
  ctx.fillRect(0, 0, W, H);

  // 木纹：一条条竖直的沟，每一根都轻轻扭一下（直线会像百叶窗）。
  const lines = 46;
  for (let i = 0; i < lines; i += 1) {
    const x0 = Math.random() * W;
    const thick = 1 + Math.random() * 4;
    const tone = shade(d, 0.7 + Math.random() * 0.9);
    ctx.strokeStyle = `rgba(${tone[0]},${tone[1]},${tone[2]},${0.25 + Math.random() * 0.5})`;
    ctx.lineWidth = thick;
    ctx.beginPath();
    let x = x0;
    ctx.moveTo(x, -10);
    for (let y = 0; y <= H + 10; y += 16) {
      x += (Math.random() - 0.5) * 5;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 几道横向的浅裂纹，免得整张全是竖的、太规整。
  for (let i = 0; i < 10; i += 1) {
    const y = Math.random() * H;
    ctx.strokeStyle = `rgba(${d[0]},${d[1]},${d[2]},${0.12 + Math.random() * 0.18})`;
    ctx.lineWidth = 0.8 + Math.random();
    ctx.beginPath();
    ctx.moveTo(Math.random() * W * 0.4, y);
    ctx.lineTo(Math.random() * W * 0.4 + W * 0.5, y + (Math.random() - 0.5) * 8);
    ctx.stroke();
  }

  speckle(ctx, W, H, 1400, 0.14);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * 天空：一张**上深下浅的竖直渐变**，直接当 `scene.background` 用。
 *
 * ⭐ three 对"普通贴图"当背景的做法是**铺满整屏**（不是贴在地球上）——
 *    所以这里的渐变**始终冲着屏幕**，相机怎么动它都不歪。
 *    这正是"天空先给纯色渐变底（真天空是第四期）"想要的效果。
 *
 * ⚠️ 画布只有 2 像素宽：渐变只沿竖直方向变，横向 1 像素就够（省内存）。
 */
export function makeSkyTexture(top: string, bottom: string): THREE.CanvasTexture {
  const [cv, ctx] = canvas2d(2, 256);
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(0.62, hex(shade(parseCssColor(bottom), 1.02)));
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 草地：底色 ＋ **淡淡的斑驳**（远处更亮一点，帮着把地平线推远）。
 *
 * ⚠️ 是"很淡"的——A5 要的是"一小片草地"，不是一片花纹地毯。
 */
export function makeGroundTexture(base: string, far: string): THREE.CanvasTexture {
  const S = 512;
  const [cv, ctx] = canvas2d(S, S);
  const b = parseCssColor(base);
  const f = parseCssColor(far);

  ctx.fillStyle = hex(b);
  ctx.fillRect(0, 0, S, S);

  // 一大团一大团的明暗，让地面不是一块死板的色。
  for (let i = 0; i < 90; i += 1) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 24 + Math.random() * 90;
    const tone = shade(Math.random() > 0.45 ? b : f, 0.86 + Math.random() * 0.3);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${tone[0]},${tone[1]},${tone[2]},0.5)`);
    grad.addColorStop(1, `rgba(${tone[0]},${tone[1]},${tone[2]},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 一层很短的小草，只在近处看得出来。
  for (let i = 0; i < 2600; i += 1) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const tone = shade(b, 0.74 + Math.random() * 0.55);
    ctx.strokeStyle = `rgba(${tone[0]},${tone[1]},${tone[2]},${0.18 + Math.random() * 0.35})`;
    ctx.lineWidth = 0.7 + Math.random() * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 3, y - 2 - Math.random() * 5);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
