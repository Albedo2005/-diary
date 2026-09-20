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
}>();

const emit = defineEmits<{ (e: "select", date: string): void }>();

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
</style>
