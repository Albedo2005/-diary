/**
 * 树语 · 舞台 —— 相机 / 光 / 地面 / 雾 / 天空，外加把 `grow.ts` 的骨架变成几何体。
 *
 * 「台子」这个概念来自第一期指令 §四：批次 2 ＝ **台子 ＋ 一棵树**。
 *
 * ⭐ **一条要紧的取景口径（用户 2026-09-30 拍板）**：
 *    「**撑满，而且全屏的时候也要等比例放大**」。
 *    实现方式是**竖直视角固定 ＋ 相机距离固定** —— 于是：
 *    · 窗口变大 ⇒ 视野里的东西**等比变大**（不是变多）；
 *    · 窗口变宽 ⇒ 两边**多露出一些天空和地**（不是把树拉扁）。
 *    ⛔ 所以这里**不许**出现"按宽度算距离"的写法，那会把树拉变形。
 *    ⚠️ 唯一例外是**极端瘦高**的窗口：那时按高度算会让树冠横着出画，
 *       `fit()` 里有一条兜底把相机退远（只影响很窄的窗口，正常画幅走不到）。
 *
 * ── 批次 3 加的两样 ──────────────────────────────────────────────────
 * **花与叶**：`foliage.ts` 算出挂点 ⇒ 叶、花**各一个 `InstancedMesh`**
 *   （一片叶子 ＝ 一个四边形面片，⛔ 不是真叶子模型）。加上枝条那一块，
 *   整棵树一共 **3 次绘制**。
 * **风**：位移在**顶点着色器里算**（`patchWind` 往材质里注入一小段代码），
 *   主线程每帧只更新一个 `uWindTime`。⛔ 不是每帧去改几千份实例矩阵。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { Tree } from "./grow.ts";
import type { Foliage, FoliageInstance } from "./foliage.ts";
import type { TrunkBlock } from "./rings.ts";
import {
  makeBarkTexture,
  makeBlossomTexture,
  makeGroundTexture,
  makeLeafTexture,
  makeSkyTexture,
  readPalette,
  type TreePalette,
} from "./material.ts";

/** 竖直视角。45 是"人眼舒服、又不至于透视太夸张"的常见值。 */
const FOV = 45;
/**
 * A4：树高占画面 75%。
 * ⚠️ 调整轮：**0.75 → 0.82**（用户：「树占比画面不是很大」）。
 *    ⚠️ 但**上不了 0.9** —— 那是 A4 之外还留了"树顶到画面顶"的余量，
 *    贴到边会显得憋；0.82 是"明显更大、又还透气"的位置。
 */
const TREE_FILL = 0.82;
/** 树冠横向要留的边（只在窗口太窄时才会用上，见文件头）。 */
const CROWN_FILL = 0.9;
/** 相机瞄在树的这个高度比例上 —— 取 0.55 是为了让树"**居中、略偏下**"。 */
const AIM_RATIO = 0.55;
/** 相机比瞄准点**低**多少（A3：**微微仰视**）。 */
const RISE_RATIO = 0.1;
/** 地面多大（够铺到雾里就行）。 */
const GROUND_SIZE = 64;

export type TreeStage = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** 画布尺寸变了必须调它 —— ⭐ "全屏时等比例放大"就是靠这里重算投影。 */
  fit(width: number, height: number): void;
  /** 系统深浅主题变了：把贴图与光的颜色整个重做一遍。 */
  applyTheme(): void;
  /**
   * 现在几点（秒）—— **风的唯一输入**。
   * ⚠️ 位移是在**顶点着色器里**按这个时间算的，⛔ 主线程每帧只改这一个数，
   *    不碰任何几何体（碰了几何体就是每帧重传 1600 份矩阵，白烧）。
   */
  setTime(seconds: number): void;
  /** 风的大小（1 ＝ 默认的"轻轻摆"）。第五期做天气时会用到。 */
  setWind(level: number): void;
  /**
   * 第二期：把**树干上的三段年轮块**摆上去（`rings.ts` 算好位置，这里只管画）。
   * ⚠️ 幂等 —— 重复调用会先把上一批拆干净，不会越堆越多。
   */
  setBlocks(blocks: TrunkBlock[]): void;
  /** 现在"开着"哪一块（`null` ＝ 都收着、面板也收着）。⭐ 同时只会有一块是开的。 */
  setBlockActive(index: number | null): void;
  /** 鼠标现在悬在哪一块上（`null` ＝ 没悬停）。 */
  setBlockHover(index: number | null): void;
  /**
   * 屏幕**归一化设备坐标**（NDC：-1~1，画布中心是 0,0，左上角是 -1,+1）
   * → 命中第几块（没命中 ＝ `null`）。
   *
   * ⚠️ NDC 必须用 `getBoundingClientRect()` 换算，⛔ 不用 `canvas.width/height`
   *    （那是**背衬**尺寸，差一个屏密度倍率，第一期在这儿栽过）。
   */
  pickBlock(nx: number, ny: number): number | null;
  /**
   * ⭐ **只给验收用**：把三块薄壳**整体藏起来 / 放出来**。
   *
   * 为什么要开这个口子：`I3`（"多出来的三角形逐个数得上"）是这一套里**最灵的
   * 一把尺子** —— 批次 1 那三圈细环就是被它当场抓出来的（多出 2,304，正好对上）。
   * 这一版把环换成薄壳，"几何算出来是 3×20×2 ＝ 120"只是**推的**；
   * 藏起来再渲染一帧、用差值量一次，才是**量的**。
   * ⚠️ 平时渲染路径**完全不走这里**，只在挂载时量一次。
   */
  setBlocksVisible(visible: boolean): void;
  /**
   * ⭐ **只给验收用**：三块薄壳的**纯几何**三角形数（Σ `index.count / 3`）。
   *
   * ⚠️ 它跟"渲染器账本上的差值"（`|blockTriOn − blockTriOff|`）**必须分开报**：
   *    两个数对不上，就说明有别的东西也被算进去了 —— 那正是要找的线索。
   */
  blockTriangles(): number;
  dispose(): void;
};

