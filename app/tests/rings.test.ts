/**
 * 「年轮环」纯函数的单测（零依赖，Node 22 原生跑 `.ts`）。
 *
 * ⚠️ 跑法：在 `app/` 下 `pnpm test:fe`
 *
 * ⭐ 这一批全部围绕**用户 2026-10-14 拍的那几条**：
 *   ① 三个点击区都在**主干**上；② 一圈 ＝ 一个月；③ 一棵树 ＝ 一个**自然季**；
 *   ④ 三个区域**一样大**（「因为树干那一部分都是一样粗的」）。
 *
 * ⚠️⚠️ 老规矩：**每条"成立"的断言都要配一条"不成立才怪"的对照** ——
 *    光写"三个半径相等"，如果函数里写死了一个常数，它**照样绿**。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import { growTree, type Branch, type Vec3 } from "../src/tree/grow.ts";
import {
  RING_FRACS,
  RING_RADIUS_CLEARANCE,
  RING_TUBE_RATIO,
  monthDays,
  ringLayout,
  seasonMonths,
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

function closeTo(a: number, b: number, eps = 1e-9, msg = ""): void {
  assert.ok(Math.abs(a - b) < eps, `${msg}（实际 ${a}，期望 ${b}）`);
}

// ---------------------------------------------------------------------------
// ⓪ 口径本身
// ---------------------------------------------------------------------------

test("⭐ 一棵树 ＝ 一个**自然季**（10 月 ⇒ 9 / 10 / 11）", () => {
  assert.deepEqual(seasonMonths(2026, 10), ["2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(seasonMonths(2026, 4), ["2026-03", "2026-04", "2026-05"]);
  assert.deepEqual(seasonMonths(2026, 7), ["2026-06", "2026-07", "2026-08"]);
  // ⚠️ 反例对照：**日历季度**会给出 10/11/12 —— 那会把 12 月拖进冬天，
  //    跟第 5 期的枇杷打架。这里必须**不是**那个答案。
  assert.notDeepEqual(seasonMonths(2026, 10), ["2026-10", "2026-11", "2026-12"]);
});

test("⚠️ 冬季跨年：1 月看到的是**上一年**的 12 月（不是未来的 12 月）", () => {
  assert.deepEqual(seasonMonths(2026, 1), ["2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(seasonMonths(2026, 2), ["2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(seasonMonths(2026, 12), ["2026-12", "2027-01", "2027-02"]);
});

test("格数 ＝ 当月**实际**天数（闰年也算对）", () => {
  assert.equal(monthDays(2026, 2), 28);
  assert.equal(monthDays(2024, 2), 29);
  assert.equal(monthDays(2026, 4), 30);
  assert.equal(monthDays(2026, 12), 31);
  // ⚠️ 反例对照：如果实现写死 31，上面第一条就抓得住；这条把话说死。
  assert.notEqual(monthDays(2026, 2), 31, "2 月给了 31 格 —— 说明格数根本没按月份算");
});

// ---------------------------------------------------------------------------
// ① 三圈摆在哪
// ---------------------------------------------------------------------------

test("⭐ 三圈**一样大**（半径两两之差 < 0.5%）", () => {
  const t = trunkOf(20260930);
  const rings = ringLayout(t.from, t.to, t.r0, t.r1, AUTUMN);
  assert.equal(rings.length, 3, "不是三圈");

  const rs = rings.map((r) => r.radius);
  const max = Math.max(...rs);
  const min = Math.min(...rs);
  assert.ok(max > 0, "环半径是 0 —— 这条断言没有意义");
  assert.ok((max - min) / min < 0.005, `三圈半径不齐：${rs.join(" / ")}`);

  // ⚠️ 反例对照：主干根部与梢部半径**确实不同**（0.105 → 0.082）。
  //    不然"取平均"这件事根本没被验到 —— 随便写个常数也能绿。
  assert.ok(t.r0 > t.r1 * 1.1, "主干根部没有明显比梢部粗，这条对照失去意义");
});

test("⚠️ 三圈必须**露在树皮外面**（陷进去就看不见、也点不着）", () => {
  /*
   * ⚠️⚠️ 这一条是**画图核对时才发现要加的**：主干从根到梢收细 22%，
   *    三处主干半径是 0.1015 / 0.0958 / 0.0900。第一版把环半径取成三者的
   *    **平均**（0.0958），结果**最低那圈整个被树皮吞掉**。
   *    ⇒ 环半径必须比它所在处的主干半径**再大一个管径**。
   */
  const t = trunkOf(20260930);
  const rings = ringLayout(t.from, t.to, t.r0, t.r1, AUTUMN);
  const tube = rings[0].radius * RING_TUBE_RATIO;
  assert.ok(tube > 0, "管径是 0，这条断言没有意义");
  rings.forEach((r, i) => {
    const rHere = t.r0 + (t.r1 - t.r0) * r.frac; // 这一圈所在处的主干半径
    assert.ok(
      r.radius - tube > rHere,
      `第 ${i + 1} 圈（主干半径 ${rHere.toFixed(4)}）陷进树皮里了：环内缘 ${(r.radius - tube).toFixed(4)}`
    );
  });
});

