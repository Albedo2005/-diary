/**
 * 树语 · **年轮** —— 纯数学，⛔ 不 import three。
 *
 * 为什么跟 three 分开（跟 `grow.ts` 同一条理由）：
 *   位置、月份、天数这一类"**对不对**"的问题，交给零依赖的前端单测直接守住
 *   （`app/tests/rings.test.ts`）。渲染层只负责"把算好的块/格子画出来"。
 *
 * ── ⚠️⚠️ 这个文件在 2026-10-14 17:37 被**推翻重写过一版** ─────────────
 * 第一版把「点击区」做成了**套在主干上的三圈可见细环**（torus ＋ 点开抽成环带）。
 * 用户当场纠正：**点击区是"树干上的一段（一块）"，不是环**；而且**平时画圈太突兀**，
 * 点开之后要**在侧边弹面板画圆环数据图**。
 * ⇒ 本文件保留「位置/月份/天数」这一套纯数学，但：
 *   · `Ring` → `TrunkBlock`（带**底/顶**的**一段**，不再是"一圈"）；
 *   · 删掉环半径 / 环带 / 管径那几个常量（那是几何，现在归 `scene.ts` 的薄壳）；
 *   · 新增 `monthCells()` —— 面板里那张**圆环数据图**要的"哪几天亮着"，仍是纯函数。
 *
 * ── 口径（用户 2026-10-14 两次拍板） ────────────────────────────────
 * · ⭐ **一棵树 ＝ 一个自然季**（春 3~5／夏 6~8／**秋 9~11**／冬 12~2）
 *   —— 不是日历季度（Q4 = 10/11/12 会把 12 月拖进冬天，跟第 5 期的枇杷打架）；
 * · ⭐ **一块 ＝ 一个月**；块心沿主干 **15% / 40% / 65%**
 *   ⚠️ **故意躲开三层侧枝**：侧枝正好着生在 **25% / 50% / 75%**
 *   （`grow.ts` 里 `trunkTiers: 3` ⇒ `k / (tiers + 1)`）；
 * · ⭐ **三块一样大、且首尾相接**（半高 12.5% ⇒ 相邻两块正好接上，⛔ 不留缝 ——
 *   留缝就会出现"点上去没反应"的死区）；
 * · ⭐ **下面那一块 ＝ 这个季度的第 1 个月**（往上 ＝ 时间往后）；
 * · ⭐ 三块都**在主干上**（用户原话：「三个区域一样大即可，因为**树干那一部分**
 *   都是一样粗的」⇒ 说的是"树干的一段"，不是"环"）。
 *
 * ⚠️ 这里**不发任何后端命令** —— "这个月哪几天写过"由调用方查好，
 *    `monthCells()` 只做"把查回来的日期映射到格子上"。
 */
import type { Vec3 } from "./grow.ts";

/** 树干上的一个「块」（＝ 一个点击区 ＝ 这个季度里的某一个月）。 */
export type TrunkBlock = {
  /** 第几块（0 ＝ 最下面那块 ＝ 这个季度的第 1 个月）。 */
  index: number;
  /** 块心沿主干的高度比例（0 ＝ 根，1 ＝ 梢）。 */
  frac: number;
  /** 块心（世界坐标，落在主干轴线上）。 */
  center: Vec3;
  /** 块的**下沿**（世界坐标，落在主干轴线上）。 */
  base: Vec3;
  /** 块的**上沿**（同上）。 */
  top: Vec3;
  /** 主干方向（单位向量）—— 薄壳要按它摆朝向。 */
  normal: Vec3;
  /**
   * 薄壳**下口**的外半径 ＝ 该处主干半径 × `BLOCK_SHELL_CLEARANCE`。
   * ⚠️ 三块的半径**不一样**（树干从根到梢收细 22%）——
   *    硬约束是"**每一处的外半径都 > 该处主干半径**"，⛔ 不是"三块共用一个数"。
   */
  rBase: number;
  /** 薄壳**上口**的外半径（同上）。 */
  rTop: number;
  /** 这一块有多高（世界单位）—— 验"三块一样大"要用。 */
  length: number;
  /** 这一块是几月（1~12）。 */
  month: number;
  /** 这个月有多少天（28/29/30/31）⇒ 面板里那张圆环图画几个格子。 */
  days: number;
};

