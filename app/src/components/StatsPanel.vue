<script setup lang="ts">
/**
 * 「年轮」面板（顶栏第三个 tab；P2-23 起由「统计」改名）。
 *
 * 页内有两个小切换：
 *   * **刻度** —— 攒下来的数字（数字卡 / 热力图 / 心情分布 / 每月字数 / 常用标签）；
 *   * **旧影** —— 往回看（往年今天 / 写得最长 / 照片最多 / 连续同一种心情）。
 * ⚠️ 名字是用户 2026-09-23 定的（"树一年长一圈"）：左是"长了多少"，
 *    右是"那一圈长什么样"。⛔ 别把 P3 那张年轮图当标题写进来（那是文档里的内部称呼）。
 *
 * 数据全部来自**三条命令**，且都由 `App.vue` 取好、**当 prop 传进来**：
 *   1. `getStats()` → Rust 的 `stats(today)` —— 数字卡 / 热力图 / 心情 / 每月字数
 *   2. `listTags()`（P2-19「常用标签」起）—— 那块榜
 *   3. `getRecap()`（P2-23「旧影」）—— 之最 ＋ 所有写过的日子
 *      ⚠️ 这一条**只在点开「旧影」那一下才算**（三遍全表扫描，开机白算不值当），
 *      所以它可能是 `null`（还没拉 / 拉失败）。
 *
 * ⚠️ **面板自己不发任何命令。** 让面板自己去 `await listTags()` 会让"这个数字从哪来"
 *    变成两处，而"只吃 prop"正是这个文件最值钱的地方。
 * ⚠️ 也**不要**把标签塞进 `stats` 的返回值：`stats` 是"数字统计"，塞一个列表进去
 *    会让它变胖，而且每调一次都白带一份标签列表。
 *
 * 这里只负责排版，不做任何统计口径的二次计算 —— 尤其"连续天数"：
 * 那种"从最近一篇往前逐日相接"的判定全项目只应有一份实现（在 `db.rs`）。
 * 标签同理：篇数**直接吃后端的 `entry_count`**（它和数字卡那行"共 N 篇"是同一把尺子），
 * 前端只做**过滤与排序**，绝不自己再数一遍。
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
import { computed, ref, watch } from "vue";
import { MOODS, type Recap, type Stats, type TagStat } from "../api";
import {
  humanDateFull,
  humanMonth,
  sameDayInPastYears,
  shiftDate,
  shiftMonth,
  toMonthKey,
  todayKey,
} from "../utils/date";
import TreePane from "./TreePane.vue";

const props = defineProps<{
  stats: Stats | null;
  tags: TagStat[];
  /**
   * 「旧影」那一屏的数据（P2-23）。**由 `App.vue` 取好传进来** —— 面板自己不发命令
   * （见文件头）。⚠️ 只在点开「旧影」时才拉，所以这里可能是 `null`。
   */
  recap?: Recap | null;
  /**
   * **所有写过的日期**（P2-17 在 `App.vue` 建立的那份缓存）。
   *
   * ⚠️ 「往年今天」的判定吃它，用的是 `sameDayInPastYears()` —— 与写日记屏那句
   *    「N 年前的今天写过」**同一条实现**（"找往年同一天"只许有一份判定）。
   * ⛔ 不要在本组件里再拉一次（两次取数会漂），也不要另写一个筛日期的循环。
   */
  dates?: string[];
  /**
   * 页内小切换当前停在哪边（P2-23）。默认「刻度」。
   *
   * ⚠️ 状态**放在 `App.vue`**，不是这儿 —— 切走再回来本组件会被卸载重建，
   *    放组件内部就记不住"上次停在旧影"，而用户要的正是记住（只在这次运行里记）。
   */
  tab?: "scale" | "recap" | "tree";
  /**
   * 从写日记屏那句「N 年前的今天写过 · 去看看」跳过来时带的**那一天**
   * （`YYYY-MM-DD`）。只用来在「往年今天」里高亮对应那一年。
   */
  focusDate?: string;
  /**
   * 「树语」动不动（第一期 · 批次 3）。**由 `App.vue` 持有**（开关在设置页），
   * 这里只是**原样往下递给 `TreePane`** —— ⛔ 本组件不许自己读 `localStorage`
   * （那会出现"设置页说关着、树上还在摆"）。
   */
  treeMotion?: boolean;
}>();

