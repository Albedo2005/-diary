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
  /**
   * ⭐⭐ **子枝相对父枝"往上抬／往下压"多少度**（调整轮第二次改，可为负）。
   *
   * ⚠️ **改之前我把它叫 `droopDeg`、方向做反了** —— 让低处的枝**往下垂**。
   *    用户当场纠正：「**真实的树都是大部分向斜上方生长，一部分向平行于地面
   *    的四周生长，向下生长的不好看都被裁剪掉了**」。他是对的。
   *
   * 依据（园艺学对枝条**垂直角**的标准分档，多份来源一致）：
   * · 《苏州市居住区绿化养护技术规程》（政府文件）：「**卵圆形／倒卵形／伞形**：
   *   主枝**向上斜伸**，与主干成约 **45~60°** 夹角」；
   * · 《果树修剪技术概要》：「垂直角 **40~60° 为半开张**、60~80° 为开张、
   *   **90° 左右为水平**、**>90° 时称为下垂**」—— 且**下垂枝是缺陷、要疏除**；
   * · 华东师大《Tree architecture…》：分枝角 **<30° 直立、30~60° 斜生、
   *   >60° 水平**；
   * · 苹果整形（Westwood / Phillips）：最优连接角 **50~60°**（<30° 弱、≈90° 也弱）。
   *
   * ⇒ 目标是让垂直角分布落在 **30~90°** 这一段（斜生为主、一部分水平），
   *    **几乎不留 >90° 的下垂枝**。
   *
   * 实现：每个子枝在父方向上再偏 `axisBiasDeg`。**取负值 ＝ 把上扬的劲头压下去**
   * （父枝已经偏过一次，逐级再抬就会叠成"往上举的扫帚"）。
   */
  axisBiasDeg: number;
  /**
   * ⭐ **越靠外的枝，垂直角再多张多少度**（真实树：低处枝更平、树冠处更陡）。
   *
   * 依据《果树修剪技术概要》：「**垂直角较大时枝条生长缓和**」＋
   * 苹果整形「基部主枝角度较大、上层主枝角度较小」——
   * 也就是**同一棵树上，外层／低处的枝更平，内层／高处的枝更陡**。
   */
  outwardWidenDeg: number;
  /** 主干沿途抽几层侧枝（"层性"；见 `limb()` 里 `depth === 0` 那一段）。 */
  trunkTiers: number;
  /**
   * 主干上**最高那一层侧枝**的上抬角（度）—— 越低的层按比例更平。
   * 依据：《苏州市居住区绿化养护技术规程》「基部主枝…向上逐渐细短」＋
   * 苹果整形「基部主枝角度较大、上层主枝角度较小」。
   */
  tierLiftDeg: number;
  /** 侧枝的长度 ÷ 主干的长度（主从关系：侧枝不该跟主干一样长）。 */
  tierLength: number;
  /** 侧枝根部半径 ÷ 它着生处主干的半径。 */
  tierRadius: number;
  /** 长度 / 角度的随机抖动幅度（0 ＝ 完全规整，1 ＝ 全部幅度拉满）。 */
  jitter: number;
};