test("⭐ 三圈都**套在主干上**（环心到主干轴线距离 ≈ 0）", () => {
  const t = trunkOf(20260930);
  const rings = ringLayout(t.from, t.to, t.r0, t.r1, AUTUMN);
  const axis = vsub(t.to, t.from);
  const axisLen = vlen(axis);

  for (const [i, r] of rings.entries()) {
    const rel = vsub(r.center, t.from);
    const along = vdot(rel, axis) / axisLen; // 投到主干上的长度
    const proj: Vec3 = {
      x: (axis.x / axisLen) * along,
      y: (axis.y / axisLen) * along,
      z: (axis.z / axisLen) * along,
    };
    const off = vlen(vsub(rel, proj));
    // ① 必须落在轴线上（不是浮在空中、也不是套在枝上）
    assert.ok(off < 1e-9, `第 ${i + 1} 圈没套在主干轴线上，偏了 ${off}`);
    // ② 也必须落在主干**两端之间**（不能跑到树干外面的空气里）
    assert.ok(along > 0 && along < axisLen, `第 ${i + 1} 圈跑出主干两端之外了`);
    // ③ 偏心量必须远远小于主干半径（这条把"套歪了"也堵住）
    closeTo(off, 0, t.r0 * 0.5, `第 ${i + 1} 圈偏心太大`);
  }
});

test("⚠️ 三圈**上下排开**（高度互不相同、越往上越高）", () => {
  const t = trunkOf(20260930);
  const rings = ringLayout(t.from, t.to, t.r0, t.r1, AUTUMN);
  const axis = vsub(t.to, t.from);
  const axisLen = vlen(axis);
  const fracs = rings.map((r) => vdot(vsub(r.center, t.from), axis) / (axisLen * axisLen));

  // 应当正好是指定的那三个比例
  fracs.forEach((f, i) => closeTo(f, RING_FRACS[i], 1e-9, `第 ${i + 1} 圈的高度比例不对`));
  // 严格递增
  assert.ok(fracs[1] > fracs[0] && fracs[2] > fracs[1], `高度没有递增：${fracs.join(" / ")}`);
  // ⚠️ 反例对照：间距必须**真的存在**（同心套叠的话这三条会全相等）
  assert.ok(fracs[1] - fracs[0] > 0.2, "相邻两圈挨得太近，看着就是「叠在一起」");
});

test("⚠️ 三圈要躲开三层侧枝（侧枝在 25% / 50% / 75%）", () => {
  // 依据：`grow.ts` 的 `trunkTiers: 3` ⇒ 侧枝着生比例是 k/(tiers+1) = 25/50/75%。
  // 环压在枝根上会跟枝糊成一团，所以三圈必须落在**层与层之间**。
  const tierFracs = [0.25, 0.5, 0.75];
  for (const f of RING_FRACS) {
    for (const tf of tierFracs) {
      assert.ok(Math.abs(f - tf) > 0.05, `有一圈(在 ${f})离侧枝着生点(${tf})太近了`);
    }
  }
});

test("⭐ 下面那一圈 ＝ 季度**第 1 个月**（往上 ＝ 时间往后）", () => {
  const t = trunkOf(20260930);
  const rings = ringLayout(t.from, t.to, t.r0, t.r1, AUTUMN);
  assert.deepEqual(
    rings.map((r) => r.month),
    [9, 10, 11],
    "三个环的月份顺序不对"
  );
  assert.deepEqual(
    rings.map((r) => r.days),
    [30, 31, 30],
    "格数不是各月实际天数"
  );
});

