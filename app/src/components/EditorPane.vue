<script setup lang="ts">
/**
 * 日记编辑器。
 *
 * 形态：**Markdown 源码 + 语法高亮**（形态 A），配一个一键**锁定**。
 * 为什么不做所见即所得：那是 V1 的目标（见 docs/backlog.md），
 * 复杂度是现在的 5~8 倍。而写日记最需要的是"打开就能写"，排版好看是**回看**时的需求。
 *
 * ⚠️ 右上角按钮的历史：它原来是"阅读"，把正文当 Markdown 渲染成 HTML。
 *    那个视图**会吃掉用户手动排的版** —— Markdown 的规矩是单个换行等于空格、
 *    行首空格被吞掉。用户自己排的版很好看，一进"阅读"就全塌了。
 *    所以改成了"锁定"：**正文一字不改地原样显示**，只是不可编辑。
 *    结论：Markdown 渲染对"手工排版"是破坏性的，这也是将来上所见即所得（V1）
 *    而不是继续加渲染开关的理由。
 *
 * ⚠️ 铁律：正文永远以 **Markdown 原文**落库。
 *    将来升级到所见即所得时，富文本只在内存里存在，存库前仍转回 Markdown。
 *    一旦改成 HTML/富文本 JSON，导出、搜索、备份全要重写，升级也不再平滑。
 *
 * 自动保存策略：输入停止 1 秒后落库。
 * 中文输入法组字期间**暂停保存** —— 否则会把打到一半的拼音存进数据库。
 */
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import {
  deleteEntry,
  listTags,
  lockAllEntries,
  MOODS,
  openEntry,
  saveEntry,
  setEntryLocked,
  setEntryTags,
  TAG_MAX_CHARS,
  TAG_SUGGEST_LIMIT,
  tagsOfEntry,
  toAppError,
  type Entry,
  type TagStat,
} from "../api";
import { humanDate } from "../utils/date";

const props = defineProps<{
  date: string;
  /** 保存成功后通知父组件（用于刷新日历标记） */
  onSaved?: () => void;
  /**
   * 标签变更信号。侧栏删掉 / 改名了某个标签时由父组件递增，
   * 用来让这里的 chip 行与下拉候选跟着刷新。
   */
  tagToken?: number;
}>();

const emit = defineEmits<{
  (e: "saved"): void;
  /** 本组件的标签改动也要让侧栏的标签列表知道（篇数变了）。 */
  (e: "tags-changed"): void;
}>();

const loading = ref(false);
const errorText = ref("");
const title = ref("");
const content = ref("");
/** '' | 'pending' | 'saving' | 'saved' | 'error' */
const saveState = ref<"" | "pending" | "saving" | "saved" | "error">("");
/** 锁定：正文只读。注意锁的是**能否修改**，不是显示方式。 */
const locked = ref(false);
const entry = ref<Entry | null>(null);

/**
 * 当前这篇的心情。null = 未标记。
 *
 * 档位表（数值 ↔ emoji）在 `api/index.ts` 的 `MOODS` —— 与日历共用同一份，
 * 避免“编辑器标的是开心、日历显示受伤”这类漂移。
 */
const mood = ref<number | null>(null);

/**
 * 这一篇的标签（后端返回的权威名字，不是本地猜的）。
 *
 * ⚠️ 每次改动都**用后端的返回值整体替换**（`set_entry_tags` 返回实际存下来的
 *    列表）。本地自己 push/splice 看着更省一次往返，但清洗规则在后端
 *    （去空白、限长、忽略大小写去重），本地那份迟早与库里差一点 ——
 *    那就成了两套真相。
 */
const tags = ref<string[]>([]);

/** 标签输入框里的内容（还没提交）。 */
const tagInput = ref("");
/** 全库的标签（含篇数）。下拉候选与"已存在过"的提示都来自它。 */
const allTags = ref<TagStat[]>([]);
/** 下拉候选是否展开。 */
const tagOpen = ref(false);
/** 标签请求进行中。避免连点两下产生两次"整组覆盖"（会互相覆盖）。 */
const tagBusy = ref(false);
const tagError = ref("");

