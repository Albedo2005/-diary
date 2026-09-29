<script setup lang="ts">
/**
 * 搜索面板。
 *
 * 后端会同时查两张索引并合并（见 docs/schema-decisions.md）：
 *   - 主索引：jieba 分词，精确匹配
 *   - 兜底索引：单字切分，保证任意子串可命中
 *
 * 所以结果里的 matched_by 可能是 "char"，表示它由兜底索引命中 ——
 * 这类结果的相关性通常低于词索引命中，界面上做一个区分标记，
 * 让用户理解"为什么这条也被搜出来了"。
 *
 * 摘要（snippet）由后端在**原文**上截取，不用 FTS5 的 snippet()，
 * 因为索引里存的是分词文本，直接输出会是破碎排版。
 */
import { computed, onMounted, ref } from "vue";
import {
  clearSearchHistory,
  getSearchHistory,
  pushSearchHistory,
  searchEntries,
  toAppError,
  type SearchHit,
} from "../api";
import { humanDate } from "../utils/date";
import { splitByTerms, type Seg } from "../utils/text";

const emit = defineEmits<{ (e: "open", date: string): void }>();

const query = ref("");
const results = ref<SearchHit[]>([]);
const searching = ref(false);
const errorText = ref("");
const searched = ref(false);

/**
 * 搜索历史（【P2-20】）。**最近搜的在最前**。
 *
 * ⚠️ 它住在**加密库**里（后端 `app_setting` 表），⛔ **不是 `localStorage`** ——
 *    搜索词往往就是日记里的字，存别处等于把日记的一部分明文摊在硬盘上。
 * ⚠️ `SearchPanel` **切页即卸载**（`App.vue` 用 `v-if` 切页）⇒ 每次进来都要重拉，
 *    ⛔ 别指望组件内变量跨页存活。
 */
const history = ref<string[]>([]);

let debounce: number | null = null;

function onInput() {
  if (debounce !== null) window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void run(), 260);
}

async function run() {
  const q = query.value.trim();
  if (!q) {
    results.value = [];
    searched.value = false;
    return;
  }
  searching.value = true;
  errorText.value = "";
  try {
    results.value = await searchEntries(q, 50);
    searched.value = true;
  } catch (e) {
    errorText.value = toAppError(e).message;
  } finally {
    searching.value = false;
  }
}

function clear() {
  query.value = "";
  results.value = [];
  searched.value = false;
  errorText.value = "";
}

// ---------------------------------------------------------------------------
// 搜索历史（【P2-20】）
// ---------------------------------------------------------------------------

/**
 * 历史区什么时候露脸。
 *
 *   * 一篇都没搜过 / 刚清空 ⇒ 历史为空 ⇒ **整块不出现**（连标题、空白都不留）；
 *   * 输入框里有字、还没回车 ⇒ **照常显示**（那不算"搜过"）；
 *   * ⭐ **只要搜过就让位** —— "一屏只放一样东西"（用户 2026-09-29 拍板：
 *     连"一条都没搜到"也算搜过）。点输入框右边那个 **×**（`clear()`）之后
 *     `searched` 回到 `false` ⇒ 历史又回来。
 */
const showHistory = computed(() => history.value.length > 0 && !searched.value);

/** 进页面拉一次（一条只读命令、几百字节）。 */
async function loadHistory() {
  try {
    history.value = await getSearchHistory();
  } catch {
    // ⚠️ 这是"读不到历史"，**不是**"搜不到日记" —— 为它弹一条错误既误导又是噪声。
    //    静默当空列表，搜索本身照常能用。
    history.value = [];
  }
}

onMounted(() => void loadHistory());

/**
 * 记一次历史。
 *
 * ⚠️ **只许在"用户真的搜了"那两处调**：**回车** 与 **点历史胶囊**。
 *    ⛔ **别塞进 `run()`** —— `run()` 被 260ms 输入防抖调到，
 *    那样"打一半停一下"也会被记进历史。
 * 后端把新列表**直接返回**（不必再拉一次）。
 */
async function remember(q: string) {
  try {
    history.value = await pushSearchHistory(q);
  } catch {
    // 记不上不影响这次搜索 —— 结果已经出来了，别为一笔历史弹错。
  }
}

/** 回车：搜 ＋ 记一次。 */
function onEnter() {
  void run();
  void remember(query.value);
}

/** 点一颗历史胶囊：填进输入框 → 立刻搜 → 记一次（顶到最前）。 */
function pick(word: string) {
  query.value = word;
  void run();
  void remember(word);
}

/**
 * 「清空」：一次清光历史。
 *
 * ⚠️ **输入框与结果都不动** —— 那是上面 `clear()` 的事，两者语义不同，
 *    ⛔ 别合并成一个动作。
 */
async function clearHistory() {
  try {
    await clearSearchHistory();
  } catch {
    // ⛔ 后端没清掉就别把本地列表置空 —— 否则界面说"已清空"、库里还留着，
    //    用户下次进来又会看见它们，那比直接说失败更糟。
    return;
  }
  history.value = [];
}

/**
 * 查询串切成词 —— 按**空白**切，每个词分别高亮（搜索框里打"牛肉 面"⇒ 两个词都亮）。
 *
 * 上限 8 个：`splitByTerms` 里是「词数 × 串长」次 `indexOf`。摘摘要一般才一两百字、
 * 本来不用担心，但用户真粘一整段话进来时，加上限更稳。
 */
function terms(): string[] {
  return query.value.trim().split(/\s+/).filter(Boolean).slice(0, 8);
}

