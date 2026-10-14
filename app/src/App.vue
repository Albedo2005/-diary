<script setup lang="ts">
/**
 * 应用外壳：决定显示解锁页还是主界面，并组织各面板。
 *
 * 界面顺序遵循一个原则：**打开就能写**。
 * 所以主界面直接是"日历 + 编辑器"，没有首页、没有列表页中转。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import CalendarPanel from "./components/CalendarPanel.vue";
import EditorPane from "./components/EditorPane.vue";
import FilterPanel from "./components/FilterPanel.vue";
import HiddenScreen from "./components/HiddenScreen.vue";
import RestoreDialog from "./components/RestoreDialog.vue";
import SearchPanel from "./components/SearchPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import StatsPanel from "./components/StatsPanel.vue";
import UnlockScreen from "./components/UnlockScreen.vue";
import {
  backupNow,
  cryptoInfo,
  DEFAULT_AUTO_LOCK_ENTRIES,
  DEFAULT_AUTO_LOCK_SECS,
  DEFAULT_DAILY_WORD_GOAL,
  DEFAULT_REMINDER_MODE,
  DEFAULT_REMINDER_TIME,
  DEFAULT_TRIPLE_CLICK_UNLOCK,
  getBackupStatus,
  getRecap,
  getSettings,
  getStats,
  getStatus,
  integrityCheck,
  isDateWritten,
  listTags,
  lockVault,
  presentReminder,
  quitApp,
  setAutoBackup,
  setReminderLastFired,
  syncAutoStart,
  toAppError,
  unlockWithAutoKey,
  writtenDates,
  type AppStatus,
  type BackupStatus,
  type ChangePasswordResult,
  type CryptoInfo,
  type Recap,
  type ReminderMode,
  type Stats,
  type TagStat,
} from "./api";
import { listen } from "@tauri-apps/api/event";
import { humanBytes, todayKey } from "./utils/date";
import { readTreeMotion, writeTreeMotion } from "./tree/motion.ts";

const status = ref<AppStatus | null>(null);
const booting = ref(true);
const fatal = ref("");

const selected = ref(todayKey());
/**
 * 当前主视图：写日记 / 搜索 / 统计（年轮）/ 筛选。
 *
 * ⚠️ 默认**永远是写日记** —— 四个 tab 里它是"家"。别把这个选择持久化：
 *    用户下次打开软件看到一屏统计，会以为软件坏了。
 *
 * ⚠️ 切走时正文区会**卸载**（`v-if` / `v-else-if`）。`EditorPane` 的
 *    `onUnmounted` 里有 `if (dirty) void flush()`，没落盘的字会先被存掉，
 *    所以**不丢内容**；代价是切回来属于重挂，光标与滚动位置归零。
 *    这与「搜索」的行为完全一致（它也是这么切的）。
 * ⚠️ **筛选页的条件不留**（用户 2026-09-23 拍板）正是靠这条：条件住在
 *    `FilterPanel` 内部的 `ref` 里，一卸载就没了 ⇒ 什么都不用做。
 *    ⛔ 别为了"顺手保住它"把它提到这里来。
 */
const mode = ref<"write" | "search" | "stats" | "filter">("write");

/** localStorage 的键。只存一个"折没折"的布尔值，不含任何日记内容。 */
const CAL_KEY = "diary.calendar-collapsed";

/**
 * 读折叠状态。⚠️ **兜底方向＝展开** —— 只有精确的 `"1"` 才算折叠；
 * 其它一切（null / 垃圾值 / 抛异常）都算展开。
 * ⛔ 别写成 `!== "0"` 之类的反向判断（本项目开关类的通用兜底方向）。
 */
function readCalendarCollapsed(): boolean {
  try {
    return localStorage.getItem(CAL_KEY) === "1";
  } catch {
    return false; // localStorage 被禁（配额满 / 隐私模式）⇒ 退回安全态
  }
}

/**
 * 左侧日历栏是不是收着的（P2-22 沉浸式写日记）。
 *
 * ⭐ **它住在 `App.vue` 而不是 `CalendarPanel` 内部**：切到搜索 / 年轮 / 筛选页时
 *    `CalendarPanel` 本来就会被 `v-if` 卸载（既有行为），放组件内部会被切 tab 弄丢。
 * ⭐ **初值直接读本地存储**（不是 `onMounted` 里再改）⇒ **首帧就是正确的布局**，
 *    不会出现"先展开一下、再收起"的闪动。
 *    ⚠️ 所以上面那个 `CAL_KEY` 与读函数必须排在它**之前** —— `const` 不提升，
 *       顺序反了会在初始化时就抛"Cannot access 'CAL_KEY' before initialization"。
 *
 * ⚠️ 为什么存 `localStorage` 而不是加密库的 `app_settings`：
 *    ① 读库要等**解锁之后**，而布局在解锁前就得定 ⇒ 走库必然闪一下；
 *    ② 新增设置项按项目约定要动后端四处（db / commands / lib.rs / api）；
 *    ③ 它不需要加密 —— 存的是"我喜不喜欢左栏"这一个 bit，**不含任何日记内容**。
 *    ⇒ 判据与项目通用风格一致：**`localStorage` 只许存界面偏好**。
 */
const calendarCollapsed = ref(readCalendarCollapsed());

/** 切换折叠。⚠️ 写失败**不许打断折叠动作**（界面照折，只是下次记不住）。 */
function toggleCalendar() {
  calendarCollapsed.value = !calendarCollapsed.value;
  try {
    localStorage.setItem(CAL_KEY, calendarCollapsed.value ? "1" : "0");
  } catch {
    /* 存不下就算了 —— 它只是个偏好 */
  }
}

/**
 * 「树语」动不动（第一期 · 批次 3 的纪律第 4 条）。
 *
 * ⚠️ 状态放这儿而不是 `TreePane` 内部：切走再回来树那一屏会被卸载重建，
 *    放组件里就记不住"我关过动效"，用户每次进来都得再关一次。
 * ⭐ 与"折叠日历栏"是同一类东西 ⇒ 同样住 `localStorage`
 *    （键 `diary.tree-motion`，读写都在 `tree/motion.ts`）。
 * ⛔ 关掉只是**树不动**，不是把树藏起来。
 */
const treeMotion = ref(readTreeMotion());

/** 切换树语动效。⚠️ 写失败**不许打断这个动作**（界面照切，只是下次记不住）。 */
function onTreeMotion(on: boolean) {
  treeMotion.value = on;
  writeTreeMotion(on);
}

/** 递增以要求日历刷新标记。**每次保存都会递增** —— 所以别拿它去驱动整篇重载。 */
const refreshToken = ref(0);

/**
 * 递增以要求编辑器**整篇重读**（只给恢复备份用，P2-5）。
 *
 * 与 `refreshToken` 严格分开，理由见 `onRestoreDone` 里的注释：
 * 那个令牌每次保存都在动，谁跟着它重载谁就会把条目重新锁上。
 */
const libraryToken = ref(0);

/**
 * 递增以要求两处标签界面刷新。
 *
 * 标签同时出现在**筛选页的筛选条 + 标签管理**（FilterPanel）与**编辑器 chip 行
 * + 下拉候选**（EditorPane）里，改标签的入口也在这两处（编辑器的 ＋/×、
 * 筛选页的 ✎/✕）。用一个共享的令牌让两边互相同步，比"谁改了谁挨个去通知对方"
 * 少一半接线，也避免出现"筛选页删了标签、编辑器还挂着它"这种半新半旧的状态。
 *
 * ⚠️ **消费者在 P2-7 换过一次**：以前是**日历侧栏**（它的标签块已整块搬去筛选页），
 *    现在这条线接到 FilterPanel 上。⚠️ **新页面 ＋ 编辑器两个消费者缺一不可** ——
 *    只搬一处就会出现"一半新、一半旧"。
 * ⚠️ 唯一还没接上的消费者是统计页的「常用标签」榜 —— 它吃的是 `tags` 那份 prop
 *    （由 `loadAux` 拉），**刻意不跟这个令牌走**，理由见 `StatsPanel.vue` 文件头。
 *
 * 与自己无关的改动也会触发一次重读 —— 多查一次换来的是
 * "界面上的标签永远来自数据库"，这个买卖划算。
 */
const tagToken = ref(0);

const stats = ref<Stats | null>(null);