/** 枝条越细，圆周上的分段越少（省三角形，肉眼看不出差别）。 */
function radialSegments(depth: number): number {
  if (depth <= 0) return 12;
  if (depth === 1) return 9;
  if (depth === 2) return 7;
  if (depth === 3) return 6;
  return 5;
}

/**
 * 把骨架变成**一整块**几何体。
 *
 * ⭐ 关键是最后那句 `mergeGeometries`：139 根枝条合起来**只画一次**。
 *    ⛔ 每根枝条单独一个 `Mesh` 的话就是 139 次绘制调用 —— 肉眼效果一模一样，
 *    代价却高一个量级。
 */
function buildBranchGeometry(tree: Tree): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const mat = new THREE.Matrix4();

  for (const b of tree.branches) {
    dir.set(b.to.x - b.from.x, b.to.y - b.from.y, b.to.z - b.from.z);
    const len = dir.length();
    if (len < 1e-6) continue;
    dir.normalize();

    // ⚠️ `CylinderGeometry(顶半径, 底半径, 高, …)` —— 参数顺序别写反了。
    //    `openEnded = true`：枝条两端不用封盖，省一半三角形（接缝都藏在树冠里）。
    const seg = new THREE.CylinderGeometry(b.r1, b.r0, len, radialSegments(b.depth), 1, true);

    /*
     * ⭐ 把贴图的 v（沿枝条的方向）按长度拉开：
     *    ⛔ 不这么做的话，每根枝条都会**把自己的树皮纹理从头铺到尾** ——
     *    于是短枝上的木纹被挤成一团、长枝上被拉得很长，一眼就假。
     */
    const uv = seg.getAttribute("uv") as THREE.BufferAttribute;
    const stretch = Math.max(1, len * 9);
    for (let i = 0; i < uv.count; i += 1) uv.setY(i, uv.getY(i) * stretch);
    uv.needsUpdate = true;

    // 圆柱默认沿 +Y、中心在原点 ⇒ 先转到枝条方向，再挪到枝条中点。
    quat.setFromUnitVectors(up, dir);
    mid.set(b.from.x, b.from.y, b.from.z).addScaledVector(dir, len / 2);
    mat.compose(mid, quat, new THREE.Vector3(1, 1, 1));
    seg.applyMatrix4(mat); // ⚠️ 它会连法线一起转，所以之后**不许**再 computeVertexNormals（会把圆柱重新算成一节一节的硬边）

    parts.push(seg);
  }

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error("枝条合并失败（几何体属性对不上）");
  merged.computeBoundingSphere();
  return merged;
}

/** 树冠横向铺开多大 —— 取景时要用（见 `fit`）。 */
function crownWidth(tree: Tree): number {
  let m = 0;
  for (const b of tree.branches) {
    m = Math.max(m, Math.abs(b.to.x), Math.abs(b.to.z));
  }
  return m * 2;
}

// ---------------------------------------------------------------------------
// 风（批次 3）
// ---------------------------------------------------------------------------

/**
 * 风：树梢处的最大摆幅（世界单位）。
 * 树高 2.82、画布宽 785 时约 **129 像素/单位** ⇒ 0.055 ≈ **7 个像素**。
 * ⚠️ 这是指令要的"**轻轻摆**"的量级。想更狠调这里，⛔ 别去改着色器里的频率
 *    （频率改了会从"摆"变成"抖"）。
 */
const WIND_AMPLITUDE = 0.055;

type WindUniforms = {
  time: { value: number };
  strength: { value: number };
  baseY: { value: number };
  treeH: { value: number };
};

