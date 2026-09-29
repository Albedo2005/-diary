/**
 * 【P2-16】`utils/text.ts::splitByTerms()` 的单测。
 *
 * 为什么单独建 `app/tests/`：
 *   * 本项目**没有前端测试框架**（`package.json` 里没有 vitest / jest），
 *     既有做法是靠 CDP 真机验收。但这条指令要求"7 条断言"（§七），
 *     而真机验收**不是回归测试** —— 它只能证明"这一次跑对了"。
 *   * 于是用 **Node 22 自带的类型剥离（零依赖）＋ `node --test`** 直接跑 `.ts`。
 *     ⛔ 不引任何新依赖（指令 §十-8 明写"本轮没有任何引新依赖的动作"）。
 *   * ⚠️ 放在 `app/tests/` 而**不是** `app/src/`：`tsconfig.json` 的
 *     `include` 只覆盖 `src/**`，放外面 `vue-tsc --noEmit` 就不会碰它，
 *     也就不需要装 `@types/node`（`node:test` / `node:assert` 的类型来自它）。
 *
 * 跑法：`cd app && npm run test:fe`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitByTerms, type Seg } from "../src/utils/text.ts";

/** 把段拼回去 —— 任何情况下都**必须逐字等于原串**（不丢字、不多字）。 */
function rejoin(segs: Seg[]): string {
  return segs.map((s) => s.text).join("");
}

/** 只取"亮"的那几段，方便断言。 */
function hits(segs: Seg[]): string[] {
  return segs.filter((s) => s.hit).map((s) => s.text);
}

/**
 * ⭐ 每一条都用它兜一遍：**切段不能改变原文**。
 * 这是本函数最要紧的不变量 —— 高亮再漂亮，少一个字都是 bug。
 */
function check(s: string, terms: string[]): Seg[] {
  const segs = splitByTerms(s, terms);
  assert.equal(rejoin(segs), s, `拼回去必须等于原串：${JSON.stringify(s)}`);
  // 不许出现空段 —— 零长度的段会在模板里渲染出看不见的空 <mark> / 空 <span>。
  // ⚠️ 唯一的例外：**输入本身就是空串**，那时返回 `[{ text: "", hit: false }]`
  //    正是 §七 要求的"一段空串、不 panic"。
  if (s.length > 0) {
    for (const seg of segs) {
      assert.ok(seg.text.length > 0, `不许出现空段：${JSON.stringify(segs)}`);
    }
  }
  return segs;
}

// ── 核心：所有出现处都亮 ────────────────────────────────────────────────

test("两处命中之间夹着别的字 ⇒ 切三段、两处亮", () => {
  // ⚠️ 指令 §七-1 写的是 `splitByTerms("abcabc", ["abc"])` ⇒ "3 段，两段 hit"。
  //    实测那组输入切出来是**一段**（两个命中挨着、被合并了，见下一条）——
  //    要得到"3 段两段亮"必须中间**真的有别的字**。这条是 §七-1 的**本意**。
  const segs = check("abcXabc", ["abc"]);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs, [
    { text: "abc", hit: true },
    { text: "X", hit: false },
    { text: "abc", hit: true },
  ]);
});

test("两个命中紧挨着 ⇒ 合并成一段（不是三个段）", () => {
  // 🔧 **指令 §七-1 的期望值有笔误**：它写 `splitByTerms("abcabc", ["abc"])` ⇒
  //    "3 段，两段 hit"。但两处命中首尾相接（[0,3] 与 [3,6]），合并条件是
  //    `r[0] <= last[1]` ⇒ 必然并成 [0,6]，切出来是**一段全亮**。
  //    若按字面去写断言，实现无论怎么写都会有一条红。⇒ 按实现本身的正确行为写。
  //    （交付记录里已标注这是文档笔误。）
  const segs = check("abcabc", ["abc"]);
  assert.deepEqual(segs, [{ text: "abcabc", hit: true }]);
});

test("同一个词出现三次 ⇒ 三处都亮", () => {
  const segs = check("面 面 面", ["面"]);
  assert.deepEqual(hits(segs), ["面", "面", "面"]);
});

// ── 不重合：不许把 "aa" 在 "aaa" 里数出两次 ──────────────────────────────

