<script setup lang="ts">
/**
 * 统计面板（顶栏第三个 tab）。
 *
 * 数据全部来自**一条命令**（`getStats()` → Rust 的 `stats(today)`），
 * 这里只负责排版，不做任何统计口径的二次计算 —— 尤其"连续天数"：
 * 那种"从最近一篇往前逐日相接"的判定全项目只应有一份实现（在 `db.rs`）。
 *
 * 图表一律用纯 CSS 画，**不引 ECharts 之类的重库**：
 * 日记的数据量很小（最多几百条），引一个图表库只会让安装包白白变大几 MB。
 *
 * 两处标注是刻意的（不是装饰）：
 *   1. 连续天数旁边写"截至 X月X日"或"含今天" —— 口径本来就是
 *      "从最近一篇往前数"，今天没写也照常显示到昨天；不标用户会以为断了。
 *   2. 一篇都没写过时给一句话，而不是满屏 0 加一堆空图。
 *
 * ⚠️ `stats` 是 `Stats | null`（读失败时 `App.vue` 的 loadAux 会吞掉错误）。
 *    所以下面把每个要显示的数字都收成**空安全的 computed**，
 *    模板里一次都不直接碰 `stats.xxx` —— 免得为"可能为 null"到处写判断。
 */
import { computed } from "vue";
import { MOODS, type Stats } from "../api";
import {
  humanDate,
  humanMonth,
  shiftMonth,
  toMonthKey,
  todayKey,
} from "../utils/date";

const props = defineProps<{ stats: Stats | null }>();

/** 柱状图窗口：最近 12 个月（含本月）。固定格数才好横向比较，缺的月份补 0。 */
const MONTHS_SHOWN = 12;

const today = todayKey();

/** 千分位。`toLocaleString` 的结果受运行环境影响，自己分组最稳。 */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 柱子上方的短数字：过万折算成"万"，免得把柱子挤没。 */
const shortNum = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n));

/** 从 stats 里取一个数字，空安全。 */
const pick = (f: (s: Stats) => number) =>
  computed(() => {
    const s = props.stats;
    return s ? f(s) : 0;
  });

const totalEntries = pick((s) => s.total_entries);
const totalWords = pick((s) => s.total_words);
const streakDays = pick((s) => s.streak_days);
const longestStreak = pick((s) => s.longest_streak);
const daysThisWeek = pick((s) => s.days_this_week);
const daysThisMonth = pick((s) => s.days_this_month);

const hasEntries = computed(() => (props.stats?.total_entries ?? 0) > 0);
const hasMoods = computed(() => (props.stats?.mood_counts.length ?? 0) > 0);

/** 连续天数的时间标注：今天写过就"含今天"，否则标出实际数到哪一天。 */
const streakAsOf = computed(() => {
  const last = props.stats?.last_date;
  if (!last) return "";
  return last === today ? "含今天" : `截至 ${humanDate(last)}`;
});

const yearMonth = computed(() => humanMonth(toMonthKey(new Date())));

const rangeText = computed(() => {
  const first = props.stats?.first_date;
  if (!first) return "";
  const last = props.stats?.last_date ?? first;
  return first === last
    ? `仅 ${humanDate(first)} 一天`
    : `从 ${humanDate(first)} 到 ${humanDate(last)}`;
});

/** 心情分布：固定按 `MOODS` 的顺序列出全部档位，没出现过的补 0。 */
const moodRows = computed(() =>
  MOODS.map((m) => ({
    ...m,
    count: props.stats?.mood_counts.find((c) => c.mood === m.value)?.count ?? 0,
  }))
);
const maxMoodCount = computed(() => Math.max(1, ...moodRows.value.map((m) => m.count)));
const moodWidth = (count: number) => `${(count / maxMoodCount.value) * 100}%`;

/** 每月的柱子：最近 12 个月，升序。 */
const monthBars = computed(() => {
  const byMonth = new Map((props.stats?.monthly_words ?? []).map((m) => [m.month, m.words]));
  const out: { key: string; words: number }[] = [];
  let cur = toMonthKey(new Date());
  for (let i = 0; i < MONTHS_SHOWN; i++) {
    out.unshift({ key: cur, words: byMonth.get(cur) ?? 0 });
    cur = shiftMonth(cur, -1);
  }
  return out;
});
const maxMonthWords = computed(() => Math.max(1, ...monthBars.value.map((m) => m.words)));
const monthHeight = (words: number) => `${(words / maxMonthWords.value) * 100}%`;
const monthLabel = (key: string) => `${Number(key.slice(5, 7))}月`;
</script>

