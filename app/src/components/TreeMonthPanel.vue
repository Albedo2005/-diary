<script setup lang="ts">
/**
 * 「树语」侧边那块**数据面板** —— 点某个年轮块之后从右边滑出来。
 *
 * ── 它为什么会存在（2026-10-14 17:37 用户纠正） ─────────────────────
 * 第一版把"点开"做成了**环在树上原地抽出来**。用户要的是：
 *   「点击之后**在画面左右或者单开一个画面**去展示**圆环数据图**和其他更多的数据。」
 * ⇒ 数据回到 2D 面板里来，3D 那边只负责"点到哪一段树干"。
 *
 * ⭐ **纯展示**：所有数据都由 `TreePane` 算好传进来（它才是发后端命令的那一层）。
 *    ⛔ 本组件不发任何命令、不读 `localStorage`、不碰 3D。
 *    这么分的好处跟 `StatsPanel` 同一条："面板里显示的东西 ＝ 传进来的东西"，
 *    不会出现"树上说这个月写过、面板说没写"两头各说各话。
 *
 * ── 长什么样 ──────────────────────────────────────────────────────
 *   ┌──────────────────────────────┐
 *   │ 2026 年 9 月              ×  │
 *   │   ‹    〔一格一天的圆环〕   ›  │   ← 左右箭头切上/下一个月
 *   │        中间写着 N 篇           │
 *   │  写了几篇 · 共多少字 · 心情     │
 *   │  9-03 标题           120 字    │
 *   │  …                            │
 *   └──────────────────────────────┘
 */
import { computed } from "vue";

import { MOOD_EMOJI, MOODS, type EntrySummary } from "../api/index.ts";
import type { MonthSummary, RingCell } from "../tree/rings.ts";

const props = defineProps<{
  /** 这个面板显示的月份 `"YYYY-MM"`。 */
  monthKey: string;
  /** 它是这个季度的第几块（0 ＝ 最下面那块）—— 箭头要按它判断两头的禁用。 */
  index: number;
  /** 一共几块（＝ 3）。 */
  count: number;
  /** 一格一天（`rings.ts::monthCells` 算好的）。 */
  cells: RingCell[];
  /** 篇数 / 字数 / 心情分布。 */
  summary: MonthSummary;
  /** 这个月的日记（`null` ＝ 还没读到）。 */
  entries: EntrySummary[] | null;
  /** 正在读数据。 */
  loading: boolean;
  /** 今天的日期键 `"YYYY-MM-DD"` —— 圆环上给今天描个圈。 */
  today: string;
}>();

const emit = defineEmits<{
  /** 点右上角 × 。 */
  close: [];
  /** 点左右箭头：`-1` ＝ 上一个月，`+1` ＝ 下一个月。 */
  shift: [delta: number];
}>();

/** `"2026-09"` → `"2026 年 9 月"`；坏数据就跑原样（⛔ 不崩）。 */
const title = computed(() => {
  const key = props.monthKey;
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return key || "　";
  return `${y} 年 ${m} 月`;
});

const atFirst = computed(() => props.index <= 0);
const atLast = computed(() => props.index >= props.count - 1);

/*
 * ── 圆环几何（纯算，不依赖任何库） ─────────────────────────────────
 * 一格 ＝ 一天，从**正上方**顺时针排。
 * ⚠️ 格与格之间留一道角向的缝，否则 30 格连成一圈、看不出"一格一格"。
 */
const VIEW = 100; // SVG 的 viewBox 是 200×200 ⇒ 中心 (100,100)
const R_OUTER = 86;
const R_INNER = 58;

function pointAt(radius: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [VIEW + radius * Math.cos(rad), VIEW + radius * Math.sin(rad)];
}