test("aaa 里搜 aa ⇒ 命中一段 aa ＋ 尾段 a（不重合）", () => {
  // 步进必须用命中词的长度：若写成 i + 1，会从第 2 个字符再命中一次 ⇒ 重合。
  const segs = check("aaa", ["aa"]);
  assert.deepEqual(segs, [
    { text: "aa", hit: true },
    { text: "a", hit: false },
  ]);
});

// ── 多个词分别亮 ────────────────────────────────────────────────────────

test("两个词分别命中 ⇒ 各亮各的，中间那段不亮", () => {
  // 🔧 **指令 §七-3 的期望值也有笔误**：它写 `splitByTerms("牛肉面", ["牛","面"])`
  //    ⇒ "三段全 hit"。但"肉"既不是"牛"也不是"面"，**它不该亮**。
  //    三段是 [牛(亮), 肉(不亮), 面(亮)] —— 两处亮。
  //    （交付记录里已标注这是文档笔误。）
  const segs = check("牛肉面", ["牛", "面"]);
  assert.deepEqual(segs, [
    { text: "牛", hit: true },
    { text: "肉", hit: false },
    { text: "面", hit: true },
  ]);
});

test("重叠的两个命中词 ⇒ 合并成一段", () => {
  // 不合并会切出 [0,3] 与 [1,4] 两条交叠的区间 ⇒ 段落在模板里叠成一团。
  const segs = check("abcd", ["abc", "bcd"]);
  assert.deepEqual(segs, [{ text: "abcd", hit: true }]);
});

// ── 大小写 ──────────────────────────────────────────────────────────────

test("不区分大小写", () => {
  const segs = check("Hello World", ["hello"]);
  assert.deepEqual(segs, [
    { text: "Hello", hit: true },
    { text: " World", hit: false },
  ]);
});

// ── 兜底与边界 ──────────────────────────────────────────────────────────

test("一个词都找不到 ⇒ 一整段、不亮", () => {
  const segs = check("abc", ["zzz"]);
  assert.deepEqual(segs, [{ text: "abc", hit: false }]);
});

test("词表为空 ⇒ 一整段、不亮（不 panic）", () => {
  const segs = check("abc", []);
  assert.deepEqual(segs, [{ text: "abc", hit: false }]);
});

test("词表里全是空串 ⇒ 等同空词表", () => {
  const segs = check("abc", ["", "  "]);
  assert.deepEqual(segs, [{ text: "abc", hit: false }]);
});

test("空串不 panic", () => {
  const segs = check("", ["a"]);
  assert.deepEqual(segs, [{ text: "", hit: false }]);
});

test("整串就是那个词 ⇒ 一整段全亮", () => {
  const segs = check("下雨", ["下雨"]);
  assert.deepEqual(segs, [{ text: "下雨", hit: true }]);
});

// ── 与真实摘要同形的用例 ────────────────────────────────────────────────

test("像真摘要那样：省略号 ＋ 前后文 ＋ 两处命中", () => {
  // 后端 make_snippet() 会在两端加 '…'，命中词在中间。
  // 这条同时钉住一个坑：`…` 是单个字符，切段不能把它拆坏（rejoin 兜住）。
  const s = "…今天下雨了，我坐在窗边看雨…";
  const segs = check(s, ["雨"]);
  assert.deepEqual(hits(segs), ["雨", "雨"]);
  assert.deepEqual(segs[0], { text: "…今天下", hit: false });
});

test("多个词、每个词命中多处 ⇒ 全部亮且不重叠", () => {
  const s = "牛肉面好吃，面汤也好喝";
  const segs = check(s, ["面", "牛肉"]);
  // ⭐ 注意第一段是 **"牛肉面"** 而不是 "牛肉" ＋ "面"：
  //    "牛肉" 落在 [0,2]、"面" 落在 [2,3]，两者**首尾相接** ⇒ 按合并规则并成一段。
  //    这是对的 —— 视觉上本来就是连续的一串高亮，
  //    拆成两个挨着的 <mark> 长得一模一样、还多一个节点。
  assert.deepEqual(hits(segs), ["牛肉面", "面"]);
  // 拼回去仍是原文（check 已断言，这里再明确一次可读性）
  assert.equal(rejoin(segs), s);
});