/**
 * 标签列表 —— 只给统计页的「常用标签」块用。
 *
 * 标签同时出现在**三个**地方：日历侧栏的列表、编辑器 chip 行 ＋ 下拉候选，
 * 以及统计页这块榜。前两处**各自**去后端读（由 `tagToken` 驱动）；这里存一份，
 * 是因为统计面板必须保持"只吃 prop"（理由见 `StatsPanel.vue` 文件头）。
 *
 * ⚠️ 它是**派生数据**，已登记在下面 `loadAux` 那张清单里 —— 解锁后与恢复备份后
 *    都要重取，别漏。
 */
const tags = ref<TagStat[]>([]);

/**
 * **所有写过的日期**（P2-17）—— "那年今日"与将来的回顾页都吃这一份。
 *
 * ⚠️ 为什么要一次查到最早：之后切日期全是**纯前端筛**（见 `sameDayInPastYears()`）
 *    —— 所以翻日期不会因此变卡。写成"往前 5 年"反而会**在某天悄悄失效**，
 *    而一次查全量（几百~几千条字符串）成本可忽略。
 * ⚠️ 与日历侧栏那份**不是同一个东西**：那边按**当月**查（`CalendarPanel.load()`），
 *    这里按**全时段**查；两者都不该被对方取代。
 * ⚠️ 它是**派生数据**，已登记在下面 `loadAux` 那张清单里 —— 解锁后与恢复备份后都要重取。
 */
const writtenDays = ref<string[]>([]);

/**
 * 「旧影」（回顾）那一屏的数据（P2-23）。
 *
 * ⚠️ **刻意不进下面那张派生数据登记处** —— 这条命令要跑三遍全表扫描，
 *    只在用户**点开「旧影」**那一下才算（见 `loadRecap`），开机白算是浪费。
 * ⚠️ 但也正因为不进登记处，**换库 / 恢复备份时必须手动清掉**（见 `clearDerived`）——
 *    不清的话，恢复完切回旧影看到的会是**上一个库**的"最长的那几天"。
 */
const recap = ref<Recap | null>(null);

/**
 * 「年轮」页内停在哪一边（P2-23）。
 *
 * ⚠️ 状态放这里而不是 `StatsPanel` 内部：切走再回来那一屏会被卸载重建，
 *    放组件里就记不住"上次停在旧影"，而用户要的正是记住。
 * ⚠️ **只在这次运行里记**，⛔ 不落盘 —— `localStorage` 只许存界面偏好
 *    （P2-22 立的规矩），"你写过什么"属于日记内容，落盘就是泄露。
 */
const statsTab = ref<"scale" | "recap" | "tree">("scale");

/**
 * 从写日记屏那句「N 年前的今天写过 · 去看看」带过来的那一天（P2-23）。
 *
 * **一次性**：`StatsPanel` 用它把对应那一年高亮一下，**离开年轮页就清掉**
 * （否则切走再回来它还挂着高亮）。⛔ 别把它改成对象或加字段 ——
 * P2-17 那边只传一个日期字符串，改了会把那边也拖下水。
 */
const recapFocus = ref("");

const crypto = ref<CryptoInfo | null>(null);
const backup = ref<BackupStatus | null>(null);
/** 设置弹窗。日历与编辑器不被卸载，所以这里悬着也不影响未保存的草稿。 */
const showSettings = ref(false);

/**
 * 遮蔽页是否挂着。
 *
 * ⚠️ 它**不是锁**：免密打开时库自始至终是解锁的，这里只是拉一层帘子
 *    （见 doLock 与 HiddenScreen.vue 的说明）。帘子挂着时主界面组件
 *    并不卸载，所以编辑器里的草稿原样保留。
 */
const hidden = ref(false);

/**
 * 正文编辑器的句柄 —— 只用来在**锁库之前**催它把没保存的内容写下去（P2-4）。
 *
 * 为什么要单独拿一个 ref：正文是 1000ms 防抖保存的，而"锁定"会先把库锁上、
 * 顺带把编辑器从主界面上卸载掉；等于说编辑器自己想保存时，门已经关了。
 * 类型只声明用到的那一个方法，免得把整个组件的类型都拖进来。
 */
const editorRef = ref<{ flushNow: () => Promise<void> } | null>(null);

/**
 * 上次启动时免密解锁失败过。
 *
 * 真时把解锁页的副标题改掉并加一条提示条 —— 用户本来期待"直接进去"，
 * 结果看到要输密码，不说清楚他会以为软件坏了。
 */
const autoLoginFailed = ref(false);

/**
 * 自动锁定时长（秒）。`0` = 永不。
 *
 * 先用默认值起步，解锁成功后由 loadSettings() 换成库里的真实值 ——
 * 设置存在**加密库**里，未解锁时根本读不到，所以这里必须可变，
 * 不能像以前那样写死成一个常量。
 */
const autoLockSecs = ref(DEFAULT_AUTO_LOCK_SECS);

/**
 * 离开某一天时是否自动把日记锁上（指令 14）。默认 **开**。
 *
 * 与 `autoLockSecs` 同一套路：先用默认值起步，解锁后由 `loadSettings()`
 * 换成库里的真实值 —— 设置在**加密库**里，未解锁根本读不到。
 *
 * ⚠️ 初值必须是 `true`：`EditorPane.load()` 首屏就会用它，而设置要等解锁。
 *    初值取 `false` 会静默地不锁（见 DEFAULT_AUTO_LOCK_ENTRIES 的说明）。
 */
const autoLockEntries = ref(DEFAULT_AUTO_LOCK_ENTRIES);

/**
 * 日记锁定时，在正文里连点三下左键是否可以直接解锁（指令 15）。默认 **开**。
 *
 * 与 `autoLockEntries` 同一套路：先用默认值起步，解锁后由 `loadSettings()`
 * 换成库里的真实值 —— 设置在**加密库**里，未解锁根本读不到。
 */
const tripleClickUnlock = ref(DEFAULT_TRIPLE_CLICK_UNLOCK);

/**
 * 写作提醒是否开启（【P2-13】）。默认 **关**。
 *
 * ⚠️ 默认关是**用户拍板的**（指令里也明令"别擅自帮用户打开"）：
 *    提醒会让窗口自己跳出来，这种事必须他亲手开。
 * 与上面三项同一套路：先用默认值起步，解锁后由 `loadSettings()` 换成真值。
 */
const reminderEnabled = ref(false);

/**
 * 提醒的重复策略（【P2-13】）。默认"一天提醒一次"。
 *
 * ⚠️ 三档与"提醒开关"是**两件事**：开关管"要不要提醒"，
 *    这一档管"报到的节奏"（用户 2026-09-28 拍板：写入设置、自己选）。
 */
const reminderMode = ref<ReminderMode>(DEFAULT_REMINDER_MODE);

/** 提醒时间，`"HH:MM"`（后端洗净过的两位补零值）。 */
const reminderTime = ref(DEFAULT_REMINDER_TIME);

/**
 * 最后一次真的响过提醒的日期（`YYYY-MM-DD`）；从没响过是空串。
 *
 * ⚠️ 它**必须落库**（不是内存标记）：`daily` 档对用户的承诺是"一天一次"，
 *    只存内存的话，他重启一次软件当天就会被再提醒一次。
 */
const reminderLastFired = ref("");

/** 开机自启（【P2-13】）。默认 **关**。 */
const autoStart = ref(false);

/**
 * 每日字数目标（【P2-12】）。`0` ＝ **不用这个功能**（底部不显示目标）。
 *
 * 与上面几项同一套路：先用默认值起步，解锁后由 `loadSettings()` 换成真值。
 *
 * ⚠️ 初值必须是 `0`：设置要等解锁才读得回来，那段时间里编辑器底部
 *    **不该先闪一下目标再消失**。
 * ⚠️ 它住在**加密库**里（与其余设置一样）—— ⛔ 不进 `localStorage`，
 *    那是放界面偏好的地方。
 * ⚠️ 真值源只有这一个：`EditorPane` 与设置页都从这里拿（设置不能有两份）。
 */
const dailyWordGoal = ref(DEFAULT_DAILY_WORD_GOAL);

/**
 * 提醒横幅是否挂着（【P2-13】）。
 *
 * ⚠️ 它**不是 toast**：toast 是 3 秒就走掉的操作反馈，
 *    而这条要**一直挂到用户处理**（点「去写」或点「×」）——
 *    所以它有自己的 ref、自己的样式、自己的关闭方式。
 */
const showReminder = ref(false);