/**
 * `open` —— 点某一条 → 跳到那天写日记（照抄 `SearchPanel` 的 `@open` 模式，不另发明一套）。
 * `tab`  —— 页内两个小切换（状态由 `App.vue` 持有，见上面 `tab` 的说明）。
 */
const emit = defineEmits<{
  (e: "open", date: string): void;
  (e: "tab", tab: "scale" | "recap" | "tree"): void;
}>();

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

/* ── 常用标签（P2-19） ──────────────────────────────────────────────────
   统计页前三块都是**时间维度**（写了多少 / 什么时候写 / 心情如何），
   这一块是**主题维度** —— 回答"我都在写什么"。放最后是维度切换，
   不打断上面的时间叙述。

   ⚠️ 气质同样是**照镜子，不是打分**（同热力图）：
      · 标题叫「常用标签」，**不叫「标签排行」** —— "排行"带竞技感；
      · 不给篇数少的标签用红/橙警示色。页面上的数字只描述事实
        （"你写过多少篇"），不含"你应该多写"。

   ⚠️ 前端**一个数都不算**：篇数直接吃后端的 `entry_count`
      （它和数字卡里"共 N 篇"是同一把尺子），这里只**过滤 + 排序**。
   ⚠️ 本块**只读**：不做点击跳转，也因此 ⛔ **绝不能给行加"看着能点"的悬停样式**
      —— "点标签看那批日记"是 P2-7 筛选页的事。 */

/** 默认只显示前 10 —— 统计页是概览，不该被三十个标签拉成一长条。 */
const TAG_TOP_N = 10;

/**
 * 有篇数的标签，按篇数降序。
 *
 * ⚠️ 两个刻意的点：
 *   1. **0 篇的不上榜** —— 后端是**故意**保留它们的（界面上看不见用户就没机会删），
 *      但放进这份榜就是噪音。过滤只在前端做，后端那条 `ORDER BY 名字` 一个字不动。
 *   2. **二次键必须显式写全** —— 篇数相同时得有确定的次序，否则每次刷新
 *      并列的几行会互换位置。不再靠 JS `sort` 的稳定性兜底（虽然规范要求稳定，
 *      但写出来下一个人（就是你）才看得懂）。
 */
const rankedTags = computed(() =>
  (props.tags ?? [])
    .filter((t) => t.entry_count > 0)
    .sort((a, b) => b.entry_count - a.entry_count || a.name.localeCompare(b.name, "zh"))
);

const maxTagCount = computed(() => Math.max(1, ...rankedTags.value.map((t) => t.entry_count)));

/**
 * 条宽按最大值归一（第一名满格）。
 * ⚠️ 留 6% 下限：只有 1 篇的标签若按 1/120 算就是一条**看不见的线**，
 *    读者会以为"这一行没画出来"。
 */
const tagWidth = (n: number) => `${Math.max(6, (n / maxTagCount.value) * 100)}%`;

const tagExpanded = ref(false);
const shownTags = computed(() =>
  tagExpanded.value ? rankedTags.value : rankedTags.value.slice(0, TAG_TOP_N)
);
const hiddenTagCount = computed(() => Math.max(0, rankedTags.value.length - TAG_TOP_N));

/**
 * 写过日记、却一个标签都没用过（或全都是 0 篇）。
 * 给一句人话，**不许显示一片空白**。
 */
const tagEmpty = computed(() => rankedTags.value.length === 0);

/* ── 页内小切换（P2-23） ─────────────────────────────────────────────────
   只是"同一屏里的两块"，不是第二层导航 ⇒ 两个细小的胶囊按钮。
   ⛔ 别做成和顶栏一样的一排 —— 那会让人以为是又一个导航层。 */

/** 当前停在哪边。`props.tab` 没传时按「刻度」—— ⛔ 默认值别写成"旧影"。 */
const tab = computed<"scale" | "recap" | "tree">(() => props.tab ?? "scale");

const switchTab = (t: "scale" | "recap" | "tree") => {
  if (t !== tab.value) emit("tab", t);
};

