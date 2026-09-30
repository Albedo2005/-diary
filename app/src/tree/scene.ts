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
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { Tree } from "./grow.ts";
import {
  makeBarkTexture,
  makeGroundTexture,
  makeSkyTexture,
  readPalette,
  type TreePalette,
} from "./material.ts";

/** 竖直视角。45 是"人眼舒服、又不至于透视太夸张"的常见值。 */
const FOV = 45;
/** A4：树高占画面 75%。 */
const TREE_FILL = 0.75;
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

/**
 * 搭台子。
 *
 * @param tree 已经长好的骨架（`grow.ts` 的输出）
 */
export function makeStage(tree: Tree): TreeStage {
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

  // ── 树下那圈很淡的圆台（A5：照视频里那个底座） ──────────────────
  const discMat = keep(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.disc),
      roughness: 0.95,
      metalness: 0,
    })
  );
  const discR = Math.max(crownWidth(tree) * 0.62, tree.height * 0.32);
  const discGeo = keep(new THREE.CylinderGeometry(discR * 0.985, discR, 0.045, 64));
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.position.y = 0.0225;
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

  return { scene, camera, fit, applyTheme, dispose };
}