/**
 * 本次运行里"该不该提醒"是**为哪一天**判断过的（内存标记，**不落盘**）。
 *
 * ⚠️ 它存在的理由是"别每分钟都去问一次库"：`tickReminder` 每 60 秒跑一次，
 *    而"今天写过没有"是一次 IPC —— 没有这个标记，一天会白发几百次。
 * ⚠️ 存的是**日期**而不是一个布尔值：软件可能一直开着、跨过午夜，
 *    存布尔值的话第二天就再也不判断了（永远停在"昨天已经看过"）。
 * ⚠️ 置位时机是"**判断完成之后**（无论写没写）"，不是"真提醒了之后"：
 *    已经写过的那天同样要停下来。
 */
let reminderCheckedOn: string | null = null;

/**
 * 上一次跑"看一眼"的时刻（内存值，**不落盘**）。模块加载时就是"现在"。
 *
 * ⭐ 它是"**错过不补**"那条规则的实现（用户 2026-09-23 定、2026-09-28 复核：
 *    "没开机/被退出 ⇒ 那天作废、重开不补"）：
 *    "到点"要求**提醒时间落在两次检查之间**，也就是"那一刻软件**确实在跑**"。
 *    ⇒ 晚上 22:00 才打开软件（21:00 时它没在跑）⇒ 那天作废、不补提醒。
 *    ⚠️ 少了它，"过了点才打开软件"会立刻弹一条 —— 那就成了"补提醒"，
 *       与用户要的正好相反。
 * ⚠️ 初值取"现在"而不是 `null`：启动那一刻算作"刚检查过一次"，
 *    于是"启动时刻 < 提醒时间 ≤ 现在"在任何情况下都有**一致**的起点
 *    （否则行为会取决于开机时焦点事件有没有触发过，太脆）。
 */
let reminderLastTickAt = new Date();

const toast = ref("");
let toastTimer: number | null = null;

const unlocked = computed(() => status.value?.unlocked === true);

function flash(msg: string) {
  toast.value = msg;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ""), 3200);
}

async function boot() {
  booting.value = true;
  fatal.value = "";
  autoLoginFailed.value = false;
  try {
    let s = await getStatus();

    /*
      免密打开：库还没解锁、而钥匙文件在，就直接开库，用户看不到解锁页。
      booting 期间显示的是"正在启动…"，所以这里不会有"闪一下解锁页"。

      失败不做特殊处理 —— 后端已经处理完了：它把那个没用的钥匙文件删掉，
      并把原因写在错误里。前端只负责回退到解锁页并告诉用户为什么。
      （失败时刻意**不**再重试一次密码路径：没有密码可试。）
    */
    if (!s.unlocked && s.auto_login) {
      try {
        s = await unlockWithAutoKey();
      } catch {
        autoLoginFailed.value = true;
        s = await getStatus();
      }
    }

    status.value = s;
    if (s.unlocked) {
      // ⚠️ 走的是与"解锁成功后""恢复备份后"**同一段**重取代码（`refreshDerived`），
      //    不是只拉 `loadAux()`。
      //
      //    为什么这条路径要紧：**免密打开**时库一开始就是解锁的
      //    （`unlockWithAutoKey`），全程不会经过 `onUnlocked`；
      //    同一个进程里 reload 界面也会落到这里。
      //    以前这里写的是 `loadAux()`，在只统计"数字"的年代没问题；
      //    P2-19 给登记处加了 `tags` 之后，"只拉 loadAux"就意味着
      //    **每次冷启动统计页的「常用标签」都是空的**（要改一次标签才出来）。
      //    ⇒ 以后谁再往登记处加一项，三个入口自动都覆盖 —— 这就是登记处的用处。
      await refreshDerived();
      // 设置也得跟着读一次：库里存的可能是 1 分钟或永不，
      // 先用默认值起步会让自动锁定在启动后的一小段时间里用错时长。
      // 免密自动解锁同样会走到这里，所以它读到的也是真实设置。
      await loadSettings();
    }
  } catch (e) {
    fatal.value = toAppError(e).message;
  } finally {
    booting.value = false;
  }
}

/**
 * ⭐ **派生数据登记处**
 *
 * 凡是"从库里算出来、又被缓存住"的东西，都必须登记在下面这张清单里 ——
 * 解锁后 与 **恢复备份后** 都要重取一遍。
 *
 * 为什么这件事必须有个登记处：恢复是**整库替换**，库里的东西全换了，
 * 而这些缓存还挂着**旧库**的值。症状是"恢复完了，统计和标签还是恢复前的"，
 * 而且几乎没人会想到是这个原因。
 *
 * 目前在册：
 *   - `stats`  —— 统计那一屏 ＋ 顶栏的"共 N 篇 · 连续 N 天"
 *   - `tags`   —— 标签（App.vue 这里缓存一份，给统计页的「常用标签」块；
 *                  日历侧栏与编辑器 chip 行仍各自去后端读，由 `tagToken` 驱动）
 *   - `crypto` —— 加密参数摘要
 *   - `backup` —— 备份状态（已有几份 / 下次什么时候）
 *   - `writtenDays` —— **所有写过的日期**（P2-17 加进来；编辑器头部那句
 *                      "N 年前的今天"靠筛它得出。【P2-23】的回顾页也吃这一份）
 *   - （以后谁新增了缓存，往下补一行）
 */
async function loadAux() {
  try {
    const [s, c, b, wd] = await Promise.all([
      getStats(),
      cryptoInfo(),
      getBackupStatus(),
      // 上限写"今天"而不是更晚：未来日期的记录不该参与"写过的日子"这个集合。
      // ⚠️ 下限写到最早（`0001-01-01`）而不是"往前 N 年" —— 见 writtenDays 的说明。
      writtenDates("0001-01-01", todayKey()),
    ]);
    stats.value = s;
    crypto.value = c;
    backup.value = b;
    writtenDays.value = wd;
  } catch {
    // 辅助信息失败不应阻塞主流程。
  }
}

/**
 * 只重读标签列表（统计页的「常用标签」块读它）。
 *
 * ⚠️ 为什么单独一个函数、不并进 `loadAux`：`loadAux` 还拉着 `cryptoInfo` /
 *    `getBackupStatus` 两条与标签毫无关系的命令，而标签是**会被频繁改动**的一项
 *    （加一个、撤一个、改个名都会走 `onTagsChanged`）—— 每次顺手重拉那两条是白费。
 */
async function loadTags() {
  try {
    tags.value = await listTags();
  } catch {
    // 读不到标签不该干扰主流程；留空列表，面板会显示"还没有用过标签"。
  }
}

/**
 * 只重读「旧影」那一屏的数据（P2-23）。
 *
 * ⚠️ **只在点开「旧影」时调**，⛔ 别把它塞进 `loadAux()` —— 这条要跑三遍全表扫描，
 *    开机白算不值当（`getRecap()` 的注释里写着同一条）。
 * ⚠️ 拉之前**不清空旧值**：重拉时界面能继续显示上一份，不会闪成"正在读取…"。
 *    真要作废（换库 / 恢复）走 `clearDerived()`。
 */
async function loadRecap() {
  try {
    recap.value = await getRecap();
  } catch {
    // 读不到回顾不该干扰主流程：面板会显示"正在读取回顾…"而不是报错。
  }
}

/**
 * 两个触发点 —— **合起来才是完整的"什么时候该重读回顾"**：
 *   1. 页内切到「旧影」；
 *   2. **进入年轮页且停在旧影**（切走再回来属于这种情况：本组件被卸载重建，
 *      第 1 条不会触发，因为 `statsTab` 的值压根没变）。
 * ⚠️ 离开年轮页时顺手把"定位年份"清掉 —— 那条指令只用一次。
 */
watch(statsTab, (t) => {
  if (t === "recap" && mode.value === "stats") void loadRecap();
});

watch(mode, (m) => {
  if (m !== "stats") {
    recapFocus.value = "";
    return;
  }
  if (statsTab.value === "recap") void loadRecap();
});

/**
 * 写日记屏那句「**N 年前的今天写过 · 去看看**」被点了一下（P2-23 接的线）。
 *
 * ⚠️ 目标**不是**"跳到那一天"，而是**切到年轮页的「旧影」并定位那一年** ——
 *    P2-17 交付时只能先做成跳过去（当时回顾页还不存在，不跳就是"点了没反应"），
 *    到这里改成最终形态。
 * ⚠️ 传进来的仍然只是**一个日期字符串**（事件名 `open` 与参数形式都没动 ——
 *    P2-17 那边就是照这个传的，改了会把它一起拖下水）。
 * ⚠️ 顺序要紧：先摆好页内 tab 和定位年份，**最后**再切 `mode` ——
 *    否则 `mode` 那个 watcher 跑起来时 `statsTab` 还是旧的，回顾数据不会去拉。
 */
