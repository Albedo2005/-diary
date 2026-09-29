/**
 * 正文里**「看得见的字」** —— 这是"这篇有多少字"的唯一入口。
 *
 * 背景：现在至少有四处地方在数正文的字（编辑器右上角那个「N 字」、
 * 将来热力图的分档、字数目标、导出）。它们要是各数各的，
 * 那些数字迟早会互相矛盾 —— **而且几乎不会被发现**。
 * 所以把"正文里到底哪些算字"收成下面这一个函数。
 *
 * ⭐ **【P2-3】第 2 步起，它真的开始干活了**：正文变成了带格式的 HTML，
 *    `<p>` `<strong>` `style="..."` 这些东西**都不是字**，必须先剥掉。
 *    剥标签的实现收在 `richText.ts::htmlToPlainText()` 里（那才是"怎么剥"），
 *    这里只负责"哪些算字"（剥完再去掉空白）—— 两件事各一份实现、不重复。
 *
 * ⚠️ 输入是 **HTML 或纯文本都行**：
 *    旧日记是纯文本（没有 `<`），`htmlToPlainText` 会走恒等快路径原样返回，
 *    所以**旧日记的字数与改前完全一致** —— 这是【P2-3】拍板第 2 条的要求。
 *
 * ⚠️ 与后端 `db.rs::count_words()` **不是同一套口径**（前端数的是 UTF-16 长度、
 *    后端数的是 Unicode 字符数，对 emoji / 生僻字本来就差 1~2 个）。
 *    这个差异是**既有**的。第 2 步把后端的口径也对齐到"剥标签后再数"，
 *    但两边"怎么数"的差异**照旧保留**（那是各自语言的原生行为）。
 */
// ⚠️ 这个 import **必须带 `.ts` 扩展名**（`tsconfig` 已开 `allowImportingTsExtensions`，
//    Vite 也照常解析）。原因是本文件要能被 Node 直接加载去跑单测
//    （`app/tests/text.test.ts`，用 Node 22 自带的类型剥离 ＋ `node --test`）——
//    Node 的 ESM 解析器**不认无扩展名的相对路径**，去掉 `.ts` 那条路立刻报
//    `ERR_MODULE_NOT_FOUND`。⛔ 别"顺手"把它还原成 `"./richText"`。
import { htmlToPlainText } from "./richText.ts";

export function visibleText(raw: string): string {
  return htmlToPlainText(raw);
}

/**
 * 一段文本，以及"它是不是命中词"。
 *
 * ⚠️ **只产出段、不产出 HTML** —— 交给模板去渲染。
 *    这是本项目**刻意的防 XSS 做法**：搜索页宁可切段拼节点，
 *    也不用 `v-html`（那样日记里手打的 `<script>` 会真的跑起来）。
 */
export interface Seg {
  text: string;
  hit: boolean;
}

/**
 * 把一个字符串按**所有**命中处切成交替的段（【P2-16】）。
 *
 * 改之前是 `SearchPanel.vue` 里一行 `indexOf` —— 它只找**第一处**，
 * 所以一篇日记里同一个词出现八次，界面上只亮一处。这里把"所有处"都找出来。
 *
 * 规则（全部由指令 §二 定过）：
 *   * 命中**全部出现的地方**，不是只亮第一处；
 *   * `terms` 里每个词**分别**找（搜索框里打"牛肉 面"⇒ 两个词都亮）；
 *   * **不区分大小写**（搜索本身也不区分）；
 *   * 重叠 / 挨着的命中**合并成一段** —— 不合并会切出零长度的段，
 *     模板里就会渲染出一个空的 `<mark>`（看不见但占位，鼠标选中时会露馅）。
 *
 * ⚠️ 这是**纯函数**：不碰 DOM、不用任何第三方库。
 *    这条约束是**故意的** —— 本项目没有前端单测框架，靠的是 Node 22 自带的
 *    类型剥离 ＋ `node --test` 直接跑 `.ts` 文件来测它（见 `app/tests/text.test.ts`）。
 *    ⇒ **别在这里 import 任何第三方包**（本文件唯一的 import 是 `./richText`，
 *      而那个文件自身零 import、也不会在加载时碰 DOM），否则那条路立刻断掉。
 */
export function splitByTerms(s: string, terms: string[]): Seg[] {
  const ts = terms.filter(Boolean);
  if (!ts.length) return [{ text: s, hit: false }];

  // 1. 在**不区分大小写**的副本上找出所有命中区间
  const lower = s.toLowerCase();
  const ranges: [number, number][] = [];
  for (const t of ts) {
    const tl = t.toLowerCase();
    let from = 0;
    for (;;) {
      const i = lower.indexOf(tl, from);
      if (i < 0) break;
      ranges.push([i, i + t.length]);
      // ⚠️ 步进用 t.length 而不是 i + 1：
      //    i + 1 会让 "aa" 在 "aaa" 里从第 2 个字符再命中一次（重合），
      //    而"不重合地扫一遍"才是我们要的语义。
      from = i + t.length;
    }
  }
  if (!ranges.length) return [{ text: s, hit: false }];

  // 2. 合并重叠 / 相邻区间（两个词套着、或者挨着时）
  //    ⚠️ 用 `<=` 而不是 `<`：相邻（如 "abcabc" 搜 "abc"）也要并成一段，
  //       否则中间会夹一个长度为 0 的不亮段、渲染出一个空 span。
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  // 3. 切段
  const out: Seg[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: s.slice(pos, a), hit: false });
    out.push({ text: s.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < s.length) out.push({ text: s.slice(pos), hit: false });
  return out;
}