/**
 * 在摘要里高亮**所有**命中处（【P2-16】）。
 *
 * 改之前这里是 `indexOf` —— 只找**第一处**，所以同一篇里那词出现八次也只亮一处。
 * 现在整件事交给了 `utils/text.ts::splitByTerms()`（抽出去才能写单测）。
 *
 * ✅ **摘要本身就是"可见文字"**：正文变成富文本后，后端 `db::make_snippet()`
 *    已经先 `strip_html()` 再开窗 ⇒ 从后端出去的摘要里**不夹格式标记**，
 *    这里直接在它上面找词天然正确。⛔ 别在前端再剥一遍（那是第二套实现）。
 *
 * ⚠️ 切段后按段渲染（`<mark>` ＋ `<span>`），**不用 `v-html`** —— 防 XSS。
 */
function parts(hit: SearchHit): Seg[] {
  return splitByTerms(hit.snippet, terms());
}
</script>

<template>
  <div class="search">
    <div class="input-row">
      <input
        v-model="query"
        class="input"
        type="search"
        placeholder="搜索日记内容…"
        @input="onInput"
        @keyup.enter="onEnter"
      />
      <button v-if="query" class="clear" title="清空" @click="clear">×</button>
    </div>

    <!--
      搜索历史（【P2-20】）：搜索框**正下方**、结果区之上。
      形态照 B站 —— 小标题 ＋ 右上角「清空」＋ 一排胶囊（放不下就**折行**）。
      ⛔ 不显示条数、⛔ 不做"删单条"（要删就清空）、⛔ 不借 B站 的配色（一律走主题变量）。
    -->
    <div v-if="showHistory" class="history">
      <div class="history-head">
        <span class="history-title">搜索历史</span>
        <button class="history-clear" title="清空搜索历史" @click="clearHistory">
          清空
        </button>
      </div>
      <div class="history-pills">
        <button
          v-for="w in history"
          :key="w"
          class="hist-pill"
          :title="w"
          @click="pick(w)"
        >
          {{ w }}
        </button>
      </div>
    </div>

    <p v-if="errorText" class="error">{{ errorText }}</p>
    <p v-else-if="searching" class="note">搜索中…</p>
    <p v-else-if="searched && results.length === 0" class="note">
      没有找到包含「{{ query }}」的日记。
    </p>
    <p v-else-if="searched" class="note">
      找到 {{ results.length }} 条
    </p>

    <ul v-if="results.length" class="list">
      <li v-for="hit in results" :key="hit.entry_date">
        <button class="item" @click="emit('open', hit.entry_date)">
          <div class="item-head">
            <span class="item-date">{{ humanDate(hit.entry_date) }}</span>
            <span v-if="hit.title" class="item-title">{{ hit.title }}</span>
            <span
              v-if="hit.matched_by === 'char'"
              class="badge"
              title="由单字索引命中，相关性可能较低"
              >宽匹配</span
            >
          </div>
          <div class="item-snippet">
            <template v-for="(p, i) in parts(hit)" :key="i">
              <mark v-if="p.hit">{{ p.text }}</mark>
              <span v-else>{{ p.text }}</span>
            </template>
          </div>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.input-row {
  position: relative;
  margin-bottom: 12px;
}
.input {
  width: 100%;
  padding: 9px 30px 9px 12px;
  font-size: 14px;
  color: var(--text-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: none;
}
.input:focus {
  border-color: var(--accent);
}
.clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  font-size: 16px;
  line-height: 1;
  color: var(--text-3);
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}
.clear:hover {
  background: var(--hover);
  color: var(--text-1);
}
/*
  搜索历史（【P2-20】）。形态照 B站：小标题 ＋ 右侧文字按钮 ＋ 一排胶囊。
  ⚠️ **颜色一律走主题变量** —— B站 是粉色系，⛔ 一个色号都不许借过来。

  ⚠️ 它只在 `!searched` 时出现，而那时候 `results` 必然为空
     （`.list` 是 `v-if="results.length"`）⇒ **不会和结果列表抢高度**。
*/
.history {
  flex-shrink: 0;
  margin-bottom: 12px;
}
.history-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
/* 小标题：比正文小一号、次要色。 */
.history-title {
  font-size: 12px;
  color: var(--text-3);
}
/* 「清空」：**文字按钮**，同 `.picker-link` 那一类（小字、无边框、悬停才亮）。 */
.history-clear {
  flex-shrink: 0;
  padding: 0;
  font-size: 12px;
  color: var(--text-2);
  background: transparent;
  border: none;
  cursor: pointer;
}
.history-clear:hover {
  color: var(--accent);
}
/* 一排胶囊：**折行**（窗口最窄 720px；B站 那种"一行溢出"在这儿会很难看）。 */
.history-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
/* 一颗历史词。⚠️ 同一个词只存一份（后端去重）⇒ 可以拿它当 `key`。 */
.hist-pill {
  max-width: 100%;
  padding: 3px 10px;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  /* 词最长 50 字 ⇒ 太长的钉住宽度、末尾省略号，别把一行撑破。 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist-pill:hover {
  background: var(--hover);
  color: var(--text-1);
}
.note,
.error {
  font-size: 12px;
  color: var(--text-3);
  margin: 0 0 10px;
}
.error {
  color: var(--danger);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}
.item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  margin-bottom: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.item:hover {
  border-color: var(--accent);
}
.item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.item-date {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  flex-shrink: 0;
}
.item-title {
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--text-3);
  background: var(--hover);
}
.item-snippet {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  word-break: break-word;
}
mark {
  background: var(--accent-soft);
  color: var(--text-1);
  border-radius: 2px;
  padding: 0 1px;
}
</style>
