<script setup lang="ts">
/**
 * 日历面板：应用的主界面。
 *
 * 设计要点：
 *   - 一周从**周一**开始（中国用户习惯），所以排版偏移要把 JS 的周日=0 换算过来
 *   - 有日记的日子做标记，让用户一眼看到这个月写了哪些天
 *   - 所有日期都按**本地时区**处理（见 utils/date.ts 的说明）
 */
import { computed, ref, watch } from "vue";
import {
  deleteTag,
  listTags,
  MOOD_EMOJI,
  renameTag,
  TAG_MAX_CHARS,
  toAppError,
  writtenDates,
  writtenMoods,
  type TagStat,
} from "../api";
import {
  humanMonth,
  monthGrid,
  shiftMonth,
  toMonthKey,
  todayKey,
} from "../utils/date";

const props = defineProps<{
  /** 当前选中的日期 */
  selected: string;
  /** 外部要求刷新的信号（保存日记后由父组件递增） */
  refreshToken: number;
  /** 标签被别处改动（编辑器加/撤了标签）时由父组件递增 */
  tagToken: number;
}>();

const emit = defineEmits<{
  (e: "select", date: string): void;
  /** 给用户的一句话反馈（由 App.vue 弹 toast） */
  (e: "notice", message: string): void;
  /** 本组件改动了标签（改名 / 删除），编辑器也要跟着刷新 */
  (e: "tags-changed"): void;
}>();

const month = ref(props.selected.slice(0, 7));
const written = ref<Set<string>>(new Set());
/** 标过心情的日子 → 心情值（1~5）。没标的日子不在这个表里。 */
const moods = ref<Map<string, number>>(new Map());
const loading = ref(false);
const errorText = ref("");

const today = todayKey();
const cells = computed(() => monthGrid(month.value));
const weekLabels = ["一", "二", "三", "四", "五", "六", "日"];

/** 本月已写的天数，用于日历下方的统计。 */
const monthCount = computed(
  () =>
    [...written.value].filter((d) => d.startsWith(month.value)).length
);

async function load() {
  loading.value = true;
  errorText.value = "";
  try {
    // 只用 writtenDates 就够：后端已按"正文非空白"过滤
    // （见 db::HAS_CONTENT_SQL），所以"打开过的日期"不再被当成"写过的日期"。
    //
    // 这里曾经额外合并 list_month 的结果，那会掩盖上面的过滤 —— 只要表里有行
    // 就标记，因此点一下日历就显示"写过"。现在两个接口用的是同一条规则。
    //
    // 心情单独取一次（written_moods）：它是**第三种标记**，只在真正标过的
    // 日子出现，不参与"写过"的判定。两次查询互不依赖，并发发出去。
    const from = `${month.value}-01`;
    const to = `${month.value}-31`;
    const [dates, dayMoods] = await Promise.all([
      writtenDates(from, to),
      writtenMoods(from, to),
    ]);
    written.value = new Set<string>(dates);
    moods.value = new Map(dayMoods.map((d) => [d.entry_date, d.mood]));
  } catch (e) {
    errorText.value = toAppError(e).message;
  } finally {
    loading.value = false;
  }
}

/** 某天的心情表情。没标记时返回空串（模板里靠它决定要不要渲染那一格）。 */
function moodEmoji(date: string): string {
  const m = moods.value.get(date);
  return m === undefined ? "" : (MOOD_EMOJI[m] ?? "");
}

// ---------------------------------------------------------------------------
// 标签列表（本指令的"列表展示入口"）
//
// ⚠️ 这里**只展示与管理，不做筛选** —— 按标签筛日记是后面的事。
//    之所以把改名 / 删除放在这儿：这两个动作在后端与接口层已经有了，
//    若界面上一个入口都不给，它们就是谁也点不到的死代码，
//    而"删掉标签日记还在不在"这种问题也就没法亲眼验证。
// ---------------------------------------------------------------------------

const tags = ref<TagStat[]>([]);
const tagError = ref("");
/** 正在改名的那条（null = 没有）。同一时刻只允许一条。 */
const editingId = ref<number | null>(null);
const editName = ref("");
const tagBusy = ref(false);

async function loadTags() {
  try {
    tags.value = await listTags();
    tagError.value = "";
  } catch (e) {
    tagError.value = toAppError(e).message;
  }
}