export const DEFAULT_GROW: GrowOptions = {
  seed: 20260930,
  /*
   * ⭐⭐ 调整轮第三次改：**5 → 4 → 又回到 5**。
   *
   * 走过的弯路值得记下来：
   *  · 第一版降到 4（用户说「树枝太密」）—— 结果是 **31 枝**，
   *    树干光秃秃、树冠挤在顶上，**像"杆顶一丛灌木"**（见截图）。
   *  · 根因不是"级数"，是**分支全都挂在同一个高度上** ⇒ 改成"主干沿途出 3 层"
   *    （见 `trunkTiers`）之后，同样的级数会长出**上下有层次**的树冠。
   *  · 于是级数回到 5：**156 枝 / 80 梢**，树冠从树高 **25%** 就开始了
   *    （原来 58%），叶子 1,636 片 —— 比这批 139 枝的原版还饱满，
   *    但角度对了（斜生 45% ＋ 水平 50%、下垂只 1%）。
   * ⚠️ 红线（D5：≤ 8）仍然满足。
   */
  maxDepth: 5,
  trunkLength: 1,
  /*
   * ⭐ 调整轮：**0.085 → 0.105**（用户："树干我觉得有点细"）。
   *    尺子：**树高 ÷ 树干直径**。
   *    · 改之前：2.8177 / (0.085×2) ≈ **16.6 倍** —— 比真实幼乔木细。
   *    · 改之后：约 **13.4 倍** —— 落进真实乔木幼树的 **10~14 倍**区间。
   */
  trunkRadius: 0.105,
  lengthRatio: 0.7,
  /*
   * ⭐ 调整轮：**0.74 → 0.78**（枝条跟着壮一点）。
   *    ⚠️ 同时级数从 5 降到 4 ⇒ 末梢少收一道 ⇒ 整棵树不再"细麻杆"。
   */
  radiusRatio: 0.78,
  spreadMinDeg: 15,
  spreadMaxDeg: 25,
  /*
   * ⭐⭐ 调整轮第二次改：**从"低处下垂"改成"整体压平上扬劲"**。
   *
   * 用户原话：「**真实的树都是大部分向斜上方生长，一部分向平行于地面的四周
   * 生长，向下生长的不好看都被裁剪掉了**」—— 把我上一版的 `droopDeg: 34`
   * （低处往下垂）直接推翻。
   *
   * 实测旧版的垂直角分布（`_probe-angle.mts`）：
   *   均 37.1°｜直立 25%｜斜生 75%｜**开张 0%｜下垂 0%** —— 一根**水平枝都没有**，
   *   全堆在 30~60° 这一段往上叠 ⇒ 还是"举着的扫帚"。
   *
   * 取 −38° 后：均 46.7°｜直立 14%｜斜生 68%｜**开张 18%｜下垂 0%**
   *   ⇒ 落进园艺学说的"**斜生为主 ＋ 一部分水平**"那一段，且**无下垂枝**。
   */
  axisBiasDeg: -38,
  /*
   * ⭐ 外层再张 6° —— 让"低处／外层的枝更平、树冠处的枝更陡"（真实树的次序）。
   *    ⚠️ 改之前次序是**反的**（实测内层 37° ＜ 外层 42°）。
   *    ⚠️ 这个数**只是把分布铺开**，不是越大越好：探针实测
   *       6° ⇒ 下垂 3%；20° ⇒ 下垂 13%；26° ⇒ 下垂 17%（越张越往下翻）。
   *       所以取 6° —— 把分布展开到"斜生 ＋ 水平"两段，又几乎不留下垂枝。
   */
  outwardWidenDeg: 6,
  /*
   * ⭐⭐ 调整轮第三次改 —— **主干沿途出 3 层侧枝**。
   *    前两版是"一个 Y 字"（所有枝挂在一个高度上），远看像"杆顶一丛灌木"。
   *    真树的层性见 `limb()` 里 `depth === 0` 那一段的注释。
   */
  trunkTiers: 3,
  /* 最高那层上抬 46°（⇒ 垂直角约 44°，落进园艺学"半开张 40~60°"）；越低越平。 */
  tierLiftDeg: 46,
  /* 侧枝长 ≈ 主干的 0.62 —— 主从关系，⛔ 不能让侧枝跟主干一样长。 */
  tierLength: 0.62,
  /* 侧枝根部 ≈ 着生处主干半径的 0.52（细一档，看着才像"枝"不像"叉")。 */
  tierRadius: 0.52,
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
 * 形态口径：
 * - **主干明显**：主干是一根直的、单独的一段，占全树高度约三分之一；
 * - ⭐⭐ **"大部分斜上方 ＋ 一部分平行于地面，几乎没有下垂枝"**（调整轮第二次改）：
 *   依据园艺学对枝条**垂直角**的标准分档（《苏州市居住区绿化养护技术规程》
 *   政府文件：「主枝**向上斜伸**，与主干成约 **45~60°**」；《果树修剪技术概要》：
 *   「**40~60° 半开张、60~80° 开张、90° 左右水平、>90° 下垂**」，
 *   且**下垂枝是缺陷、要疏除**）。用户原话：「真实的树都是大部分向斜上方生长，
 *   一部分向平行于地面的四周生长，向下生长的不好看都被裁剪掉了」。
 *   ⚠️ 我上一版做的"低处下垂"是**反的** —— 见 `GrowOptions.axisBiasDeg`。
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
     * 一个叉分几根。
     *
     * ⭐ 调整轮：**从"一级分 3 根"改成"每级都分 2 根"** —— 用户说「树枝太密」。
     *    依据：桂花**标准株分枝力平均只有 2.8 个**（《科普中国》丹桂条目），
     *    而"一级 3 根 + 再往上每级 2 根"叠到 4 级就已经 40 根枝条了。
     */
    const kids = 2;
    const [u, w] = sideBasis(dir);

    /*
     * ⭐⭐ 调整轮第二次改 —— **张开角**。
     *
     * 上一版把它写成 `1 / (1 + 0.18 * depth)`（越往外张得越小），并配了一个
     * "低处下垂"的写法。**效果不对**：实测整棵树**一根水平枝都没有**，
     * 全在 30~60° 往上叠（见 `_probe-angle.mts`）。
     *
     * 现在的写法分两半：
     *  ① **主动加压**：`axisBiasDeg`（负值）把"每级都在父方向上再往上抬"的
     *     累积劲头压掉 —— 这才是"举着的扫帚"的病根；
     *  ② **外层多张**：`outwardWidenDeg × (depth - 1)` 让**越靠外的枝越平**，
     *     让垂直角分布从"一团"展开成**斜生 → 水平**的一整段
     *     （园艺学说的 30~90°；见 `GrowOptions.axisBiasDeg` 的注释）。
     */
    const widen = 1 + (o.outwardWidenDeg * (depth - 1)) / Math.max(1, o.spreadMaxDeg);
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
      /*
       * ⭐ 加压：把子枝方向**从"继续上扬"掰回"斜生／水平"**。
       *
       * ⚠️ 掰的轴只能是**水平的侧向量**（不含竖直分量），⛔ 不能直接改 `y` 分量
       *    —— 那样会连枝条长度一起变，整棵树会被"压扁"。
       * ⚠️ `bias` 为负 ⇒ 绕水平轴**向下**转，正好抵消逐级累积的上扬。
       */
      const bias = o.axisBiasDeg * DEG;
      let nextDir = grown;
      if (Math.abs(o.axisBiasDeg) > 1e-6 && u.y !== 0) {
        // 挑一个"能往下掰"的水平轴：转它会让 y 变小。
        const axis = normalize(v(-u.z, 0, u.x));
        const cross2 = cross(axis, grown);
        nextDir = add(
          mul(grown, Math.cos(bias)),
          mul(normalize(cross2), Math.sin(bias))
        );
      }
      limb(
        to,
        normalize(nextDir),
        len * o.lengthRatio * (1 + wobble(0.12)),
        r1,
        depth + 1
      );
    }

    /*
     * ⭐⭐ 调整轮第三次改 —— **主干要"沿途出枝"，不能只在顶上一个叉**。
     *
     * 为什么非改不可：前两版长出来的树是**一个"Y"字** —— 所有枝条都挂在同一
     * 个高度上（第一版是树冠顶、第二版是树干梢），远看就是"一根杆顶着一丛灌木"。
     * 真树是**主干一路往上、一路在不同的高度抽出侧枝**（园艺学叫"层性"：
     * 《苏州市居住区绿化养护技术规程》里"基部主枝粗壮、向上逐渐细短"、
     * 苹果整形讲的"每隔 40~60 cm 一层"）。
     *
     * ⭐ 做法：只有**主干（depth ＝ 0）**沿途出枝 ——
     *   在主干上取若干个高度点，每个点上抽一根侧枝；
     *   ⛔ 再往下的各级仍然是"到梢分 2 根"（那是树冠内部的细分，不该也沿途出枝，
     *   否则枝条数会再翻好几倍，又回到用户说的"太密"）。
     */
    if (depth === 0) {
      const tiers = Math.max(2, Math.round(o.trunkTiers));
      for (let k = 1; k <= tiers; k += 1) {
        /*
         * 高度点从"主干下端"到"接近梢部"均匀铺开。
         * ⚠️ 最后一层不取到 1.0 —— 梢上本来就会分叉，再挂一层会挤在一起；
         *    留一点余量（tiers / (tiers + 1)）让顶层跟冠心自然衔接。
         */
        const t = (k / (tiers + 1)) * (1 + wobble(0.08));
        const at = add(from, mul(dir, len * Math.max(0.08, Math.min(0.94, t))));
        /*
         * 方位绕一圈平分（再加抖动）—— 免得所有侧枝都从同一侧冒出来。
         * ⚠️ 用 `(k - 1)` 而不是 `k`：这样最低那层从 0° 起，和上面几层的黄
         *    金角错开，不会出现"上下两层叠在同一个方向"。
         */
        const az = ((k - 1) / tiers) * Math.PI * 2 + wobble(0.6);
        /*
         * ⭐ 侧枝的**抬升角**：越高的层越往上、越低的层越平 —— 这就是园艺学
         *    「基部主枝角度较大、上层主枝角度较小」的"层性"。
         *    `tierLiftDeg` 是最高那层的上抬角；低的层按比例减小。
         */
        const heightFrac = k / tiers; // 0（最低）→ 1（最高）
        const lift = (o.tierLiftDeg * (0.55 + 0.45 * heightFrac)) * DEG;
        const radial = v(Math.cos(az), 0, Math.sin(az));
        const outwardDir = normalize(add(mul(dir, Math.cos(lift)), mul(radial, Math.sin(lift))));

        /*
         * 侧枝的粗细与长度：按"越往上越短越细"（主从关系，见上面那份规程）。
         * ⚠️ 半径直接从主干的对应高度处**按收细比例**取 —— 这样侧枝根部
         *    不会比它着生的那一段主干还粗。
         */
        const alongFrac = Math.max(0.08, Math.min(0.94, t));
        const rHere = r0 + (r1 - r0) * alongFrac;
        const sideR = rHere * o.tierRadius;
        const sideLen = len * o.tierLength * (0.72 + 0.34 * heightFrac) * (1 + wobble(0.1));
        limb(at, outwardDir, sideLen, sideR, 1);
      }
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