/** 一段圆环扇面（外弧 → 内弧 → 闭合）的 `d`。 */
function sectorPath(a0: number, a1: number): string {
  const [x0, y0] = pointAt(R_OUTER, a0);
  const [x1, y1] = pointAt(R_OUTER, a1);
  const [x2, y2] = pointAt(R_INNER, a1);
  const [x3, y3] = pointAt(R_INNER, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${R_OUTER} ${R_OUTER} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${R_INNER} ${R_INNER} 0 ${large} 0 ${x3} ${y3} Z`;
}

const arcs = computed(() => {
  const n = props.cells.length;
  if (n <= 0) return [];
  const step = 360 / n;
  const gap = Math.min(2.2, step * 0.18);
  return props.cells.map((c, i) => {
    const a0 = -90 + i * step + gap / 2;
    const a1 = -90 + (i + 1) * step - gap / 2;
    return {
      day: c.day,
      lit: c.lit,
      isToday: c.key === props.today,
      d: sectorPath(a0, a1),
    };
  });
});

/** 有哪几档心情出现过（0 的不显示，免得五行空着占地方）。 */
const moodRows = computed(() =>
  MOODS.map((m, i) => ({ ...m, n: props.summary.moods[i] ?? 0 })).filter((m) => m.n > 0)
);

/** `"2026-09-03"` → `"9-03"`（列表里日期短一点，别把标题挤没了）。 */
function shortDate(key: string): string {
  return key.length >= 10 ? `${Number(key.slice(5, 7))}-${key.slice(8, 10)}` : key;
}
</script>

<template>
  <aside class="month-panel" aria-label="这个月的写作数据">
    <header class="mp-head">
      <strong class="mp-title">{{ title }}</strong>
      <button class="mp-close" type="button" aria-label="关闭" title="关闭" @click="emit('close')">
        ×
      </button>
    </header>

    <div class="mp-ring-row">
      <button
        class="mp-arrow"
        type="button"
        aria-label="上一个月"
        :disabled="atFirst"
        @click="emit('shift', -1)"
      >
        ‹
      </button>

      <svg class="mp-ring" viewBox="0 0 200 200" role="img" :aria-label="`${title}的写作圆环图`">
        <path
          v-for="a in arcs"
          :key="a.day"
          :d="a.d"
          :class="['cell', a.lit ? 'is-lit' : 'is-off', a.isToday ? 'is-today' : '']"
        />
        <text class="mp-ring-num" x="100" y="96">{{ summary.count }}</text>
        <text class="mp-ring-unit" x="100" y="118">篇</text>
      </svg>

      <button
        class="mp-arrow"
        type="button"
        aria-label="下一个月"
        :disabled="atLast"
        @click="emit('shift', 1)"
      >
        ›
      </button>
    </div>

    <p class="mp-line">
      <span>共 {{ summary.words.toLocaleString() }} 字</span>
      <span v-if="summary.count === 0" class="mp-dim">这个月还没有写</span>
    </p>

    <p v-if="moodRows.length > 0" class="mp-moods">
      <span v-for="m in moodRows" :key="m.value" class="mp-mood">
        <span aria-hidden="true">{{ m.emoji }}</span>
        <span class="mp-dim">{{ m.n }}</span>
      </span>
    </p>

    <p v-if="loading" class="mp-hint">读取中…</p>

    <ul v-else-if="entries && entries.length > 0" class="mp-list">
      <li v-for="e in entries" :key="e.entry_date" class="mp-item">
        <span class="mp-date">{{ shortDate(e.entry_date) }}</span>
        <span class="mp-name">{{ e.title || "（无标题）" }}</span>
        <span v-if="e.mood" class="mp-dim" aria-hidden="true">{{ MOOD_EMOJI[e.mood] }}</span>
        <span class="mp-words mp-dim">{{ e.word_count }} 字</span>
      </li>
    </ul>

    <p v-else class="mp-hint">这个月还没有写</p>
  </aside>
</template>

<style scoped>
/*
  ⚠️ 面板是**用界面色画的一块平面 UI**（不是 3D）⇒ 一律用 `--surface / --border /
     --text-*` 这一族，⛔ 别去用 `--tree-*` 那套"天、地、树皮"的自然色。
  ⚠️ 宽度给 `min(340px, 42%)` —— 窗口窄的时候不许把树挤没。
*/
.month-panel {
  flex: 0 0 auto;
  width: min(340px, 42%);
  min-width: 232px;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 14px 6px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  border-radius: 0 10px 10px 0;
}

.mp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mp-title {
  font-size: 15px;
  color: var(--text-1);
  font-weight: 600;
}

.mp-close {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  line-height: 1;
  font-size: 16px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}

.mp-close:hover {
  background: var(--hover);
  color: var(--text-1);
}

.mp-ring-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.mp-arrow {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  font-size: 18px;
  line-height: 1;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 50%;
  cursor: pointer;
}

.mp-arrow:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text-1);
}

.mp-arrow:disabled {
  opacity: 0.3;
  cursor: default;
}

.mp-ring {
  width: 100%;
  max-width: 190px;
  height: auto;
  flex: 1 1 auto;
}

/* ⚠️「没写」必须比「写了」更靠近背景色（跟 P2-18 热力图同一条规矩）。 */
.cell.is-off {
  fill: var(--heat-0);
}

.cell.is-lit {
  fill: var(--accent);
}

.cell.is-today {
  stroke: var(--text-2);
  stroke-width: 1.5;
}

.mp-ring-num,
.mp-ring-unit {
  fill: var(--text-1);
  text-anchor: middle;
  font-family: var(--mono);
}

.mp-ring-num {
  font-size: 30px;
}

.mp-ring-unit {
  font-size: 12px;
  fill: var(--text-3);
}

.mp-line {
  margin: 0;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}

.mp-moods {
  margin: 0;
  display: flex;
  gap: 12px;
  font-size: 13px;
}

.mp-mood {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.mp-dim {
  color: var(--text-3);
  font-size: 12px;
}

.mp-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
}

.mp-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.mp-date {
  flex: 0 0 auto;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-3);
}

.mp-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-1);
}

.mp-words {
  flex: 0 0 auto;
}

.mp-hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}
</style>