function openOnThisDay(d: string) {
  statsTab.value = "recap";
  recapFocus.value = d;
  mode.value = "stats";
}

/**
 * 重取**全部**派生数据（见上面那张登记表）。
 *
 * ⚠️ **三个调用点走的是同一段代码**：`boot()`（库在启动时就已解锁 —— 免密打开
 *    或界面 reload）、`onUnlocked`、`onRestoreDone`。这不是图省事 ——
 *    这三件事的语义本来就一样："库的内容变了，界面上所有从库里算出来的东西都作废"。
 *    各写一份的话，早晚有一个人会漏掉其中一项
 *    （P2-19 真的栽过：`boot()` 漏了，于是开了免密的人每次启动榜都是空的）。
 */
async function refreshDerived() {
  await loadAux();
  // ⚠️ 标签也在册 —— 恢复备份是**整库替换**，统计页那块榜读的就是这里缓存的
  //    `tags`，不重取就会出现"恢复完了，榜还是恢复前的"。
  await loadTags();
  // 标签同时出现在日历侧栏与编辑器 chip 行，两边各自去后端读，递增令牌即可。
  tagToken.value++;
}

/**
 * 进入未解锁态时把派生数据全部清掉 —— 那些值属于**已经关掉的那个库**。
 *
 * 与 `refreshDerived` 是一对：那个是"换个库重取"，这个是"没有库了"。
 */
function clearDerived() {
  stats.value = null;
  tags.value = [];
  writtenDays.value = [];
  // ⚠️ 「旧影」的数据**不在登记处**（它按需拉，见 loadRecap），所以这里必须手清 ——
  //    它是"从库里算出来的"，恢复备份后不清就会显示上一个库的纪录。
  recap.value = null;
  crypto.value = null;
  backup.value = null;
}

/**
 * 读取应用设置（自动锁定时长 ＋ 离开日记时自动锁定 ＋ 三击左键快速解锁）。
 *
 * 只能在**解锁后**调 —— 设置在加密库里，未解锁读不到。
 * 读失败不阻塞主流程：留用默认值也比卡住强，何况这几项都有安全的落点
 *（时长回落到 10 分钟、两个开关都回落到"开"）。
 */
async function loadSettings() {
  try {
    const s = await getSettings();
    autoLockSecs.value = s.auto_lock_secs;
    autoLockEntries.value = s.auto_lock_entries;
    tripleClickUnlock.value = s.triple_click_unlock;
    // 写作提醒与开机自启（【P2-13】）
    reminderEnabled.value = s.reminder_enabled;
    reminderMode.value = s.reminder_mode;
    reminderTime.value = s.reminder_time;
    reminderLastFired.value = s.reminder_last_fired;
    autoStart.value = s.auto_start;
    // 每日字数目标（【P2-12】）。`0` ＝ 不用，编辑器底部那一句随之消失。
    dailyWordGoal.value = s.daily_word_goal;
  } catch {
    // 保持默认值。不值得为这一项弹错误。
  }
  // ⭐ 开机自启的**路径校正**（【P2-13】）：软件换过位置之后，注册表里
  //    那条自启命令还指着旧 exe ⇒ 症状是"自启明明开着，开机却什么都没发生"。
  //    ⚠️ 必须排在**读设置之后**：后端要先知道"用户确实开着自启"才肯动注册表，
  //       否则"从别处的 exe 启动一次"就会把他的自启悄悄改到那个路径上。
  //    ⚠️ 失败不吭声：这是每次解锁都跑的**背景动作**，用户没做错什么。
  try {
    await syncAutoStart();
  } catch {
    // 同上，静默。
  }
  // ⭐ 设置到位之后立刻看一眼该不该提醒（【P2-13】）。
  //    ⚠️ 这一句不能省：`watch(unlocked)` 触发时设置**还没读回来**
  //       （`loadSettings` 是异步的），那时 `reminderEnabled` 还是初值 `false`
  //       ⇒ 定时器起了、但这一轮判断会被跳过。早上打开软件时如果已经过了
  //       提醒时间，就该当场提醒，而不是等下一个 60 秒。
  tickReminder();
}

function onUnlocked(s: AppStatus) {
  status.value = s;
  // 已经进来了，那条"免密失效"的提示就没有意义了。
  autoLoginFailed.value = false;
  // ⚠️ 用的是与"恢复备份之后"**同一段**重取代码（见 refreshDerived 的说明）。
  void refreshDerived();
  // 解锁成功后必须把设置读回来 —— 包括"免密自动解锁"那条路径，
  // 它同样会走到这里。否则会一直用启动时的默认值。
  void loadSettings();
}

/**
 * 免密开关变了（设置页里开的或关的）。
 *
 * 用后端返回的那一份**整体替换**，而不是只改 auto_login 这一个字段：
 * 开关失败会改变剩余尝试次数、甚至进入锁定期，前端自己拼必然漏项。
 */
function onAutoLoginChanged(s: AppStatus) {
  status.value = s;
}

/**
 * 从遮蔽页回来。
 *
 * 库自始至终是解锁的，所以这里只撤帘子 —— 不碰状态、不重拉数据，
 * 编辑器里的草稿原样还在（组件全程没被卸载）。
 * 但要**重挂自动锁定计时器**：帘子挂着这段时间里它已被清掉，
 * 不重挂的话"再次失焦"就不会再触发了。
 */
function resume() {
  hidden.value = false;
  rearmLockTimer();
}

function onSaved() {
  refreshToken.value++;
  void loadAux();
}

/**
 * 任何一处改了标签（编辑器加/撤、侧栏改名/删除）→ 让三个标签界面都重读。
 *
 * ⚠️ 只递增令牌，**不判断是谁改的**：判断"这次改动影响哪些视图"需要
 *    在前端复制一份标签与日记的关联关系，而那份镜像迟早会与数据库不一致
 *    （标签会被级联删除、会被改名）。让两边都去问后端，最简单也最准。
 */
function onTagsChanged() {
  tagToken.value++;
  // ⚠️ 统计页新增了「常用标签」块，它读的正是 App.vue 缓存的 `tags` ——
  //    标签一改，那块榜必须跟着变。（这里原来写着"标签改了不影响统计"，
  //    加上那块榜之后那句话直接作废。）
  //    ⛔ 只重取标签，**不要图省事调 `loadAux()`** —— 那会白拉 cryptoInfo
  //    与备份状态两条跟标签毫无关系的命令。
  void loadTags();
}

async function doLock() {
  // 先撤掉自动锁定的计时器：已经锁上了，它再响一次是空跑；
  // 更糟的是万一定时器残留到解锁之后，会突袭式地把刚解开的库又锁上。
  clearLockTimer();

  /*
    免密打开时**不能真锁库**：库里没有密码可输，锁上就是死锁 ——
    用户下一次打开会撞上一个"要求密码、却又不接受任何密码"的界面。
    所以这里只拉一层帘子（纯前端），回来看一眼就恢复，草稿也不丢。

    ⚠️ 判断只写在**这一处**。手动点「锁定」和自动锁定到点都走本函数，
       两处各写一份 if 的话，漏掉任何一处就会出现上面那个死锁。
    ⚠️ 免密模式下"自动锁定"仍然照常生效（到点就走这里拉帘子），
       不要加 `if (auto_login) return` 去停用它 —— 那样屏幕会一直亮着。
  */
  if (status.value?.auto_login) {
    hidden.value = true;
    return;
  }

  /*
    ⚠️ 先落库、再锁库 —— 顺序不能反（P2-4）。

    正文是 1000ms 防抖保存的。原先这里直接 lockVault()：库一锁，编辑器就随
    主界面一起卸载，卸载时它那句 `if (dirty) void flush()` 必然被已锁的库拒绝
    ⇒ "点锁定前最后一秒打的字"会静默消失（界面上只闪一下"保存失败"）。
    所以在锁之前必须先催它一次，而且**等它写完**（await）再往下走。

    免密那条分支在上面已经 return 了 —— 它只拉帘子、不真锁库，编辑器也不会卸载，
    轮不到这里操心。

    flushNow() 没脏内容时是空跑；失败由 flush() 自己写进 saveState、不往外抛，
    所以这里不需要再包一层 catch。
  */
  await editorRef.value?.flushNow();

  try {
    status.value = await lockVault();
    clearDerived();
  } catch (e) {
    flash(toAppError(e).message);
  }
}