/* ── 「旧影」（P2-23） ───────────────────────────────────────────────────
   四块，顺序固定：**往年今天 → 写得最长 → 照片最多 → 连续心情**。
   往年今天放最上：它是"今天"相关的，一进来就该看见；其余三块是"纪录"，往下看。

   ⚠️ 这一屏**全是只读**：不在这里改心情 / 改标签 / 改正文。
   ⚠️ 这里的日期一律 `humanDateFull`（带年份）—— 除「往年今天」那一行，
      它的年份由"N 年前"表达，所以写"9月23日"就够（跨年也不会读错）。 */

/**
 * 「定位年份」：从写日记屏那句「去看看」跳过来时，把对应那一年高亮一下。
 *
 * ⚠️ **一次性**：`App.vue` 在离开本页时会把 `focusDate` 清掉，
 *    所以"切走再回来"不会还挂着高亮（用户要的就是这个 —— 高亮只用那一下）。
 * ⛔ 只高亮，**不做滚动定位动画、不把其他年份藏起来**。
 */
const focusYear = ref("");

watch(
  () => props.focusDate,
  (v) => {
    focusYear.value = v ? v.slice(0, 4) : "";
  },
  { immediate: true }
);

/** `recap.days` 按日期建索引 —— 「往年今天」靠它取那几天的内容。 */
const digestByDate = computed(
  () => new Map((props.recap?.days ?? []).map((d) => [d.date, d]))
);

/**
 * 「往年今天」是哪几天：**逐年的都列**（1 年前、2 年前、3 年前…），不是只列最近那条
 * —— 只列最近一年的话，第三年就只剩一条了，那不叫回顾。
 *
 * ⚠️ 判定走 `sameDayInPastYears()`：与写日记屏那句「N 年前的今天写过」
 *    **同一条实现**（"找往年同一天"只许有一份）。⛔ 别在这里另写一个
 *    `endsWith("-MM-DD")` 的循环，也**别手拼** `new Date(y - 1, m - 1, d)`
 *    —— 那会在 2/29 造出一个并不存在的日期。
 */
const onThisDay = computed(() => sameDayInPastYears(props.dates ?? [], today));

/** "N 年前"里的那个 N。 */
const yearsAgo = (date: string) =>
  Number(today.slice(0, 4)) - Number(date.slice(0, 4));