/**
 * 顶点位移：**所有的风都在这一段里**。
 *
 * ⭐ 直接替掉 `#include <project_vertex>`（three 里算屏幕坐标就这一段），
 *    于是**普通网格和实例化网格共用同一段代码** —— "实例矩阵要乘在前面"
 *    这类坑只在同一个地方出现一次。
 * ⚠️ `modelMatrix` / `viewMatrix` / `projectionMatrix` 都是 three 注入的内建
 *    uniform，直接用，⛔ 不用自己传。
 * ⚠️ 弯曲量取 `h²`：树根几乎不动、树梢摆得最狠（`h` ＝ 这个点离地多高，0~1）。
 * ⚠️ 主线程每帧只更新 `uWindTime` 一个数 —— 位移是显卡算的（指令明文要求）。
 */
const WIND_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );

#ifdef USE_BATCHING

	mvPosition = batchingMatrix * mvPosition;

#endif

#ifdef USE_INSTANCING

	mvPosition = instanceMatrix * mvPosition;

#endif

vec4 treeWorld = modelMatrix * mvPosition;
float treeH = clamp( ( treeWorld.y - uWindBaseY ) / uWindTreeH, 0.0, 1.0 );
float treeFlex = treeH * treeH;
float treePhase = treeWorld.x * 1.7 + treeWorld.z * 1.15;
float treeGust = 0.66 + 0.34 * sin( uWindTime * 0.29 + 1.1 );
float treeAmp = uWindStrength * treeFlex * treeGust;
treeWorld.x += sin( uWindTime * 1.55 + treePhase ) * treeAmp;
treeWorld.z += sin( uWindTime * 1.19 + treePhase * 0.72 ) * treeAmp * 0.55;
treeWorld.y -= abs( sin( uWindTime * 1.55 + treePhase ) ) * treeAmp * 0.14;
mvPosition = viewMatrix * treeWorld;
gl_Position = projectionMatrix * mvPosition;
`;

/**
 * 把一个材质接到风上。
 *
 * ⚠️⚠️ **`customProgramCacheKey` 这一句不能省** —— three 的着色器缓存键里
 *    **不含 `onBeforeCompile`**（它只看材质自身的参数）。不设的话，两个
 *    "参数看起来一样"的材质会**共用同一个编好的程序** ⇒ 补过风的树皮
 *    和没补过的地面有可能撞成同一个，**整块地跟着树一起摆**。
 *    这是本批最容易踩、而且从现象上看不出原因的一个坑。
 * ⚠️ 风**只补在树皮与花叶上**，地面、台座、天空一律不补。
 */
function patchWind(material: THREE.Material, u: WindUniforms): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = u.time;
    shader.uniforms.uWindStrength = u.strength;
    shader.uniforms.uWindBaseY = u.baseY;
    shader.uniforms.uWindTreeH = u.treeH;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uWindTime;
uniform float uWindStrength;
uniform float uWindBaseY;
uniform float uWindTreeH;`
      )
      .replace("#include <project_vertex>", WIND_PROJECT);
  };
  material.customProgramCacheKey = () => "tree-wind";
  material.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// 花与叶（批次 3）
// ---------------------------------------------------------------------------

/**
 * 把一批挂点变成**一个**实例化网格（1600 片叶子 ＝ **1 次绘制**）。
 *
 * ⚠️ 几何体是**一个四边形**，只是往上挪了半个身子 ⇒ 实例的挂点正好落在
 *    面片的**下沿**（叶柄），叶子于是"从枝条上长出来"，而不是"挂在中点"。
 */