/**
 * 立即备份。
 * 备份目录固定是数据目录下的 backups —— 前端不再传路径，
 * 改由后端用默认目录，避免界面与后端对"备份放哪"产生分歧。
 */
async function doBackup() {
  const dir = backup.value?.dest_dir;
  if (!dir) return;
  try {
    const r = await backupNow(dir);
    flash(`已备份（${humanBytes(r.bytes)}）`);
    backup.value = await getBackupStatus();
  } catch (e) {
    flash(`备份失败：${toAppError(e).message}`);
  }
}

/** 开关自动备份。 */
async function toggleAutoBackup() {
  if (!backup.value) return;
  const next = !backup.value.auto_enabled;
  try {
    await setAutoBackup(next);
    backup.value = await getBackupStatus();
    flash(next ? "已开启自动备份（每天一次）" : "已关闭自动备份");
  } catch (e) {
    flash(toAppError(e).message);
  }
}

// ---------------------------------------------------------------------------
// 备份恢复（P2-5）
// ---------------------------------------------------------------------------

/**
 * 恢复确认弹窗：开不开 / 正在恢复的是哪一份。
 *
 * ⚠️ 流程**必须留在 App.vue**，不能塞进设置页或解锁页，有三个理由：
 *   ① 恢复前要 `editorRef.flushNow()` —— 编辑器句柄只有这里拿得到；
 *   ② 恢复后要重取**全部**派生数据（`refreshDerived`）；
 *   ③ 恢复后可能得回解锁页（备份不是当前密码加密的时候）。
 * 那两处入口只做一件事：把路径发过来。
 */
const restoreOpen = ref(false);
const restorePath = ref("");

/**
 * 打开恢复确认弹窗。
 *
 * ⚠️ **先落库、再恢复**，顺序不能反 —— 和 `doLock` 是同一个病根：
 *    正文是 1000ms 防抖保存的，不催它一次，恢复前最后几秒打的字
 *    既不在当前库里、也不会进"后悔药"，等于凭空蒸发了。
 *    必须 `await`：flush 是异步的，不 await 就等于没等。
 */
async function doRestore(dbPath: string) {
  await editorRef.value?.flushNow();
  restorePath.value = dbPath;
  restoreOpen.value = true;
}

/**
 * 恢复完成（弹窗里已经确认过、也真的换完库了）。
 *
 * 分两种情况，因为它们对用户意味着完全不同的事：
 *   - **能用当前密码打开** ⇒ 直接继续用，界面上的数字也换成恢复后的；
 *   - **打不开** ⇒ 回解锁页，并说清"要用这份备份当时那个密码" ——
 *     绝不能让他以为是自己密码记错了。
 */
async function onRestoreDone(s: AppStatus) {
  restoreOpen.value = false;
  status.value = s;
  // 日历上"写过"的标记属于那个已经被换掉的库。
  refreshToken.value++;
  // ⚠️ 编辑器要的是**另一个**令牌。这两件事看着像，其实完全不同：
  //    `refreshToken` 每次保存都会递增（日历靠它刷标记），
  //    而 EditorPane 收到它就会整篇重载，重载里带着 `lockAllEntries()` ——
  //    接上去的后果是"打完字一保存就被重新锁上，后面打的字静默丢掉"。
  //    只有"整个库被换掉"才该让编辑器重读，所以单开一个。
  libraryToken.value++;

  if (s.unlocked) {
    await refreshDerived();
    await loadSettings();
    flash("已恢复 —— 界面上的数字也都换成恢复后的了");
  } else {
    clearDerived();
    flash("已恢复。请用这份备份当时那个密码解锁");
  }
}

/** 重新拉一次状态。改密码失败会改变剩余尝试次数 / 是否已锁定。 */
async function refreshStatus() {
  try {
    status.value = await getStatus();
  } catch {
    // 保持旧状态。为这一项弹错误不值得 —— 下一次操作还会再拉一次。
  }
}

/**
 * 主密码已更换。
 *
 * 状态用后端返回的那一份**整体替换**，而不是只改提示语：
 * 改密码会同时影响提示语、剩余尝试次数（清零）与锁定状态，
 * 前端自己拼一份必然漏项。
 *
 * 收尾警告必须如实显示：它们都发生在"密码已经换掉"之后，
 * 不显示用户就会以为一切都好了（比如以为免密还能用）。
 */
function onPasswordChanged(res: ChangePasswordResult) {
  status.value = res.status;
  flash(
    res.warnings.length > 0
      ? `密码已更换；${res.warnings.join("；")}`
      : "密码已更换"
  );
  // 换完密码会自动备份一份新的，备份数量跟着变了。
  void loadAux();
}

/** 检查搜索索引与正文是否对得上。结果用 toast 汇报，不弹新窗口。 */
async function doIntegrity() {
  try {
    const r = await integrityCheck();
    const healthy =
      r.orphan_word_index === 0 &&
      r.orphan_char_index === 0 &&
      r.missing_word_index === 0 &&
      r.missing_char_index === 0;
    flash(
      healthy
        ? `索引一致性正常（${r.entry_count} 篇）`
        : `索引异常：孤儿 ${r.orphan_word_index}/${r.orphan_char_index}，缺失 ${r.missing_word_index}/${r.missing_char_index}`
    );
  } catch (e) {
    flash(toAppError(e).message);
  }
}

/**
 * 离开电脑自动锁定的兜底：窗口失去焦点后，按**用户设定的时长**清除内存中的密钥。
 *
 * 计时起点是**窗口失焦**，不是 Windows 那种"系统空闲时间"（人在不在电脑前）——
 * 后者要调系统 API 取空闲时长，本项目不做。区别很实际：
 * 开着窗口盯着日记发呆不会锁，切到别的程序才走计时。
 *
 * 时长可配（设置页【安全】→ 自动锁定时长），所以它不能是常量；
 * 而且**设置一改就得重挂**：否则刚从"1 分钟"改成"永不"，
 * 旧 timer 到点照样把库锁上。
 */
let blurTimer: number | null = null;

function clearLockTimer() {
  if (blurTimer !== null) {
    window.clearTimeout(blurTimer);
    blurTimer = null;
  }
}

function onBlur() {
  if (!unlocked.value) return;
  if (autoLockSecs.value <= 0) return; // 永不
  clearLockTimer();
  blurTimer = window.setTimeout(() => {
    if (unlocked.value) void doLock();
  }, autoLockSecs.value * 1000);
}

function onFocus() {
  clearLockTimer();
  // 窗口重新获得焦点时顺便看一眼该不该提醒（【P2-13】）。
  // ⚠️ 这条**不是锦上添花**：定时器在窗口隐藏时会被系统节流，
  //    而且"合盖一夜、第二天打开电脑"时第一次 tick 最多要等 60 秒 ——
  //    焦点事件能让它立刻判断。
  tickReminder();
}

/**
 * 按当前设置重挂计时器。
 *
 * 窗口此刻有焦点就不该有计时器 —— 交回给 onFocus 的语义；
 * 只有确实处于失焦状态时才按新时长重新开始计。
 */
function rearmLockTimer() {
  clearLockTimer();
  if (!unlocked.value) return;
  if (autoLockSecs.value <= 0) return;
  if (!document.hasFocus()) onBlur();
}

/** 设置一改立刻生效（不用重启）：重挂计时器。 */
watch(autoLockSecs, () => rearmLockTimer());

/**
 * 任何"进入未解锁态"的路径都清掉计时器 ——
 * 手动锁定也会经过这里，不必在每个调用点都记得清一遍。
 */
watch(unlocked, (ok) => {
  if (!ok) {
    clearLockTimer();
    // 提醒定时器同理：未解锁时它什么都判断不了（`isDateWritten` 会报错），
    // 而且那会儿软件停在锁屏页、提醒没有意义。
    stopReminderTimer();
    // 横幅也得收掉 —— 它是"上一个解锁状态"留下的界面残留。
    showReminder.value = false;
    return;
  }
  startReminderTimer();
});

// ---------------------------------------------------------------------------
// 写作提醒（【P2-13】）
// ---------------------------------------------------------------------------

/** 定时器句柄。`null` = 没在跑。 */
let reminderTimer: number | null = null;

