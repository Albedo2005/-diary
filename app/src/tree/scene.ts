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

  return { scene, camera, fit, applyTheme, setTime, setWind, dispose };
}