function buildFoliageMesh(
  list: FoliageInstance[],
  material: THREE.Material
): THREE.InstancedMesh | null {
  if (list.length === 0) return null;

  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);

  const mesh = new THREE.InstancedMesh(geo, material, list.length);
  // 整个场景就 5 个物体，视锥剔除省不下什么，关掉反而少一类
  // "东西明明在、就是没画出来"的怪事（合并网格/实例化网格都容易栽在这）。
  mesh.frustumCulled = false;

  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const align = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const m = new THREE.Matrix4();

  list.forEach((it, i) => {
    pos.set(it.pos.x, it.pos.y, it.pos.z);
    dir.set(it.dir.x, it.dir.y, it.dir.z).normalize();
    align.setFromUnitVectors(up, dir);
    spin.setFromAxisAngle(up, it.roll);
    align.multiply(spin); // 先自转（把叶子翻个面），再对齐到"朝外"
    m.compose(pos, align, scale.set(it.size, it.size, it.size));
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/**
 * 给每个实例刷上颜色（深浅不一，清一色一样亮会像塑料叶子）。
 * ⚠️ 单独一个函数：换主题时贴图要重画、**实例颜色也得重算**（都从 CSS 变量来）。
 */
function paintInstances(
  mesh: THREE.InstancedMesh | null,
  list: FoliageInstance[],
  colour: (tone: number) => THREE.Color
): void {
  if (!mesh) return;
  list.forEach((it, i) => mesh.setColorAt(i, colour(it.tone)));
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// 年轮块（第二期 · 修订版：树干上的三段）
// ---------------------------------------------------------------------------

/*
 * ⚠️⚠️ 这一节在 **2026-10-14 17:37 被推翻重写过一版**。
 *
 * 第一版把"点击区"做成了**套在主干上的三圈可见细环**（`TorusGeometry`
 * ＋ 点开原地抽成环带）。用户看完截图当场纠正：
 *   · **点击区是"树干上的一段（一块）"，不是环**；
 *   · **平时画个圈太突兀**；
 *   · 点开之后应当**在侧边弹面板**画"圆环数据图"，⛔ 不是在树上原地展开。
 * ⇒ 可见的环几何（`buildRingTorus` / `buildRingBand`）**整段删掉**，
 *   留下的是"怎么把一段树干淡淡地标出来 ＋ 怎么点得中"。
 *
 * ⭐ 现在的做法：每块一个**贴着树皮的透明薄壳** ——
 *   · 半径 ＝ 该处主干半径 × 1.06（⛔ 不能 ≤ 主干半径，否则陷进树皮里看不见也点不着）；
 *   · 平时**很淡**，鼠标划过 ⇒ 提亮，开着的那块 ⇒ 更亮；
 *   · ⭐ **薄壳自己就是射线热区** —— 不再需要第一版那种"看不见的粗圆柱"
 *     （那时是因为细环太细、点不中；现在薄壳整段包住树干，点哪都中）；
 *   · ⚠️ 颜色一律从 CSS 变量取（换主题时 `applyTheme()` 会重读重刷）。
 */

/**
 * 三种状态下的透明度。
 * ⭐ 薄壳"看不看得见"**只靠这个数**（⛔ 不靠描边、不靠画圈）——
 *    用户要的正是"够看得见、又不突兀"，所以这组数是这一版最要紧的参数。
 * ⚠️ 调大之前想清楚：批次 1 的"突兀"就是这么来的。
 */
const BLOCK_OPACITY = { idle: 0.13, hover: 0.3, active: 0.36 } as const;

/** 薄壳颜色取哪几个 CSS 变量（⛔ 不新增变量 —— 复用树语那一套）。 */
const BLOCK_VARS = {
  /** 平时 / 悬停 —— 用花的浅黄（两种主题下树皮都是棕色，浅黄压上去对比明显）。 */
  shell: "--tree-blossom",
  /** "开着"那一块 —— 直射光的暖白，显得更"被选中"。 */
  active: "--tree-sun",
} as const;

/** CSS 变量取不到时的兜底色（⛔ 不许让空串进 three）。 */
const BLOCK_FALLBACK = { shell: "#ffe9a3", active: "#fff3e0" } as const;

/** 从 CSS 变量读一个颜色；读不到就用兜底。 */
function readCss(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * ⭐「年轮纹理」：一张极简的**横向条纹**贴图，贴在薄壳上当"纹路"。
 *
 * 为什么不用纯色：用户拍板的是"**保留一点极淡的年轮纹理**"——
 * 纯色只是一层均匀的色雾（像罩了个塑料袋），有几道横线才像**树的年轮**。
 * ⚠️ 贴图**现场生成**（跟树皮 / 叶子那些一个路子），⛔ 不引图片资源。
 * ⚠️ 只画 **4 像素宽**（沿周长重复，看不出接缝），高 64 ——
 *    上下各一道实线（＝ 相邻两块的**分界线**，让人一眼看出"是三段"），中间两道浅线。
 */
function makeBlockTexture(): THREE.CanvasTexture {
  const h = 64;
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 4, h);
    // 底色：一层"看得见但不抢眼"的淡色（透明度最终还要乘 `BLOCK_OPACITY`）
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(0, 0, 4, h);
    // 几道更亮的横线 ＝ 年轮（0/1 与 h-2/h-1 是**块的边界**）
    ctx.fillStyle = "rgba(255,255,255,1)";
    for (const y of [0, 1, 21, 42, h - 2, h - 1]) ctx.fillRect(0, y, 4, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 一块的**薄壳**几何：贴着树干的一段**锥台**（跟主干一样上细下粗），只是外扩一点点。
 *
 * ⚠️ `CylinderGeometry(顶半径, 底半径, 高, …)` —— 参数顺序别写反（主干那边也栽过）。
 * ⚠️ `openEnded = true`：不用封盖 —— 壳里面还包着树干，封了也看不见，白费一半三角形。
 * ⚠️ 默认 UV 的 v 从底（0）到顶（1）⇒ 那张条纹贴图**竖着铺正好**（上下各一道边界线）。
 */
function buildBlockShell(b: TrunkBlock): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(b.rTop, b.rBase, b.length, 20, 1, true);
}

/**
 * 搭台子。
 *
 * @param tree    已经长好的骨架（`grow.ts` 的输出）
 * @param foliage 已经算好的花叶挂点（`foliage.ts` 的输出）
 */
export function makeStage(tree: Tree, foliage: Foliage): TreeStage {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 400);

  // 排好队，卸载时按顺序全部释放 —— 切来切去不释放会一直往显卡里堆东西。
  const trash: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    trash.push(x);
    return x;
  };

  let palette: TreePalette = readPalette();

  // ── 天空：一张竖直渐变图，直接当背景铺满整屏 ──────────────────────
  let skyTex = keep(makeSkyTexture(palette.skyTop, palette.skyBottom));
  scene.background = skyTex;

  // ── 雾：很淡一层，把远处的地和天"接"上（指令 §四-1） ────────────
  // 雾色取地平线那个色（天空最下面一档），远方才不会突然"断开"。
  const fog = new THREE.Fog(palette.skyBottom, 6, 30);
  scene.fog = fog;

  // ── 光 ──────────────────────────────────────────────────────────
  // 天光（半球光）：上来自天空、下反射自地面 ⇒ 树荫里不会是死黑。
  // ⚠️ `THREE.Color` 收字符串时**默认按 sRGB 解释** —— 所以直接喂 CSS 变量即可，
  //    ⛔ 不需要自己拆成 0~1 再 setRGB（那样反而容易把色彩空间搞错）。
  const hemi = keep(new THREE.HemisphereLight(palette.skyTop, palette.ground, 1.5));
  scene.add(hemi);
  // 那束**带阴影**的直射光（D2 拍板要开）。位置在树的左上前方。
  const sun = keep(new THREE.DirectionalLight(palette.sun, 2.3));
  sun.position.set(3.4, 5.6, 3.0);
  sun.target.position.set(0, tree.height * 0.45, 0);
  scene.add(sun);
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // ⚠️ 平行光的阴影相机是**正交**的，范围写小了树影会被裁掉、写大了精度不够。
  //    这里按树的高度给，留一倍余量。
  const sc = sun.shadow.camera;
  sc.left = -tree.height * 0.9;
  sc.right = tree.height * 0.9;
  sc.top = tree.height * 0.9;
  sc.bottom = -tree.height * 0.9;
  sc.near = 0.5;
  sc.far = 20;
  sc.updateProjectionMatrix();
  // 一点点偏移，治"自阴影"在树皮上留下的条纹状噪点。
  sun.shadow.bias = -0.0009;
  sun.shadow.normalBias = 0.02;

  // ── 地面 ────────────────────────────────────────────────────────
  const groundTex = keep(makeGroundTexture(palette.ground, palette.groundFar));
  groundTex.repeat.set(14, 14);
  const groundMat = keep(
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, metalness: 0 })
  );
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  keep(ground.geometry);

  /* ── 树下那圈很淡的圆台 ──────────────────────────────────────────
   * A5：照视频里那个底座。
   * ⚠️ 调整轮：**更含蓄**（用户："树下那圈圆台改成跟地面同色系、更含蓄一点"）。
   *    原来 0.045 高、颜色 `--tree-disc` 比草地明显深一档 ⇒ 像扣了个盘子。
   *    现在压到 **0.026**（几乎贴地）、颜色交给 CSS 里往草地靠。
   */
  const discMat = keep(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.disc),
      roughness: 0.95,
      metalness: 0,
    })
  );
  const discR = Math.max(crownWidth(tree) * 0.62, tree.height * 0.32);
  const discGeo = keep(new THREE.CylinderGeometry(discR * 0.985, discR, 0.026, 64));
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.position.y = 0.013;
  disc.receiveShadow = true;
  disc.castShadow = false;
  scene.add(disc);

  // ── 树 ──────────────────────────────────────────────────────────
  const barkTex = keep(makeBarkTexture(palette.bark, palette.barkDark));
  const barkMat = keep(
    new THREE.MeshStandardMaterial({ map: barkTex, roughness: 0.92, metalness: 0 })
  );
  const treeGeo = keep(buildBranchGeometry(tree));
  const trunk = new THREE.Mesh(treeGeo, barkMat);
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  scene.add(trunk);

  // ── 花与叶（批次 3 · B 段） ─────────────────────────────────────
  /*
   * ⚠️ 两张贴图的"深色配角"都取 `barkDark`：那是这一套自然色里唯一的深色，
   *    用来画叶脉和花心刚好（⛔ 别写死一个色号，换主题时会露馅）。
   */
  let leafTex = keep(makeLeafTexture(palette.foliage, palette.barkDark));
  const leafMat = keep(
    new THREE.MeshStandardMaterial({
      map: leafTex,
      roughness: 0.9,
      metalness: 0,
      // ⚠️ 叶子是**面片**：法线朝哪边都不该变黑，所以必须双面。
      side: THREE.DoubleSide,
      /*
       * ⭐ 靠 `alphaTest` 把贴图里透明的地方**整个切掉**（不是半透明混合）：
       *    叶缘干净、不用管前后排序，而且**还能投出带镂空的影子**
       *    （three 的阴影深度材质会自动继承 map ＋ alphaTest）。
       */
      alphaTest: 0.4,
    })
  );
  let blossomTex = keep(makeBlossomTexture(palette.blossom, palette.barkDark));
  const blossomMat = keep(
    new THREE.MeshStandardMaterial({
      map: blossomTex,
      roughness: 0.75,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: 0.4,
    })
  );

  // 深/浅两档实例颜色：`tone` 在它们之间插值 ⇒ 花叶有层次。
  const leafLo = new THREE.Color();
  const leafHi = new THREE.Color();
  const bloomLo = new THREE.Color();
  const bloomHi = new THREE.Color();
  const scratch = new THREE.Color();
  function readFoliageColours(): void {
    leafLo.set(palette.foliage).offsetHSL(0, 0.05, -0.13);
    leafHi.set(palette.foliage).offsetHSL(0, 0.02, 0.19);
    /*
     * ⚠️ 调整轮：花的**两档差距拉开**（用户："对比度拉开"）。
     *    原来 −0.10 / +0.17 —— 同一簇里明暗只差 0.27，远看是一块平的色块。
     *    现在 −0.16 / +0.22 ⇒ 一簇里自己就有明暗层次，加上花本身已经近白，
     *    和叶子的金黄在**亮度 ＋ 饱和度**两处同时分开。
     */
    bloomLo.set(palette.blossom).offsetHSL(0, 0.04, -0.16);
    bloomHi.set(palette.blossom).offsetHSL(0, 0.01, 0.22);
  }
  const leafColour = (t: number): THREE.Color => scratch.copy(leafLo).lerp(leafHi, t);
  const bloomColour = (t: number): THREE.Color => scratch.copy(bloomLo).lerp(bloomHi, t);

  const leafMesh = buildFoliageMesh(foliage.leaves, leafMat);
  if (leafMesh) {
    // ⭐ 叶子投影：几何上是一片片四边形的影子 —— 地面上于是有"树影里有光斑"的层次。
    leafMesh.castShadow = true;
    scene.add(leafMesh);
    keep(leafMesh.geometry);
    keep(leafMesh);
  }
  const blossomMesh = buildFoliageMesh(foliage.blossoms, blossomMat);
  if (blossomMesh) {
    // ⚠️ 花簇**不投影**：一簇才 9 个像素，投出来只是一层脏兮兮的噪点，
    //    却要多跑一遍阴影。等第五期真要做"花瓣落下"再说。
    blossomMesh.castShadow = false;
    scene.add(blossomMesh);
    keep(blossomMesh.geometry);
    keep(blossomMesh);
  }

  // ── 风 ──────────────────────────────────────────────────────────
  /*
   * ⚠️ 只补树皮与花叶三块材质 —— 地面、台座、天空都**不进风**。
   *    靠 `patchWind` 里的 `customProgramCacheKey` 把它们隔开（那里有说明）。
   */
  const wind: WindUniforms = {
    time: { value: 0 },
    strength: { value: WIND_AMPLITUDE },
    // 树根大约在 y＝0（`growTree` 把主干起点放在 −0.02）⇒ 弯曲量从地面算起。
    baseY: { value: 0 },
    treeH: { value: Math.max(0.5, tree.height) },
  };
  patchWind(barkMat, wind);
  patchWind(leafMat, wind);
  patchWind(blossomMat, wind);

  // ── 年轮块（第二期 · 修订版：树干上的三段） ──────────────────────
  /*
   * ⭐ 口径（用户 2026-10-14 两次拍板）：
   *   · 点击区是**树干上的一段（一块）**，⛔ 不是环（第一版做错的就是这件）；
   *   · 三块**上下排开、一样高、首尾相接**，位置由 `rings.ts` 纯函数算；
   *   · 平时只是**极淡的一层薄壳 ＋ 几道年轮线**（"看得见但不突兀"）；
   *   · 鼠标划过 ⇒ 那一块**提亮**；点一下 ⇒ 提亮更明显，并**弹侧边面板**；
   *   · 同时**只开一块**；再点同一块收回；点树干别处 / 空白 ⇒ 收回。
   *
   * ⭐ **薄壳自己就是射线热区** —— 不再需要第一版那种"看不见的粗圆柱"：
   *    那时是因为细环太细、点不中；现在薄壳整段包住树干，点哪都中。
   * ⚠️ 但仍然**只把这三块拿去 `intersectObjects`**，⛔ 不翻全场景。
   */
  const blockGroup = new THREE.Group();
  scene.add(blockGroup);

  let blockActive: number | null = null;
  let blockHover: number | null = null;
  /*
   * ⚠️ 颜色**读一次、缓存住** —— `getComputedStyle` 会强制一次样式计算，
   *    挂在 `pointermove`（每动一下就查一次）上会明显卡。
   *    换主题时由 `applyTheme()` 重读一遍。
   */
  let blockColours = { shell: new THREE.Color(), active: new THREE.Color() };
  const blockMats: THREE.MeshBasicMaterial[] = [];
  const blockMeshes: THREE.Mesh[] = [];
  const blockGeos: THREE.BufferGeometry[] = [];
  let blockTex: THREE.Texture | null = null;

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const blockAxisUp = new THREE.Vector3(0, 1, 0);
  const blockNormal = new THREE.Vector3();

  function readBlockColours(): void {
    blockColours = {
      shell: new THREE.Color(readCss(BLOCK_VARS.shell, BLOCK_FALLBACK.shell)),
      active: new THREE.Color(readCss(BLOCK_VARS.active, BLOCK_FALLBACK.active)),
    };
  }

  /** 按"开没开、悬没悬"把三块的样子刷一遍（只改颜色与透明度，⛔ 不重建几何）。 */
  function refreshBlockLook(): void {
    blockMats.forEach((mat, i) => {
      const on = blockActive === i;
      mat.opacity = on
        ? BLOCK_OPACITY.active
        : blockHover === i
          ? BLOCK_OPACITY.hover
          : BLOCK_OPACITY.idle;
      mat.color.copy(on ? blockColours.active : blockColours.shell);
    });
  }

  function setBlocks(next: TrunkBlock[]): void {
    // ① 先把上一批拆干净（幂等 —— 重复调用不会越堆越多）
    for (const m of blockMeshes) blockGroup.remove(m);
    blockMeshes.length = 0;
    blockMats.length = 0;
    for (const g of blockGeos) g.dispose();
    blockGeos.length = 0;
    blockTex?.dispose();
    blockTex = null;

    blockActive = null;
    blockHover = null;
    if (next.length === 0) return;

    readBlockColours();
    // 一张条纹贴图**三块共用**（每块各自乘自己的颜色与透明度）
    blockTex = keep(makeBlockTexture());

    next.forEach((b) => {
      const geo = keep(buildBlockShell(b));
      const mat = keep(
        new THREE.MeshBasicMaterial({
          color: blockColours.shell.clone(),
          map: blockTex,
          transparent: true,
          opacity: BLOCK_OPACITY.idle,
          /*
           * ⚠️ 透明薄壳**不写深度** —— 否则它会把后面那半圈树干挡掉，
           *    看着就变成一圈"实心"的箍（第一版那个"突兀"有一部分就是这么来的）。
           */
          depthWrite: false,
          side: THREE.DoubleSide,
          /*
           * ⚠️⚠️ **必须显式关掉"双面 ＋ 透明"的两遍渲染** —— 这是本批最值一提的坑。
           *
           * three.js 对**双面且透明**的材质默认画**两遍**（先背面、再正面，用来缓解
           * 透明混色的顺序问题）。原文见 `node_modules/three/build/three.core.js`：
           *   "The engine renders double-sided, transparent objects with **two draw calls**
           *    (back faces first, then front faces)... set the `forceSinglePass` flag to
           *    `true` to disable the two pass rendering to avoid performance issues."
           *
           * ⇒ 三块薄壳因此变成 **6 次绘制 / 240 个三角形**（本该 3 次 / 120 个）。
           * ⭐ 是 `I3`（三角形逐个数得上）把这笔账抓出来的：几何算 120、账本上多 240，
           *    而 `drawCalls` 只多 6 ⇒ 一块两次。**先量出来、再去源码里找为什么**，
           *    ⛔ 绝不是把常数从 120 改成 240 了事（那就成了"数字全绿、东西不对"）。
           *
           * 这里关掉是**纯赚**：薄壳是套在树干外面的一层极淡的壳（透明度 0.13），
           * 背／正面的先后对混色结果没有可见影响，却白烧一倍绘制。
           */
          forceSinglePass: true,
        })
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(b.center.x, b.center.y, b.center.z);
      blockNormal.set(b.normal.x, b.normal.y, b.normal.z);
      mesh.quaternion.setFromUnitVectors(blockAxisUp, blockNormal);
      /*
       * ⚠️ **明确写死两件事**（都不靠默认值 —— 默认值改一次就悄悄失效）：
       *   · `castShadow = false`：薄壳是**装饰性**的（透明度 0.13），
       *     投影只会在树干／地面上压出一道谁也说不清的暗带；
       *   · `receiveShadow = false`：它自己也不需要接阴影。
       * ⚠️ 实测这两条**不是**"三块被画两遍"的原因（写死之后依然是 6 次绘制）——
       *    真凶是材质那边"双面 ＋ 透明"的两遍渲染，见下面 `forceSinglePass` 那段。
       *    留着它们是因为**本来就该这么写**，⛔ 不因为"改了也没用"就删掉。
       */
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // 整个场景就几个物体，关掉视锥剔除少一类"明明在、就是没画出来"的怪事
      mesh.frustumCulled = false;
      blockGroup.add(mesh);
      blockMeshes.push(mesh);
      blockMats.push(mat);
      blockGeos.push(geo);
    });

    refreshBlockLook();
  }

  function setBlockActive(index: number | null): void {
    blockActive = index;
    refreshBlockLook();
  }

  function setBlockHover(index: number | null): void {
    if (blockHover === index) return; // 没变就不刷（`pointermove` 触发得很密）
    blockHover = index;
    refreshBlockLook();
  }

  function pickBlock(nx: number, ny: number): number | null {
    if (blockMeshes.length === 0) return null;
    /*
     * ⚠️ 拾取前把世界矩阵刷到最新 —— 否则"刚摆好块、还没画第一帧"就去点，
     *    矩阵还是上一次的，会整片点空。
     */
    camera.updateMatrixWorld();
    for (const m of blockMeshes) m.updateWorldMatrix(true, false);
    ndc.set(nx, ny);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(blockMeshes, false);
    if (hits.length === 0) return null;
    const idx = blockMeshes.indexOf(hits[0].object as THREE.Mesh);
    return idx >= 0 ? idx : null;
  }

  // ── 取景 ────────────────────────────────────────────────────────
  const aimY = tree.height * AIM_RATIO;
  const crown = crownWidth(tree);
  const halfFovTan = Math.tan((FOV * Math.PI) / 180 / 2);

  function applyTheme(): void {
    palette = readPalette();

    // 天空：换一张新图，把旧图丢掉。
    const nextSky = makeSkyTexture(palette.skyTop, palette.skyBottom);
    trash.push(nextSky);
    scene.background = nextSky;
    skyTex.dispose();
    skyTex = nextSky;

    hemi.color.set(palette.skyTop);
    hemi.groundColor.set(palette.ground);
    sun.color.set(palette.sun);

    const horizon = palette.skyBottom;
    fog.color.set(horizon);

    // 贴图重画（颜色变了），材质本身不用换。
    const nextGround = makeGroundTexture(palette.ground, palette.groundFar);
    nextGround.repeat.set(14, 14);
    trash.push(nextGround);
    groundMat.map?.dispose();
    groundMat.map = nextGround;
    groundMat.needsUpdate = true;

    const nextBark = makeBarkTexture(palette.bark, palette.barkDark);
    trash.push(nextBark);
    barkMat.map?.dispose();
    barkMat.map = nextBark;
    barkMat.needsUpdate = true;

    // 花与叶：贴图重画 ＋ **实例颜色也重算**（颜色全从 CSS 变量来，换主题就得一起换）。
    const nextLeaf = makeLeafTexture(palette.foliage, palette.barkDark);
    trash.push(nextLeaf);
    leafMat.map?.dispose();
    leafMat.map = nextLeaf;
    leafMat.needsUpdate = true;

    const nextBlossom = makeBlossomTexture(palette.blossom, palette.barkDark);
    trash.push(nextBlossom);
    blossomMat.map?.dispose();
    blossomMat.map = nextBlossom;
    blossomMat.needsUpdate = true;

    readFoliageColours();
    paintInstances(leafMesh, foliage.leaves, leafColour);
    paintInstances(blossomMesh, foliage.blossoms, bloomColour);

    const dc = palette.disc;
    discMat.color.set(dc);

    // 年轮块：颜色也全从 CSS 变量来 ⇒ 换主题要重读一遍并重刷（⛔ 不重建几何）。
    if (blockMeshes.length > 0) {
      readBlockColours();
      refreshBlockLook();
    }
  }
  applyTheme();

  function fit(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    camera.aspect = w / h;

    // 竖直方向：让树高占到画面 TREE_FILL。
    const distV = tree.height / TREE_FILL / 2 / halfFovTan;
    // 横向兜底：只有窗口"比树冠还窄"时才会比 distV 大（见文件头那条）。
    const distH = crown / CROWN_FILL / 2 / (halfFovTan * camera.aspect);
    const dist = Math.max(distV, distH);

    // ⚠️ 相机比瞄准点低一点点 ⇒ **微微仰视**（A3）；距离只由上面算出来，不掺宽度。
    camera.position.set(0, aimY - tree.height * RISE_RATIO, dist);
    camera.lookAt(0, aimY, 0);
    camera.updateProjectionMatrix();
  }

  function dispose(): void {
    scene.clear();
    for (const item of trash) {
      try {
        item.dispose();
      } catch {
        /* 已经放过了 */
      }
    }
    trash.length = 0;
  }

  function setTime(seconds: number): void {
    wind.time.value = seconds;
  }

  function setWind(level: number): void {
    wind.strength.value = WIND_AMPLITUDE * level;
  }

  /** ⭐ 只给验收用 —— 见 `TreeStage` 上的说明。平时渲染路径不走这里。 */
  function setBlocksVisible(visible: boolean): void {
    blockGroup.visible = visible;
  }

  /** ⭐ 只给验收用 —— 三块薄壳的**纯几何**三角形数（量出来的，不是写死的）。 */
  function blockTriangles(): number {
    let n = 0;
    for (const g of blockGeos) {
      n += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
    return n;
  }

  return {
    scene,
    camera,
    fit,
    applyTheme,
    setTime,
    setWind,
    setBlocks,
    setBlockActive,
    setBlockHover,
    pickBlock,
    setBlocksVisible,
    blockTriangles,
    dispose,
  };
}