/** 「9月23日」这种短写法，只给「往年今天」用（年份由"N 年前"表达）。 */
const monthDayText = (date: string) =>
  `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

/** 心情 → emoji / 名字。档位表全项目只有 `MOODS` 一份。 */
const moodEmoji = (mood: number | null) =>
  mood === null ? "" : (MOODS.find((m) => m.value === mood)?.emoji ?? "");

const moodLabel = (mood: number | null) =>
  mood === null ? "" : (MOODS.find((m) => m.value === mood)?.label ?? "");

/**
 * 「往年今天」每一行要显示的东西，**在这里一次性拼好**。
 *
 * 为什么先拼成普通对象再给模板：模板里反复 `digestByDate.get(d)?.xxx`
 * 既难读、又会让类型在"可能取不到"上反复横跳。
 *
 * ⚠️ 取不到那天的摘要时不整行藏掉、只少显示内容 —— 藏着会让人以为"那天不算"
 *    （正常情况下取不到不会发生：两个日期集合是同一把尺子量出来的）。
 */
const onThisDayRows = computed(() =>
  onThisDay.value.map((date) => {
    const g = digestByDate.value.get(date);
    const words = g?.words ?? 0;
    return {
      date,
      when: `${yearsAgo(date)} 年前 · ${monthDayText(date)}`,
      mood: moodEmoji(g?.mood ?? null),
      tail: words > 0 ? `${grouped(words)} 字` : "只有图片",
      preview: g?.preview ?? "",
      /** 是不是"从写日记屏跳过来那一年"—— 是就高亮一下。 */
      hit: focusYear.value !== "" && date.slice(0, 4) === focusYear.value,
    };
  })
);

/* 三张"单条"卡片：一律拼成**字段齐全**的普通对象（含 `has`），
   这样模板里一个 optional 链都不用写 —— 见上面 onThisDayRows 的说明。 */

/** 「写得最长的一篇」。库里只有纯图片日记时没有这一条（它们 `word_count = 0`）。 */
const longestCard = computed(() => {
  const d = props.recap?.longest_entry;
  return {
    has: !!d,
    date: d?.date ?? "",
    when: d ? humanDateFull(d.date) : "",
    mood: moodEmoji(d?.mood ?? null),
    words: d ? `${grouped(d.words)} 字` : "",
    preview: d?.preview ?? "",
  };
});

/** 「照片最多的一篇」。一张图都没有时没有这一条（**不拿"0 张"占位**）。 */
const photosCard = computed(() => {
  const p = props.recap?.most_photos;
  return {
    has: !!p,
    date: p?.date ?? "",
    when: p ? humanDateFull(p.date) : "",
    photos: p?.photos ?? 0,
  };
});

/**
 * 「最长连续同一种心情」。
 *
 * ⚠️ 五种心情是**并列的类型、不是刻度** ⇒ 标题里不写"心情最好的那些天"，
 *    只写"连着 N 天"。天数并列时后端取编号小的（只为结果稳定）。
 */
const streakCard = computed(() => {
  const s = props.recap?.mood_streak;
  return {
    has: !!s,
    mood: moodEmoji(s?.mood ?? null),
    label: moodLabel(s?.mood ?? null),
    days: s?.days ?? 0,
    range: s ? `${humanDateFull(s.from)} — ${humanDateFull(s.to)}` : "",
  };
});
</script>

<template>
  <div class="stats" :class="{ 'stats--tree': tab === 'tree' }">
    <!-- 还没读到 / 读失败：只说一句中性的话，不弹错误。 -->
    <p v-if="!stats" class="hint">正在读取统计…</p>

    <template v-else>
      <!--
        页内三个小切换。⚠️ 状态由 `App.vue` 持有（见 script 里 `tab` 的说明）：
        切走再回来本组件会被卸载重建，状态放这儿就记不住"上次停在哪边"。

        ⚠️ 这一层**搬到了空库判断之外** —— 树语（第一期）不读任何数据，
        空库时照样画得出那棵树。若还留在原来那个 `v-else` 里，
        一篇日记都没写过时整排切换都不会出现，树语就永远进不去。
      -->
      <nav class="subtabs">
        <button type="button" :class="{ on: tab === 'scale' }" @click="switchTab('scale')">
          刻度
        </button>
        <button type="button" :class="{ on: tab === 'recap' }" @click="switchTab('recap')">
          旧影
        </button>
        <button type="button" :class="{ on: tab === 'tree' }" @click="switchTab('tree')">
          树语
        </button>
      </nav>

      <!-- ══ 树语：一棵树（独立小项目 ⇒ `生产\Diary-树语-项目书.md`） ════
           ⚠️ **不读数据** ⇒ 排在空库判断**前面**：一篇日记都没有时也要看得见。
           ⚠️ 外面这层 `.tree-slot` 只干一件事：**把剩下的高度吃满**
              （用户拍板要"撑满 ＋ 全屏等比例放大"，那条链子的一环：
               `.stats-wrap--tree` → `.stats--tree` → `.tree-slot` → 画布）。 -->
      <div v-if="tab === 'tree'" class="tree-slot">
        <TreePane :motion="treeMotion !== false" />
      </div>

      <section v-else-if="!hasEntries" class="hint">
        <p>还没有写过日记。</p>
        <p class="sub">写下第一篇之后，这里会开始累积数据。</p>
      </section>

      <!-- ══ 刻度：攒下来的数字 ══════════════════════════════════════ -->
      <template v-else-if="tab === 'scale'">
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
        <!-- ⛔ 正文（各页面）不写解释性小字 —— 用户 2026-09-24 的规矩：
             界面上只留数据本身，解释要么不写、要么放设置里。 -->
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

      <!-- ── 常用标签（P2-19） ───────────────────────────────────
           复用心情分布那套横条结构（`.mood-row` / `.track` / `i`）——
           统计页几块长得像一家人，比多写一套样式值。 -->
      <section class="block">
        <h3>常用标签</h3>

        <p v-if="tagEmpty" class="empty-note">
          还没有用过标签 —— 写日记时可以在正文下面加标签。
        </p>

        <template v-else>
          <div class="moods tag-list">
            <div v-for="t in shownTags" :key="t.id" class="mood-row">
              <!-- 名字可能很长：限宽 ＋ 省略号，全名走 :title（日历页同款做法）。 -->
              <span class="tag-name" :title="t.name">{{ t.name }}</span>
              <span class="track"><i :style="{ width: tagWidth(t.entry_count) }"></i></span>
              <!-- ⛔ 绝对篇数必须写出来：条只说明**相对**多少，不给数字就没法读准。 -->
              <span class="num">{{ t.entry_count }} 篇</span>
            </div>
          </div>
          <button
            v-if="hiddenTagCount > 0"
            type="button"
            class="more"
            @click="tagExpanded = !tagExpanded"
          >
            {{ tagExpanded ? "收起" : `+ 还有 ${hiddenTagCount} 个标签` }}
          </button>
        </template>
      </section>
      </template>

      <!-- ══ 旧影：往回看（P2-23） ════════════════════════════════════
           四块顺序**固定**：往年今天 → 写得最长 → 照片最多 → 连续心情。
           ⚠️ 全是**只读**：不在这里改心情 / 改标签 / 改正文。
           ⚠️ 每块点一下跳到那一天（与搜索结果、热力图同一套动作）。 -->
      <template v-else>
        <!-- 还没拉到 / 拉失败：只说一句中性的话，不弹错误（同上面 stats 的做法）。 -->
        <p v-if="!recap" class="hint">正在读取回顾…</p>

        <template v-else>
          <!-- ── 往年今天 ───────────────────────────────────────────
               放最上：它是"今天"相关的，一进来就该看见；下面三块是"纪录"。
               ⚠️ **逐年的都列**（1 年前、2 年前…），不是只列最近那条 ——
                  只列最近一年的话，第三年就只剩一条了，那不叫回顾。
               ⚠️ 第一年必然是空的（日记从 2026-09 才开始）⇒ 空着，
                  ⛔ 不许退而求其次改成"上个月的今天"。 -->
          <section class="block">
            <h3>往年今天</h3>

            <div class="recap-list">
              <p v-if="onThisDayRows.length === 0" class="empty-note">今天没有以前的日记。</p>
              <template v-else>
                <button
                  v-for="r in onThisDayRows"
                  :key="r.date"
                  type="button"
                  class="recap-card"
                  :class="{ hit: r.hit }"
                  :title="`跳到 ${humanDateFull(r.date)}`"
                  @click="emit('open', r.date)"
                >
                  <div class="rv-head">
                    <span class="rv-when">{{ r.when }}</span>
                    <span class="rv-tail">
                      <span v-if="r.mood" class="rv-mood">{{ r.mood }}</span>
                      <span class="rv-words">{{ r.tail }}</span>
                    </span>
                  </div>
                  <p v-if="r.preview" class="rv-preview">{{ r.preview }}</p>
                </button>
              </template>
            </div>
          </section>

          <!-- ── 写得最长的一篇 ─────────────────────────────────────── -->
          <section class="block">
            <h3>写得最长的一篇</h3>

            <div class="recap-list">
              <p v-if="!longestCard.has" class="empty-note">还没有写过正文。</p>
              <button
                v-else
                type="button"
                class="recap-card"
                :title="`跳到 ${longestCard.when}`"
                @click="emit('open', longestCard.date)"
              >
                <div class="rv-head">
                  <span class="rv-when">{{ longestCard.when }}</span>
                  <span class="rv-tail">
                    <span v-if="longestCard.mood" class="rv-mood">{{ longestCard.mood }}</span>
                    <span class="rv-words">{{ longestCard.words }}</span>
                  </span>
                </div>
                <p v-if="longestCard.preview" class="rv-preview">{{ longestCard.preview }}</p>
              </button>
            </div>
          </section>

          <!-- ── 照片最多的一篇 ───────────────────────────────────────
               ⛔ 一张图都没有时**不显示"0 张"的卡片**，只说一句"还没有图片。" -->
          <section class="block">
            <h3>照片最多的一篇</h3>

            <div class="recap-list">
              <p v-if="!photosCard.has" class="empty-note">还没有图片。</p>
              <button
                v-else
                type="button"
                class="recap-card"
                :title="`跳到 ${photosCard.when}`"
                @click="emit('open', photosCard.date)"
              >
                <div class="rv-head">
                  <span class="rv-when">{{ photosCard.when }}</span>
                  <span class="rv-tail">
                    <span class="rv-words">{{ photosCard.photos }} 张照片</span>
                  </span>
                </div>
              </button>
            </div>
          </section>

          <!-- ── 最长连续同一种心情 ───────────────────────────────────
               整块**不可点**：它是一段区间，不是某一天。
               ⚠️ 口径是"逐日相接 **且** 心情相同"，与数字卡那个"最长连续"
                  （只要求逐日相接）不是一回事 —— 后者可能更长，这是对的。 -->
          <section class="block">
            <h3>最长连续同一种心情</h3>

            <div class="recap-list">
              <p v-if="!streakCard.has" class="empty-note">还没有标过心情。</p>
              <div v-else class="recap-card as-div">
                <div class="rv-head">
                  <span class="rv-when">
                    <span v-if="streakCard.mood" class="rv-mood">{{ streakCard.mood }}</span>
                    {{ streakCard.label }}
                  </span>
                  <span class="rv-tail">
                    <span class="rv-words">连着 {{ streakCard.days }} 天</span>
                  </span>
                </div>
                <p class="rv-preview">{{ streakCard.range }}</p>
              </div>
            </div>
          </section>
        </template>
      </template>
    </template>
  </div>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/*
  树语那一栏：本组件自己也要变成 flex 列 ＋ 允许收缩，
  否则里面那块画布拿不到"剩余高度"，`height: 100%` 会算成 0。
  ⚠️ 只在这一栏生效（`:class` 绑定在 `tab === 'tree'`）—— 刻度/旧影 的间距不动。
*/
.stats--tree {
  flex: 1;
  min-height: 0;
}
.tree-slot {
  flex: 1;
  min-height: 0;
  display: flex;
}
.tree-slot > * {
  flex: 1;
  min-width: 0;
}

.hint {
  margin: 6px 0 0;
  color: var(--text-2);
}
.hint .sub {
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

/* ── 常用标签（P2-19） ───────────────────────────────────────
   颜色**只用现有主题变量**（`var(--accent)` / `var(--hover)` / `var(--text-*)`），
   ⛔ 一个硬编码色号都不许出现（热力图那两轮栽的正是这一类错）。 */
.tag-list .tag-name {
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-2);
}
/* 篇数可能上三位数（"128 篇"），比心情那一格宽一点，免得折行。 */
.tag-list .num {
  width: 52px;
}
/* 折叠行：一个中性的小按钮 —— ⛔ 别做成主按钮，那不是这块的重点。 */
.more {
  margin-top: 8px;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
}
.more:hover {
  background: var(--hover);
  color: var(--text-2);
}

/* ── 页内小切换（P2-23） ─────────────────────────────────────
   只是"同一屏里的两块"，不是第二层导航 ⇒ 两颗小胶囊。
   ⛔ 别做成与顶栏同款的一排按钮 —— 那会让人以为是又一个导航层。
   颜色**只用现有主题变量**，一个硬编码色号都不许出现。 */
.subtabs {
  display: flex;
  gap: 6px;
}
.subtabs button {
  padding: 3px 12px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.subtabs button:hover {
  background: var(--hover);
  color: var(--text-1);
}
.subtabs button.on {
  border-color: var(--accent);
  color: var(--text-1);
}

/* ── 「旧影」四块（P2-23） ───────────────────────────────────── */
.recap-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 列表里的空态**不要再顶一层外边距**（列表自己已经有 margin-top）。 */
.recap-list .empty-note {
  margin-top: 0;
}
.recap-card {
  display: block;
  width: 100%;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  text-align: left;
  font: inherit;
  color: inherit;
}
button.recap-card {
  cursor: pointer;
}
button.recap-card:hover {
  background: var(--hover);
}
/* ⭐ 从写日记屏「去看看」跳过来时，对应那一年**高亮一下**。
   ⛔ 只高亮，不做滚动定位动画、也不把其他年份藏起来。 */
.recap-card.hit {
  border-color: var(--accent);
}
.rv-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.rv-when {
  font-size: 12px;
  color: var(--text-2);
}
.rv-tail {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rv-mood {
  font-size: 13px;
}
/* 最多两行：卡片高度可控，「回顾」才扫得快。 */
.rv-preview {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
