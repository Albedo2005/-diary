/**
 * 「长树」—— **纯数学，⛔ 不 import three**。
 *
 * 为什么非要跟 three 分开：这样它就能被**零依赖的前端单测**直接守住
 * （在 `app/` 下跑 `pnpm test:fe`，用例在 `app/tests/tree.test.ts`）。
 * 一旦把生成逻辑写进 `TreePane.vue`，它就只能靠"看截图"来验了。
 *
 * ⭐ **一句话口径**：**同一颗种子 ⇒ 永远长成同一棵树。**
 *    这是 A2 拍的板（"先做一棵树"，固定下来你才好判断好不好看）。
 *    所以这里**不许出现 `Math.random()`** —— 随机数一律出自下面那个
 *    由种子决定的小发生器。
 *
 * ⚠️ 输出的不是"画好的树"，是**枝条的骨架**：每根枝条给两个端点 ＋
 *    两端半径，渲染层（`scene.ts`）负责把它变成几何体。
 *    枝梢（`tips`）就是**批次 3 挂花挂叶的点**。
 */

/** 只用一个最小向量形状，⛔ 不引 three 的 `Vector3`。 */
export type Vec3 = { x: number; y: number; z: number };

/** 一根枝条：从 `from` 长到 `to`，根部半径 `r0`、梢部半径 `r1`。 */
export type Branch = {
  /** 0 ＝ 主干；每分一次叉 +1。 */
  depth: number;
  from: Vec3;
  to: Vec3;
  r0: number;
  r1: number;
};

export type Tree = {
  branches: Branch[];
  /** ⭐ 枝梢 ＝ **批次 3 的花叶挂点**。 */
  tips: Vec3[];
  /** 树顶到地面的高度 —— 渲染时拿它把相机对准（A4：树高占画面 75%）。 */
  height: number;
  /** 最粗处的半径 —— 用来决定相机离多近。 */
  maxRadius: number;
  /** 这棵树实际用到的分枝级数。 */
  maxDepth: number;
};

export type GrowOptions = {
  /** 决定这棵树的**全部形态**。换一个数就是另一棵树，同一个数永远是同一棵。 */
  seed: number;
  /** 分枝级数上限。**D5 定的红线是 ≤ 8**（每层翻倍，再深就明显卡）。 */
  maxDepth: number;
  /** 主干长度（无量纲，最后统一缩放）。 */
  trunkLength: number;
  /** 主干**根部**半径。A6：根部要略粗，不能是根均匀的塑料管。 */
  trunkRadius: number;
  /** 每深一级，枝条长度乘这个数（A 段定的 0.7 左右）。 */
  lengthRatio: number;
  /** 每深一级，半径乘这个数。 */
  radiusRatio: number;
  /** 分叉张开角下限（度）—— A 段定的 ±15~25°。 */
  spreadMinDeg: number;
  /** 分叉张开角上限（度）。 */
  spreadMaxDeg: number;
  /** 长度 / 角度的随机抖动幅度（0 ＝ 完全规整，1 ＝ 全部幅度拉满）。 */
  jitter: number;
};

export const DEFAULT_GROW: GrowOptions = {
  seed: 20260930,
  // ⭐ D5 的硬红线是 ≤ 8。默认取 5：主干 + 5 级 ＝ 139 根枝条，
  //    形状够饱满、代价也够低（批次 3 的花叶会再把树冠填满）。
  maxDepth: 5,
  trunkLength: 1,
  trunkRadius: 0.085,
  lengthRatio: 0.7,
  radiusRatio: 0.74,
  spreadMinDeg: 15,
  spreadMaxDeg: 25,
  jitter: 1,
};

// ---------------------------------------------------------------------------
// 最小向量运算（都在这里，⛔ 别散到渲染层去）
// ---------------------------------------------------------------------------

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a: Vec3, k: number): Vec3 => v(a.x * k, a.y * k, a.z * k);
const cross = (a: Vec3, b: Vec3): Vec3 =>
  v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const vecLength = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export function normalize(a: Vec3): Vec3 {
  const l = vecLength(a);
  return l < 1e-9 ? v(0, 1, 0) : mul(a, 1 / l);
}

/**
 * 由种子决定的小随机数发生器（mulberry32）。
 *
 * ⭐ **全项目唯一的"随机"来源**（批次 3 的挂花挂叶也从这儿导出去用 ——
 *    见 `foliage.ts`）。整数种子进去、[0,1) 出来，同一颗种子给出的数列
 *    **逐位相同** —— 这就是 A2 那条"同一棵树"的实现方式。
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 给一个方向配两个互相垂直的"侧向"单位向量。
 *
 * 分叉 = 把父方向**在一个圆锥面上偏转**：绕这两个侧向量各转一点。
 * ⚠️ 参考轴要挑一个跟 `dir` **不平行**的，否则叉乘出零向量、整棵树会塌成一条线。
 */
