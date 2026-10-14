/**
 * 「年轮／树干三段」纯函数的单测（零依赖，Node 22 原生跑 `.ts`）。
 *
 * ⚠️ 跑法：在 `app/` 下 `pnpm test:fe`
 *
 * ⭐ 这一批围绕**用户 2026-10-14 两次拍板**：
 *   ① 三个点击区都在**主干**上、是"树干上的一段"（⛔ 不是环）；
 *   ② 一块 ＝ 一个月；③ 一棵树 ＝ 一个**自然季**；
 *   ④ 三块**一样大**（「因为树干那一部分都是一样粗的」）；⑤ 三块**首尾相接、不留缝**。
 *
 * ⚠️⚠️ 老规矩：**每条"成立"的断言都要配一条"不成立才怪"的对照** ——
 *    光写"三块高度相等"，如果函数里写死了一个常数，它**照样绿**。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import { growTree, type Branch, type Vec3 } from "../src/tree/grow.ts";
import {
  BLOCK_FRACS,
  BLOCK_HALF,
  BLOCK_SHELL_CLEARANCE,
  monthCells,
  monthDays,
  monthSummary,
  parseMonthKey,
  seasonMonths,
  trunkBlocks,
} from "../src/tree/rings.ts";

/** 从真实长出来的一棵树里取主干（`depth === 0` 的那一根）。 */
function trunkOf(seed: number): Branch {
  const tree = growTree({ seed });
  const t = tree.branches.find((b) => b.depth === 0);
  assert.ok(t, "长出来的树里没有主干（depth === 0 的枝条）");
  return t;
}

/** 秋天（2026-10 ⇒ 9 / 10 / 11 月）。 */
const AUTUMN = seasonMonths(2026, 10);

const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vlen = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const vdot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const vcross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function closeTo(a: number, b: number, eps = 1e-9, msg = ""): void {
  assert.ok(Math.abs(a - b) < eps, `${msg}（实际 ${a}，期望 ${b}）`);
}

/** 主干在比例 f 处的半径 —— 与 `CylinderGeometry(锥面)` 同一套线性口径。 */
const trunkRAt = (t: Branch, f: number): number => t.r0 + (t.r1 - t.r0) * f;

// ---------------------------------------------------------------------------
// ⓪ 口径本身
// ---------------------------------------------------------------------------