/**
 * 检查间隔：**每分钟**一次。
 *
 * ⚠️ 为什么不是"算出距离 21:00 还有多少毫秒、然后睡那么久"：
 *    - 合盖 / 休眠 ⇒ 醒来时那一次早就过了，或者被系统时钟改动搞乱；
 *    - 用户改了提醒时间 ⇒ 那个长定时器得**重算**，而"改时间"这条路径最容易漏；
 *    - 长 `setTimeout` 还踩 int32 毫秒溢出那条老坑。
 *    与后台自动备份线程同一套做法：**隔一阵醒一次、判断一下**。
 */
const REMINDER_TICK_MS = 60_000;

/** 现在几点的 `HH:MM`（本地时间、两位补零）。 */
function nowHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function startReminderTimer() {
  if (reminderTimer !== null) return;
  reminderTimer = window.setInterval(tickReminder, REMINDER_TICK_MS);
}

function stopReminderTimer() {
  if (reminderTimer === null) return;
  window.clearInterval(reminderTimer);
  reminderTimer = null;
}

/**
 * 看一眼"该不该提醒"，该就提醒。
 *
 * 每 60 秒跑一次，另外两处各补跑一次：
 *   - `onFocus`（窗口重新获得焦点）：合盖一夜后第一次 tick 最多要等 60 秒；
 *   - `loadSettings` 末尾（设置刚读回来）：`watch(unlocked)` 触发那一刻
 *     设置还没到位，判断会被跳过。
 *
 * ⚠️ **只在解锁后跑**：`isDateWritten` 未解锁会报错，锁屏页上提醒也没意义
 *    （"锁着照常提醒"指的是**应用被锁定但人还在用**，不是停在锁屏页）。
 */
function tickReminder() {
  const now = new Date();
  // ⚠️ **先取旧值、再更新**，而且要把更新放在所有 `return` 之前：
  //    后面有好几个提前返回，而"检查区间"必须连续 ——
  //    漏更新会让区间断掉，下一次判断的 `prev` 还是很久以前，
  //    可能凭空"跨过"一个早就过去的提醒时间。
  const prev = reminderLastTickAt;
  reminderLastTickAt = now;

  if (!unlocked.value || !reminderEnabled.value) return;
  if (reminderMode.value === "never") return;

  const today = todayKey();
  if (reminderCheckedOn === today) return;

  if (reminderMode.value === "daily") {
    // ⭐ 到点 = **提醒时间落在 (上次检查, 现在] 之间**，不是"现在过了提醒时间"。
    //    两者只差一件事：**那一刻软件在不在跑**。
    //    22:00 才打开软件时，"现在过了 21:00"成立，但"21:00 落在区间里"不成立
    //    ⇒ 那天作废、**不补提醒**（用户定的）。
    // ⚠️ 字符串比较就够：两边都是**定长**的 `HH:MM`（后端保证洗净成两位补零），
    //    定长字符串的字典序就是时间序。
    // ⚠️ 左边用 `<=` 而不是 `<`：`prev` 就是"上次检查的那一刻"，
    //    它**等于**提醒时间时说明"那一刻软件在跑、而且已经到点"，
    //    本来就不该排除。少了这一条，"启动时刻正好落在提醒时间那一分钟里"
    //    （比如 21:00:40 打开软件）会被判成"错过"，而用户明明刚打开软件。
    if (
      !(
        nowHHMM(prev) <= reminderTime.value &&
        reminderTime.value <= nowHHMM(now)
      )
    ) {
      return;
    }
    // 今天已经响过了。⚠️ 看的是**库里**那个标记，所以重启也认得 ——
    //    这正是"一天一次"能兑现的原因。
    if (reminderLastFired.value === today) return;
  }

  void isDateWritten(today)
    .then((written) => {
      // ⚠️ 无论写没写都记下"这一天看过了"：已经写过的那天也要停下来，
      //    否则这一整天每分钟都会白发一次 IPC。
      reminderCheckedOn = today;
      if (written) return;
      showReminder.value = true;
      // Rust 侧：把窗口叫到前台 ＋ 抢不到前台时闪任务栏。
      void presentReminder();
      if (reminderMode.value === "daily") {
        // ⭐ **真的提醒过之后**才记 —— 它是"一天一次"那个承诺的凭据。
        //    提前记下去会让当天**再也不响**，那比多响一次糟得多。
        reminderLastFired.value = today;
        // 写失败就算了：最坏结果是当天多响一次。
        void setReminderLastFired(today).catch(() => {});
      }
    })
    .catch(() => {
      // 读失败（库坏了之类）也记下：不该每分钟去撞一次坏掉的库。
      reminderCheckedOn = today;
    });
}

/**
 * 设置页改了「写作提醒」。
 *
 * ⚠️ 这里必须**重读一次全部设置**（不是只改这一个 ref）：
 *    「点击关闭时」显示的是后端**推导**出来的值（用户没设过时跟提醒走），
 *    只改本地这一个 ref 会让那一行停在旧值上 ——
 *    而那一行正是用户改完提醒之后接着要看的。
 */
function onReminderEnabled(on: boolean) {
  reminderEnabled.value = on;
  void loadSettings();
}

/** 设置页改了提醒策略（三档）。 */
function onReminderMode(m: ReminderMode) {
  reminderMode.value = m;
}

/** 设置页改了提醒时间（传过来的是后端洗净过的值）。 */
function onReminderTime(t: string) {
  reminderTime.value = t;
}

/** 设置页改了开机自启。 */
function onAutoStart(on: boolean) {
  autoStart.value = on;
}

/**
 * 设置页改了每日字数目标（【P2-12】）。传过来的是**后端洗净后的值**
 * （`-5` ⇒ `0`、`999999` ⇒ `100000`）。
 *
 * ⚠️ 设置页那个输入框会自己回填洗净值，但**真值源是这里的 ref** ——
 *    编辑器底部那一句吃的就是它，两边因此不会各说各话。
 */
function onDailyWordGoal(n: number) {
  dailyWordGoal.value = n;
}

/**
 * 改完提醒设置立刻生效：重看一眼（不用重启软件）。
 * ⚠️ 幂等 —— `reminderCheckedOn` 会挡住当天已经判断过的情况。
 */
watch([reminderEnabled, reminderMode, reminderTime], () => tickReminder());

/** 横幅上的「去写」：切到写日记屏、日期定在今天，并收起横幅。 */
function goWriteFromReminder() {
  mode.value = "write";
  selected.value = todayKey();
  showReminder.value = false;
}

/** 横幅上的「×」：只收起横幅。**今天不会再响**（`reminderLastFired` 已置位）。 */
function dismissReminder() {
  showReminder.value = false;
}

// ---------------------------------------------------------------------------
// 退出前的落库（【P2-21】）
// ---------------------------------------------------------------------------

/**
 * 后端发来"要退出了"：点 ✕ 走的是"直接退出"、或者托盘菜单里点了「退出」。
 *
 * ⚠️ **顺序不能反**：正文是 1000ms 防抖保存的，点 ✕ 那一瞬间最后打的字
 *    可能还没落库 —— 必须先 `flushNow()` 把它写下去，再真退。
 *    （与 `doLock` / `doRestore` 是同一个病根、同一条解法：
 *     凡是"界面要没了"的路径，都得先催编辑器一次，而且 `await` 住。）
 *
 * ⚠️ `flushNow()` 在**当前不是写日记页**时没有实例（编辑器已被卸载）：
 *    用 `?.` 兜住 —— 没实例就没有东西要 flush，直接退。
 *
 * ⚠️ 出错也得退：`flushNow()` 失败时不会往外抛（失败由 flush 自己写进
 *    `saveState`），而 `quitApp()` 万一失败，**绝不能卡在这里不退** ——
 *    "关不掉"比丢一行字严重得多。后端的 2 秒兜底会收掉进程，
 *    但那是兜底，不是设计。
 */
async function onQuitRequested() {
  await editorRef.value?.flushNow();
  try {
    await quitApp();
  } catch {
    // 什么都不做：等后端那 2 秒的兜底把进程收掉
  }
}

/**
 * 事件监听的注销句柄。
 *
 * ⚠️ 必须注销：`listen` 是**全局**监听，不注销的话热重载会叠出第二、第三份。
 */
let unlistenQuit: (() => void) | null = null;