export function sideBasis(dir: Vec3): [Vec3, Vec3] {
  const ref = Math.abs(dir.y) > 0.9 ? v(1, 0, 0) : v(0, 1, 0);
  const u = normalize(cross(ref, dir));
  const w = cross(dir, u);
  return [u, w];
}

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 长一棵树。**同一个 `seed` ⇒ 逐字节相同的结果。**
 *
 * 形态口径（来自第一期指令 §二 A 段，⭐ 这些是**拍过板**的，别随手改）：
 * - **主干明显**：主干是一根直的、单独的一段，占全树高度约三分之一；
 * - **3~4 级分枝 + 伞状树冠**：张开角随深度**逐级放大**，
 *   于是外层枝条往外铺 —— 这就是"伞状"的来源；
 * - **根部略粗**：主干从根到梢一路收细（`r0` → `r1`），不是均匀圆柱。
 */
export function growTree(overrides: Partial<GrowOptions> = {}): Tree {
  const o: GrowOptions = { ...DEFAULT_GROW, ...overrides };
  if (o.maxDepth < 1) throw new Error("maxDepth 至少要是 1（只有主干不算树）");

  const rng = makeRng(o.seed);
  const branches: Branch[] = [];
  const tips: Vec3[] = [];
  let top = 0;
  let maxRadius = 0;

  /** 抖动一下（`jitter` ＝ 0 时就是原值，方便调试时关掉随机感）。 */
  const wobble = (half: number): number => (rng() * 2 - 1) * half * o.jitter;
  /** 在 [lo, hi] 里取一个值。 */
  const between = (lo: number, hi: number): number => lo + rng() * (hi - lo);

  /**
   * 递归长一根枝条，再从它的梢上分叉。
   *
   * @param from   这根枝条的根
   * @param dir    朝向（单位向量）
   * @param len    长度
   * @param r0     根部半径
   * @param depth  当前级数（0 ＝ 主干）
   */
  function limb(from: Vec3, dir: Vec3, len: number, r0: number, depth: number): void {
    const r1 = r0 * o.radiusRatio;
    const to = add(from, mul(dir, len));
    branches.push({ depth, from, to, r0, r1 });
    if (to.y > top) top = to.y;
    if (r0 > maxRadius) maxRadius = r0;

    // 到顶了：这里就是枝梢，将来的花叶挂在这儿。
    if (depth >= o.maxDepth) {
      tips.push(to);
      return;
    }

    /*
     * 一个叉分几根：主干（0 级）和它下面一级分 3 根 —— 这就是 A1 要的
     * "主干明显、3~4 级分枝"；再往上分 2 根，免得枝条数翻太快。
     */
    const kids = depth <= 1 ? 3 : 2;
    const [u, w] = sideBasis(dir);

    /*
     * ⭐ **伞状的关键**：张开角随深度放大。
     *    只是"每级都张 20°"的话，树冠会是一个瘦长的纺锤；
     *    越往外张得越开，外圈枝条才会往横里铺开成一把伞。
     */
    const widen = 1 + 0.22 * depth;
    const spreadLo = o.spreadMinDeg * widen * DEG;
    const spreadHi = o.spreadMaxDeg * widen * DEG;

    for (let i = 0; i < kids; i += 1) {
      // 绕一圈平分，再把起点抖一个角度 —— 免得每棵树的叉都长在同一个方位。
      const az = (i / kids) * Math.PI * 2 + wobble(0.5);
      const spread = between(spreadLo, spreadHi) + wobble(0.12);
      const grown = add(
        add(mul(dir, Math.cos(spread)), mul(u, Math.sin(spread) * Math.cos(az))),
        mul(w, Math.sin(spread) * Math.sin(az))
      );
      // 越往外的枝条越往横里倒一点 ⇒ 树冠横向铺开（伞状）。
      const outward = normalize(v(grown.x, grown.y * (1 - 0.1 * depth), grown.z));
      limb(
        to,
        normalize(outward),
        len * o.lengthRatio * (1 + wobble(0.12)),
        r1,
        depth + 1
      );
    }
  }

  const trunkLen = o.trunkLength * (1 + wobble(0.05));
  // 主干起点略低于地面一点点，免得根部和地面之间露出一道缝。
  limb(v(0, -0.02, 0), v(0, 1, 0), trunkLen, o.trunkRadius, 0);

  return {
    branches,
    tips,
    height: top + 0.02,
    maxRadius,
    maxDepth: o.maxDepth,
  };
}
