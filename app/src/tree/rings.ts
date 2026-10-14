/**
 * 树语 · **年轮环** —— 纯数学，⛔ 不 import three。
 *
 * 为什么跟 three 分开（跟 `grow.ts` 同一条理由）：
 *   位置、月份、天数这一类"**对不对**"的问题，交给零依赖的前端单测直接守住
 *   （`app/tests/rings.test.ts`）。渲染层只负责"把算好的环画出来"。
 *
 * ── 口径（用户 2026-10-14 拍板） ────────────────────────────────────
 * · ⭐ **一棵树 ＝ 一个自然季**（春 3~5／夏 6~8／**秋 9~11**／冬 12~2）
 *   —— 不是日历季度（Q4 = 10/11/12 会把 12 月拖进冬天，跟第 5 期的枇杷打架）；
 * · ⭐ **一圈 ＝ 一个月**；一圈里的**一格 ＝ 一天**（按当月**实际**天数 28/29/30/31）；
 * · ⭐ 三圈**上下排开、一样大**（用户原话：「**三个区域一样大即可，因为树干
 *   那一部分都是一样粗的**」）⇒ 半径取三处主干半径的**平均**，三圈**共用同一个数**；
 * · 三圈的高度 **15% / 40% / 65%**（沿主干，从根数起）——
 *   ⚠️ **故意躲开三层侧枝**：侧枝正好着生在 **25% / 50% / 75%**
 *   （`grow.ts` 里 `trunkTiers: 3` ⇒ `k / (tiers + 1)`），环压在枝根上会糊成一团；
 * · ⭐ **下面那一圈 ＝ 这个季度的第 1 个月**（往上 ＝ 时间往后）。
 *
 * ⚠️ 这一期**不接数据、不发后端命令** —— 这里只算"环摆在哪、是几月、几天"。
 *    "格子里亮几格"是批次 2 的事（还是放在这个文件里，仍然纯函数）。
 */
import type { Vec3 } from "./grow.ts";

/** 一个年轮环（＝这个季度里的某一个月）。 */
export type Ring = {
  /** 环心（世界坐标，落在主干轴线上）。 */
  center: Vec3;
  /** 环平面的法线（＝主干方向，单位向量）。 */
  normal: Vec3;
  /** 环的半径 —— ⭐ **三环完全相同**（用户 2026-10-14 拍的第 5 条）。 */
  radius: number;
  /** 这个环是几月（1~12）。 */
  month: number;
  /** 这个月有多少天（28/29/30/31）⇒ 环上画几个格子。 */
  days: number;
  /** 沿主干的高度比例（0 ＝ 根，1 ＝ 梢）—— 验"上下排开"要用。 */
  frac: number;
};

/**
 * 三圈沿主干的高度比例。
 *
 * ⚠️ 侧枝着生点在 **25% / 50% / 75%**（见 `grow.ts` 的 `trunkTiers`），
 *    所以这三个数都取在"层与层之间"，且各自离侧枝 **10 个百分点**。
 */
export const RING_FRACS = [0.15, 0.4, 0.65] as const;

/** 细环的**管半径 ÷ 环半径**。取 0.075 ⇒ 管直径约是环半径的 15%，是个"细箍"。 */
export const RING_TUBE_RATIO = 0.075;

/**
 * 环半径 ÷ 主干**最粗那处**的半径。
 *
 * ⚠️⚠️ **必须 > 1 + 管径比**，否则环会陷进树皮里 —— 见 `ringLayout` 里的说明。
 *    1.18 的效果：最低那圈刚露出树皮一点点，最高那圈浮出约 6 像素（都在能看见、
 *    也有点得到的范围里）。
 */
export const RING_RADIUS_CLEARANCE = 1.18;

/** 展开态：**外半径 ÷ 平时半径**（"抽出来"、放大到能看清格子）。 */
export const RING_BAND_OUTER = 2;

/**
 * 展开态：**内半径 ÷ 平时半径**。
 * ⚠️ 必须 **> 1** —— 环带内圈小于主干半径的话，内半边会直接陷进树干里看不见。
 */
export const RING_BAND_INNER = 1.06;

/**
 * 拾取热区半径 ÷ 环半径。
 * ⚠️ **比视觉上粗一圈**：环本来是细的（管直径只有半径的 15%），
 *    直接拿细环当热区会点不中（第二期指令坑表第 2 条）。
 */
export const RING_PICK_RADIUS = 1.9;

