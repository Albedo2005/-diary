/**
 * 「挂花挂叶」—— **纯数学，⛔ 不 import three**（与 `grow.ts` 同一条纪律）。
 *
 * 为什么要单独一个文件：`grow.ts` 管"树长什么样"，这里管"花叶挂在哪儿"。
 * 分开有两个好处 ——
 * ① `grow.ts` 的 9 条单测不用跟着动（它已经验过了，⛔ 别去碰）；
 * ② 这一层同样能被**零依赖的前端单测**直接守住（`app/tests/foliage.test.ts`）。
 *
 * ⭐ **口径（第一期指令 §二 B 段，都是拍过板的）**：
 * - **B1**：跟着当季走。现在是秋天 ⇒ **桂花 ＋ 金黄的叶**（颜色在 CSS 变量里，这里只管位置）。
 * - **B2**：冬天也**不是零**（这条要到第五期才用得上，现在先不做）。
 * - **B4**：**桂花是一簇簇小碎花** ⇒ 这里挂的是"一簇"的挂点，不是"一朵"。
 * - **⛔ 不接日记数据**：花多花少跟数据无关（那是第二期的事），
 *   所以这里的数量**只由枝条长度和种子决定**。
 *
 * ⚠️ **不许出现 `Math.random()`** —— 随机数一律出自 `grow.ts` 里那个
 *    由种子决定的发生器（A2：同一颗种子 ⇒ 同一棵树、同一身花叶）。
 */

import { makeRng, normalize, sideBasis, vecLength, type Tree, type Vec3 } from "./grow.ts";

/**
 * 一片叶 / 一簇花的挂点。
 *
 * ⚠️ `dir` 是"面片的 **+Y** 要指向哪儿"，不是面片的法线 ——
 *    面片是双面的（`side: DoubleSide`），法线朝向不重要，
 *    但**叶尖朝哪**很重要：朝错了叶子会像插反的标签纸。
 */
export type FoliageInstance = {
  /** 挂点（世界坐标）。 */
  pos: Vec3;
  /** 面片 +Y 的指向（单位向量）—— 叶尖 / 花簇的"朝上"方向。 */
  dir: Vec3;
  /** 面片的世界尺寸（⚠️ 是四边形的高，叶子本身只占贴图中间那一条）。 */
  size: number;
  /** 绕自身 +Y 轴的滚转（弧度）—— 让叶子不是清一色立着。 */
  roll: number;
  /** 风的相位偏移（弧度）—— **每片叶子错开**，不然整棵树像一块硬纸板在扇。 */
  phase: number;
  /** 0~1：实例颜色在"淡"与"浓"之间取哪一档（颜色本身在渲染层由 CSS 变量算）。 */
  tone: number;
};

export type Foliage = {
  leaves: FoliageInstance[];
  blossoms: FoliageInstance[];
};

export type FoliageOptions = {
  /** 决定这一身花叶的**全部细节**。与 `grow.ts` 用同一个种子时形态才配得上。 */
  seed: number;
  /** 从第几级枝条开始挂 —— 主干和前两级留光杆，否则树心会糊成一团。 */
  minDepth: number;
  /** 每单位枝长挂几片叶（树高约 2.8，外层枝条总长 20 上下）。 */
  leafPerUnit: number;
  /** 每单位枝长挂几簇花 —— 桂花是一簇簇的，本来就比叶子少。 */
  blossomPerUnit: number;
  /** 叶子四边形的世界尺寸。 */
  leafSize: number;
  /** 花簇四边形的世界尺寸。 */
  blossomSize: number;
};

export const DEFAULT_FOLIAGE: FoliageOptions = {
  seed: 20260930,
  /*
   * 从 2 级枝开始挂：主干 ＋ 一级枝留光杆（A1："主干明显"），
   * 但**不能等到 3 级** —— 实测那样叶子最低点到树高的 68%，
   * 树冠会整个堆在顶上，下身空一截（"瘦"就是这么来的）。
   * 2 级起 ⇒ 叶子从 **58%** 处开始，冠型饱满得多。
   */
  minDepth: 2,
  leafPerUnit: 30,
  blossomPerUnit: 6.5,
  // 树高 2.82；这两个数是"叶子在屏幕上大约 13 像素"倒推出来的（画布宽 785 时）。
  leafSize: 0.115,
  blossomSize: 0.095,
};

// ---------------------------------------------------------------------------
// 一行算术就地写 —— 只借 grow.ts 里带"规矩"的那几个（种子发生器 / 侧向基底 / 归一化）
// ---------------------------------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, mul({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, t));

