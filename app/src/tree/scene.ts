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
import {
  RING_BAND_INNER,
  RING_BAND_OUTER,
  RING_PICK_HEIGHT_RATIO,
  RING_PICK_RADIUS,
  RING_TUBE_RATIO,
  type Ring,
} from "./rings.ts";
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
   * 第二期：把年轮环摆到主干上（`rings.ts` 算好位置，这里只管画）。
   * ⚠️ 幂等 —— 重复调用会先把上一批拆干净，不会越堆越多。
   */
  setRings(rings: Ring[]): void;
  /** 展开某一圈（`null` ＝ 全收回）。⭐ 同时只会有一圈是开的。 */
  setRingOpen(index: number | null): void;
  /** 鼠标现在悬在哪一圈上（`null` ＝ 没悬停）。 */
  setRingHover(index: number | null): void;
  /**
   * 屏幕**归一化设备坐标**（NDC：-1~1，画布中心是 0,0，左上角是 -1,+1）
   * → 命中第几圈（没命中 ＝ `null`）。
   *
   * ⚠️ NDC 必须用 `getBoundingClientRect()` 换算，⛔ 不用 `canvas.width/height`
   *    （那是**背衬**尺寸，差一个屏密度倍率，第一期在这儿栽过）。
   */
  pickRing(nx: number, ny: number): number | null;
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
// 年轮环（第二期 · 批次 1）
// ---------------------------------------------------------------------------

/*
 * ⚠️ 环的颜色**复用已有的树色变量，不新增 CSS 变量** ——
 *    这一批只许动 4 个文件（`rings.ts` / `rings.test.ts` / `scene.ts` / `TreePane.vue`），
 *    `styles/global.css` 不在名单里。
 *
 * ⚠️⚠️ **第一次跑完截图之后改过一版**：原来平时态用的是 `--tree-bark-dark`
 *    （"比树皮深一档"，看着最含蓄）—— 结果**在深色主题下整个看不见**：
 *    树干本身就差不多是这个色，细环（管径不到 2 像素）压上去等于没画。
 *    而用户定过"界面上不写解释性小字"⇒ **唯一的提示就只剩"看得见"**，
 *    看不见 ＝ 这个功能等于不存在。
 *    ⇒ 改成用**浅黄**（跟花同色系）：两种主题下树皮都是棕色，
 *      浅黄压上去对比明显，但因为是"细箍"所以并不抢眼。
 */
const RING_VARS = {
  /** 平时那一圈细环 —— ⭐ 必须跟树皮**明显不同色**，否则等于没画（见上）。 */
  ring: "--tree-blossom",
  /** 悬停 / 展开时的细环（"亮起来"）—— 接近白的暖白，跟浅黄能分辨。 */
  hot: "--tree-sun",
  /** 展开环带里"没写过"的格子（暗底）。 */
  dim: "--tree-bark-dark",
  /** 展开环带里"写过"的格子（批次 2 接上数据才会用上）。 */
  lit: "--tree-blossom",
} as const;

/** CSS 变量取不到时的兜底色（⛔ 不许让 undefined 进 three）。 */
const RING_FALLBACK = {
  ring: "#ffe9a3",
  hot: "#fff3e0",
  dim: "#4f4235",
  lit: "#ffe9a3",
} as const;

