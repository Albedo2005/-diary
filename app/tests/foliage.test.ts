/**
 * 「挂花挂叶」纯函数的单测（零依赖，Node 22 原生跑 `.ts`）。
 *
 * ⚠️ 跑法：在 `app/` 下 `pnpm test:fe`
 *    （⛔ 别自己写 `node --test` 带 glob —— Windows 下它会把目录当成 CJS 模块）。
 *
 * ⭐ 这里最要紧的一条不是"数量对不对"，而是**"花叶真的挂在枝条上"**：
 *    数量对了、但整批飘在半空或者埋在地里，截图上一样是"树上有花有叶"，
 *    肉眼根本分不出来 —— 只有几何判定能抓。
 * ⚠️⚠️ 与 `tree.test.ts` 同样的道理：**"跑两次一样"必须配一条"换个种子
 *    必须不一样"**，否则种子根本没被用上时它照样绿。
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { growTree, type Branch, type Vec3 } from "../src/tree/grow.ts";
import { DEFAULT_FOLIAGE, growFoliage } from "../src/tree/foliage.ts";

/** 把结果压成字符串，用来做"两次跑是否逐字节相同"的比较。 */
const dump = (f: { leaves: unknown[]; blossoms: unknown[] }): string => JSON.stringify(f);

/** 点到**线段**的最短距离（花叶挂点必须贴着枝条，这条是判据的核心）。 */
function distToBranch(p: Vec3, b: Branch): number {
  const vx = b.to.x - b.from.x;
  const vy = b.to.y - b.from.y;
  const vz = b.to.z - b.from.z;
  const wx = p.x - b.from.x;
  const wy = p.y - b.from.y;
  const wz = p.z - b.from.z;
  const vv = vx * vx + vy * vy + vz * vz;
  let t = vv > 0 ? (wx * vx + wy * vy + wz * vz) / vv : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  const dz = wz - vz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 一个挂点到**最近那根枝条**的距离。 */
function nearestBranch(p: Vec3, branches: Branch[]): number {
  let best = Infinity;
  for (const b of branches) best = Math.min(best, distToBranch(p, b));
  return best;
}

test("同一个种子 ⇒ 逐字节完全相同，且真的不是空的", () => {
  const t = growTree({ seed: 12345 });
  const a = growFoliage(t, { seed: 12345 });
  const b = growFoliage(t, { seed: 12345 });
  assert.equal(dump(a), dump(b), "同种子两次算出了不同的花叶");
  // ⚠️ 顺手确认非空 —— 否则"两批空花叶相等"也是真的。
  assert.ok(a.leaves.length > 0, "叶子数为 0，这条断言就没有意义");
  assert.ok(a.blossoms.length > 0, "花簇数为 0，这条断言就没有意义");
});

test("⭐ 反例对照：换个种子 ⇒ 必须是另一身花叶", () => {
  const t = growTree({ seed: 12345 });
  const a = growFoliage(t, { seed: 12345 });
  const b = growFoliage(t, { seed: 999 });
  assert.notEqual(dump(a), dump(b), "换了种子却算出完全一样的花叶 —— 种子根本没被用上");
});

test("⭐ 每片花叶都**真的贴着枝条**（不是飘在半空、也不是埋在地里）", () => {
  const t = growTree({ seed: 20260930 });
  const f = growFoliage(t, { seed: 20260930 });

  // 挂点 = 枝条上的点 ＋ 沿朝向往外挪半个面片（最大约 0.074）⇒ 0.15 是留足余量的门限。
  // ⚠️ 门限写太松这条断言就废了：把挂点全推到 1.0 以外它也照样绿。
  const LIMIT = 0.15;
  for (const kind of ["leaves", "blossoms"] as const) {
    const list = f[kind];
    for (let i = 0; i < list.length; i += 1) {
      const d = nearestBranch(list[i].pos, t.branches);
      assert.ok(d <= LIMIT, `${kind}[${i}] 离最近的枝条 ${d.toFixed(3)}（超过 ${LIMIT}）⇒ 飘在半空`);
    }
  }
});

test("花叶都长在树冠上，⛔ 没有一片长到地面以下", () => {
  const t = growTree({ seed: 20260930 });
  const f = growFoliage(t, { seed: 20260930 });
  const ys = [...f.leaves, ...f.blossoms].map((x) => x.pos.y);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  /*
   * ⚠️ 调整轮改判据：原来要求"最低一片 > 树高 45%"。
   *    但"主干沿途出 3 层侧枝"之后，**最下面那层侧枝本身就在树高约 1/4 处**，
   *    花叶跟着挂到那儿 ⇒ 实测 25%。这正是要的"树冠从下往上都有东西"，
   *    ⛔ 不是退化 —— 旧判据会把正确的树判红。
   * ⭐ 新判据守住真正该守的那条线：**别掉到树干那一段上去**（树高 20% 以下）。
   */
  assert.ok(lo > t.height * 0.2, `最低的一片在树高 ${(lo / t.height * 100).toFixed(0)}% 处，太低（掉到树干上了）`);
  assert.ok(hi <= t.height + 0.2, `最高的一片比树还高 ${(hi - t.height).toFixed(2)}`);
});

test("数量在合理区间（太少树冠是光的，太多批次 3 会拖慢）", () => {
  const t = growTree({ seed: 20260930 });
  const f = growFoliage(t, { seed: 20260930 });
  // ⚠️ 调整轮：maxDepth 5→4（用户："树枝太密"）⇒ 枝条 139→31、挂点 72→16，
  //    叶子总量跟着从 1,645 降到约 390。**这是用户要的"疏"，不是回归。**
  //    ⚠️ 但"枝条变少"不能变成"树冠发亮" —— 所以下限按**每根枝**来定更稳：
  //    `leafPerUnit` 保证每单位枝长上叶子管够（那条另有专门断言）。
  assert.ok(f.leaves.length >= 300, `叶子只有 ${f.leaves.length} 片，树冠会很稀`);
  assert.ok(f.leaves.length <= 3000, `叶子多到 ${f.leaves.length} 片，会白烧显卡`);
  assert.ok(f.blossoms.length >= 30, `花簇只有 ${f.blossoms.length} 簇，看不出"开花了"`);
  assert.ok(f.blossoms.length <= 600, `花簇多到 ${f.blossoms.length} 簇，会白烧显卡`);
  // 桂花是"一簇簇小碎花"，本来就比叶子少 —— 花比叶还多的树不像桂花。
  assert.ok(f.blossoms.length < f.leaves.length, "花比叶子还多，不像桂花");
});

test("朝向是单位向量，滚转与相位都在 [0, 2π)", () => {
  const t = growTree({ seed: 7 });
  const f = growFoliage(t, { seed: 7 });
  for (const it of [...f.leaves, ...f.blossoms]) {
    const len = Math.sqrt(it.dir.x ** 2 + it.dir.y ** 2 + it.dir.z ** 2);
    assert.ok(Math.abs(len - 1) < 1e-6, `朝向不是单位向量（长度 ${len}）`);
    assert.ok(it.roll >= 0 && it.roll < Math.PI * 2 + 1e-9, `滚转越界：${it.roll}`);
    assert.ok(it.phase >= 0 && it.phase < Math.PI * 2 + 1e-9, `相位越界：${it.phase}`);
    assert.ok(it.tone >= 0 && it.tone <= 1, `色调越界：${it.tone}`);
    assert.ok(it.size > 0, "尺寸必须为正");
  }
  /*
   * ⚠️ 判据是「相位真的散开了」，⛔ 不是「两两都不相同」——
   *    一千多个数落在 0~2π 里、取三位小数，本来就会撞上几百个（生日问题），
   *    拿"去重后还剩多少"当判据，会得到一条**永远贴着红边**的断言。
   *    均匀分布的均值是 π≈3.14、标准差是 2π/√12≈1.81 —— 拿这两个数当尺子。
   */
  const ps = f.leaves.map((x) => x.phase);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  const sd = Math.sqrt(ps.reduce((a, b) => a + (b - mean) ** 2, 0) / ps.length);
  assert.ok(hi - lo > 5.5, `相位只铺开了 ${(hi - lo).toFixed(2)} 弧度，风会把整棵树一起推`);
  assert.ok(mean > 2.6 && mean < 3.7, `相位均值 ${mean.toFixed(2)} 偏离 π，分布是偏的`);
  assert.ok(sd > 1.4 && sd < 2.3, `相位标准差 ${sd.toFixed(2)} 不像均匀分布（均匀约 1.81）`);
});

test("挂得越靠外 ⇒ 叶子越多（minDepth 调深，叶子必须变少）", () => {
  const t = growTree({ seed: 5 });
  const shallow = growFoliage(t, { seed: 5, minDepth: 2 }).leaves.length;
  const deep = growFoliage(t, { seed: 5, minDepth: 3 }).leaves.length;
  assert.ok(shallow > deep, `minDepth 调深了叶子却没变少：${shallow} → ${deep}`);
});

test("兜底：只有主干的一棵树上也得有花叶（⛔ 不许整片落空）", () => {
  // 默认 minDepth 比这棵树的分枝级数深 ⇒ 必须自动退回到最深那一级。
  const t = growTree({ seed: 5, maxDepth: 1 });
  assert.ok(DEFAULT_FOLIAGE.minDepth > t.maxDepth, "这条用例的前提变了（minDepth 不再大于 maxDepth）");
  const f = growFoliage(t, { seed: 5 });
  assert.ok(f.leaves.length > 0, "退化情形下一片叶子都没有 —— 用户会看到一棵光杆树");
});

test("形状随树走：树的枝条越多，花叶也越多（不是写死的常数）", () => {
  const small = growFoliage(growTree({ seed: 42, maxDepth: 3 }), { seed: 42 });
  const big = growFoliage(growTree({ seed: 42, maxDepth: 5 }), { seed: 42 });
  assert.ok(
    big.leaves.length > small.leaves.length,
    `枝条变多了叶子却没跟着多：${small.leaves.length} → ${big.leaves.length}`
  );
});
