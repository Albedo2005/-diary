<script setup lang="ts">
/**
 * 日历面板：应用的主界面。
 *
 * 设计要点：
 *   - 一周从**周一**开始（中国用户习惯），所以排版偏移要把 JS 的周日=0 换算过来
 *   - 有日记的日子做标记，让用户一眼看到这个月写了哪些天
 *   - 所有日期都按**本地时区**处理（见 utils/date.ts 的说明）
 */
import { computed, onUnmounted, ref, watch } from "vue";
import {
  retireTag,
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
  /** 这一本最早写过的那天（一篇都没写过时是 null）—— 给「第一篇」用 */
  firstDate: string | null;
  /** 最近写过的那天（一篇都没写过时是 null）—— 给「最近一篇」用 */
  lastDate: string | null;
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
/** 今年。只用来给年月面板的年份一个初始值（可翻范围是写死的，见 yearFloor / yearCeil）。 */
const currentYear = Number(today.slice(0, 4));
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
 * 让标签"退休"（界面上的「删除」）。
 *
 * 不做二次确认：它连日记的边都碰不到，而且重新打一次同名标签就复活了。
 * 为它弹一个"确定吗"反而把真实风险（改密码、删日记那种）的警示给稀释了。
 *
 * 但提示里必须说清两件事：① 从此不再出现在这个列表里（这是用户要的）；
 * ② **已经贴过它的日记仍然保留这个标签**（这是用户最担心的"我的日记呢"）。
 */
async function removeTag(t: TagStat) {
  if (tagBusy.value) return;
  tagBusy.value = true;
  try {
    const affected = await retireTag(t.id);
    emit(
      "notice",
      affected > 0
        ? `已移除标签「${t.name}」——以后不再出现在这里；另有 ${affected} 篇日记仍保留它`
        : `已移除标签「${t.name}」（本来就没有日记在用它）`
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

/* ── 年月面板（指令 9）────────────────────────────────────────────────
   标题此前是「一点就回今天」：既没有视觉提示（悬停才看得到），又把
   「回今天」这件常用的事藏了起来。现在点标题弹一个面板 ——
   上面翻年 + 选月，下面三个快捷入口。

   ⚠️ 面板只换 `month`，**不动 `selected`** —— 与 ‹ › 是同一套行为。
      用户只是想看看 2024 年写了什么，编辑区那篇日记不该被切走。
      唯一的例外是底部那三个入口，它们的语义本来就是「跳过去」。
   ⚠️ 浮层用 position:absolute，所以 .head 必须是定位上下文，
      否则它相对整个窗口定位、位置乱飞。z-index 20 才盖得住日期格。
   ⚠️ 切月后的标记重载由已有的 watch(month, load) 负责，这里**不再手动 load()** ——
      手动加一次会让每次切月发两遍 IPC。 */

const pickerOpen = ref(false);
const pickerYear = ref(currentYear);
const pickerRef = ref<HTMLElement | null>(null);
const headRef = ref<HTMLElement | null>(null);

const MONTH_LABELS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);

/**
 * 年份能翻的范围：**写死 `1949 ~ 2099`**（2026-09-22 定）。
 *
 * 这里原本是「最早写过的那年 −1 ～ 今年 +1」，**坏在"日记本很新时等于没余量"**：
 * 本子建在 2026 年 ⇒ 只能翻 2025 / 2026 / 2027 三格，用户按两下就撞墙、当成 bug 报上来。
 * 日历本来就该能随便往前翻，不该拿"你已经写了多久"来限制。
 *
 * ⚠️ 放宽到 150 年**不增加任何内存 / 性能开销**：这里只是两个数字常量；
 *    日历格子永远是 42 个（6 行 × 7 列），跟翻到哪一年无关；
 *    翻到没写过的年份，后端只是发一条查不到行的 `entry_date BETWEEN ? AND ?`。
 * ⚠️ 走到两头时两个箭头会自动置灰（模板里的 `:disabled`），不会"点了没反应"。
 */
const YEAR_MIN = 1949;
const YEAR_MAX = 2099;
const yearFloor = computed(() => YEAR_MIN);
const yearCeil = computed(() => YEAR_MAX);

function clampYear(y: number): number {
  return Math.min(Math.max(y, yearFloor.value), yearCeil.value);
}

/** 面板里该高亮的那个月：年份和月份都要对上。 */
function isCurrentMonth(m: number): boolean {
  return (
    pickerYear.value === Number(month.value.slice(0, 4)) &&
    m === Number(month.value.slice(5, 7))
  );
}

/** 点标题：开面板时把年份对到当前看的月份上，别让面板和日历各说各话。 */
function togglePicker() {
  if (!pickerOpen.value) {
    pickerYear.value = clampYear(Number(month.value.slice(0, 4)));
  }
  pickerOpen.value = !pickerOpen.value;
}

function shiftYear(delta: number) {
  pickerYear.value = clampYear(pickerYear.value + delta);
}

/** 点某个月：只换月份，选中日期不动。 */
function pickMonth(m: number) {
  month.value = `${pickerYear.value}-${String(m).padStart(2, "0")}`;
  pickerOpen.value = false;
}

/**
 * 「第一篇」/「最近一篇」：没有日记时置灰（模板里 :disabled），
 * 真点进来也直接返回，不让 null 混进 month。
 */
function jumpToEdge(date: string | null) {
  if (!date) return;
  month.value = date.slice(0, 7);
  emit("select", date);
  pickerOpen.value = false;
}

/**
 * 「点外部关闭」。
 *
 * ⚠️ 不能用 click 判断 —— 打开面板的那次 click 会接着冒泡到 document，
 *    于是「刚开就被自己关掉」。用 pointerdown，并且把**标题栏**（含 ‹ ›）
 *    也算成内部：它们只是旁观者，不该顺手把面板关掉。
 */
function onDocPointerDown(ev: PointerEvent) {
  if (!pickerOpen.value) return;
  const t = ev.target as Node | null;
  if (!t) return;
  if (pickerRef.value?.contains(t) || headRef.value?.contains(t)) return;
  pickerOpen.value = false;
}

function onDocKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") pickerOpen.value = false;
}

/** 监听器跟着面板开关走，关掉就摘。 */
watch(pickerOpen, (open, _old, onCleanup) => {
  if (!open) return;
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeydown);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeydown);
  });
});