/**
 * 标签区是否可编辑。
 *
 * 两道闸，与心情条同款：
 *   1. **正文为空时不能打标签**。标签挂在 entry_id 上，而 entry 行是保存
 *      正文时产生的 —— 空日记的 id 是 0，此时打标签要么插一条空行
 *      （直接破坏"打开 ≠ 写过"这条铁律），要么失败。后端也会拒，
 *      这里置灰只是为了不让用户白填一次。
 *   2. 锁定时不能改：锁定 = 只读，标签也是这篇日记的一部分。
 */
const canTag = computed(() => hasContent() && !locked.value);

/** 标签区的悬停提示 / 置灰时旁边那行说明。 */
const tagHint = computed(() => {
  if (locked.value) return "解锁后可改标签";
  if (!hasContent()) return "先写点内容，再贴标签";
  return "回车添加；点 × 移除";
});

/**
 * 下拉候选：已有的、这篇还没有的、且与输入内容沾边的。
 *
 * 空输入时给出**全部**已有标签 —— 标签的价值在于复用，
 * 让用户在打第一个字之前就看见"上次那个叫什么"，比让他凭记忆打更实用。
 */
const tagSuggestions = computed(() => {
  const q = tagInput.value.trim().toLowerCase();
  return allTags.value
    .filter((t) => !tags.value.includes(t.name))
    .filter((t) => q === "" || t.name.toLowerCase().includes(q))
    .slice(0, TAG_SUGGEST_LIMIT);
});

/**
 * 心情条是否可点。
 *
 * 两道闸：
 *   1. **正文为空时不能标**。后端在正文为空时会丢掉心情，前端置灰是为了
 *      不让用户白点一次；更根本的是不让"有心情但没内容"的记录出现 ——
 *      那会与"打开 ≠ 写过"这条铁律冲突。
 *   2. 锁定时不能改，与锁定状态下其它编辑行为保持一致。
 */
const canMarkMood = computed(() => hasContent() && !locked.value);

/** 心情条的悬停提示，把"为什么点不动"讲清楚。 */
const moodHint = computed(() => {
  if (locked.value) return "解锁后可修改心情";
  if (!hasContent()) return "先写点内容，再标心情";
  return "今天心情如何？再点一次可取消";
});

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

/**
 * 切换锁定 / 解锁。
 *
 * 只调后端改一个标记位，**不提交任何正文** —— 这是"锁定不改变排版"的保证：
 * 走的接口根本不带 title/content 参数，想改也改不了。
 */
async function toggleLock() {
  const next = !locked.value;
  errorText.value = "";
  try {
    // 锁定前先把已改的内容落库，否则会丢掉"锁定前最后一次编辑"。
    if (next && dirty) await flush();
    const e = await setEntryLocked(props.date, next);
    entry.value = e;
    locked.value = e.locked;
    saveState.value = "";
  } catch (e) {
    errorText.value = toAppError(e).message;
  }
}

