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
 *   1. 连续天数旁边写"截至 2026年9月20日 周日"或"含今天" —— 口径本来就是
 *      "从最近一篇往前数"，今天没写也照常显示到昨天；不标用户会以为断了。
 *   2. 一篇都没写过时给一句话，而不是满屏 0 加一堆空图。
 *
 * ⚠️ **本面板的日期一律带年份**（用 `humanDateFull`，不用 `humanDate`）：
 *    这里显示的是"从…到…"和"数到哪一天"这类**跨年区间**，
 *    不带年份过了年会读成"从 12月30日 到 1月2日"，看着像倒着走。
 *    编辑区、搜索结果在当天日记的上下文里，继续用不带年份的短格式。
 *
 * ⚠️ `stats` 是 `Stats | null`（读失败时 `App.vue` 的 loadAux 会吞掉错误）。
 *    所以下面把每个要显示的数字都收成**空安全的 computed**，
 *    模板里一次都不直接碰 `stats.xxx` —— 免得为"可能为 null"到处写判断。
 */
import { computed } from "vue";
import { MOODS, type Stats } from "../api";
import {
  humanDateFull,
  humanMonth,
  shiftDate,
  shiftMonth,
  toMonthKey,
  todayKey,
} from "../utils/date";

const props = defineProps<{ stats: Stats | null }>();

/** 点热力图某一格 → 跳到那天写日记。照抄 `SearchPanel` 的 `@open` 模式，不另发明一套。 */
const emit = defineEmits<{ (e: "open", date: string): void }>();

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

/**
 * 连续天数的时间标注：今天写过就"含今天"，否则标出实际数到哪一天。
 *
 * 用带年份的 `humanDateFull` —— 这个面板上的日期一律带年份（见文件头说明）。
 */
const streakAsOf = computed(() => {
  const last = props.stats?.last_date;
  if (!last) return "";
  return last === today ? "含今天" : `截至 ${humanDateFull(last)}`;
});

const yearMonth = computed(() => humanMonth(toMonthKey(new Date())));