/** 再摘一次：组件反复挂载不能把监听器攒起来。 */
onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown);
});

function goto(delta: number) {
  month.value = shiftMonth(month.value, delta);
}

function gotoToday() {
  month.value = toMonthKey(new Date());
  emit("select", today);
  pickerOpen.value = false;
}

function pick(date: string) {
  emit("select", date);
}

// 切换月份时重新加载标记。
watch(month, load, { immediate: true });
/**
 * 面板开着时用户仍可按标题两侧的 ‹ › 翻月（它们算「内部」，不会被当成
 * 点外部关掉）。翻完把年份对回去，免得面板写着 2026、日历已经翻到 2025。
 */
watch(month, (m) => {
  if (pickerOpen.value) pickerYear.value = clampYear(Number(m.slice(0, 4)));
});
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
    <header ref="headRef" class="head">
      <button class="nav" title="上个月" @click="goto(-1)">‹</button>
      <button
        class="month-label"
        :class="{ on: pickerOpen }"
        title="选择年月，或跳到第一篇 / 最近一篇"
        @click="togglePicker"
      >
        {{ humanMonth(month) }}
      </button>
      <button class="nav" title="下个月" @click="goto(1)">›</button>

      <!--
        年月面板。只换月份，不动选中日期（底部那三个入口除外）。
        年份的可翻范围见 yearFloor / yearCeil（写死 1949 ~ 2099）。
      -->
      <div v-if="pickerOpen" ref="pickerRef" class="picker">
        <div class="picker-year">
          <button
            class="nav"
            :disabled="pickerYear <= yearFloor"
            title="上一年"
            @click="shiftYear(-1)"
          >
            ‹
          </button>
          <span class="picker-year-text">{{ pickerYear }} 年</span>
          <button
            class="nav"
            :disabled="pickerYear >= yearCeil"
            title="下一年"
            @click="shiftYear(1)"
          >
            ›
          </button>
        </div>

        <div class="picker-months">
          <button
            v-for="(label, i) in MONTH_LABELS"
            :key="label"
            class="picker-month"
            :class="{ on: isCurrentMonth(i + 1) }"
            @click="pickMonth(i + 1)"
          >
            {{ label }}
          </button>
        </div>

        <div class="picker-quick">
          <button class="picker-link" title="跳到今天" @click="gotoToday">
            今天
          </button>
          <button
            class="picker-link"
            :disabled="!props.firstDate"
            title="跳到最早写过的那天"
            @click="jumpToEdge(props.firstDate)"
          >
            第一篇
          </button>
          <button
            class="picker-link"
            :disabled="!props.lastDate"
            title="跳到最近写过的那天"
            @click="jumpToEdge(props.lastDate)"
          >
            最近一篇
          </button>
        </div>
      </div>
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
              title="移除标签（以后不再出现在列表里；已写过的日记仍保留它）"
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
  /* 年月面板（position:absolute）的定位上下文 —— 少了它面板会相对窗口定位。 */
  position: relative;
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

/* ── 年月面板（指令 9）─────────────────────────────────────────────────── */
.picker {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 20;
  width: 100%;
  padding: 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}
.picker-year {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.picker-year-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.picker-months {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.picker-month {
  padding: 6px 0;
  font-size: 12px;
  color: var(--text-1);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.picker-month:hover {
  background: var(--hover);
}
.picker-month.on {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.picker-quick {
  display: flex;
  gap: 4px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.picker-link {
  flex: 1;
  padding: 6px 0;
  font-size: 12px;
  color: var(--text-1);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.picker-link:hover:not(:disabled) {
  background: var(--hover);
  border-color: var(--accent);
}
.picker-link:disabled {
  opacity: 0.45;
  cursor: default;
}
/* 面板开着时标题亮一下，表示"这个浮层是从这儿出来的"。 */
.month-label.on {
  background: var(--hover);
}
</style>
