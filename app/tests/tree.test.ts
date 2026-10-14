/**
 * 「长树」纯函数的单测（零依赖，Node 22 原生跑 `.ts`）。
 *
 * ⚠️ 跑法：在 `app/` 下 `pnpm test:fe`
 *    （⛔ 别自己写 `node --test` 带上那个 glob —— 在 Windows 下它会把目录
 *      当成 CJS 模块去加载；`package.json` 里那份已经写对了）。
 *
 * ⭐ 这批断言全部围绕 **A2 那条拍板**（"同一颗种子 ⇒ 同一棵树"）。
 *    ⚠️⚠️ 光有"跑两次结果一样"是**不够的** —— 如果 `growTree` 根本不看种子
 *    （比如内部写死了几个常数），那条断言**照样绿，却什么都没证明**。
 *    所以下面第 2 条是**反例对照**：换个种子**必须**长出另一棵树。
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { DEFAULT_GROW, growTree, type Tree, type Vec3 } from "../src/tree/grow.ts";

/** 把结果压成字符串，用来做"两次跑是否逐字节相同"的比较。 */
const dump = (t: Tree): string => JSON.stringify(t);

test("同一个种子 ⇒ 逐字节完全相同", () => {
  const a = growTree({ seed: 12345 });
  const b = growTree({ seed: 12345 });
  assert.equal(dump(a), dump(b), "同种子两次跑出了不同的树");
  // ⚠️ 顺手确认这棵树**不是空的** —— 否则"两棵空树相等"也是真的。
  assert.ok(a.branches.length > 0, "一棵树枝条数为 0，这条断言就没有意义");
  assert.ok(a.tips.length > 0, "一棵树挂点数为 0，这条断言就没有意义");
});

test("⭐ 反例对照：换个种子 ⇒ 长出的必须是另一棵树", () => {
  // 没有这一条，"同种子一致"可能只是因为不管喂什么都返回同一棵树。
  const a = growTree({ seed: 12345 });
  const b = growTree({ seed: 54321 });
  assert.notEqual(dump(a), dump(b), "换了种子却长出完全一样的树 —— 种子根本没被用上");
});

test("分叉数随深度增长（每一级都比上一级多）", () => {
  const counts = [2, 3, 4, 5].map((d) => growTree({ seed: 7, maxDepth: d }).branches.length);
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(
      counts[i] > counts[i - 1],
      `深度第 ${i + 2} 级的枝条数(${counts[i]})没有比上一级(${counts[i - 1]})多，序列=${counts}`
    );
  }
});

test("挂点数量在合理区间", () => {
  const t = growTree({ seed: 7 });
  // 太少 ⇒ 树冠是光的；太多 ⇒ 批次 3 挂花叶时会爆量。
  // ⚠️ 调整轮把 maxDepth 从 5 降到 4（用户："树枝太密"）⇒ 挂点跟着从 72 降到约 16。
  assert.ok(t.tips.length >= 12, `挂点只有 ${t.tips.length} 个，树冠会太稀`);
  assert.ok(t.tips.length <= 500, `挂点多到 ${t.tips.length} 个，批次 3 挂花叶会拖慢`);
});

