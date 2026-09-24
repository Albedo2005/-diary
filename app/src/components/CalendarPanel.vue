<script setup lang="ts">
/**
 * 日历面板：写日记屏左边那一栏。
 *
 * 设计要点：
 *   - 一周从**周一**开始（中国用户习惯），所以排版偏移要把 JS 的周日=0 换算过来
 *   - 有日记的日子做标记，让用户一眼看到这个月写了哪些天
 *   - 所有日期都按**本地时区**处理（见 utils/date.ts 的说明）
 *
 * ⚠️ 底部原来那块「标签」列表（改名 ✎ / 删除 ✕ / 每条多少篇）在 **P2-7** 时
 *    **整块搬去了筛选页**（`FilterPanel.vue`）—— 那里才是它该在的地方：
 *    标签在那边能**点**（点一下加进筛选条件），在这边只能看。
 *    搬走之后下面自然留白：`.calendar` 是 flex 列，剩余空间本来就只是空着，
 *    ⛔ **一个占位元素都不要加**（用户明确说"先空着"）。
 *    ⚠️ 连带变化：「标签改动 → 各处刷新」原来的消费者之一是这里，现在换成了
 *       筛选页 ⇒ `tagToken` 这个 prop 与本组件**再无关系**。
 */
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { MOOD_EMOJI, toAppError, writtenDates, writtenMoods } from "../api";
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
  /** 这一本最早写过的那天（一篇都没写过时是 null）—— 给「第一篇」用 */
  firstDate: string | null;
  /** 最近写过的那天（一篇都没写过时是 null）—— 给「最近一篇」用 */
  lastDate: string | null;
}>();

const emit = defineEmits<{
  (e: "select", date: string): void;
  /** 给用户的一句话反馈（由 App.vue 弹 toast） */
  (e: "notice", message: string): void;
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

/* ── 年月面板（指令 9）────────────────────────────────────────────────
   标题此前是「一点就回今天」：既没有视觉提示（悬停才看得到），又把
   「回今天」这件常用的事藏了起来。现在点标题弹一个面板 ——
   上面翻年 + 选月，下面三个快捷入口。
   （年份那一行自 2026-09-22 起**点一下就能直接打字**，见下面「年份改成可直接输入」一段。）

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

/* ── 年份改成可直接输入（指令 16，2026-09-22）──────────────────────────
   从"只能 ‹ › 一格一格挪"改成**点一下直接打年份**。
   用户当场拍的板（逐条对应，别自己改口径）：
     - **点一下才显示输入框** —— "常显"那个方案被明确否掉（原话："太丑了"）；
     - 范围**仍是 `1949 ~ 2099`**，超出的一律**夹到边界**（打 1800 → 1949、3000 → 2099）；
     - **只有按回车算"打完了"**；其它任何离开方式（失焦、点箭头、点月份）**一律放弃草稿**、
       显示退回原年份 —— 所以"打了半截又去点箭头"不会既提交又步进、一下跳两年；
     - 输完**只换面板年份**，不替你选月份、也不关面板（与 ‹ › 同一套行为）；
     - 输入框里按 Esc **一律关掉整个面板**（与面板外按 Esc 同待遇，走的是下面那条现成的全局监听）。
   ⚠️ 输入过程中**一律不校验、不 clamp、不弹回** —— 打 "1"、"19" 都不是合法年份，
      边打边夹会完全没法用。只在回车那一下判断。
   ⚠️ 中文输入法：回车提交前必须先看 `ev.isComposing`（中文输入法里 Enter 是
      "上屏候选词"，不挡会在选词时误提交）。 */
const yearEditing = ref(false);
const yearDraft = ref("");
const yearInputRef = ref<HTMLInputElement | null>(null);

/** 点年份文字：换成输入框，聚焦并全选（省得先删掉旧的）。 */
async function startYearEdit() {
  yearDraft.value = String(pickerYear.value);
  yearEditing.value = true;
  await nextTick();
  yearInputRef.value?.focus();
  yearInputRef.value?.select();
}

/** 退出编辑态（提交与放弃都走它），显示退回 pickerYear。 */
function endYearEdit() {
  yearEditing.value = false;
  yearDraft.value = "";
}

/**
 * 只留数字。
 * 全角数字（中文输入法下很容易打出来）先折成半角再过滤，
 * 顺带挡掉粘贴进来的 "1998年" / "1,998" 之类。
 */
function onYearInput() {
  const half = yearDraft.value.replace(/[\uff10-\uff19]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  const cleaned = half.replace(/[^0-9]/g, "").slice(0, 4);
  if (cleaned !== yearDraft.value) yearDraft.value = cleaned;
}

/**
 * 回车提交。
 *
 * 「夹到边界」＝ 只要解析得出数字就 clamp；**什么都没打（空）夹不了，退回原值**。
 * （位数不足的如 "19" 也走同一条规则、夹到 1949 —— 与"夹到边界"这个口径一致；
 *   不再额外加一套"位数不够就拒绝"的说法。）
 */
function commitYear() {
  const raw = yearDraft.value;
  if (raw !== "") pickerYear.value = clampYear(Number(raw));
  endYearEdit();
}

/** 回车：中文输入法正在组合时不算（那是"上屏候选词"）。 */
function onYearEnter(ev: KeyboardEvent) {
  if (ev.isComposing) return;
  commitYear();
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
  if (!open) {
    // 面板一关就把"改年份"状态一起收掉：下次打开是干净的文本，
    // 不会留着一个空输入框，也不会把半截草稿带过去。
    endYearEdit();
    return;
  }
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

          <!--
            年份平时是**文字**（"常显输入框"被用户否掉过一次，嫌丑），
            点一下才变成输入框。回车提交；失焦 / 点箭头 / 点月份都算放弃草稿。
          -->
          <input
            v-if="yearEditing"
            ref="yearInputRef"
            v-model="yearDraft"
            class="picker-year-input"
            type="text"
            inputmode="numeric"
            maxlength="4"
            :title="`输入 ${YEAR_MIN} ~ ${YEAR_MAX} 之间的年份，回车确认`"
            @input="onYearInput"
            @keydown.enter="onYearEnter"
            @blur="endYearEdit"
          />
          <button
            v-else
            class="picker-year-text"
            title="点击可直接输入年份"
            @click="startYearEdit"
          >
            {{ pickerYear }} 年
          </button>

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
/* 年份平时是一段**可点的文字**，点一下才换成输入框（指令 16）。
   cursor 用 text 而不是 pointer：暗示"点进去能打字"，不是"点一下就跳"。 */
.picker-year-text {
  padding: 3px 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: text;
}
.picker-year-text:hover {
  background: var(--hover);
  border-color: var(--border);
}
/* 宽度与文字态（"2026 年" ≈ 63px）对齐，切换时那一行不会左右跳一下。 */
.picker-year-input {
  box-sizing: border-box;
  width: 63px;
  padding: 3px 6px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  text-align: center;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 6px;
  outline: none;
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
