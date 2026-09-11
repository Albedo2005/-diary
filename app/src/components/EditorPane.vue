<script setup lang="ts">
/**
 * 日记编辑器。
 *
 * 形态：**Markdown 源码 + 语法高亮**（形态 A），配一个一键切换的阅读模式。
 * 为什么不做所见即所得：那是 V1 的目标（见 docs/backlog.md），
 * 复杂度是现在的 5~8 倍。而写日记最需要的是"打开就能写"，排版好看是**回看**时的需求。
 *
 * ⚠️ 铁律：正文永远以 **Markdown 原文**落库。
 *    将来升级到所见即所得时，富文本只在内存里存在，存库前仍转回 Markdown。
 *    一旦改成 HTML/富文本 JSON，导出、搜索、备份全要重写，升级也不再平滑。
 *
 * 自动保存策略：输入停止 1 秒后落库。
 * 中文输入法组字期间**暂停保存** —— 否则会把打到一半的拼音存进数据库。
 */
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { marked } from "marked";
import {
  deleteEntry,
  openEntry,
  saveEntry,
  toAppError,
  type Entry,
} from "../api";
import { humanDate } from "../utils/date";

const props = defineProps<{
  date: string;
  /** 保存成功后通知父组件（用于刷新日历标记） */
  onSaved?: () => void;
}>();

const emit = defineEmits<{ (e: "saved"): void }>();

const loading = ref(false);
const errorText = ref("");
const title = ref("");
const content = ref("");
/** '' | 'pending' | 'saving' | 'saved' | 'error' */
const saveState = ref<"" | "pending" | "saving" | "saved" | "error">("");
const previewMode = ref(false);
const entry = ref<Entry | null>(null);

/** 输入法组字中。中文打字时输入法会先给出拼音候选，这段时间不能保存。 */
let composing = false;
let saveTimer: number | null = null;
/** 标记"当前内容是否已被改动但尚未保存"，避免无谓写库。 */
let dirty = false;

/**
 * 这篇日记算不算"写过"（正文非空白）。
 *
 * ⚠️ 必须与后端 `db::HAS_CONTENT_SQL` 保持完全一致，否则会出现
 *    "编辑器认为写过、日历认为没写"这类界面自相矛盾的状态。
 *    刻意只留正文、不看标题：只打了标题没写正文不算写完一篇。
 */
function hasContent(): boolean {
  return content.value.trim().length > 0;
}

/** 数据库里是否已经存在这一行。 */
function isPersisted(): boolean {
  return entry.value !== null && entry.value.id !== 0;
}

const wordCount = computed(
  () => content.value.replace(/\s/g, "").length
);

const renderedHtml = computed(() => {
  try {
    // marked 默认会转义内联 HTML 吗？不会 —— 所以这里显式做一层过滤：
    // 日记是本机数据，风险低，但仍避免把 <script> 之类渲染进 DOM。
    const raw = marked.parse(content.value || "", { async: false }) as string;
    return sanitize(raw);
  } catch {
    return "<p>（内容渲染失败）</p>";
  }
});