test("结构连通：每根分枝的根，都**落在某根上一级枝条上**", () => {
  const t = growTree({ seed: 99 });
  const byDepth = new Map<number, typeof t.branches>();
  for (const b of t.branches) {
    const list = byDepth.get(b.depth) ?? [];
    list.push(b);
    byDepth.set(b.depth, list);
  }
  const parents = byDepth.get(0) ?? [];
  assert.equal(parents.length, 1, "主干应该只有一根");

  /**
   * ⚠️ 调整轮改判据：原来要求"根**恰好等于**父枝的梢"。
   *    但"主干沿途出 3 层侧枝"这个新做法，侧枝的根**落在主干的中段上**
   *    （这正是真树的"层性"）⇒ 旧判据会把正确的树判成"悬空"。
   * ⭐ 新判据：根必须落在父枝**那一段线段上**（含两端），而不是只在端点上。
   */
  const onSegment = (p: Vec3, a: Vec3, b: Vec3): boolean => {
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
    const l2 = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
    if (l2 < 1e-12) return Math.hypot(ap.x, ap.y, ap.z) < 1e-6;
    const u = (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / l2;
    if (u < -1e-6 || u > 1 + 1e-6) return false;
    const proj = { x: a.x + ab.x * u, y: a.y + ab.y * u, z: a.z + ab.z * u };
    return Math.hypot(p.x - proj.x, p.y - proj.y, p.z - proj.z) < 1e-6;
  };

  for (const b of t.branches) {
    if (b.depth === 0) continue;
    const up = byDepth.get(b.depth - 1) ?? [];
    const hit = up.some((p) => onSegment(b.from, p.from, p.to));
    assert.ok(hit, `第 ${b.depth} 级有枝条悬空：它的根没落在任何上一级枝条上`);
  }
});

test("半径逐级变细，⛔ 不会出现子枝比父枝还粗", () => {
  const t = growTree({ seed: 99 });
  const byDepth = new Map<number, typeof t.branches>();
  for (const b of t.branches) {
    const list = byDepth.get(b.depth) ?? [];
    list.push(b);
    byDepth.set(b.depth, list);
  }
  /** 点到线段的最短距离（判"根扎在哪根父枝上"用）。 */
  const distToSegment = (p: Vec3, a: Vec3, b: Vec3): number => {
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
    const l2 = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
    const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / l2));
    const proj = { x: a.x + ab.x * u, y: a.y + ab.y * u, z: a.z + ab.z * u };
    return Math.hypot(p.x - proj.x, p.y - proj.y, p.z - proj.z);
  };
  for (const b of t.branches) {
    assert.ok(b.r1 <= b.r0, "枝条从根到梢没有变细");
    if (b.depth === 0) continue;
    const up = byDepth.get(b.depth - 1) ?? [];
    // ⚠️ 同上：父枝是"根落在其上的那一段"，不一定是梢。
    const parent = up.find((p) => distToSegment(b.from, p.from, p.to) < 1e-6);
    assert.ok(parent, "找不到父枝（前一条断言应该已经报出来了）");
    // ⚠️ 侧枝的根半径是按"着生处主干半径"给的，所以跟父枝的 `r1` 比要留余量。
    assert.ok(b.r0 <= parent!.r0 + 1e-9, "子枝的根比父枝的根还粗");
  }
});

test("深度不超过上限，且真的用到了这个上限", () => {
  const t = growTree({ seed: 3, maxDepth: 4 });
  assert.equal(t.maxDepth, 4);
  const deepest = Math.max(...t.branches.map((b) => b.depth));
  assert.equal(deepest, 4, "没有长到设定的深度，树会显得被砍了一半");
  // D5 的红线：≤ 8。这里顺手把它钉成断言，改配置时越线会当场红。
  assert.ok(DEFAULT_GROW.maxDepth <= 8, "默认分枝深度超过了 D5 定的红线 8");
});

test("主干明显：只有一根，而且是最粗的", () => {
  const t = growTree({ seed: 5 });
  const trunk = t.branches.filter((b) => b.depth === 0);
  assert.equal(trunk.length, 1);
  const thickest = Math.max(...t.branches.map((b) => b.r0));
  assert.equal(trunk[0].r0, thickest, "最粗的枝条不是主干 ⇒ 主干不明显");
  assert.ok(trunk[0].r0 > trunk[0].r1, "主干从根到梢没有收细（会像一根塑料管）");
});

test("树高为正、且长在地面之上", () => {
  const t = growTree({ seed: 5 });
  assert.ok(t.height > 0.5, `树高只有 ${t.height}，太矮了`);
  for (const b of t.branches) {
    assert.ok(b.to.y > -0.05, "有枝条长到地面以下去了");
  }
});