test("⭐ 反例对照：换一根主干 ⇒ 环的位置与大小**跟着变**", () => {
  // ⚠️ 这一条专门堵"位置是写死的" —— 主干长度在 `grow.ts` 里带 ±5% 抖动，
  //    半径也随树而变。写死坐标的话下面两条会立刻红。
  const a = trunkOf(20260930);
  const b = trunkOf(12345);
  const ra = ringLayout(a.from, a.to, a.r0, a.r1, AUTUMN);
  const rb = ringLayout(b.from, b.to, b.r0, b.r1, AUTUMN);

  assert.notEqual(ra[2].center.y, rb[2].center.y, "换了主干、高度却一样 —— 坐标是写死的");

  /*
   * ⚠️ 这里原本还断言"换种子 ⇒ 半径也变"，**实测不成立、是我记错了**：
   *    `grow.ts` 里主干的**半径是固定值**（`trunkRadius: 0.105`，不参与抖动），
   *    带 ±5% 抖动的只有**长度**。⇒ 半径这条改用**不同粗细的人造主干**来验。
   */
  const thin = ringLayout({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.1, 0.08, AUTUMN);
  const thick = ringLayout({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.2, 0.16, AUTUMN);
  assert.ok(
    thick[0].radius > thin[0].radius * 1.9,
    "主干粗了一倍、环半径却没跟着变 —— 半径是写死的"
  );
  // 而且要**正好等于"主干最粗处 × 余量"**（"一样大"的口径就是这么来的）
  const maxR = Math.max(...RING_FRACS.map((t) => 0.1 + (0.08 - 0.1) * t));
  closeTo(thin[0].radius, maxR * RING_RADIUS_CLEARANCE, 1e-9, "环半径不是按主干最粗处算的");

  // 再用两根**人造**主干把话说明白：高度必须正比于主干长度。
  const one = ringLayout({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.1, 0.08, AUTUMN);
  const two = ringLayout({ x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, 0.1, 0.08, AUTUMN);
  closeTo(one[2].center.y, 0.65, 1e-9, "1 单位长的主干，第 3 圈应当在 0.65 处");
  closeTo(two[2].center.y, 1.3, 1e-9, "2 单位长的主干，第 3 圈应当在 1.3 处");
});

test("环的法线＝主干方向（单位向量）", () => {
  const t = trunkOf(20260930);
  const rings = ringLayout(t.from, t.to, t.r0, t.r1, AUTUMN);
  const axis = vsub(t.to, t.from);
  const unit = { x: axis.x / vlen(axis), y: axis.y / vlen(axis), z: axis.z / vlen(axis) };
  for (const r of rings) {
    closeTo(vlen(r.normal), 1, 1e-9, "法线不是单位向量");
    closeTo(r.normal.y, unit.y, 1e-9, "法线没跟主干对齐");
  }
  // 主干是竖直的 ⇒ 法线应当朝 ±Y（这条同时证明"环是水平的，像箍"）
  assert.ok(Math.abs(unit.y) > 0.99, "主干竟然不是竖直的，取景与环的朝向都要重看");
});

// ---------------------------------------------------------------------------
// ② 边界：数据不合法时不许炸
// ---------------------------------------------------------------------------

test("拿不到合法月份时也不抛错（树是看的，不能因为一个参数白屏）", () => {
  const t = trunkOf(20260930);
  const rings = ringLayout(t.from, t.to, t.r0, t.r1, ["坏数据", "", "2026-10"]);
  assert.equal(rings.length, 3, "兜底时也必须给出三圈");
  assert.equal(rings[2].month, 10, "合法的那一个不该被兜底改掉");
  assert.equal(rings[2].days, 31);
  assert.ok(rings[0].days > 0 && rings[1].days > 0, "兜底月份的格数必须是正数（不能是 0 或 NaN）");
});

test("主干长度为 0 时**明确报错**（不是悄悄给一堆 NaN）", () => {
  assert.throws(
    () => ringLayout({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0.1, 0.08, AUTUMN),
    /主干长度/,
    "零长度主干应当明确报错"
  );
});

// ---------------------------------------------------------------------------
// ③ 纯函数纪律
// ---------------------------------------------------------------------------

test("⛔ 文件里没有 `Math.random`（同一输入必须同一输出）", () => {
  const src = readFileSync(new URL("../src/tree/rings.ts", import.meta.url), "utf8");
  // ⚠️ 反例对照：先确认读到的是**真源码**（能搜到一个确实存在的串），
  //    否则"搜不到 Math.random"可能只是因为读了个空文件。
  assert.ok(src.includes("ringLayout"), "连函数名都搜不到 —— 说明读到的不是源码");
  assert.ok(!src.includes("Math.random"), "rings.ts 里出现了 Math.random —— 环的位置就不稳定了");
});

test("⛔ 文件里没有 `three`（纯函数要能被零依赖单测守住）", () => {
  const src = readFileSync(new URL("../src/tree/rings.ts", import.meta.url), "utf8");
  assert.ok(src.includes("ringLayout"), "连函数名都搜不到 —— 说明读到的不是源码");
  assert.ok(!/from\s+["']three/.test(src), "rings.ts 引入了 three —— 单测就跑不动了");
});
