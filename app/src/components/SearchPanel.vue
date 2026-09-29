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
import { ref } from "vue";
import { searchEntries, toAppError, type SearchHit } from "../api";
import { humanDate } from "../utils/date";
import { splitByTerms, type Seg } from "../utils/text";

const emit = defineEmits<{ (e: "open", date: string): void }>();

const query = ref("");
const results = ref<SearchHit[]>([]);
const searching = ref(false);
const errorText = ref("");
const searched = ref(false);

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
        @keyup.enter="run"
      />
      <button v-if="query" class="clear" title="清空" @click="clear">×</button>
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