/** 从 CSS 变量读一个颜色；读不到就用兜底。 */
function readCss(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 平时态：一圈**细环**（像一道箍贴在树皮上）。
 * ⚠️ 圆环默认躺在 XY 平面（法线 +Z）⇒ 这里先转成**法线 +Y**，
 *    好让细环与环带**共用同一套朝向口径**（都按 "+Y → 主干方向" 摆）。
 */
function buildRingTorus(radius: number): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(radius, radius * RING_TUBE_RATIO, 6, 64);
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * 展开态：一圈**扁环带**，按那个月的天数切成 `cells` 格。
 *
 * ⭐ 每格的**顶点色**写进 color 属性 ⇒ 批次 2 只要改颜色就能"点亮某几天"。
 * ⚠️ 整条环带**合成一个几何体**（`cells` 格 × 2 三角形）——
 *    ⛔ 不是一格一个 `Mesh`（31 格 × 3 圈 ＝ 93 次绘制，老规矩：合并）。
 * ⚠️ 格与格之间留一道角向的缝，否则 30 格连成一圈、看不出"一格一格"。
 */
function buildRingBand(cells: number, inner: number, outer: number): THREE.BufferGeometry {
  const n = Math.max(1, Math.round(cells));
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const step = (Math.PI * 2) / n;
  const gap = step * 0.16;

  for (let i = 0; i < n; i += 1) {
    const a0 = i * step + gap / 2;
    const a1 = (i + 1) * step - gap / 2;
    const quad: [number, number, number][] = [
      [Math.cos(a0) * inner, 0, Math.sin(a0) * inner],
      [Math.cos(a0) * outer, 0, Math.sin(a0) * outer],
      [Math.cos(a1) * outer, 0, Math.sin(a1) * outer],
      [Math.cos(a1) * inner, 0, Math.sin(a1) * inner],
    ];
    // 两个三角形 ＝ 一格（顶点顺序 0-1-2 / 0-2-3）
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const p = quad[idx];
      pos.push(p[0], p[1], p[2]);
      nor.push(0, 1, 0);
      col.push(1, 1, 1); // 先全白，随后由 `paintBand` 按格刷成实际颜色
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
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

  // ── 年轮环（第二期 · 批次 1） ────────────────────────────────────
  /*
   * ⭐ 口径（用户 2026-10-14 拍板）：
   *   · 三圈**上下排开、一样大**，都套在主干上（位置由 `rings.ts` 纯函数算）；
   *   · 平时是**三圈细环**（"看得见但含蓄" —— 界面上不写解释性小字，
   *     唯一的提示就只剩"看得见"）；
   *   · 点一下 ⇒ 那一圈**原地扩成一圈扁环带**（外径 2 倍），格数 ＝ 当月天数；
   *   · 同时**只开一圈**；再点收回；点空白收回；点树干不反应。
   *
   * ⚠️ **拾取不用细环本身**（太细，点不中），而是每圈配一个**看不见的粗圆柱**
   *    当热区。这些圆柱只放进 `pickers` 这一个数组里单独检测，
   *    ⛔ 不去 `intersectObjects(scene.children, true)` 翻全场景。
   * ⚠️ 圆柱用的是**材质级** `visible = false`（对象本身仍是 visible）——
   *    这样它不参与渲染，但射线照样打得中，不依赖 `Raycaster` 对 `visible` 的处理。
   */
  const ringGroup = new THREE.Group();
  scene.add(ringGroup);

  let rings: Ring[] = [];
  let ringOpen: number | null = null;
  let ringHover: number | null = null;
  /** 每个环"哪几格亮着"。批次 1 全暗；批次 2 接上数据后才会有点亮的。 */
  let ringLit: boolean[][] = [];
  /*
   * ⚠️ 颜色**读一次、缓存住** —— `getComputedStyle` 会强制一次样式计算，
   *    挂在 `pointermove`（每动一下就查一次）上会明显卡。
   *    换主题时由 `applyTheme()` 重读一遍。
   */
  let ringColours = {
    ring: new THREE.Color(),
    hot: new THREE.Color(),
    dim: new THREE.Color(),
    lit: new THREE.Color(),
  };
  const ringMats: THREE.MeshBasicMaterial[] = [];
  const torusMeshes: THREE.Mesh[] = [];
  const bandMeshes: THREE.Mesh[] = [];
  const pickers: THREE.Mesh[] = [];
  const bandGeos: THREE.BufferGeometry[] = [];
  let torusGeo: THREE.BufferGeometry | null = null;
  let pickGeo: THREE.BufferGeometry | null = null;

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ringAxisUp = new THREE.Vector3(0, 1, 0);
  const ringNormal = new THREE.Vector3();
  /** 纯草稿纸（算热区高度用）—— ⛔ 别拿 `ringNormal` 凑合。 */
  const ringScratch = new THREE.Vector3();

  function readRingColours(): void {
    ringColours = {
      ring: new THREE.Color(readCss(RING_VARS.ring, RING_FALLBACK.ring)),
      hot: new THREE.Color(readCss(RING_VARS.hot, RING_FALLBACK.hot)),
      dim: new THREE.Color(readCss(RING_VARS.dim, RING_FALLBACK.dim)),
      lit: new THREE.Color(readCss(RING_VARS.lit, RING_FALLBACK.lit)),
    };
  }

  /** 把"哪几格亮着"刷进顶点颜色。 */
  function paintBand(geo: THREE.BufferGeometry, lit: boolean[]): void {
    const attr = geo.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const cells = Math.floor(attr.count / 6);
    for (let i = 0; i < cells; i += 1) {
      const c = lit[i] === true ? ringColours.lit : ringColours.dim;
      for (let k = 0; k < 6; k += 1) attr.setXYZ(i * 6 + k, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  }

  /** 按"开没开、悬没悬"把三圈的样子刷一遍。 */
  function refreshRingLook(): void {
    rings.forEach((_, i) => {
      const mat = ringMats[i];
      if (mat) {
        const active = ringOpen === i || ringHover === i;
        mat.color.copy(active ? ringColours.hot : ringColours.ring);
      }
      const band = bandMeshes[i];
      if (band) band.visible = ringOpen === i;
    });
  }

  function setRings(next: Ring[]): void {
    // ① 先把上一批拆干净（幂等 —— 重复调用不会越堆越多）
    for (const m of torusMeshes) ringGroup.remove(m);
    for (const m of bandMeshes) ringGroup.remove(m);
    for (const m of pickers) ringGroup.remove(m);
    torusMeshes.length = 0;
    bandMeshes.length = 0;
    pickers.length = 0;
    ringMats.length = 0;
    for (const g of bandGeos) g.dispose();
    bandGeos.length = 0;
    torusGeo?.dispose();
    pickGeo?.dispose();
    torusGeo = null;
    pickGeo = null;

    rings = next;
    ringOpen = null;
    ringHover = null;
    ringLit = next.map((r) => new Array<boolean>(Math.max(1, r.days)).fill(false));
    if (next.length === 0) return;

    readRingColours();

    const radius = next[0].radius;
    torusGeo = keep(buildRingTorus(radius));

    // ② 平时态：三圈细环。⭐ 三圈**共用同一个几何体**（半径一样）。
    next.forEach((r) => {
      const mat = keep(new THREE.MeshBasicMaterial({ color: ringColours.ring.clone() }));
      const mesh = new THREE.Mesh(torusGeo as THREE.BufferGeometry, mat);
      mesh.position.set(r.center.x, r.center.y, r.center.z);
      ringNormal.set(r.normal.x, r.normal.y, r.normal.z);
      mesh.quaternion.setFromUnitVectors(ringAxisUp, ringNormal);
      // 整个场景就几个物体，关掉视锥剔除少一类"明明在、就是没画出来"的怪事
      mesh.frustumCulled = false;
      ringGroup.add(mesh);
      ringMats.push(mat);
      torusMeshes.push(mesh);
    });

    // ③ 展开态：一圈扁环带（每格一个色块）—— 平时先藏着
    next.forEach((r, i) => {
      const geo = keep(buildRingBand(r.days, radius * RING_BAND_INNER, radius * RING_BAND_OUTER));
      const mat = keep(
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(torusMeshes[i].position);
      mesh.quaternion.copy(torusMeshes[i].quaternion);
      mesh.frustumCulled = false;
      mesh.visible = false;
      ringGroup.add(mesh);
      bandGeos.push(geo);
      bandMeshes.push(mesh);
      paintBand(geo, ringLit[i]);
    });

    // ④ 热区：一个**看不见的粗圆柱**（环本身太细，直接当热区会点空）
    const pickR = radius * RING_PICK_RADIUS;
    /*
     * 热区**高度** ＝ 相邻两圈的间距 × 0.88。
     * ⚠️ 必须 < 1 —— 到 1 时上下两个热区正好贴上，再大就会重叠
     *    （现象：点哪一圈都开同一圈）。
     * ⚠️ 用**独立的**临时向量算距离，⛔ 别借用 `ringNormal` —— 那个后面还有人读，
     *    借来当草稿纸的话，下次改的人会以为它还是法线。
     */
    const gap =
      next.length > 1
        ? ringScratch
            .set(
              next[1].center.x - next[0].center.x,
              next[1].center.y - next[0].center.y,
              next[1].center.z - next[0].center.z
            )
            .length()
        : radius * 2;
    pickGeo = keep(
      new THREE.CylinderGeometry(pickR, pickR, gap * RING_PICK_HEIGHT_RATIO, 16, 1, true)
    );
    // ⚠️ 材质级 `visible = false`：不渲染，但射线照样打得中（对象本身仍是 visible）。
    const pickMat = keep(new THREE.MeshBasicMaterial({ visible: false }));
    next.forEach((_, i) => {
      const pick = new THREE.Mesh(pickGeo as THREE.BufferGeometry, pickMat);
      pick.position.copy(torusMeshes[i].position);
      pick.quaternion.copy(torusMeshes[i].quaternion);
      pick.frustumCulled = false;
      ringGroup.add(pick);
      pickers.push(pick);
    });

    refreshRingLook();
  }

  function setRingOpen(index: number | null): void {
    ringOpen = index;
    refreshRingLook();
  }

  function setRingHover(index: number | null): void {
    if (ringHover === index) return; // 没变就不刷（`pointermove` 触发得很密）
    ringHover = index;
    refreshRingLook();
  }

  function pickRing(nx: number, ny: number): number | null {
    if (pickers.length === 0) return null;
    /*
     * ⚠️ 拾取前把世界矩阵刷到最新 —— 否则"刚摆好环、还没画第一帧"就去点，
     *    矩阵还是上一次的，会整片点空。
     */
    camera.updateMatrixWorld();
    for (const p of pickers) p.updateWorldMatrix(true, false);
    ndc.set(nx, ny);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(pickers, false);
    if (hits.length === 0) return null;
    const idx = pickers.indexOf(hits[0].object as THREE.Mesh);
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

    // 年轮环：颜色也全从 CSS 变量来 ⇒ 换主题要重读一遍并重刷。
    if (rings.length > 0) {
      readRingColours();
      bandGeos.forEach((g, i) => paintBand(g, ringLit[i]));
      refreshRingLook();
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

  return {
    scene,
    camera,
    fit,
    applyTheme,
    setTime,
    setWind,
    setRings,
    setRingOpen,
    setRingHover,
    pickRing,
    dispose,
  };
}