/**
 * 三块的**块心**沿主干的高度比例。
 *
 * ⚠️ 侧枝着生点在 **25% / 50% / 75%**（见 `grow.ts` 的 `trunkTiers`），
 *    所以这三个数都取在"层与层之间"，且各自离侧枝 **10 个百分点**。
 */
export const BLOCK_FRACS = [0.15, 0.4, 0.65] as const;

/**
 * 每一块的**半高**（占主干长度的比例）。
 * ⚠️⚠️ 取 **0.125 ＝ 相邻两块间距（0.25）的一半** ⇒ 上下两块**正好接上**。
 *    ⛔ 取小 ⇒ 中间留缝，缝里点上去没反应，看着像"坏了"；
 *    ⛔ 取大 ⇒ 两块重叠，射线取最近的会把上一块判成下一块。
 */
export const BLOCK_HALF = 0.125;

/**
 * 薄壳外半径 ÷ 该处主干半径。
 *
 * ⚠️ 必须 **> 1**，否则薄壳陷进树皮里 —— 批次 1 在这上面栽过一次
 *    （当时给"三圈"取了三处主干半径的**平均**，结果最低那圈整个被树皮吞掉，
 *    **看不见也点不着**，而且**所有的断言都是绿的**，是画图核对时才发现的）。
 * ⚠️ 也不宜太大：薄壳是"贴着树皮的淡淡一层"，1.06 大约是在屏幕上多出 1~2 像素。
 */
export const BLOCK_SHELL_CLEARANCE = 1.06;

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