onMounted(() => {
  void boot();
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  // 「退出前请先落库」这条事件的监听（【P2-21】）。
  // ⚠️ 这是本软件**第一处**用 Tauri 的"后端 → 前端"事件（此前全是前端调后端）。
  //    权限不用管：`core:default` 里已经含 `core:event:default`（监听权）。
  // ⚠️ `listen` 返回的是 Promise，且理论上可能失败 —— 失败不该让界面起不来，
  //    所以吞掉错误（真失败了还有后端的 2 秒兜底）。
  void listen("app-quit-requested", () => void onQuitRequested())
    .then((un) => {
      unlistenQuit = un;
    })
    .catch(() => {});
});
onUnmounted(() => {
  window.removeEventListener("blur", onBlur);
  window.removeEventListener("focus", onFocus);
  unlistenQuit?.();
  unlistenQuit = null;
});
</script>

<template>
  <div class="app">
    <!--
      遮蔽页（免密打开下的"假锁定"）。
      ⚠️ 必须放在最前、且**独立成一条判断** —— 不能插进下面那条
         v-if / v-else-if 链中间，那会打断链，导致 v-else-if 报错。
      它自己带 z-index，能盖住主界面与设置弹窗（见组件内说明）。
    -->
    <HiddenScreen v-if="hidden" @resume="resume" />

    <div v-if="booting" class="boot">正在启动…</div>

    <div v-else-if="fatal" class="boot error">
      <p>启动失败：{{ fatal }}</p>
      <button class="btn" @click="boot">重试</button>
    </div>

    <UnlockScreen
      v-else-if="status && !unlocked"
      :status="status"
      :auto-login-failed="autoLoginFailed"
      @unlocked="onUnlocked"
      @status="(s) => (status = s)"
      @restore="doRestore"
    />

    <template v-else-if="status">
      <header class="topbar">
        <!--
          日历栏开关（P2-22 沉浸式写日记）。

          ⚠️ 它是**窗口级**的开关，不是第五个页面 —— 所以放顶栏**最左**、
          和 .tabs 之间隔着 .brand（"日记"两个字）。⛔ 别挪进 .tabs、别紧贴它、
          ⛔ 更别在它和 tab 之间加分割线 —— 用户 2026-09-23 的原话是
          "和 tab 写在一行，有种功能错乱的感觉"，隔开才看得出性质不同。

          ⚠️ `v-if="mode === 'write'"`：搜索 / 年轮 / 筛选页**根本没有日历栏**，
          在那边摆一个图标点了没反应，只会让人困惑。

          ⭐ 图标**固定不变**、状态靠 `title` 说 —— 与 EditorPane 的 `.shot-toggle`
          同一套做法；做成"图标随状态变"会让人以为"这是个新按钮"。
          ⭐ 它是项目第一个内联 `svg`：Unicode 里找不到字形稳定的"侧栏/面板"
          （`◧` 换字体换字号就变形、对不齐），而 `stroke="currentColor"` 能跟随主题
          —— ⛔ 绝不给它写死色号（项目在这条上栽过两轮）。
        -->
        <button
          v-if="mode === 'write'"
          type="button"
          class="folder-toggle"
          :title="calendarCollapsed ? '展开左侧日历栏' : '收起左侧日历栏'"
          :aria-label="calendarCollapsed ? '展开左侧日历栏' : '收起左侧日历栏'"
          :aria-expanded="!calendarCollapsed"
          @click="toggleCalendar"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect
              x="1.25"
              y="1.75"
              width="13.5"
              height="12.5"
              rx="3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <line
              x1="5.6"
              y1="2"
              x2="5.6"
              y2="14"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
        </button>
        <div class="brand">日记</div>
        <nav class="tabs">
          <button :class="{ on: mode === 'write' }" @click="mode = 'write'">
            写日记
          </button>
          <button :class="{ on: mode === 'search' }" @click="mode = 'search'">
            搜索
          </button>
          <!--
            年轮（原「统计」）是**整屏视图**，与「搜索」同级：都是"看"，不是"改"。
            它不在设置弹窗里 —— 一个用来鼓励坚持的数字，不该埋在配置项里。
            ⚠️ 名字是用户 2026-09-23 定的（"树一年长一圈"）。改名只动这里两个字，
               不碰任何数据；用着不顺口随时换回来。
          -->
          <button :class="{ on: mode === 'stats' }" @click="mode = 'stats'">
            年轮
          </button>
          <!--
            筛选是**第四个整屏视图**（P2-7）—— 与「搜索」同族（都是"按条件捞"），
            区别是搜索吃一个查询词、它吃条件。
            ⚠️ 代价是顶栏又宽了一点 ⇒ 窗口拖到最窄（720px）时会挤，
            所以样式那边补了 `@media (max-width: 880px)` 把那行数字藏掉
            （"共 N 篇 · 连续 N 天"在年轮页里本来就有，一点信息都不丢）。
          -->
          <button :class="{ on: mode === 'filter' }" @click="mode = 'filter'">
            筛选
          </button>
        </nav>
        <div class="right">
          <!--
            连续天数的口径是"从最近一篇往前逐日相接"——**今天还没写也照常显示到
            最近写过的那天**（用户 2026-09-21 拍板，比"今天没写就归 0"友好）。
            顶栏太窄，放不下"截至 X月X日"，就写进悬停说明；
            完整标注在统计面板里（那边是数字的主场）。
          -->
          <span
            v-if="stats"
            class="stat"
            :title="`共 ${stats.total_entries} 篇 · 连续 ${stats.streak_days} 天（截至 ${stats.last_date ?? '—'}）。今天还没写也照常显示到那一天。`"
          >
            共 {{ stats.total_entries }} 篇 · 连续 {{ stats.streak_days }} 天
          </span>
          <button class="btn ghost" title="设置" @click="showSettings = true">
            设置
          </button>
          <button class="btn ghost" @click="doLock">锁定</button>
        </div>
      </header>

      <main class="body">
        <template v-if="mode === 'write'">
          <!--
            ⭐ **`v-show`，不是 `v-if`**：`v-if` 会**卸载**组件 ⇒ 你翻到的月份、
            打开的年月面板、已拉的标签列表全丢、展开瞬间还要重跑一遍 IPC（可能闪一下）。
            `v-show` 只是 `display: none`，组件仍在、状态全留、展开即原样。
            ✅ 这里用它是安全的：`CalendarPanel` 里**没有任何尺寸测量**
            （对照 `EditorPane`：它靠量 `scrollWidth` 判缩略图装不装得下，
             `display: none` 会让它量到 0 ⇒ 那边不能这么干。别照抄。）
            ⚠️ 代价只是一个 268px 的 DOM 常驻（它本来就在，可忽略）。
          -->
          <CalendarPanel
            v-show="!calendarCollapsed"
            :selected="selected"
            :refresh-token="refreshToken"
            :first-date="stats?.first_date ?? null"
            :last-date="stats?.last_date ?? null"
            @select="(d) => (selected = d)"
            @notice="flash"
          />
          <EditorPane
            ref="editorRef"
            :date="selected"
            :wide="calendarCollapsed"
            :tag-token="tagToken"
            :library-token="libraryToken"
            :auto-lock-entries="autoLockEntries"
            :triple-click-unlock="tripleClickUnlock"
            :daily-word-goal="dailyWordGoal"
            :dates="writtenDays"
            @saved="onSaved"
            @tags-changed="onTagsChanged"
            @notice="flash"
            @open="openOnThisDay"
            @goto-today="selected = todayKey()"
          />
        </template>
        <div v-else-if="mode === 'search'" class="search-wrap">
          <SearchPanel
            @open="
              (d) => {
                selected = d;
                mode = 'write';
              }
            "
          />
        </div>
        <div v-else-if="mode === 'filter'" class="filter-wrap">
          <!--
            筛选页（P2-7）。
            ⚠️ `@tags-changed` 是**从日历挪过来的**：标签改名 / 退役的入口这次
               也跟着搬到了本页，所以"改了标签 ⇒ 编辑器与各处跟着刷新"这条线
               必须接到这里（日历那边已经不带 `tagToken` 了）。
            ⚠️ 筛选条件**不住在这里** —— 它在组件内部，切走即清空（用户拍板"不留"）。
          -->
          <FilterPanel
            :tag-token="tagToken"
            @open="
              (d) => {
                selected = d;
                mode = 'write';
              }
            "
            @tags-changed="onTagsChanged"
            @notice="flash"
          />
        </div>
        <div v-else class="stats-wrap" :class="{ 'stats-wrap--tree': statsTab === 'tree' }">
          <!--
            热力图点格子 → 跳到那天写日记（与搜索结果的 @open 是同一套动作）。
            标签、回顾数据、写过的日期都走 **prop** —— 面板自己不发命令
            （见 StatsPanel.vue 文件头）。
            `tab` / `focusDate` 是 P2-23 的两条接线：页内小切换停在哪边，
            以及从写日记屏「去看看」跳过来时要高亮的那一年。
          -->
          <StatsPanel
            :stats="stats"
            :tags="tags"
            :recap="recap"
            :dates="writtenDays"
            :tab="statsTab"
            :focus-date="recapFocus"
            :tree-motion="treeMotion"
            @tab="(t) => (statsTab = t)"
            @open="
              (d) => {
                selected = d;
                mode = 'write';
              }
            "
          />
        </div>
      </main>

      <!--
        写作提醒横幅（【P2-13】）。
        ⚠️ 它与 toast **同区域但不是 toast**：toast 是 3 秒就走掉的操作反馈，
           而这一条要**一直挂到用户处理**（点「去写」或点「×」）。
        ⚠️ 它**不抢输入焦点** —— 用户可能正在打字，抢走光标很讨厌
           （所以这里不 autofocus、也不主动 focus 任何元素）。
      -->
      <div v-if="showReminder" class="reminder-bar">
        <span>今天还没写日记</span>
        <button class="go" @click="goWriteFromReminder">去写</button>
        <button class="drop" title="今天不再提醒" @click="dismissReminder">×</button>
      </div>

      <div v-if="toast" class="toast">{{ toast }}</div>

      <!--
        设置：可以改的东西都在这儿。
        状态一律从 App.vue 传进去 —— 它自己不再拉一次 status，
        免得出现"弹窗里的状态和顶栏各说各话"。
        （统计不再往里传：它已挪去顶栏第三个 tab，见 StatsPanel。）
      -->
      <SettingsPanel
        v-if="showSettings"
        :status="status"
        :backup="backup"
        :crypto="crypto"
        :auto-lock-secs="autoLockSecs"
        :auto-lock-entries="autoLockEntries"
        :triple-click-unlock="tripleClickUnlock"
        :reminder-enabled="reminderEnabled"
        :reminder-mode="reminderMode"
        :reminder-time="reminderTime"
        :auto-start="autoStart"
        :daily-word-goal="dailyWordGoal"
        :tree-motion="treeMotion"
        @close="showSettings = false"
        @backup="doBackup"
        @integrity="doIntegrity"
        @toggle-auto-backup="toggleAutoBackup"
        @auto-lock-secs="(s) => (autoLockSecs = s)"
        @auto-lock-entries="(on) => (autoLockEntries = on)"
        @triple-click-unlock="(on) => (tripleClickUnlock = on)"
        @reminder-enabled="onReminderEnabled"
        @reminder-mode="onReminderMode"
        @reminder-time="onReminderTime"
        @auto-start="onAutoStart"
        @daily-word-goal="onDailyWordGoal"
        @tree-motion="onTreeMotion"
        @password-changed="onPasswordChanged"
        @auto-login-changed="onAutoLoginChanged"
        @refresh-status="refreshStatus"
        @restore="doRestore"
        @notice="flash"
      />
    </template>

    <!--
      恢复备份的二次确认弹窗（P2-5）。
      ⚠️ 必须挂在**最外层、独立成一条判断**：它的两个入口分别在「设置弹窗」
         与「解锁页」里，而那两处属于不同的 v-if 分支 —— 塞进任何一条分支，
         另一个场景就永远弹不出来。
      ⚠️ 也不能插进上面那条 v-if / v-else-if 链的中间（会打断链，让后面的
         v-else-if 报错），所以放在链外、放最末尾。
      ⚠️ `will-keep-pre-restore` 直接取 `status.unlocked`：它与后端
         `restore_core` 里"有没有已解锁连接、因而有没有东西可保"是同一个判断。
    -->
    <RestoreDialog
      v-if="restoreOpen && status"
      :db-path="restorePath"
      :pre-restore-dir="status.pre_restore_dir"
      :will-keep-pre-restore="status.unlocked"
      @close="restoreOpen = false"
      @done="onRestoreDone"
    />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.boot {
  margin: auto;
  font-size: 14px;
  color: var(--text-3);
}
.boot.error {
  color: var(--danger);
  text-align: center;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 20px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}