/** 开始改名：把当前名字填进输入框，全选，方便直接覆盖。 */
function startRename(t: TagStat) {
  editingId.value = t.id;
  editName.value = t.name;
  tagError.value = "";
}

function cancelRename() {
  editingId.value = null;
  editName.value = "";
}

/**
 * 提交改名。
 *
 * 名字被别的标签占着时后端返回 validation 错误 —— 这里原样显示，
 * **什么都不改**（不合并、不改任何一个标签）。这正是"重名要报错"的验收。
 */
async function commitRename() {
  const id = editingId.value;
  if (id === null || tagBusy.value) return;
  const name = editName.value.trim();
  if (!name) {
    cancelRename();
    return;
  }
  tagBusy.value = true;
  try {
    const finalName = await renameTag(id, name);
    cancelRename();
    emit("notice", `已改名为「${finalName}」`);
    await loadTags();
    emit("tags-changed");
  } catch (e) {
    // 故意**不关掉输入框**：用户改到一半撞上重名，应该能就地改个名字重试，
    // 而不是从头再来一遍。
    tagError.value = toAppError(e).message;
  } finally {
    tagBusy.value = false;
  }
}

/**
 * 删除标签。
 *
 * 不做二次确认：这个动作**碰不到任何日记内容**（外键方向是
 * tag → entry_tag，删除只清关联行），而且误删了重新打一次就回来了。
 * 为它弹一个"确定吗"反而把真实风险（改密码、删日记那种）的警示给稀释了。
 *
 * 但要在提示里说清"日记没事" —— 用户看到"已删除"三个字，
 * 第一反应就是"我的日记呢"。
 */
async function removeTag(t: TagStat) {
  if (tagBusy.value) return;
  tagBusy.value = true;
  try {
    const affected = await deleteTag(t.id);
    emit(
      "notice",
      affected > 0
        ? `已删除标签「${t.name}」——${affected} 篇日记的标签被移除，内容未受影响`
        : `已删除标签「${t.name}」（本来就没有日记在用它）`
    );
    if (editingId.value === t.id) cancelRename();
    await loadTags();
    emit("tags-changed");
  } catch (e) {
    tagError.value = toAppError(e).message;
  } finally {
    tagBusy.value = false;
  }
}

function goto(delta: number) {
  month.value = shiftMonth(month.value, delta);
}

function gotoToday() {
  month.value = toMonthKey(new Date());
  emit("select", today);
}

function pick(date: string) {
  emit("select", date);
}

// 切换月份时重新加载标记。
watch(month, load, { immediate: true });
// 保存日记后刷新标记。
watch(() => props.refreshToken, load);
/**
 * 标签列表：挂载时读一次，之后任何一处改动标签都通过 tagToken 重读
 *（编辑器加/撤、这里改名/删除）。
 *
 * 刻意**不跟着月份走**：标签是全库的，不属于某个月；
 * 每翻一次日历就重查一遍是白费。
 */
watch(() => props.tagToken, loadTags, { immediate: true });
// 选中日期跨月时（例如点"今天"）同步月份。
watch(
  () => props.selected,
  (d) => {
    const m = d.slice(0, 7);
    if (m !== month.value) month.value = m;
  }
);
</script>