/** 把 `"YYYY-MM"` 拆成 `{ year, month }`；不合规返回 `null`。 */
export function parseMonthKey(monthKey: string): { year: number; month: number } | null {
  if (typeof monthKey !== "string" || monthKey.length < 7) return null;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
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
 * 摆三块年轮（树干上的三段）。
 *
 * @param trunkFrom 主干起点（`tree.branches` 里 `depth === 0` 那根的 `from`）
 * @param trunkTo   主干终点（同上那根的 `to`）
 * @param trunkR0   主干**根部**半径
 * @param trunkR1   主干**梢部**半径
 * @param monthKeys ⭐ 这个季度的三个月，**按时间先后**，形如 `["2026-09","2026-10","2026-11"]`
 *
 * ⚠️ 位置**必须从真实主干坐标算** —— `grow.ts` 给主干长度加了 ±5% 抖动
 *    （`trunkLength * (1 + wobble(0.05))`），写死坐标会对不准。
 * ⚠️ 主干在 `scene.ts` 里是 `CylinderGeometry(r1, r0, len, …)` ⇒ 半径沿主轴是**线性**的，
 *    所以这里直接线性插值就**严丝合缝**地贴在树皮上。
 */
export function trunkBlocks(
  trunkFrom: Vec3,
  trunkTo: Vec3,
  trunkR0: number,
  trunkR1: number,
  monthKeys: readonly string[]
): TrunkBlock[] {
  const axis: Vec3 = {
    x: trunkTo.x - trunkFrom.x,
    y: trunkTo.y - trunkFrom.y,
    z: trunkTo.z - trunkFrom.z,
  };
  const len = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
  if (len < 1e-9) throw new Error("主干长度是 0，算不出年轮摆在哪");
  const normal: Vec3 = { x: axis.x / len, y: axis.y / len, z: axis.z / len };

  /** 主干在比例 f 处的半径（线性 —— 与 `CylinderGeometry` 的锥面一致）。 */
  const at = (f: number): Vec3 => ({
    x: trunkFrom.x + axis.x * f,
    y: trunkFrom.y + axis.y * f,
    z: trunkFrom.z + axis.z * f,
  });
  const trunkRAt = (f: number): number => trunkR0 + (trunkR1 - trunkR0) * f;

  return BLOCK_FRACS.map((frac, i) => {
    // ⚠️ 夹在 [0,1]：将来若有人把 BLOCK_FRACS 挪到贴边，也不许把块伸到主干外面去。
    const f0 = Math.min(1, Math.max(0, frac - BLOCK_HALF));
    const f1 = Math.min(1, Math.max(0, frac + BLOCK_HALF));

    const key = monthKeys[i] ?? "";
    const parsed = parseMonthKey(key);
    return {
      index: i,
      frac,
      center: at(frac),
      base: at(f0),
      top: at(f1),
      normal,
      // ⭐ 各自按**该处**的主干半径放大一点点 ⇒ 处处露在树皮外面，且贴着树干收细。
      rBase: trunkRAt(f0) * BLOCK_SHELL_CLEARANCE,
      rTop: trunkRAt(f1) * BLOCK_SHELL_CLEARANCE,
      length: len * (f1 - f0),
      // ⚠️ 拿不到合法月份时给个"占位"（第 i+1 月），⛔ 不抛错 ——
      //    树是看的，不能因为一个参数就白屏（对应指令 C4）。
      month: parsed ? parsed.month : i + 1,
      days: parsed ? monthDays(parsed.year, parsed.month) : 30,
    };
  });
}

/** 圆环数据图上的一格（＝ 一天）。 */
export type RingCell = {
  /** 几号（1~28/29/30/31）。 */
  day: number;
  /** `"YYYY-MM-DD"` —— 跟日记的 `entry_date` 同一个口径。 */
  key: string;
  /** ⭐ 这一天写过日记（面板上点亮）。 */
  lit: boolean;
};

/**
 * 把"这个月查到的那几篇日记"映射成**一格一天**的圆环。
 *
 * @param monthKey `"YYYY-MM"`
 * @param entries  任意带 `entry_date` 的对象数组（`list_month` 的返回值就够）
 *
 * ⚠️ 格数按**当月实际天数**（28/29/30/31），⛔ 不是一律 31。
 * ⚠️ 只认 `entry_date` 前缀等于 `monthKey` 的条目 —— 传进来的数据若是脏的
 *    （跨月 / 空串 / `null`），这里**静默忽略**，⛔ 不抛错（面板不能因为一条脏数据白屏）。
 */
export function monthCells(
  monthKey: string,
  entries: readonly { entry_date?: string | null }[] | null | undefined
): RingCell[] {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return [];
  const n = monthDays(parsed.year, parsed.month);

  const written = new Set<string>();
  for (const e of entries ?? []) {
    const d = e?.entry_date;
    if (typeof d === "string" && d.slice(0, 7) === monthKey) written.add(d);
  }

  const out: RingCell[] = [];
  for (let day = 1; day <= n; day += 1) {
    const key = `${monthKey}-${String(day).padStart(2, "0")}`;
    out.push({ day, key, lit: written.has(key) });
  }
  return out;
}

/** 这个月的汇总（面板上那三行数字）。纯函数 ⇒ 可被单测守住。 */
export type MonthSummary = {
  /** 写了几篇。 */
  count: number;
  /** 一共多少字。 */
  words: number;
  /** 心情分布：`1~5` 各几篇（没标心情的不计入）。 */
  moods: number[];
};

/** 由 `list_month` 的结果算出面板要显示的三行数字。 */
export function monthSummary(
  entries: readonly { word_count?: number | null; mood?: number | null }[] | null | undefined
): MonthSummary {
  const moods = [0, 0, 0, 0, 0];
  let words = 0;
  let count = 0;
  for (const e of entries ?? []) {
    if (!e) continue;
    count += 1;
    const w = e.word_count;
    if (typeof w === "number" && Number.isFinite(w) && w > 0) words += w;
    const m = e.mood;
    if (typeof m === "number" && m >= 1 && m <= 5) moods[m - 1] += 1;
  }
  return { count, words, moods };
}