<template>
  <div class="stats">
    <!-- 还没读到 / 读失败：只说一句中性的话，不弹错误。 -->
    <p v-if="!stats" class="hint">正在读取统计…</p>

    <section v-else-if="!hasEntries" class="hint">
      <p>还没有写过日记。</p>
      <p class="sub">写下第一篇之后，这里会开始累积数据。</p>
    </section>

    <template v-else>
      <!-- ── 六个数字 ───────────────────────────────────────────── -->
      <section class="cards">
        <div class="card">
          <span class="k">共</span>
          <span class="v">{{ grouped(totalEntries) }}<em>篇</em></span>
        </div>
        <div class="card">
          <span class="k">累计</span>
          <span class="v">{{ grouped(totalWords) }}<em>字</em></span>
        </div>
        <div class="card">
          <span class="k">当前连续</span>
          <span class="v">{{ streakDays }}<em>天</em></span>
          <span class="note">{{ streakAsOf }}</span>
        </div>
        <div class="card">
          <span class="k">最长连续</span>
          <span class="v">{{ longestStreak }}<em>天</em></span>
          <span class="note">历史纪录</span>
        </div>
        <div class="card">
          <span class="k">本周</span>
          <span class="v">{{ daysThisWeek }}<em>天</em></span>
          <span class="note">周一算起</span>
        </div>
        <div class="card">
          <span class="k">本月</span>
          <span class="v">{{ daysThisMonth }}<em>天</em></span>
          <span class="note">{{ yearMonth }}</span>
        </div>
      </section>

      <p v-if="rangeText" class="range">{{ rangeText }}</p>

      <!-- ── 心情分布 ───────────────────────────────────────────── -->
      <section class="block">
        <h3>心情分布</h3>
        <p class="cap">
          只有写过正文、并且标了心情的日子才计入（五种心情是并列的类型，不分高低）
        </p>
        <div class="moods">
          <div v-for="m in moodRows" :key="m.value" class="mood-row">
            <span class="emoji">{{ m.emoji }}</span>
            <span class="label">{{ m.label }}</span>
            <span class="track"><i :style="{ width: moodWidth(m.count) }"></i></span>
            <span class="num">{{ m.count }}</span>
          </div>
        </div>
        <p v-if="!hasMoods" class="empty-note">
          还没有标过心情。写日记时点一下心情条上的表情就能标。
        </p>
      </section>

      <!-- ── 每月字数 ───────────────────────────────────────────── -->
      <section class="block">
        <h3>每月字数</h3>
        <p class="cap">最近 {{ MONTHS_SHOWN }} 个月（空月份补 0）</p>
        <div class="months">
          <div
            v-for="m in monthBars"
            :key="m.key"
            class="col"
            :title="`${humanMonth(m.key)}：${grouped(m.words)} 字`"
          >
            <span class="val">{{ m.words > 0 ? shortNum(m.words) : "" }}</span>
            <span class="bar">
              <i v-if="m.words > 0" :style="{ height: monthHeight(m.words) }"></i>
            </span>
            <span class="lab">{{ monthLabel(m.key) }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.hint {
  margin: 6px 0 0;
  color: var(--text-2);
}
.hint .sub,
.cap {
  color: var(--text-3);
  font-size: 12px;
  margin: 4px 0 0;
}

/* ── 六个数字卡 ───────────────────────────────────────────── */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.card .k {
  font-size: 12px;
  color: var(--text-3);
}
.card .v {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}
.card .v em {
  font-size: 12px;
  font-weight: 400;
  font-style: normal;
  color: var(--text-3);
  margin-left: 3px;
}
.card .note {
  font-size: 11px;
  color: var(--text-3);
}

.range {
  margin: -10px 0 0;
  font-size: 12px;
  color: var(--text-3);
}

/* ── 心情分布 ─────────────────────────────────────────────── */
.block h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.moods {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mood-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mood-row .emoji {
  width: 20px;
  text-align: center;
}
.mood-row .label {
  width: 34px;
  font-size: 12px;
  color: var(--text-2);
}
.track {
  flex: 1;
  height: 12px;
  background: var(--hover);
  border-radius: 6px;
  overflow: hidden;
}
.track i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 6px;
  transition: width 0.25s ease;
}
.mood-row .num {
  width: 34px;
  text-align: right;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.empty-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-3);
}

/* ── 每月字数（纯 CSS 柱状图） ─────────────────────────────── */
.months {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 4px;
  align-items: end;
}
.col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.col .val {
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  height: 13px;
}
.col .bar {
  width: 100%;
  height: 110px;
  display: flex;
  align-items: flex-end;
  background: var(--hover);
  border-radius: 5px;
  overflow: hidden;
}
/* 0 字的那一格**不画柱子**（否则 min-height 那 2px 看起来像有值）。 */
.col .bar i {
  display: block;
  width: 100%;
  background: var(--accent);
  border-radius: 5px 5px 0 0;
  min-height: 2px;
  transition: height 0.25s ease;
}
.col .lab {
  font-size: 10px;
  color: var(--text-3);
}
</style>