const rangeText = computed(() => {
  const first = props.stats?.first_date;
  if (!first) return "";
  const last = props.stats?.last_date ?? first;
  return first === last
    ? `仅 ${humanDateFull(first)} 一天`
    : `从 ${humanDateFull(first)} 到 ${humanDateFull(last)}`;
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

/* ── 写作热力图 ──────────────────────────────────────────────────────────
   窗口（53 周 × 7 天 ＝ 371 天）**由后端给**：`heatmap_start` 是周一、
   `heatmap_end` 是本周周日。前端**不自己算窗口** —— 那是业务口径，只应有一处定义。

   铺格子靠 CSS Grid 的 `grid-auto-flow: column` ＋ 7 行：数据按"窗口内第 i 天"
   的顺序平铺，天然形成"列＝周、行＝星期"，**不用自己算行列**。

   ⚠️ 本图是**照镜子，不是打分**（用户原话："每天都不一样，心情好多写点，
      不开心或者忙的时候就少写点"）。所以：不用红/橙表示少、不写"你写得不够"、
      颜色只说明"那天写了多少"，并且**悬停一定给绝对数字**（下面 `heatTitle`）。
      —— 分位数分档的代价就是"深浅只说明相对多少"，绝对数字必须另给。 */

/** 一天在热力图里的样子。`words === null` ＝ 没写（画灰格）。 */
interface HeatDay {
  date: string;
  words: number | null;
  /** 本周还没到的那几天：**留空占位**，不画格子也不可点。 */
  future: boolean;
}

/**
 * 窗口内的每一天（含没写的），按日期升序。
 *
 * ⚠️ "没写"与"写了 0 字"的区别**全靠 `daily_words` 名单**：
 *    在名单里 → 写过（哪怕 0 字，纯图片日记）；不在名单里且在今天之前 → 没写。
 */
const heatDays = computed<HeatDay[]>(() => {
  const s = props.stats;
  if (!s || !s.heatmap_start || !s.heatmap_end) return [];
  const written = new Map(s.daily_words.map((d) => [d.date, d.words]));
  const out: HeatDay[] = [];
  const end = s.heatmap_end;
  let cur = s.heatmap_start;
  // 上限 400 天（正常 371）：窗口数据万一坏掉，不至于在这里空转把界面卡住。
  // 日期是定长 ISO，字典序＝时间序，可以直接比字符串。
  for (let i = 0; i < 400 && cur <= end; i++) {
    const has = written.has(cur);
    out.push({
      date: cur,
      words: has ? (written.get(cur) as number) : null,
      future: !has && cur > today,
    });
    cur = shiftDate(cur, 1);
  }
  return out;
});

/**
 * 分档切点（升序，最多 3 个）。
 *
 * **为什么用分位数，而不是固定阈值（100 / 300 / 600 字）**：固定阈值会让
 * "每天写 2000 字的人"永远顶格、"每天写 50 字的人"永远最低 —— 热力图变成一片纯色，
 * 彻底失去分辨力。分位数保证颜色的分布**永远是均匀的**，始终有层次。
 *
 * 两个刻意的边界：
 *   1. **数据太少（< 8 天）不分档** —— 那时候"相对"毫无意义，而且会给出
 *      "你今天是最低档"这种不该有的暗示。全部算第 1 档。
 *   2. **切点必须去重** —— 很多天字数相同时（比如一大片 0 字）会出现
 *      `q1 == q2`，不去重就会有某一档**永远为空**、图例上两个一模一样的颜色。
 */
const heatCuts = computed(() => {
  const words = (props.stats?.daily_words ?? []).map((d) => d.words).sort((a, b) => a - b);
  if (words.length < 8) return [];
  const at = (p: number) => words[Math.floor(words.length * p)];
  return [...new Set([at(0.25), at(0.5), at(0.75)])].sort((a, b) => a - b);
});

/** 某天落到第几档：0 ＝ 没写（主题灰），1~4 ＝ 写了多少（浅→深）。 */
const heatLevel = (words: number | null): number => {
  if (words === null) return 0;
  // 0 字（纯图片日记）永远是第 1 档 —— 它算"写过"，只是没有文字。
  // 用 `>` 比较时这一点自动成立（没有一个切点会被 0 超过）。
  let level = 1;
  for (const cut of heatCuts.value) {
    if (words > cut) level += 1;
  }
  return Math.min(level, 4);
};

/** 悬停文案。**绝对数字必须出现在这里**（理由见上面分位数那段）。 */
const heatTitle = (d: HeatDay) => {
  if (d.future) return `${humanDateFull(d.date)} · 还没到`;
  return `${humanDateFull(d.date)} · ${d.words === null ? "没写" : `${grouped(d.words)} 字`}`;
};

/** 月份标签：每列看该列**第一天**的月份，与前一列不同才标一个。 */
const heatMonths = computed(() => {
  const days = heatDays.value;
  const out: { col: number; label: string }[] = [];
  let prev = "";
  for (let i = 0; i < days.length; i += 7) {
    const m = days[i].date.slice(0, 7);
    if (m !== prev) {
      out.push({ col: i / 7 + 1, label: `${Number(m.slice(5, 7))}月` });
      prev = m;
    }
  }
  return out;
});

/** 窗口内"写过"的天数 —— 图例右侧那句"有记录 N 天"。 */
const heatWrittenDays = computed(() => props.stats?.daily_words.length ?? 0);

/**
 * 有日记、但近一年一篇都没写 ⇒ 会看到**一整块灰**。
 * 这时必须给一句话，否则用户会以为是没加载出来（而不是真的没写）。
 */
const heatEmpty = computed(() => hasEntries.value && heatWrittenDays.value === 0);

/** 点格子 → 跳到那天。**未来的格子点不动**（那天还没到，没法写）。 */
const openDay = (d: HeatDay) => {
  if (d.future) return;
  emit("open", d.date);
};
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

      <!-- ── 写作热力图 ─────────────────────────────────────────── -->
      <section class="block">
        <h3>写作热力图</h3>
        <p class="cap">最近 53 周。颜色只表示那天写了多少</p>
        <div class="heat">
          <!-- 行标签只标 一 三 五 日 四行 —— 隔行标注省地方，也是用户给的参考图里的做法。 -->
          <div class="heat-days" aria-hidden="true">
            <span>一</span><span></span><span>三</span><span></span>
            <span>五</span><span></span><span>日</span>
          </div>
          <div class="heat-main">
            <div class="heat-months" aria-hidden="true">
              <span v-for="m in heatMonths" :key="m.col" :style="{ gridColumnStart: m.col }">{{
                m.label
              }}</span>
            </div>
            <!--
              371 个格子**不参与 Tab 顺序**（否则 Tab 键会疯掉），所以用 div ＋ @click，
              靠原生 title 保证鼠标用户能读到那个绝对数字。
              ⛔ 不为此实现 role="grid" ＋ 方向键导航 —— 那是给"热力图是主功能"的网站准备的。
            -->
            <div class="heat-grid">
              <div
                v-for="d in heatDays"
                :key="d.date"
                class="cell"
                :class="{ future: d.future }"
                :title="heatTitle(d)"
                :style="d.future ? undefined : { background: `var(--heat-${heatLevel(d.words)})` }"
                @click="openDay(d)"
              ></div>
            </div>
          </div>
        </div>
        <p class="heat-legend">
          <span>少</span>
          <i class="lg" style="background: var(--heat-0)"></i>
          <i class="lg" style="background: var(--heat-1)"></i>
          <i class="lg" style="background: var(--heat-2)"></i>
          <i class="lg" style="background: var(--heat-3)"></i>
          <i class="lg" style="background: var(--heat-4)"></i>
          <span>多</span>
          <span class="lg-note">{{
            heatEmpty ? "近一年没有记录" : `有记录 ${heatWrittenDays} 天`
          }}</span>
        </p>
      </section>

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

/* ── 写作热力图（P2-18） ─────────────────────────────────────
   53 列 × 7 行 ＝ 371 个格子的纯 CSS Grid，不引任何图表库。
   铺格子**不用自己算行列**：`grid-auto-flow: column` ＋ 7 行 ⇒
   数据按"窗口内第 i 天"的顺序平铺，天然就是"列＝周、行＝星期"。 */
.heat {
  /* 月份标签那一行占的总高度（12 ＋ 4 的外边距）。
     `.heat-days` 靠它把行标签压到与格子同高 —— 改这一处，两边一起变，不会错位。 */
  --heat-months-h: 16px;
  display: flex;
  gap: 5px;
  margin-top: 10px;
}
.heat-days {
  display: grid;
  grid-template-rows: repeat(7, 1fr);
  align-items: center;
  padding-top: var(--heat-months-h);
  font-size: 10px;
  line-height: 1;
  color: var(--text-3);
}
.heat-main {
  flex: 1;
  min-width: 0; /* 让 53 列的网格自己缩，而不是把父级撑破（否则会出横向滚动条） */
}
.heat-months {
  display: grid;
  /* ⚠️ 这里的 53 与后端窗口的 53 周一一对应（`heatmap_start` 到 `heatmap_end`）。
     月份标签必须落在**某一列**上，所以列数得写死；后端窗口一旦改周数，
     这个数字要跟着改，否则标签会整体错位。 */
  grid-template-columns: repeat(53, 1fr);
  gap: 3px;
  height: 12px;
  margin-bottom: 4px;
}
.heat-months span {
  grid-row: 1;
  font-size: 10px;
  line-height: 1;
  color: var(--text-3);
  white-space: nowrap;
  /* 允许向右溢出：窗口首尾可能出现"某月只占 1~2 列"，标签会挤。
     ⛔ 不为此引入测量 / 折行逻辑 —— 最多首尾各挤一次，可接受。 */
  justify-self: start;
}
.heat-grid {
  display: grid;
  grid-template-rows: repeat(7, 1fr);
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 3px;
}
.heat-grid .cell {
  aspect-ratio: 1; /* 正方 —— 窗口拉大时也不会变成扁条 */
  border-radius: 2px;
  background: var(--heat-0);
  cursor: pointer;
}
/* 本周还没到的那几天：**留空占位**、不画格子、点不动。
   与"没写"的灰刻意做成两种样子 —— 否则用户分不清"那天没写"和"那天还没到"。 */
.heat-grid .cell.future {
  background: transparent;
  cursor: default;
}
.heat-grid .cell:not(.future):hover {
  outline: 1px solid var(--text-3);
  outline-offset: 1px;
}
.heat-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-3);
}
.heat-legend .lg {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.heat-legend .lg-note {
  margin-left: 6px;
}
</style>