/**
 * 挑一个"往外撇"的方向：以枝条方向为轴、在圆锥面上偏一个角。
 *
 * ⭐ 用的是 `grow.ts` 里那个 `sideBasis` —— 分叉方向和花叶朝向必须共用
 *    同一套"参考轴怎么挑"的逻辑，否则会在枝条跟轴平行的位置叉乘出零向量。
 */
function fanOut(dir: Vec3, spread: number, az: number): Vec3 {
  const [u, w] = sideBasis(dir);
  return add(
    add(mul(dir, Math.cos(spread)), mul(u, Math.sin(spread) * Math.cos(az))),
    mul(w, Math.sin(spread) * Math.sin(az))
  );
}

/**
 * 算出一棵树的花叶挂点。
 *
 * @param tree 已经长好的骨架（`growTree()` 的输出）
 * @param overrides 想改的口径（一般不用传）
 */
export function growFoliage(tree: Tree, overrides: Partial<FoliageOptions> = {}): Foliage {
  const o: FoliageOptions = { ...DEFAULT_FOLIAGE, ...overrides };
  const rng = makeRng(o.seed);

  /*
   * ⚠️ 兜底：`minDepth` 比这棵树实际的分枝级数还深时（比如把 maxDepth 调到 1
   *    去单测），一律退回到**最深那一级** —— ⛔ 不能让花叶整片落空，
   *    那会得到一棵光秃秃的树，而"没有花叶"和"花叶没挂上"在截图上分不出来。
   */
  const from = Math.min(o.minDepth, tree.maxDepth);

  const leaves: FoliageInstance[] = [];
  const blossoms: FoliageInstance[] = [];

  for (const b of tree.branches) {
    if (b.depth < from) continue;

    const span = { x: b.to.x - b.from.x, y: b.to.y - b.from.y, z: b.to.z - b.from.z };
    const len = vecLength(span);
    if (len < 1e-6) continue;
    const axis = normalize(span);

    /*
     * ⭐ 一个挂点用掉的随机数**个数是固定的**（下面 `t` 里 1 个 ＋ 体内 6 个）——
     *    这样"叶子和花"用的是同一条随机数列的不同段，换个种子两边一起变，
     *    ⛔ 不会出现"叶子变了、花没变"这种半截随机。
     */
    const place = (out: FoliageInstance[], size: number, lift: number, t: number): void => {
      const roll = rng();
      const phase = rng();
      const tone = rng();
      const openAngle = 0.5 + rng() * 0.55; // ≈ 29°~60° 张开
      const az = rng() * Math.PI * 2;
      /*
       * ⚠️ `t` 由**调用方按下标算好**（不是在这儿现抽）—— 现抽的话所有挂点都会
       *    挤在枝条根部（`t` 的期望值跟片数成反比），梢上反而光秃秃。
       */
      const at = lerp(b.from, b.to, t);

      // 叶尖朝外、再往上抬一点（向光）—— 抬得太狠会变成"朝天长的旗子"。
      const outPos = fanOut(axis, openAngle, az);
      const dir = normalize({ x: outPos.x, y: outPos.y + 0.4, z: outPos.z });

      out.push({
        // 沿 dir 往外挪半个尺寸 ⇒ 花叶"长在枝条表面"，不是埋在枝条里
        pos: add(at, mul(dir, size * 0.45 + lift)),
        dir,
        // 大小抖 ±25%：清一色一样大会像塑料叶子
        size: size * (0.78 + rng() * 0.45),
        roll: roll * Math.PI * 2,
        phase: phase * Math.PI * 2,
        tone,
      });
    };

    /** 沿枝条把 `n` 个挂点撒开（首尾各留一点余量，别怼在端点上）。 */
    const alongBranch = (n: number, f: (t: number) => void): void => {
      for (let i = 0; i < n; i += 1) f(Math.min(0.99, (i + 0.15 + rng() * 0.7) / n));
    };

    const nLeaf = Math.max(0, Math.round(len * o.leafPerUnit * (0.55 + 0.3 * b.depth)));
    alongBranch(nLeaf, (t) => place(leaves, o.leafSize, 0, t));

    const nBloom = Math.max(0, Math.round(len * o.blossomPerUnit * (0.4 + 0.22 * b.depth)));
    alongBranch(nBloom, (t) => place(blossoms, o.blossomSize, 0.01, t));
  }

  return { leaves, blossoms };
}