test("⭐ 一棵树 ＝ 一个**自然季**（10 月 ⇒ 9 / 10 / 11）", () => {
  assert.deepEqual(seasonMonths(2026, 10), ["2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(seasonMonths(2026, 4), ["2026-03", "2026-04", "2026-05"]);
  assert.deepEqual(seasonMonths(2026, 7), ["2026-06", "2026-07", "2026-08"]);
  // ⚠️ 反例对照：**日历季度**（Q4 = 10/11/12）是**错的** ——
  //    12 月已经是冬天，该开第 5 期的枇杷花，跟秋天这棵树打架。
  assert.notDeepEqual(seasonMonths(2026, 10), ["2026-10", "2026-11", "2026-12"]);
});

test("⭐ 冬季跨年：1 月看到的是**上一年** 12 月", () => {
  assert.deepEqual(seasonMonths(2026, 1), ["2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(seasonMonths(2026, 2), ["2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(seasonMonths(2026, 12), ["2026-12", "2027-01", "2027-02"]);
});

test("⭐ 天数按**当月实际天数**（2 月不是 31 天）", () => {
  assert.equal(monthDays(2026, 2), 28);
  assert.equal(monthDays(2024, 2), 29);
  assert.equal(monthDays(2026, 4), 30);
  assert.equal(monthDays(2026, 12), 31);
  // ⚠️ 反例对照：若拿"一律 31"糊弄，这一条会红。
  assert.notEqual(monthDays(2026, 2), 31, "2 月给了 31 格 —— 说明格数根本没按月份算");
});

test("`parseMonthKey`：合规才认，坏数据给 null（⛔ 不抛错）", () => {
  assert.deepEqual(parseMonthKey("2026-09"), { year: 2026, month: 9 });
  assert.equal(parseMonthKey("坏数据"), null);
  assert.equal(parseMonthKey(""), null);
  assert.equal(parseMonthKey("2026-13"), null);
  assert.equal(parseMonthKey("abcd-09"), null);
});

// ---------------------------------------------------------------------------
// ① 三块的位置与大小
// ---------------------------------------------------------------------------

test("三块的**块心**比例 ＝ 15% / 40% / 65%", () => {
  const t = trunkOf(20260930);
  const blocks = trunkBlocks(t.from, t.to, t.r0, t.r1, AUTUMN);
  assert.equal(blocks.length, 3);
  blocks.forEach((b, i) => {
    closeTo(b.frac, BLOCK_FRACS[i], 1e-12, `第 ${i + 1} 块的块心比例不对`);
  });
  // ⚠️ 反例对照：**不能**是三处侧枝着生点（25/50/75），那样薄壳压在枝根上会糊成一团。
  const tierFracs = [0.25, 0.5, 0.75];
  for (const f of tierFracs) {
    assert.ok(
      BLOCK_FRACS.every((b) => Math.abs(b - f) > 0.09),
      `块心 ${f} 离侧枝着生点太近`
    );
  }
});

test("⭐ 三块**一样高**（用户：「三个区域一样大即可」）", () => {
  const t = trunkOf(20260930);
  const blocks = trunkBlocks(t.from, t.to, t.r0, t.r1, AUTUMN);
  const lens = blocks.map((b) => b.length);
  const rel = (Math.max(...lens) - Math.min(...lens)) / Math.max(...lens);
  assert.ok(rel < 0.005, `三块高度相对差 ${(rel * 100).toFixed(3)}% —— 超过 0.5%`);
  // ⚠️ 反例对照：三块高度也不该是"0"（真长出来了），也不该等于整个主干长度。
  const trunkLen = vlen(vsub(t.to, t.from));
  assert.ok(lens[0] > 0.1 * trunkLen, "块太矮了");
  assert.ok(lens[0] < 0.5 * trunkLen, "块太高了（几乎盖满整根主干）");
});

test("⭐⭐ 相邻两块**首尾相接**（⛔ 不留缝 —— 缝里点上去会没反应）", () => {
  const t = trunkOf(20260930);
  const blocks = trunkBlocks(t.from, t.to, t.r0, t.r1, AUTUMN);
  for (let i = 0; i < blocks.length - 1; i += 1) {
    const gap = vlen(vsub(blocks[i + 1].base, blocks[i].top));
    closeTo(gap, 0, 1e-9, `第 ${i + 1} 块与第 ${i + 2} 块之间有条 ${gap} 的缝`);
  }
  // ⚠️ 反例对照：**块与块也不许重叠**（重叠 ⇒ 射线取最近的会判错块）。
  for (let i = 0; i < blocks.length - 1; i += 1) {
    const overlap = vdot(
      vsub(blocks[i + 1].base, blocks[i].top),
      blocks[i].normal
    );
    assert.ok(overlap > -1e-9, `第 ${i + 1} / ${i + 2} 块重叠了 ${-overlap}`);
  }
});

test("⭐ 三块都**套在主干轴线**上（离轴量 0）", () => {
  const t = trunkOf(20260930);
  const blocks = trunkBlocks(t.from, t.to, t.r0, t.r1, AUTUMN);
  for (const b of blocks) {
    // 点到直线的距离 ＝ |(P − F) × n|
    const off = vlen(vcross(vsub(b.center, t.from), b.normal));
    assert.ok(off < 1e-12, `第 ${b.index + 1} 块离主干轴线 ${off}`);
    // 上/下沿同样要落在轴线上
    assert.ok(vlen(vcross(vsub(b.base, t.from), b.normal)) < 1e-12);
    assert.ok(vlen(vcross(vsub(b.top, t.from), b.normal)) < 1e-12);
  }
  // ⚠️ 反例对照：法线必须是**单位向量**，否则上面那个"×"算出来的不是距离。
  for (const b of blocks) closeTo(vlen(b.normal), 1, 1e-12, "法线不是单位向量");
});

test("⭐⭐ 每一处薄壳都**露在树皮外面**（批次 1 栽过的那一条）", () => {
  const t = trunkOf(20260930);
  const blocks = trunkBlocks(t.from, t.to, t.r0, t.r1, AUTUMN);
  blocks.forEach((b) => {
    const f0 = b.frac - BLOCK_HALF;
    const f1 = b.frac + BLOCK_HALF;
    assert.ok(
      b.rBase > trunkRAt(t, f0),
      `第 ${b.index + 1} 块**下口**陷进树皮（壳 ${b.rBase} ≤ 主干 ${trunkRAt(t, f0)}）`
    );
    assert.ok(
      b.rTop > trunkRAt(t, f1),
      `第 ${b.index + 1} 块**上口**陷进树皮（壳 ${b.rTop} ≤ 主干 ${trunkRAt(t, f1)}）`
    );
  });

  /*
   * ⚠️⚠️ **反例对照（这一条才是这个用例的价值）**：
   * 批次 1 的第一版给"三圈"取了**三处主干半径的平均值**当共用半径 ——
   * 树干从根到梢收细 22%，平均值**比最低那处的主干半径还小** ⇒ 最低那圈整个陷进树皮，
   * **看不见也点不着**，而且**当时所有断言都是绿的**（是画图核对时才发现的）。
   * 这里把那个错法**显式算一遍**，证明"取平均"必然出事 ⇒ 现在的"逐点 × 余量"不是多余的。
   */
  const avg =
    BLOCK_FRACS.reduce((s, f) => s + trunkRAt(t, f), 0) / BLOCK_FRACS.length;
  const lowestBase = trunkRAt(t, BLOCK_FRACS[0] - BLOCK_HALF);
  assert.ok(
    lowestBase > avg,
    "反例对照失效：最低那处的主干半径竟然不比平均值大，说明这棵树没在收细"
  );
});

test("⭐ 三块的外半径**贴着树干收细**（不是一根等粗的筒）", () => {
  const t = trunkOf(20260930);
  const blocks = trunkBlocks(t.from, t.to, t.r0, t.r1, AUTUMN);
  // 越靠上 ⇒ 树干越细 ⇒ 壳也越细
  assert.ok(blocks[0].rBase > blocks[2].rBase, "最下面那块竟然比最上面那块细");
  // ⚠️ 反例对照：也不能细成 0 或负数（坏数据）。用一棵"上下一样粗"的人造主干看边界。
  const straight = trunkBlocks({ x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, 0.1, 0.1, AUTUMN);
  straight.forEach((b) => {
    closeTo(b.rBase, 0.1 * BLOCK_SHELL_CLEARANCE, 1e-12, "等粗主干的壳半径不对");
    closeTo(b.rTop, 0.1 * BLOCK_SHELL_CLEARANCE, 1e-12, "等粗主干的壳半径不对");
  });
});

test("⭐ 换一根**更长的**主干 ⇒ 块跟着变长（不是写死的坐标）", () => {
  const one = trunkBlocks({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.1, 0.08, AUTUMN);
  const two = trunkBlocks({ x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, 0.1, 0.08, AUTUMN);
  closeTo(two[0].length / one[0].length, 2, 1e-9, "主干长一倍，块没跟着长一倍");
  // ⚠️ 反例对照：位置也是按比例走的，不是"两倍长度 ⇒ 同一个中点"。
  closeTo(one[0].center.y * 2, two[0].center.y, 1e-9, "块心没跟着主轴按比例走");
});

// ---------------------------------------------------------------------------
// ② 月份 / 天数 / 坏数据
// ---------------------------------------------------------------------------

test("⭐ 下面那一块 ＝ 这个季度的第 1 个月（往上 ＝ 时间往后）", () => {
  const t = trunkOf(20260930);
  const blocks = trunkBlocks(t.from, t.to, t.r0, t.r1, AUTUMN);
  assert.deepEqual(blocks.map((b) => b.month), [9, 10, 11]);
  assert.deepEqual(blocks.map((b) => b.days), [30, 31, 30]);
  // ⚠️ 反例对照：不能是倒着的（那会把"往上 ＝ 时间往后"这句反过来说）。
  assert.notDeepEqual(blocks.map((b) => b.month), [11, 10, 9]);
  // ⚠️ 也不能拿"一律 31 天"糊弄
  assert.notDeepEqual(blocks.map((b) => b.days), [31, 31, 31]);
});

test("⭐ 月份数据坏了也**不抛错**（给占位，⛔ 不白屏）", () => {
  const t = trunkOf(20260930);
  const blocks = trunkBlocks(t.from, t.to, t.r0, t.r1, ["坏数据", "", "2026-10"]);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.month), [1, 2, 10]);
  assert.deepEqual(blocks.map((b) => b.days), [30, 30, 31]);
});

test("⛔ 主干长度为 0 ⇒ 明确报错（不是算出一堆 NaN）", () => {
  assert.throws(
    () => trunkBlocks({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0.1, 0.08, AUTUMN),
    /主干长度/,
    "零长度主干应当明确报错"
  );
});

// ---------------------------------------------------------------------------
// ③ 面板那张「圆环数据图」的纯计算
// ---------------------------------------------------------------------------

test("⭐ `monthCells`：有 5 天写过 ⇒ 恰好 5 格亮，格数 ＝ 当月天数", () => {
  const entries = [
    { entry_date: "2026-09-03" },
    { entry_date: "2026-09-07" },
    { entry_date: "2026-09-08" },
    { entry_date: "2026-09-21" },
    { entry_date: "2026-09-30" },
  ];
  const cells = monthCells("2026-09", entries);
  assert.equal(cells.length, 30, "9 月应当是 30 格");
  assert.equal(cells.filter((c) => c.lit).length, 5, "亮着的格子数不对");
  assert.deepEqual(
    cells.filter((c) => c.lit).map((c) => c.day),
    [3, 7, 8, 21, 30],
    "亮的是哪几天不对"
  );
  // 日期字符串口径：跟日记的 `entry_date` 同格式
  assert.equal(cells[0].key, "2026-09-01");
  assert.equal(cells[29].key, "2026-09-30");
  // ⚠️ 反例对照：**没写的那天必须不亮** —— 否则上面"恰好 5 格"会变成"30 格全亮"也绿。
  assert.equal(cells[0].lit, false, "1 号没写过，却亮着");
});

test("⭐ `monthCells`：空库 ⇒ 全暗；坏月份 ⇒ 空数组（⛔ 不抛错）", () => {
  const empty = monthCells("2026-09", []);
  assert.equal(empty.length, 30);
  assert.equal(empty.filter((c) => c.lit).length, 0, "空库竟然有点亮的格子");
  assert.deepEqual(monthCells("坏数据", [{ entry_date: "2026-09-01" }]), []);
  assert.deepEqual(monthCells("2026-09", null), monthCells("2026-09", []));
});

test("⭐ `monthCells`：**跨月 / 脏数据**的条目不点亮（静默忽略）", () => {
  const cells = monthCells("2026-09", [
    { entry_date: "2026-10-01" }, // 别的月份
    { entry_date: "" },
    { entry_date: null },
    { entry_date: "2026-09-15" }, // 只有这一条算数
  ]);
  assert.deepEqual(cells.filter((c) => c.lit).map((c) => c.day), [15]);
  // ⚠️ 反例对照：不能因为"有条 2026-10-01"就把整月判成有数据
  assert.equal(cells.filter((c) => c.lit).length, 1);
});

test("⭐ `monthCells` 闰年 2 月 ＝ 29 格", () => {
  assert.equal(monthCells("2024-02", []).length, 29);
  assert.equal(monthCells("2026-02", []).length, 28);
});

test("⭐ `monthSummary`：篇数 / 字数 / 心情分布", () => {
  const s = monthSummary([
    { word_count: 120, mood: 5 },
    { word_count: 80, mood: null },
    { word_count: 0, mood: 3 },
    { word_count: null, mood: 5 },
  ]);
  assert.equal(s.count, 4, "篇数不对");
  assert.equal(s.words, 200, "字数不对（0 与 null 都不该加进去）");
  assert.deepEqual(s.moods, [0, 0, 1, 0, 2], "心情分布不对");
  // ⚠️ 反例对照：心情表长度必须是 5（对应 `MOODS` 的 1~5 档）
  assert.equal(monthSummary([]).moods.length, 5);
  assert.deepEqual(monthSummary(null), { count: 0, words: 0, moods: [0, 0, 0, 0, 0] });
});

// ---------------------------------------------------------------------------
// ④ 纯函数纪律
// ---------------------------------------------------------------------------

test("⛔ 文件里没有 `Math.random`（同一输入必须同一输出）", () => {
  const src = readFileSync(new URL("../src/tree/rings.ts", import.meta.url), "utf8");
  // ⚠️ 反例对照：先确认读到的是**真源码**（能搜到一个确实存在的串），
  //    否则"搜不到 Math.random"可能只是因为读了个空文件。
  assert.ok(src.includes("trunkBlocks"), "连函数名都搜不到 —— 说明读到的不是源码");
  assert.ok(!src.includes("Math.random"), "rings.ts 里出现了 Math.random —— 块的位置就不稳定了");
});

test("⛔ 文件里没有 `three`（纯函数要能被零依赖单测守住）", () => {
  const src = readFileSync(new URL("../src/tree/rings.ts", import.meta.url), "utf8");
  assert.ok(src.includes("trunkBlocks"), "连函数名都搜不到 —— 说明读到的不是源码");
  assert.ok(!/from\s+["']three/.test(src), "rings.ts 引入了 three —— 单测就跑不动了");
});