async function load() {
  loading.value = true;
  errorText.value = "";
  cancelPendingSave();
  try {
    // 先把所有日记锁上，再读要打开的这一篇。
    // 于是"切换日期"和"重新打开软件"都会让上一篇自动回到锁定状态。
    await lockAllEntries();
    // openEntry 是纯读取：没有内容时返回空模板（id = 0），不会写库。
    // 所以"点开日历"不会把这一天变成"写过"。
    const e = await openEntry(props.date);
    entry.value = e;
    title.value = e.title;
    content.value = e.content_md;
    locked.value = e.locked;
    mood.value = e.mood;
    // 先清空再读：读失败时宁可"看不到标签"，也不能把上一天的标签
    // 留在屏幕上冒充这一天的（那会让用户以为标签串了）。
    tags.value = [];
    tagInput.value = "";
    tagOpen.value = false;
    await loadTags();
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
  // 锁定时一律不保存。load() 会把内容写进 title/content，从而触发本函数 ——
  // 没有这道闸，打开一篇锁定的日记就会立刻发起一次注定被后端拒绝的保存。
  if (locked.value) return;
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
async function flush(forDate: string = props.date) {
  if (locked.value) return; // 锁定的日记不写库
  if (!dirty) return;
  cancelPendingSave();

  // 规则 1 与 2
  if (!hasContent()) {
    if (isPersisted()) {
      saveState.value = "saving";
      try {
        await deleteEntry(forDate);
        entry.value = null;
        // 行都没了，心情自然也不存在。前端跟着清掉 ——
        // 否则界面上还留着一个高亮的表情，看着"有心情"，重开这天却是空的。
        mood.value = null;
        // 标签同理，而且是**两层**都不存在了：
        // entry 行没了 → entry_tag 的 ON DELETE CASCADE 把关联行清掉
        //（标签本身还在，可能别的日记在用）。所以这里清空的是"这一篇的标签"。
        tags.value = [];
        dirty = false;
        saveState.value = "";
        emit("saved");
        // 篇数少了，侧栏那份标签列表要跟着变。
        emit("tags-changed");
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
    const e = await saveEntry(forDate, title.value, content.value, mood.value);
    entry.value = e;
    dirty = false;
    saveState.value = "saved";
    emit("saved");
  } catch (e) {
    saveState.value = "error";
    errorText.value = toAppError(e).message;
  }
}

/**
 * 点选心情。
 *
 * **立即保存**，不进防抖队列：心情是个离散选择，点完就该落库。
 * 若跟着正文的 1 秒防抖走，用户点完马上切日期，这次心情会连着"未保存"
 * 一起被丢掉。
 *
 * 再点同一个档位 = 取消标记（传 null）。
 * 正文为空时直接返回 —— 按钮本来就是禁用的，这里是第二道闸。
 */
function pickMood(value: number) {
  if (!canMarkMood.value) return;
  mood.value = mood.value === value ? null : value;
  dirty = true;
  saveState.value = "pending";
  void flush();
}

/**
 * 读这一篇的标签 + 全库标签（下拉候选用）。
 *
 * 两个查询互不依赖，并发发出去。失败只记错误、不阻塞编辑 ——
 * 标签是附加信息，读不到不该让整个编辑器用不了。
 */
async function loadTags() {
  tagError.value = "";
  try {
    const [mine, all] = await Promise.all([
      tagsOfEntry(props.date),
      listTags(),
    ]);
    tags.value = mine;
    allTags.value = all;
  } catch (e) {
    tagError.value = toAppError(e).message;
  }
}

/**
 * 把这一篇的标签整组提交给后端，并用后端返回的那份刷新界面。
 *
 * ⚠️ 提交前必须先把正文落库。标签挂的是 `entry_id`，而 entry 行是
 *    `save_entry` 的 upsert 产生的：用户打下第一个字、还没到 1 秒防抖就
 *    去贴标签的话，库里根本没有那一行 —— 后端会回"先写点内容再打标签"，
 *    而他明明已经写了。那种错最让人摸不着头脑，所以在这一层先 flush。
 */
async function commitTags(next: string[]) {
  // 整组覆盖是"读-改-写"，两次并发会互相覆盖（后到的把先到的结果冲掉），
  // 所以同一时刻只允许一次在飞。
  if (tagBusy.value) return;
  tagBusy.value = true;
  tagError.value = "";
  try {
    if (dirty) await flush();
    // flush 失败（例如已锁定）时就别往下走了：库里的行没变，
    // 这时候提交标签只会再报一个看不懂的错。
    if (saveState.value === "error") return;

    tags.value = await setEntryTags(props.date, next);
    // 篇数变了，侧栏那份列表也得跟着变。
    allTags.value = await listTags();
    tagInput.value = "";
    emit("tags-changed");
  } catch (e) {
    tagError.value = toAppError(e).message;
  } finally {
    tagBusy.value = false;
  }
}

/**
 * 添加一个标签。
 *
 * 重复的直接吞掉（不报错、也不发请求）：用户常常记不清有没有加过，
 * 连点两下就弹个"已存在"很烦人。判定**忽略大小写** ——
 * 后端 `tag.name` 是 `UNIQUE COLLATE NOCASE`，`Travel` 与 `travel`
 * 本来就是同一个标签。
 */
function addTag(raw: string) {
  const name = raw.trim();
  if (!name) return;
  const lower = name.toLowerCase();
  if (tags.value.some((t) => t.toLowerCase() === lower)) {
    tagInput.value = "";
    return;
  }
  void commitTags([...tags.value, name]);
}

function removeTag(name: string) {
  void commitTags(tags.value.filter((t) => t !== name));
}

/** 点下拉里的候选。加完保持展开，方便连着加几个。 */
function pickSuggestion(name: string) {
  tagOpen.value = true;
  addTag(name);
}

function onTagKeydown(ev: KeyboardEvent) {
  // ⚠️ 输入法组字期间的回车是在**选词**，不是在提交标签。
  //    不挡这一下，中文用户每打完一个词都会顺手 . 提交一次。
  if (ev.isComposing) return;
  if (ev.key === "Enter") {
    ev.preventDefault();
    addTag(tagInput.value);
  } else if (ev.key === "Escape") {
    tagOpen.value = false;
    tagInput.value = "";
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
  // 只读输入框仍然会触发 keydown。不挡住的话，在锁定状态下按 Tab 会悄悄改掉
  // 内存里的 content —— 界面上看不见变化，解锁后那次编辑却会被保存进去。
  if (locked.value) return;
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

watch(
  () => props.date,
  async (_next, prev) => {
    // ⚠️ 先保存，再锁定，顺序不能反。
    //
    // 两件事都容易踩错：
    //   1. load() 会 lockAllEntries()。要是先锁再存，这次保存会被刚上的锁
    //      拒绝，用户最后敲的几个字**静默消失**（界面上只闪一下"保存失败"）。
    //   2. 必须写到 prev（旧日期）。此刻 props.date 已经是新日期了，
    //      照 props.date 写会把 A 的正文覆盖到 B 那天上 —— 那比丢字更糟。
    if (dirty && prev) await flush(prev);
    await load();
  }
);
watch([title, content], scheduleSave);

/**
 * 侧栏删掉了某个标签 / 把它改了名 → 这里的 chip 行与下拉候选都得刷新
 *（被删的那个可能正挂在这一篇上）。
 *
 * 自己发出的改动也会绕回来触发一次（父组件把 tagToken 递增后传回来），
 * 多查一次不算浪费：它保证界面上的最终状态**来自数据库**，
 * 而不是来自前端自己那条推理链。
 *
 * ⚠️ 只监听 tagToken，**不监听 date** —— 换日期由 load() 负责，
 *    它已经读过一次标签了，这里再读一次就是纯重复。
 */
watch(
  () => props.tagToken,
  () => void loadTags()
);

// 首屏：load() 里的 lockAllEntries() 顺带实现了
// "关掉软件再打开，所有日记都是锁的"。
void load();

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
        :class="{ on: locked }"
        :title="locked ? '解锁后可继续修改' : '锁定后正文只读，排版原样保留'"
        @click="toggleLock"
      >
        {{ locked ? "🔒 已锁定" : "🔓 锁定" }}
      </button>
    </header>

    <p v-if="errorText" class="error">{{ errorText }}</p>

    <div v-if="loading" class="placeholder">读取中…</div>

    <template v-else>
      <div class="title-row">
        <input
          v-model="title"
          class="title-input"
          type="text"
          placeholder="标题（可留空）"
          maxlength="200"
          :readonly="locked"
          :class="{ locked }"
        />

        <!--
          心情条：五档，当前档高亮。
          正文为空 / 锁定状态下整体置灰 —— 后端在空内容时会丢掉心情，
          置灰是为了不让用户白点，也避免产生"有心情但没内容"的记录。
        -->
        <div
          class="mood-bar"
          :class="{ disabled: !canMarkMood }"
          :title="moodHint"
        >
          <button
            v-for="m in MOODS"
            :key="m.value"
            class="mood-btn"
            :class="{ on: mood === m.value }"
            :disabled="!canMarkMood"
            @click="pickMood(m.value)"
          >
            {{ m.emoji }}
          </button>
        </div>
      </div>

      <!--
        标签区：已有标签是 chip（点 × 移除），末尾一个 ＋ 输入框（回车添加，
        输入时下拉提示已用过的标签）。

        ⚠️ 正文为空 / 已锁定时整个区置灰，并把原因写在旁边（tagHint）——
           "为什么点不动"必须当场说清楚，否则用户只会觉得按钮坏了。
           后端也会拒（标签挂 entry_id，空日记没有 id），这里只是省得他白填。
      -->
      <div class="tag-row" :class="{ disabled: !canTag }">
        <span v-for="t in tags" :key="t" class="chip">
          <span class="chip-name">{{ t }}</span>
          <button
            class="chip-x"
            :disabled="!canTag || tagBusy"
            :title="canTag ? `移除标签「${t}」` : tagHint"
            @click="removeTag(t)"
          >
            ×
          </button>
        </span>

        <div class="tag-add">
          <input
            v-model="tagInput"
            class="tag-input"
            type="text"
            placeholder="＋ 标签"
            :maxlength="TAG_MAX_CHARS"
            :disabled="!canTag || tagBusy"
            :title="tagHint"
            @focus="tagOpen = true"
            @blur="tagOpen = false"
            @input="tagOpen = true"
            @keydown="onTagKeydown"
          />
          <!--
            下拉候选。
            ⚠️ 候选用 @mousedown.prevent：不挡这一下，输入框会在 click
               触发之前先 blur，下拉被关掉，用户永远点不中候选。
          -->
          <ul v-if="tagOpen && canTag && tagSuggestions.length" class="suggest">
            <li v-for="s in tagSuggestions" :key="s.id">
              <button type="button" @mousedown.prevent @click="pickSuggestion(s.name)">
                <span class="suggest-name">{{ s.name }}</span>
                <span class="suggest-count">{{ s.entry_count }} 篇</span>
              </button>
            </li>
          </ul>
        </div>

        <span v-if="!canTag" class="tag-note">{{ tagHint }}</span>
      </div>

      <p v-if="tagError" class="error">{{ tagError }}</p>

      <!--
        锁定与编辑共用同一个 textarea，**刻意不切换成渲染视图**。
        看得见的就是将要保存的原文：换行、空格、缩进全部原样，
        所以"锁定"不会改变排版。只读靠 readonly（不是 disabled）——
        disabled 的输入框不能选中、不能滚动，想复制一段都做不到。
      -->
      <textarea
        v-model="content"
        class="content-input"
        :class="{ locked }"
        placeholder="今天发生了什么…"
        spellcheck="false"
        :readonly="locked"
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
/* 标题与心情条同一行：标题吃掉剩余宽度，心情条固定宽度贴右。 */
.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.title-input {
  flex: 1;
  min-width: 0;
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

/* 心情条：未选中的档位淡一些，选中的高亮。 */
.mood-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.mood-btn {
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
  opacity: 0.4;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.mood-btn:hover:not(:disabled) {
  opacity: 1;
  background: var(--hover);
}
.mood-btn.on {
  opacity: 1;
  background: var(--accent-soft);
}
/* 不可点（正文为空 / 已锁定）：整体压暗，但仍看得见当前心情。 */
.mood-bar.disabled .mood-btn {
  opacity: 0.15;
  cursor: default;
}

/* 标签区：一行 chip + 一个 ＋ 输入框，可折行。 */
.tag-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 10px;
}
/* 不可编辑（空日记 / 已锁定）：整体压暗，但仍看得见已挂的标签。
   旁边那行 tag-note 说明原因 —— 光置灰不解释，用户只会以为坏了。 */
.tag-row.disabled .chip,
.tag-row.disabled .tag-add {
  opacity: 0.45;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px 2px 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  background: var(--accent-soft);
  border-radius: 999px;
}
.chip-x {
  width: 16px;
  height: 16px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--text-3);
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}
.chip-x:hover:not(:disabled) {
  color: var(--danger);
  background: var(--hover);
}
.chip-x:disabled {
  cursor: default;
}
/* 输入框本身要窄：标签一般两个字，占一行宽输入框会把整行撑开。 */
.tag-add {
  position: relative;
  display: flex;
  align-items: center;
}
.tag-input {
  width: 84px;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--text-1);
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 999px;
  outline: none;
}
.tag-input:focus {
  width: 120px;
  border-style: solid;
  border-color: var(--accent);
}
.tag-input:disabled {
  cursor: default;
}
.tag-input::placeholder {
  color: var(--text-3);
}
.tag-note {
  font-size: 12px;
  color: var(--text-3);
}
/* 下拉候选：绝对定位，不占版面高度（否则正文会被推下去一下）。 */
.suggest {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 10;
  min-width: 140px;
  max-height: 190px;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}
.suggest button {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  text-align: left;
  color: var(--text-1);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}
.suggest button:hover {
  background: var(--hover);
}
.suggest-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.suggest-count {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
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
/* 锁定态：文字淡一点表示只读，但仍然可选中、可复制、可滚动。 */
.title-input.locked,
.content-input.locked {
  color: var(--text-2);
  cursor: default;
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