/* 折叠日历栏的图标按钮（P2-22）：纯图标、固定 30×30
   —— 尺寸恒定，顶栏不会因为悬停而抖；颜色全走变量（图标用 currentColor）。 */
.folder-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.folder-toggle:hover {
  background: var(--hover);
  color: var(--text-1);
}
.brand {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}
.tabs {
  display: flex;
  gap: 4px;
}
.tabs button {
  padding: 6px 14px;
  font-size: 13px;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
}
.tabs button:hover {
  background: var(--hover);
}
.tabs button.on {
  color: var(--text-1);
  background: var(--hover);
  font-weight: 500;
}
.right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
.stat {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.btn {
  padding: 6px 13px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
}
.btn:hover {
  border-color: var(--accent);
}
.btn.ghost {
  background: transparent;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
/*
  搜索 / 年轮 / 筛选都是"整屏视图"，共用同一套留白与滚动。
  宽度各不相同：搜索最窄（一行查询词），年轮图表次之，筛选是三行药丸 ＋ 结果列表。
*/
.search-wrap,
.stats-wrap,
.filter-wrap {
  flex: 1;
  min-width: 0;
  padding: 20px 24px;
  overflow-y: auto;
}
.search-wrap {
  max-width: 720px;
}
.stats-wrap {
  max-width: 820px;
}

/*
  树语那一栏（2026-09-30 用户拍板：「撑满，而且全屏的时候也要等比例放大」）。

  ⚠️ 只在**停在「树语」这一栏**时生效 —— 刻度 / 旧影 两栏的版式**一个像素都不动**。
     `.stats-wrap--tree` 这个类由 `statsTab` 驱动（见模板），不是无条件松开的。

  三条改动各自解决一件事：
  · `max-width: none` —— 820px 是给图表用的；树需要整个宽度，否则会被压成一条横条；
  · `overflow: hidden` —— 撑满的 3D 场景**不该出现页面滚动条**（拖一下滚轮画面不动，
    很容易被当成坏了）；
  · 变成 flex 列容器 —— 好让里面那块画布 `flex: 1` 吃掉剩下的高度，
    这正是"全屏时跟着放大"的链条起点（往下依次是 `.stats--tree` → `.tree-slot`）。
*/
.stats-wrap--tree {
  max-width: none;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.filter-wrap {
  max-width: 760px;
}

/*
  窄屏退让（P2-7）。
  顶栏现在装着：日记 ＋ **四个** tab ＋「共 N 篇 · 连续 N 天」＋ 设置 ＋ 锁定。
  窗口最窄是 720px（`tauri.conf.json` 的 `minWidth`）⇒ 到 880px 就把那行数字收起来，
  保证顶栏**不换行、不溢出、按钮都点得到**。
  ⚠️ 那行数字在年轮页里本来就有 ⇒ **一点信息都不丢**。
  ✅ **这条只做一次**（P2-7 落地）：P2-22（折叠日历）也要占顶栏，它**只复查、没再加一份**
     —— 加两份会出现"一处生效、一处不生效"。实测 720px 下顶栏不溢出、不换行。
*/
@media (max-width: 880px) {
  .topbar {
    gap: 12px;
    padding: 0 14px;
  }
  .stat {
    display: none;
  }
}
/*
 * 写作提醒横幅（【P2-13】）。
 * ⚠️ 独立于 .toast（理由见模板那段注释）：toast 会自己消失，这条不会。
 */
.reminder-bar {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 18px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 9px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
  max-width: 86vw;
  /* 比弹窗的遮罩高：提醒要被看见。
     ⚠️ 但**低于**遮蔽页（HiddenScreen 自己带更高的层级）—— 那是"人不在"
        的状态，不该被一条提醒盖在上面。 */
  z-index: 50;
}
.reminder-bar .go {
  padding: 4px 11px;
  font-size: 12px;
  color: var(--bg);
  background: var(--accent);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.reminder-bar .drop {
  padding: 2px 6px;
  font-size: 14px;
  line-height: 1;
  color: var(--text-3);
  background: transparent;
  border: none;
  cursor: pointer;
}
.reminder-bar .drop:hover {
  color: var(--text-1);
}

.toast {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 18px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 9px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.1);
  max-width: 80vw;
  word-break: break-all;
}
</style>