/**
 * 拾取热区的**高度 ÷ 相邻两圈的间距**。
 * ⚠️ 必须 **< 1** —— 到 1 时上下两个热区正好贴上，再大就会重叠
 *    （现象：点哪一圈都开同一圈）。0.88 是"够宽裕、又不打架"的位置。
 */
export const RING_PICK_HEIGHT_RATIO = 0.88;

/** 自然季的首月：春 3／夏 6／秋 9／冬 12。 */
const SEASON_START: Record<number, number> = {
  3: 3, 4: 3, 5: 3,
  6: 6, 7: 6, 8: 6,
  9: 9, 10: 9, 11: 9,
  12: 12, 1: 12, 2: 12,
};

/** 这个月有几天（28/29/30/31）。⚠️ 闰年交给 `Date` 自己算，⛔ 不手写"能被 4 整除"。 */
export function monthDays(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * 这个月所在的**自然季**是哪三个月，按时间先后返回 `["YYYY-MM", …]`。
 *
 * ⚠️ 冬季跨年（12/1/2）：1 月的"上一个 12 月"属于**上一年**
 *    （2026 年 1 月看到的是 **2025-12 / 2026-01 / 2026-02**）。
 *    这个 `yearShift` 就是为它写的。
 */
export function seasonMonths(year: number, month: number): string[] {
  const start = SEASON_START[month];
  if (start === undefined) throw new Error(`月份只能是 1~12，收到 ${month}`);
  // ⭐ 季节首月比当前月"更靠后" ⇒ 这个季是**去年**开的（只有冬天会走到）。
  const yearShift = start > month ? -1 : 0;
  const out: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const raw = start + i;
    const m = ((raw - 1) % 12) + 1;
    const y = year + yearShift + Math.floor((raw - 1) / 12);
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

/**
 * 摆三圈年轮。
 *
 * @param trunkFrom 主干起点（`tree.branches` 里 `depth === 0` 那根的 `from`）
 * @param trunkTo   主干终点（同上那根的 `to`）
 * @param trunkR0   主干**根部**半径
 * @param trunkR1   主干**梢部**半径
 * @param monthKeys ⭐ 这个季度的三个月，**按时间先后**，形如 `["2026-09","2026-10","2026-11"]`
 *
 * ⚠️ 位置**必须从真实主干坐标算** —— `grow.ts` 给主干长度加了 ±5% 抖动
 *    （`trunkLength * (1 + wobble(0.05))`），写死坐标会对不准。
 */
export function ringLayout(
  trunkFrom: Vec3,
  trunkTo: Vec3,
  trunkR0: number,
  trunkR1: number,
  monthKeys: readonly string[]
): Ring[] {
  const axis: Vec3 = {
    x: trunkTo.x - trunkFrom.x,
    y: trunkTo.y - trunkFrom.y,
    z: trunkTo.z - trunkFrom.z,
  };
  const len = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
  if (len < 1e-9) throw new Error("主干长度是 0，算不出年轮摆在哪");
  const normal: Vec3 = { x: axis.x / len, y: axis.y / len, z: axis.z / len };

  /*
   * ⭐ 三环**同半径**（用户：「三个区域一样大即可，因为树干那一部分都是一样粗的」），
   *    取三处主干半径的**最大值** × 一个余量。
   *
   * ⚠️⚠️ 为什么**不是"平均"** —— 第一版取的正是平均值，实测**最低那圈整个陷进
   *    树皮里**：三处主干半径是 0.1015 / 0.0958 / 0.0900（从根到梢收细 22%），
   *    平均值 0.0958 **比最低处的主干半径 0.1015 还小** ⇒ 环被树皮吞掉，
   *    **看不见、也点不着**（这一条没有任何断言在守，是我画图核对时才发现的）。
   *    取最大值 × 1.18 ⇒ 三圈都露在外面，且仍然"一样大"。
   */
  let maxR = 0;
  for (const f of RING_FRACS) maxR = Math.max(maxR, trunkR0 + (trunkR1 - trunkR0) * f);
  const radius = maxR * RING_RADIUS_CLEARANCE;

  return RING_FRACS.map((f, i) => {
    const key = monthKeys[i] ?? "";
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    const ok = Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12;
    return {
      center: {
        x: trunkFrom.x + axis.x * f,
        y: trunkFrom.y + axis.y * f,
        z: trunkFrom.z + axis.z * f,
      },
      normal,
      radius,
      // ⚠️ 拿不到合法月份时给个"占位"（第 i+1 月），⛔ 不抛错 ——
      //    树是看的，不能因为一个参数就白屏（对应指令 C4）。
      month: ok ? m : i + 1,
      days: ok ? monthDays(y, m) : 30,
      frac: f,
    };
  });
}
