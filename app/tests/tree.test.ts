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

import { DEFAULT_GROW, growTree, type Tree } from "../src/tree/grow.ts";

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
  assert.ok(t.tips.length >= 30, `挂点只有 ${t.tips.length} 个，树冠会太稀`);
  assert.ok(t.tips.length <= 500, `挂点多到 ${t.tips.length} 个，批次 3 挂花叶会拖慢`);
});

test("结构连通：每根分枝的根，都接在某个上一级枝条的梢上", () => {
  const t = growTree({ seed: 99 });
  const byDepth = new Map<number, typeof t.branches>();
  for (const b of t.branches) {
    const list = byDepth.get(b.depth) ?? [];
    list.push(b);
    byDepth.set(b.depth, list);
  }
  const parents = byDepth.get(0) ?? [];
  assert.equal(parents.length, 1, "主干应该只有一根");

  for (const b of t.branches) {
    if (b.depth === 0) continue;
    const up = byDepth.get(b.depth - 1) ?? [];
    const hit = up.some(
      (p) => p.to.x === b.from.x && p.to.y === b.from.y && p.to.z === b.from.z
    );
    assert.ok(hit, `第 ${b.depth} 级有枝条悬空：它的根没接在任何上一级枝条的梢上`);
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
  for (const b of t.branches) {
    assert.ok(b.r1 <= b.r0, "枝条从根到梢没有变细");
    if (b.depth === 0) continue;
    const up = byDepth.get(b.depth - 1) ?? [];
    const parent = up.find(
      (p) => p.to.x === b.from.x && p.to.y === b.from.y && p.to.z === b.from.z
    );
    assert.ok(parent, "找不到父枝（前一条断言应该已经报出来了）");
    assert.ok(b.r0 <= parent!.r1 + 1e-9, "子枝的根比父枝的梢还粗");
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