<template>
  <aside class="calendar">
    <header class="head">
      <button class="nav" title="上个月" @click="goto(-1)">‹</button>
      <button class="month-label" title="回到今天" @click="gotoToday">
        {{ humanMonth(month) }}
      </button>
      <button class="nav" title="下个月" @click="goto(1)">›</button>
    </header>

    <div class="weekdays">
      <span v-for="w in weekLabels" :key="w">{{ w }}</span>
    </div>

    <div class="grid">
      <template v-for="(cell, i) in cells" :key="i">
        <span v-if="cell === null" class="cell empty" />
        <button
          v-else
          class="cell"
          :class="{
            selected: cell === props.selected,
            today: cell === today,
            written: written.has(cell),
          }"
          @click="pick(cell)"
        >
          {{ Number(cell.slice(8, 10)) }}
          <!--
            第三种标记：心情。只在标过的日子出现，放右上角 ——
            与"写过"的圆点（底部）、"今天"的高亮框（内阴影）各占一处，
            互不干扰，也没有改动它们原有的样式。
          -->
          <span v-if="moodEmoji(cell)" class="mood">{{
            moodEmoji(cell)
          }}</span>
        </button>
      </template>
    </div>

    <p v-if="errorText" class="error">{{ errorText }}</p>
    <p v-else class="summary">
      本月写了 <strong>{{ monthCount }}</strong> 天
      <span v-if="loading" class="loading">· 读取中</span>
    </p>

    <!--
      标签列表（本指令要求的"列表展示入口"）。
      只展示 + 改名 / 删除；**筛选留到后面做**，所以名字本身不可点。

      篇数只算"写过"的日记，所以会出现 0 篇 —— 那表示"这个标签还在库里，
      但没有任何写过的日记在用它"，界面上如实显示，别藏起来：
      藏了用户就永远没机会删它。
    -->
    <section class="tags">
      <h3 class="tags-head">
        标签
        <span class="tags-total">{{ tags.length }}</span>
      </h3>

      <p v-if="tagError" class="error tags-error">{{ tagError }}</p>
      <p v-if="tags.length === 0" class="tags-empty">还没有标签</p>

      <ul class="tags-list">
        <li v-for="t in tags" :key="t.id" class="tag-item">
          <template v-if="editingId === t.id">
            <input
              v-model="editName"
              class="tag-edit"
              type="text"
              :maxlength="TAG_MAX_CHARS"
              :disabled="tagBusy"
              @keydown.enter.prevent="commitRename"
              @keydown.esc="cancelRename"
            />
            <button class="tag-op" title="保存" @click="commitRename">✓</button>
            <button class="tag-op" title="取消" @click="cancelRename">✕</button>
          </template>
          <template v-else>
            <span class="tag-name" :title="t.name">{{ t.name }}</span>
            <span class="tag-count">{{ t.entry_count }} 篇</span>
            <button
              class="tag-op"
              title="改名（改名不会合并到同名标签上，重名会报错）"
              @click="startRename(t)"
            >
              ✎
            </button>
            <button
              class="tag-op danger"
              title="删除标签（只清标签，日记内容不受影响）"
              @click="removeTag(t)"
            >
              ✕
            </button>
          </template>
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
.calendar {
  width: 268px;
  flex-shrink: 0;
  padding: 18px 16px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.nav {
  width: 28px;
  height: 28px;
  font-size: 18px;
  line-height: 1;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.nav:hover {
  background: var(--hover);
}
.month-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}
.month-label:hover {
  background: var(--hover);
}
.weekdays,
.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.weekdays {
  margin-bottom: 6px;
}
.weekdays span {
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  padding: 4px 0;
}
.cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-1);
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  position: relative;
  font-variant-numeric: tabular-nums;
}
.cell.empty {
  cursor: default;
}
.cell:not(.empty):hover {
  background: var(--hover);
}
/* 写过日记的日子：底色 + 小圆点 */
.cell.written {
  background: var(--accent-soft);
  font-weight: 500;
}
.cell.written::after {
  content: "";
  position: absolute;
  bottom: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
}
.cell.today {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
.cell.selected {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.cell.selected::after {
  background: #fff;
}
/* 第三种标记：心情。放右上角，避开底部的"写过"圆点。 */
.cell .mood {
  position: absolute;
  top: 1px;
  right: 2px;
  font-size: 9px;
  line-height: 1;
  pointer-events: none;
}
.summary {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
.summary strong {
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.loading {
  color: var(--text-3);
}
.error {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--danger);
}

/* ---------------------------------------------------------------------------
   标签列表
   占满日历下方的剩余高度并自己滚动：标签数量不可控，
   顶到窗口外面去的话既看不见也点不到（日历本体是固定高度的）。
   --------------------------------------------------------------------------- */
.tags {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.tags-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.tags-total {
  font-weight: 400;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.tags-error {
  margin: 0 0 8px;
}
.tags-empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.tags-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}
.tag-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 2px 3px 6px;
  border-radius: 6px;
}
.tag-item:hover {
  background: var(--hover);
}
.tag-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* 改名 / 删除：常显但压暗，悬停才提亮 —— 一直闪烁会吵，
   完全藏起来又没人知道这里有按钮。 */
.tag-op {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: var(--text-3);
  opacity: 0.5;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.tag-item:hover .tag-op {
  opacity: 1;
}
.tag-op:hover {
  color: var(--text-1);
  background: var(--hover);
}
.tag-op.danger:hover {
  color: var(--danger);
}
.tag-edit {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 5px;
  outline: none;
}
</style>