/** 极简过滤：去掉 script/style/iframe 标签与内联事件处理器。 */
function sanitize(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

async function load() {
  loading.value = true;
  errorText.value = "";
  cancelPendingSave();
  try {
    // openEntry 是纯读取：没有内容时返回空模板（id = 0），不会写库。
    // 所以"点开日历"不会把这一天变成"写过"。
    const e = await openEntry(props.date);
    entry.value = e;
    title.value = e.title;
    content.value = e.content_md;
    dirty = false;
    saveState.value = "";
  } catch (e) {
    errorText.value = toAppError(e).message;
  } finally {
    loading.value = false;
  }
}

function cancelPendingSave() {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** 输入变化：标记脏数据并安排一次防抖保存。 */
function scheduleSave() {
  // 关键：组字期间不保存，否则会存下未完成的拼音。
  if (composing) return;
  dirty = true;
  saveState.value = "pending";
  cancelPendingSave();
  saveTimer = window.setTimeout(() => {
    void flush();
  }, 1000);
}

/**
 * 把当前内容落库。
 *
 * 三条规则（都是为了"只有真的写了内容才算写过"这个语义）：
 *
 *   1. **没有正文内容时不落库**。只打了标题就离开，不应该在数据库里留下记录，
 *      更不应该让日历显示"这天写过"。
 *
 *   2. **曾经有内容、现在被删空 → 删除数据库里的行**，而不是存一条空记录。
 *      否则日历上会留下一个"写过但点进去是空的"幽灵标记。
 *
 *   3. 保存成功才通知父组件刷新日历标记。
 *      在内容为空的情况下也要通知 —— 因为可能刚刚删空了一篇，
 *      日历需要把这个标记去掉。
 */
async function flush() {
  if (!dirty) return;
  cancelPendingSave();

  // 规则 1 与 2
  if (!hasContent()) {
    if (isPersisted()) {
      saveState.value = "saving";
      try {
        await deleteEntry(props.date);
        entry.value = null;
        dirty = false;
        saveState.value = "";
        emit("saved");
      } catch (e) {
        saveState.value = "error";
        errorText.value = toAppError(e).message;
      }
    } else {
      // 从来没落库过，也就没什么可保存的。
      dirty = false;
      saveState.value = "";
    }
    return;
  }

  saveState.value = "saving";
  try {
    const e = await saveEntry(props.date, title.value, content.value);
    entry.value = e;
    dirty = false;
    saveState.value = "saved";
    emit("saved");
  } catch (e) {
    saveState.value = "error";
    errorText.value = toAppError(e).message;
  }
}

/** 组字开始/结束。结束时补一次保存，把最终文本落库。 */
function onCompositionStart() {
  composing = true;
}
function onCompositionEnd() {
  composing = false;
  scheduleSave();
}

/**
 * 文本域里按下 Tab 时插入缩进而不是移动焦点。
 * 日记里写代码块或列表时很需要。
 */
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Tab") {
    ev.preventDefault();
    const el = ev.target as HTMLTextAreaElement;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    content.value =
      content.value.slice(0, start) + "  " + content.value.slice(end);
    void nextTick(() => {
      el.selectionStart = el.selectionEnd = start + 2;
    });
    scheduleSave();
  }
  // Ctrl+S 手动保存（虽然自动保存已覆盖，但符合直觉）
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    void flush();
  }
}

const saveLabel = computed(() => {
  switch (saveState.value) {
    case "pending":
      return "未保存…";
    case "saving":
      return "保存中…";
    case "saved":
      return "已保存";
    case "error":
      return "保存失败";
    default:
      return "";
  }
});

watch(() => props.date, load, { immediate: true });
watch([title, content], scheduleSave);

// 关窗前尽力保存，减少意外丢失。
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
}
window.addEventListener("beforeunload", beforeUnload);
onUnmounted(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  // 组件卸载前把未落库的内容写下去。
  if (dirty) void flush();
});
</script>

<template>
  <section class="editor">
    <header class="bar">
      <div class="left">
        <span class="date">{{ humanDate(props.date) }}</span>
        <span class="meta">{{ wordCount }} 字</span>
        <span v-if="saveLabel" class="save" :class="saveState">{{
          saveLabel
        }}</span>
      </div>
      <button
        class="toggle"
        :class="{ on: previewMode }"
        @click="previewMode = !previewMode"
      >
        {{ previewMode ? "编辑" : "阅读" }}
      </button>
    </header>

    <p v-if="errorText" class="error">{{ errorText }}</p>

    <div v-if="loading" class="placeholder">读取中…</div>

    <template v-else>
      <input
        v-model="title"
        class="title-input"
        type="text"
        placeholder="标题（可留空）"
        maxlength="200"
      />

      <!-- 阅读模式：渲染 Markdown -->
      <article
        v-if="previewMode"
        class="preview markdown-body"
        v-html="renderedHtml"
      />

      <!-- 编辑模式：Markdown 源码 -->
      <textarea
        v-else
        v-model="content"
        class="content-input"
        placeholder="今天发生了什么…"
        spellcheck="false"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
        @keydown="onKeydown"
      />
    </template>
  </section>
</template>

<style scoped>
.editor {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 28px 24px;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.left {
  display: flex;
  align-items: baseline;
  gap: 14px;
}
.date {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}
.meta {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.save {
  font-size: 12px;
  color: var(--text-3);
}
.save.error {
  color: var(--danger);
}
.save.saved {
  color: var(--ok);
}
.toggle {
  padding: 6px 14px;
  font-size: 13px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
}
.toggle:hover {
  background: var(--hover);
}
.toggle.on {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}
.title-input {
  width: 100%;
  padding: 4px 0 12px;
  font-size: 21px;
  font-weight: 600;
  color: var(--text-1);
  background: transparent;
  border: none;
  outline: none;
}
.title-input::placeholder {
  color: var(--text-3);
  font-weight: 400;
}
.content-input {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 0;
  font-family: var(--mono);
  font-size: 15px;
  line-height: 1.9;
  color: var(--text-1);
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  tab-size: 2;
}
.content-input::placeholder {
  color: var(--text-3);
}
.preview {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.placeholder,
.error {
  font-size: 13px;
  color: var(--text-3);
}
.error {
  color: var(--danger);
  margin-bottom: 10px;
}
</style>