// ---------------------------------------------------------------------------
// ⭐⭐ 调整轮新增：**枝条走向**（用户 2026-10-14 亲口纠的那条）
//
// 用户原话：
//   「真实的树都是**大部分向斜上方生长**，**一部分向平行于地面的四周生长**，
//     **向下生长的不好看都被裁剪掉了**」
//
// 尺子用园艺学的**垂直角**（枝条与竖直主干的夹角），分档见多份权威来源：
//   · 《苏州市居住区绿化养护技术规程》（政府文件）：「主枝**向上斜伸**，
//     与主干成约 **45~60°**」（卵圆形／倒卵形／伞形都是这一档）；
//   · 《果树修剪技术概要》：「**40~60° 半开张、60~80° 开张、90° 左右水平、
//     >90° 下垂**」——**下垂枝是缺陷、要疏除**；
//   · 华东师大《Tree architecture…》：**<30° 直立、30~60° 斜生、>60° 水平**。
// ---------------------------------------------------------------------------

const DEG = 180 / Math.PI;

/** 一根枝条的**垂直角**（与竖直方向的夹角，度）。 */
function verticalAngle(from: Vec3, to: Vec3): number {
  const dy = to.y - from.y;
  const len = Math.hypot(to.x - from.x, dy, to.z - from.z);
  return len < 1e-9 ? 0 : Math.acos(Math.max(-1, Math.min(1, dy / len))) * DEG;
}

/** 树冠里的枝条（depth ≥ 2；主干和它下面一级是"骨架"，不参与树冠形态判断）。 */
function crownAngles(t: Tree): number[] {
  return t.branches.filter((b) => b.depth >= 2).map((b) => verticalAngle(b.from, b.to));
}

test("⭐⭐ 枝条大部分是斜生／水平（30~90°），⛔ 几乎没有下垂枝（>90°）", () => {
  const angles = crownAngles(growTree({ seed: 20260930 }));
  assert.ok(angles.length > 0, "树冠里一根枝都没有，这条断言就没有意义");

  const slanted = angles.filter((a) => a >= 30 && a < 90).length / angles.length;
  const drooping = angles.filter((a) => a > 92).length / angles.length; // 留 2° 余量

  // 用户说的"大部分斜上方"—— 30~90° 这一段必须是压倒性的主体。
  assert.ok(slanted > 0.7, `斜生＋水平只占 ${(slanted * 100).toFixed(0)}%，不到 70% —— 树冠不像真树`);
  // 用户说的"向下生长的不好看都被裁剪掉了"。
  assert.ok(drooping < 0.08, `下垂枝占到 ${(drooping * 100).toFixed(0)}%，真树里这些都是要剪掉的`);
});

test("⭐ 反例对照：参数调歪 ⇒ 上面那条必须真的不成立", () => {
  // ⚠️ 这条最容易被写成一个"假绿"：
  //    第一版我写的是「把 bias 归零 ⇒ 必须不成立」，结果**归零后斜生仍有 75%**
  //    （因为原始的张开锥 15~25° 本身已经落进 30~60° 那一档）⇒ 那条对照根本
  //    没在考 bias。现在改成**反着拧**：把 bias 拧到 −80°（狠狠往下翻），
  //    下垂占比**必须**冲上去 —— 这才证明上面那条是真被"参数"决定的。
  const bad = crownAngles(growTree({ seed: 20260930, axisBiasDeg: -80 }));
  const drooping = bad.filter((a) => a > 92).length / bad.length;
  assert.ok(
    drooping > 0.15,
    `bias 拧到 −80° 后下垂枝却只有 ${(drooping * 100).toFixed(0)}% —— ` +
      `说明上面那条断言无论参数怎么调都绿，判据失效了`
  );
});

test("⭐ 外层枝条比内层更平（真实树的次序：基部角度大、靠上角度小）", () => {
  // 依据《果树修剪技术概要》「垂直角较大时枝条生长缓和」＋苹果整形
  // 「基部主枝角度较大、上层主枝角度较小」。
  const t = growTree({ seed: 20260930 });
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const inner = avg(t.branches.filter((b) => b.depth === 2).map((b) => verticalAngle(b.from, b.to)));
  const outer = avg(t.branches.filter((b) => b.depth >= 3).map((b) => verticalAngle(b.from, b.to)));
  assert.ok(
    outer > inner + 5,
    `外层平均 ${outer.toFixed(1)}° 没有明显比内层 ${inner.toFixed(1)}° 更平 —— 枝条会挤成一团往上举`
  );
});
