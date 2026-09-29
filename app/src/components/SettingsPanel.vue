<script setup lang="ts">
/**
 * 设置面板 —— 集中放"可以改的东西"。
 *
 * 与「关于」的分界线只有一条：**能改的进设置，只能看的留关于**。
 * 只读信息（版本、数据目录、加密参数）在【关于】分类里，
 * 这里是全应用**唯一**的只读出口（顶栏那个「关于」入口已经删掉了）。
 *
 * ⚠️ 原来【关于】里那行"统计"已撤（2026-09-21）：统计挪去了**顶栏第三个 tab**
 *    （`StatsPanel.vue`）。同一个信息只放一处 —— 留在【关于】里就成了第三个出处。
 *
 * 已接线的项：
 *   - 数据与备份 三项 —— 逻辑留在 App.vue，这里只发信号
 *   - **导出**（指令 7 的 Markdown ＋【P2-8】的网页）—— 报表式的项，自己调后端拿结果，见下面 doExport
 *   - **自动锁定时长**（指令 11）—— 见下面 onChangeAutoLock 的说明
 *   - **离开日记时自动锁定**（指令 14）—— 见下面 onToggleAutoLockEntries 的说明
 *   - **三击左键快速解锁**（指令 15）—— 见下面 onToggleTripleClickUnlock 的说明
 *   - **修改主密码**（指令 3）—— 见下面 submitChangePin 的说明
 *   - **免密打开**（指令 4）—— 见下面 openAutoLogin / submitAutoLogin 的说明
 * 到此【安全】分类里**没有占位项了**，全部接线完毕。
 *
 * ⚠️ 【外观】分类已撤销（2026-09-20）：它当初只为装"窗口模式"而建，
 * 而窗口模式（指令 12）连同【全屏】档一起被用户否掉了 —— 他不需要沉浸式，
 * 保留"窗口 / 最大化"两档也没有意义（系统标题栏本来就有那两个按钮）。
 * 唯一的项没了，分类就成了空壳，点进去什么都没有 = 界面骗人，故整组删除。
 * 将来真要做主题切换，再按需要重建这个分类。
 *
 * 组件不自己拉状态：status / backup / crypto / stats / autoLockSecs /
 * autoLockEntries / tripleClickUnlock 全部从 App.vue 传入，免得两份状态
 * 各走各的、切个分类就对不上。
 * 例外只有一处：改密码成功后由 App.vue 用返回的新状态覆盖（见 password-changed）。
 */
import { computed, nextTick, onMounted, ref } from "vue";
import pkg from "../../package.json";
import {
  AUTO_LOCK_OPTIONS,
  CLOSE_ACTION_OPTIONS,
  EXPORT_FORMAT_OPTIONS,
  MAX_DAILY_WORD_GOAL,
  REMINDER_MODE_OPTIONS,
  changePassword,
  copyBackupsTo,
  disableAutoLogin,
  enableAutoLogin,
  exportHtml,
  exportMarkdown,
  getCloseAction,
  pruneOrphanAttachments,
  revealDir,
  setAutoLockEntries,
  setAutoLockSecs,
  setAutoStart,
  setCloseAction,
  setDailyWordGoal,
  setReminderEnabled,
  setReminderMode,
  setReminderTime,
  setTripleClickUnlock,
  toAppError,
  type AppStatus,
  type BackupStatus,
  type ChangePasswordResult,
  type CloseAction,
  type CopyBackupsResult,
  type CryptoInfo,
  type ExportFormat,
  type ExportResult,
  type PruneReport,
  type ReminderMode,
} from "../api";
import { humanBytes } from "../utils/date";

const props = defineProps<{
  status: AppStatus;
  backup: BackupStatus | null;
  crypto: CryptoInfo | null;
  /** 自动锁定时长（秒）。0 = 永不。由 App.vue 持有，是唯一真值源。 */
  autoLockSecs: number;
  /**
   * 离开日记时是否自动把单篇日记锁上（指令 14）。
   * 同样由 App.vue 持有 —— 它还要传给 EditorPane，不能有两份。
   */
  autoLockEntries: boolean;
  /**
   * 日记锁定时，在正文里连点三下左键是否可以直接解锁（指令 15）。
   * 同样由 App.vue 持有 —— 它还要传给 EditorPane，不能有两份。
   */
  tripleClickUnlock: boolean;
  /**
   * 写作提醒是否开启（【P2-13】）。由 App.vue 持有 ——
   * 它还要跑那个每分钟看一眼的定时器、还要决定挂不挂横幅。
   */
  reminderEnabled: boolean;
  /**
   * 提醒的重复策略（【P2-13】）。真值源同样在 App.vue ——
   * 定时器每 tick 都要看它，放两份必然对不上。
   */
  reminderMode: ReminderMode;
  /** 提醒时间，`"HH:MM"`（后端的洗净值）。 */
  reminderTime: string;
  /** 开机自启（【P2-13】）。由 App.vue 持有（它负责解锁后校正注册表路径）。 */
  autoStart: boolean;
  /**
   * 每日字数目标（【P2-12】）。`0` ＝ **不用这个功能**。
   *
   * ⚠️ 真值源在 App.vue —— 它还要把同一个值传给 `EditorPane`
   *    （编辑器底部那一句吃的就是它），放两份必然对不上。
   */
  dailyWordGoal: number;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  /** 立即备份：逻辑留在 App.vue，这里只发信号。 */
  (e: "backup"): void;
  /** 检查索引一致性。 */
  (e: "integrity"): void;
  /** 切换自动备份开关。 */
  (e: "toggle-auto-backup"): void;
  /** 自动锁定时长已成功写入后端，通知 App.vue 更新本地值。 */
  (e: "auto-lock-secs", secs: number): void;
  /** 「离开日记时自动锁定」已成功写入后端，通知 App.vue 更新本地值。 */
  (e: "auto-lock-entries", on: boolean): void;
  /** 「三击左键快速解锁」已成功写入后端，通知 App.vue 更新本地值。 */
  (e: "triple-click-unlock", on: boolean): void;
  /** 主密码已更换。带上后端返回的最新状态与收尾警告，由 App.vue 落库。 */
  (e: "password-changed", res: ChangePasswordResult): void;
  /**
   * 免密开关变了。带上后端返回的最新状态 ——
   * App.vue 必须**整体替换**（不是只改 auto_login 一个字段）：
   * 开关失败会改变剩余尝试次数，甚至把库置入锁定期。
   */
  (e: "auto-login-changed", status: AppStatus): void;
  /** 请 App.vue 重新拉一次 status（改密码失败会改变剩余尝试次数 / 锁定状态）。 */
  (e: "refresh-status"): void;
  /**
   * 请求"从这份备份恢复"（P2-5）。
   *
   * 只发信号、不自己做，理由和「立即备份」一样，而且这里还要多两件事：
   *   ① 恢复前必须 `flushNow()` 把编辑器里没保存的正文落库；
   *   ② 恢复后必须**重取全部派生数据**（统计 / 标签 / 写过的日期）。
   * 这两件都住在 `App.vue`，设置页拿不到编辑器句柄。
   */
  (e: "restore", dbPath: string): void;
  /** 「写作提醒」开关已成功写入后端，通知 App.vue 更新本地值（【P2-13】）。 */
  (e: "reminder-enabled", on: boolean): void;
  /**
   * 提醒时间已成功写入后端。带的是**后端洗净后的值** ——
   * 它可能和用户填的不一样（`"9:5"` ⇒ `"09:05"`），App.vue 要拿它当新真值。
   */
  (e: "reminder-time", time: string): void;
  /** 提醒策略已成功写入后端（【P2-13】）。 */
  (e: "reminder-mode", mode: ReminderMode): void;
  /** 「开机自启」已成功写入后端（【P2-13】）。 */
  (e: "auto-start", on: boolean): void;
  /**
   * 每日字数目标已成功写入后端（【P2-12】）。
   * 带的是**后端洗净后的值**（`-5` ⇒ `0`、`999999` ⇒ `100000`）——
   * 它可能和用户填的不一样，App.vue 要拿它当新真值。
   */
  (e: "daily-word-goal", goal: number): void;
  /** 一句提示，由 App.vue 的 toast 显示。 */
  (e: "notice", message: string): void;
}>();

type TabKey = "security" | "data" | "general" | "about";

const TABS: { key: TabKey; label: string }[] = [
  { key: "security", label: "安全" },
  { key: "data", label: "数据与备份" },
  // 【通用】（【P2-21】新增，原名「习惯」）：回答的是"让写日记这件事
  // **自己发生**"那一族 —— 关闭行为（关掉窗口还留在托盘）、提醒、字数目标、
  // 开机自启都住这里。
  // ⚠️ 本件只放**一项**（点击关闭时）；【P2-13】再往里加提醒 / 开机自启，
  //    【P2-12】加每日字数目标 —— 栏名要换只动这一个字符串。
  { key: "general", label: "通用" },
  { key: "about", label: "关于" },
];

const tab = ref<TabKey>("security");

// ---------------------------------------------------------------------------
// 点击关闭时（【P2-21】）
// ---------------------------------------------------------------------------

/**
 * 点窗口 `✕` 时做什么。
 *
 * ⚠️ 这一项**不住 `App.vue`**（与上面三个开关不同）：它只在这一屏显示与修改，
 *    别处谁都不用 —— 真按 `✕` 时干什么由**后端**读库决定
 *    （`lib.rs` 的 `on_window_event` → `commands::close_action_now`），
 *    整个过程不经前端。所以这里自己调 `api/` 拿值、自己写。
 *
 * ⚠️ 初值给 `"quit"`：读到之前显示「直接退出」。
 *    兜底方向必须与后端一致 —— 后端在"读不到设置"时也是按直接退出处理
 *    （宁可关得掉，也不能出现"点了 ✕ 什么都没发生"）。
 */
const closeAction = ref<CloseAction>("quit");

/**
 * 拉一次**生效值**。
 *
 * ⚠️ 读的是 `getCloseAction()`，不是 `getSettings().close_action`：
 *    前者已经叠上"这台机器有没有托盘可用"，后者只是库里的选择。
 *    显示库里的值会出现"设置里写着最小化到托盘、点 ✕ 却直接退了"这种
 *    用户永远查不明白的不一致。
 */
async function loadCloseAction() {
  try {
    closeAction.value = await getCloseAction();
  } catch {
    // 读不到就保持初值（`"quit"`），**不弹提示** ——
    // 这是打开设置页时的背景动作，用户没做错什么。
  }
}

onMounted(() => {
  void loadCloseAction();
});

/**
 * 切换「点击关闭时」。
 * 与 `onChangeAutoLock` 同一套路：自己调后端、失败时把界面拨回原值。
 *
 * ⚠️ 成功后**必须重读一次生效值**，不能把用户刚选的那个直接当成新值：
 *    托盘在这台机器上建不起来时后端仍然返回 `"quit"` ——
 *    直接把 `"tray"` 显示出来就成了"设置骗人"。
 * ⚠️ 重读回来的值若与用户选的不同，还要**手动把 `<select>` 拨回去**：
 *    DOM 里用户已经拨到新项了，而这个 ref 的值可能压根没变
 *    （比如本来就存着 `"quit"`），Vue 认为绑定值没变化、不会重渲染该属性。
 */
async function onChangeCloseAction(e: Event) {
  const el = e.target as HTMLSelectElement;
  const next = el.value as CloseAction;
  if (next === closeAction.value) return;
  try {
    await setCloseAction(next);
    closeAction.value = await getCloseAction();
    if (el.value !== closeAction.value) {
      el.value = closeAction.value;
      // 说清为什么没生效，别让用户以为是自己点错了。
      emit(
        "notice",
        "这台机器上没有可用的托盘图标 ——「点击关闭时」会按「直接退出」执行（否则关掉窗口就回不来了）。",
      );
    }
  } catch (err) {
    el.value = closeAction.value; // 回滚，不留假状态
    emit("notice", toAppError(err).message);
  }
}

// ---------------------------------------------------------------------------
// 展示用的格式化
// ---------------------------------------------------------------------------

/** 把"距下次备份"的秒数变成人话。 */
function humanInterval(secs: number): string {
  if (secs <= 0) return "即将执行";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} 天后`;
  if (h > 0) return `${h} 小时后`;
  return `${Math.max(m, 1)} 分钟后`;
}

/** 锁定秒数 → 人话。 */
function humanLockout(secs: number): string {
  if (secs <= 0) return "不锁定";
  if (secs % 60 === 0) return `${secs / 60} 分钟`;
  return `${secs} 秒`;
}

/**
 * "连续输错 5 次锁定 10 分钟"。
 * 数据直接取自 AppStatus 的 max_attempts / lockout_secs，
 * 不为它单独开后端接口 —— 这两个值本来就是解锁页在用的同一份。
 */
const attemptText = computed(
  () =>
    `连续输错 ${props.status.max_attempts} 次锁定 ${humanLockout(props.status.lockout_secs)}`
);

// ---------------------------------------------------------------------------
// 自动锁定时长（指令 11，已接线）
// ---------------------------------------------------------------------------

/**
 * 切换自动锁定时长。
 *
 * 为什么这一项**自己调后端**，而备份三项是 emit 给 App.vue：
 *   "写入失败要把下拉恢复成原值"需要拿到调用结果，而 emit 是单向的 ——
 *   父组件没法把失败回传给这里。所以这一项由组件直接调 api/，
 *   成功后 emit 新值让 App.vue 更新 ref（ref 仍然唯一真值源）。
 *
 * ⚠️ 失败时必须**手动**把 <select> 拨回去：
 *    DOM 里用户已经选中了新项，而 props 没变，Vue 认为"绑定的值没变化"、
 *    不会重渲染这个属性 —— 下拉会停在一个并未生效的值上。
 */
async function onChangeAutoLock(e: Event) {
  const el = e.target as HTMLSelectElement;
  const next = Number(el.value);
  if (next === props.autoLockSecs) return;
  try {
    await setAutoLockSecs(next);
    emit("auto-lock-secs", next);
  } catch (err) {
    el.value = String(props.autoLockSecs); // 回滚，不留假状态
    emit("notice", toAppError(err).message);
  }
}

/**
 * 切换「离开日记时自动锁定」（指令 14）。
 * 逻辑与 onChangeAutoLock 同一套路：自己调后端、成功后 emit 新值让
 * App.vue 更新 ref（ref 仍是唯一真值源）、失败时把界面拨回原值。
 *
 * ⚠️ 失败回滚这里**必须手动**写：DOM 里用户已经把勾拨过去了，
 *    而 props 没变 —— Vue 认为"绑定的值没变化"，不会重渲染这个属性。
 *    与上面 <select> 是同一类坑，只是控件不同。
 *
 * ⚠️ 不改动页面上任何已锁的日记：这个开关只管"以后要不要自动锁"。
 */
async function onToggleAutoLockEntries(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = el.checked;
  if (next === props.autoLockEntries) return;
  try {
    await setAutoLockEntries(next);
    emit("auto-lock-entries", next);
  } catch (err) {
    el.checked = props.autoLockEntries; // 回滚，不留假状态
    emit("notice", toAppError(err).message);
  }
}

/**
 * 切换「三击左键快速解锁」（指令 15）。
 * 与上一条**完全同一套路**：自己调后端、成功后 emit 新值让 App.vue
 * 更新 ref（ref 仍是唯一真值源）、失败时把勾拨回原值。
 *
 * ⚠️ 同样"不改动页面上任何已锁的日记"：它只是关掉一个手势。
 */
async function onToggleTripleClickUnlock(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = el.checked;
  if (next === props.tripleClickUnlock) return;
  try {
    await setTripleClickUnlock(next);
    emit("triple-click-unlock", next);
  } catch (err) {
    el.checked = props.tripleClickUnlock; // 回滚，不留假状态
    emit("notice", toAppError(err).message);
  }
}

// ---------------------------------------------------------------------------
// 写作提醒与开机自启（【P2-13】）
// ---------------------------------------------------------------------------

/**
 * 切换「写作提醒」。
 * 与上面三个开关**完全同一套路**：自己调后端、成功后 emit 新值让 App.vue
 * 更新 ref（ref 仍是唯一真值源）、失败时把勾拨回原值。
 *
 * ⚠️ App.vue 收到之后会**重读一次设置**（不是只改这一个 ref）：
 *    打开/关掉提醒会改变「点击关闭时」的**显示值**（没设过时跟提醒走），
 *    而那个值由后端推导 —— 只改本地这一个 ref 会让那一行停在旧值上。
 *
 * ⚠️ 光靠 App.vue 重读**还不够**：上面那一行「点击关闭时」的值存在本组件
 *    自己的 `closeAction` ref 里（它走 `getCloseAction()`，要叠上"这台机器
 *    有没有托盘可用"，与 App.vue 那份不是同一个东西），而它只在 `onMounted`
 *    读过一次 ⇒ 弹窗开着的时候勾提醒，那一行会停在旧值上，
 *    用户看到的是"设置自己会骗人"。 ⇒ 这里必须自己再读一次。
 */
async function onToggleReminder(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = el.checked;
  if (next === props.reminderEnabled) return;
  try {
    await setReminderEnabled(next);
    emit("reminder-enabled", next);
    await loadCloseAction();
  } catch (err) {
    el.checked = props.reminderEnabled; // 回滚，不留假状态
    emit("notice", toAppError(err).message);
  }
}

/** 切换提醒策略（三档）。与上面的 `<select>` 同一套路 + 失败回滚。 */
async function onChangeReminderMode(e: Event) {
  const el = e.target as HTMLSelectElement;
  const next = el.value as ReminderMode;
  if (next === props.reminderMode) return;
  try {
    await setReminderMode(next);
    emit("reminder-mode", next);
  } catch (err) {
    el.value = props.reminderMode; // 回滚，不留假状态
    emit("notice", toAppError(err).message);
  }
}

/**
 * 改提醒时间。
 *
 * ⚠️ **必须拿后端返回的值回填那个输入框**（`setReminderTime` 返回洗净值）：
 *    它是 `<input type="time">`，但**不保证**交给我们的就一定是 `HH:MM`
 *    （给不给秒随 WebView2 版本变）。后端洗完这里要照它显示 ——
 *    否则用户看到的和真正存下去的不是同一个值。
 * ⚠️ 这一项**不报错**（任何输入都能得出一个合法结果），所以这里没有
 *    "失败回滚"，只有"把界面拨到后端说的那个值"。
 */
async function onChangeReminderTime(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = el.value;
  if (!next || next === props.reminderTime) return;
  try {
    const clean = await setReminderTime(next);
    el.value = clean; // 把界面拨到后端那句话上
    emit("reminder-time", clean);
  } catch (err) {
    el.value = props.reminderTime; // 回滚，不留假状态
    emit("notice", toAppError(err).message);
  }
}

/**
 * 切换「开机自启」。
 *
 * ⚠️ 这一项失败时**必须把原因说出来**（其余开关失败也只是回滚 + toast，
 *    同一条路）：它要**动注册表**，而失败原因（权限、组策略锁住注册表）
 *    不是用户自己能猜到的，光把勾拨回去他会以为是点坏了。
 */
async function onToggleAutoStart(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = el.checked;
  if (next === props.autoStart) return;
  try {
    await setAutoStart(next);
    emit("auto-start", next);
  } catch (err) {
    el.checked = props.autoStart; // 回滚，不留假状态
    emit("notice", toAppError(err).message);
  }
}

// ---------------------------------------------------------------------------
// 每日字数目标（【P2-12】）
// ---------------------------------------------------------------------------

/**
 * 改「每日字数目标」。
 *
 * ⚠️ 必须拿后端返回的值**回填那个框**（与 `onChangeReminderTime` 同一理由）：
 *    这一项**不报错**（留空 / 负数 / 原文 / 超上限都能得出一个合法结果），
 *    只会被修正。不回填的话，用户看到的和真正存下去的就不是同一个数。
 * ⚠️ **留空是合法输入**（＝ 不用这个功能）⇒ ⛔ 不能像别的字段那样
 *    在 `!next` 时直接 `return` —— 那样用户清空之后目标还挂在编辑器底部。
 * ⚠️ 回填时 `0` 要显示成**空框**，⛔ 不是显示一个 `0`：
 *    `0` 在这里的意思是"不用"，写个 `0` 会让人以为"目标是 0 个字"。
 */
async function onChangeDailyWordGoal(e: Event) {
  const el = e.target as HTMLInputElement;
  const raw = el.value;
  // 本来就是"不用"、这次也是空 ⇒ 没有什么可写的（免得白撞一次 IPC）。
  if (!raw.trim() && props.dailyWordGoal === 0) return;
  try {
    const clean = await setDailyWordGoal(raw);
    el.value = clean > 0 ? String(clean) : ""; // 把界面拨到后端那句话上
    emit("daily-word-goal", clean);
  } catch (err) {
    el.value = props.dailyWordGoal > 0 ? String(props.dailyWordGoal) : ""; // 回滚
    emit("notice", toAppError(err).message);
  }
}

// ---------------------------------------------------------------------------
// 修改主密码（指令 3，已接线）
// ---------------------------------------------------------------------------

/**
 * 子表单是否展开。
 *
 * 为什么"就地展开"而不是再叠一层弹窗：设置页本身已经是模态遮罩了，
 * 再叠一层就要处理 z-index、Esc 该关哪一层、点外面算点哪一层 ——
 * 为一个三格表单付这些代价不值得。展开在「主密码」那一行下面，
 * 在哪儿点开就在哪儿填，视线不用跳。
 */
const changePinOpen = ref(false);
const pinBusy = ref(false);
const pinError = ref("");

const pinForm = ref({ old: "", next: "", confirm: "", hint: "" });
const oldPinInput = ref<HTMLInputElement | null>(null);

/**
 * 当前提示语。它是**明文**存在 lockout.json 里的（解锁前就要显示，
 * 放不进加密库），所以在设置页里显示它不会多泄漏什么 ——
 * 但它正是"改密码时必须顺手换掉"的那条信息，所以必须让人看得见。
 */
const currentHint = computed(() => props.status.hint ?? "未设置");

function openChangePin() {
  changePinOpen.value = true;
  pinError.value = "";
  // 展开后自动聚焦第一格：这是"就地展开"相对弹窗唯一丢掉的便利，补回来。
  void nextTick(() => oldPinInput.value?.focus());
}

function closeChangePin() {
  changePinOpen.value = false;
  pinBusy.value = false;
  pinError.value = "";
  // 连输入框里的明文密码一起清掉 —— 表单收起了，值不该还留在内存/界面上。
  pinForm.value = { old: "", next: "", confirm: "", hint: "" };
}

/**
 * 提交改密码。
 *
 * 这一项和自动锁定时长一样**自己调后端**，理由相同：要拿到结果才知道
 * 该收起表单还是留着让人改（emit 是单向的，父组件没法把失败回传）。
 * 但状态的唯一真值源仍是 App.vue —— 成功后把返回的 status 交给它。
 *
 * 前端这几条检查只是"省一次往返"：挡的都是**必然失败**的手误，
 * 每挡一次就省掉后端两次 KDF（约 1.6 秒）和一次可能触发锁定的失败计数。
 * 真正的规则（纯数字、长度、白名单）始终以后端为准，前端不重复实现。
 */
async function submitChangePin() {
  if (pinBusy.value) return;
  const { old, next, confirm, hint } = pinForm.value;

  if (!old) {
    pinError.value = "请输入当前密码";
    return;
  }
  if (!/^\d+$/.test(next)) {
    pinError.value = "新密码只能包含数字";
    return;
  }
  if (next.length < props.status.pin_min_len) {
    pinError.value = `新密码至少需要 ${props.status.pin_min_len} 位数字`;
    return;
  }
  if (next !== confirm) {
    pinError.value = "两次输入的新密码不一致";
    return;
  }

  pinBusy.value = true;
  pinError.value = "";
  try {
    const res = await changePassword(old, next, hint.trim() ? hint.trim() : null);
    // 成功：先收起表单（输入框里的明文密码一并清掉），再把结果交给 App.vue。
    closeChangePin();
    emit("password-changed", res);
  } catch (err) {
    const e = toAppError(err);
    // 后端的 message 已经是给用户看的人话（"密码不正确" / "已锁定，请在 N 秒后重试"…），
    // 不在前端重写一份 —— 两份文案迟早对不上。
    pinError.value = e.message;

    if (e.kind === "wrong_pin") {
      // 旧密码错了就把那一格清掉并聚焦：留着它只会让人再点一次"确认"。
      pinForm.value.old = "";
      void nextTick(() => oldPinInput.value?.focus());
      // 失败次数变了（可能已进入锁定期），让顶层状态跟上。
      emit("refresh-status");
    } else if (e.kind === "locked") {
      emit("refresh-status");
    }
  } finally {
    pinBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// 免密打开（指令 4，已接线）
// ---------------------------------------------------------------------------

/**
 * 当前是否已开启。真值源是 `status.auto_login` ——
 * 后端读的是**库外文件** `data/auto_login.json` 是否存在，
 * 所以未解锁时它也是准的（这正是启动流程能靠它决定走不走免密的原因）。
 */
const autoLoginOn = computed(() => props.status.auto_login);

/** 子表单是否展开。 */
const autoLoginOpen = ref(false);
/** 这次点开是要"开启"还是"关闭" —— 同一条子表单服务两个方向。 */
const autoLoginIntent = ref<"enable" | "disable">("enable");
const autoLoginBusy = ref(false);
const autoLoginError = ref("");
const autoLoginPin = ref("");
const autoLoginInput = ref<HTMLInputElement | null>(null);

/**
 * 点开关 → 展开子表单，**不是**立刻切换。
 *
 * 为什么不能"点一下就生效"：开启免密**必须验证密码**，否则任何人趁你
 * 屏幕还解锁着点两下，就把它变成了永久免密入口。关闭同样要密码 ——
 * 那不是防人，是**帮你确认自己还记得密码**，不然关掉之后下次启动
 * 就进不去了，而你会以为只是关了个开关。
 *
 * ⚠️ 开关用 `@click.prevent`：浏览器默认会在点击瞬间翻转勾选状态，
 *    而那一步还没经过密码验证。不阻止的话界面会先显示"已开启"、
 *    再被 props 拉回来 —— 中间那一瞬就是在骗人。
 */
function openAutoLogin() {
  autoLoginIntent.value = autoLoginOn.value ? "disable" : "enable";
  autoLoginOpen.value = true;
  autoLoginError.value = "";
  autoLoginPin.value = "";
  void nextTick(() => autoLoginInput.value?.focus());
}

function closeAutoLogin() {
  autoLoginOpen.value = false;
  autoLoginBusy.value = false;
  autoLoginError.value = "";
  // 明文密码不留内存、也不留在界面上
  autoLoginPin.value = "";
}

/**
 * 提交。成功后把后端返回的**整份状态**交给 App.vue 整体替换。
 *
 * 与自动锁定时长、改密码同一套路：这一项自己调后端（要拿到结果才知道
 * 该收起表单还是留着让人改，emit 是单向的），但状态的唯一真值源在 App.vue。
 */
async function submitAutoLogin() {
  if (autoLoginBusy.value) return;
  if (!autoLoginPin.value) {
    autoLoginError.value = "请输入当前密码";
    return;
  }

  const enabling = autoLoginIntent.value === "enable";
  autoLoginBusy.value = true;
  autoLoginError.value = "";
  try {
    const s = enabling
      ? await enableAutoLogin(autoLoginPin.value)
      : await disableAutoLogin(autoLoginPin.value);
    closeAutoLogin();
    emit("auto-login-changed", s);
    emit("notice", enabling ? "已开启免密打开" : "已关闭免密打开");
  } catch (err) {
    const e = toAppError(err);
    // 后端文案已经是人话（"密码不正确" / "已锁定，请在 N 秒后重试"），
    // 不在前端重写第二份 —— 两份文案迟早对不上。
    autoLoginError.value = e.message;

    if (e.kind === "wrong_pin") {
      autoLoginPin.value = "";
      void nextTick(() => autoLoginInput.value?.focus());
      emit("refresh-status");
    } else if (e.kind === "locked") {
      emit("refresh-status");
    }
  } finally {
    autoLoginBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// 导出（指令 7 的 Markdown ＋ 【P2-8】的网页，已接线）
// ---------------------------------------------------------------------------

/**
 * 目标目录。初值取后端给的默认值（数据目录同级的 `导出/`）。
 *
 * ⚠️ 原设计是弹系统目录选择器（`tauri-plugin-dialog`），但构建环境拉不到
 *    那个 crate（出网被拦），所以改成**路径输入框**：UI 少一点便利，
 *    功能一点不少，而且不多一个依赖。
 */
const exportDir = ref(props.status.export_default_dir);
const exportBusy = ref(false);
const exportError = ref("");
const exportDone = ref<ExportResult | null>(null);

/**
 * 上一次**实际导出**用的格式。
 *
 * ⚠️ 结果那行文案靠它，**不读当前的 select** —— 用户完全可能导完 Markdown
 *    之后把下拉拨到"网页"，那时这行若跟着拨，就是在骗人。
 */
const exportDoneFormat = ref<ExportFormat>("md");

/** localStorage 的键。只存"导出成哪种格式"这一个串，不含任何日记内容。 */
const EXPORT_FORMAT_KEY = "diary.export-format";

/**
 * 读上次选的导出格式。
 *
 * ⚠️ **兜底方向 ＝ Markdown** —— 只有精确的 `"html"` 才算网页，其它一切
 *    （`null` / 垃圾值 / 抛异常）都退回 Markdown（＝加上本件之前的行为）。
 *    ⛔ 别写成 `=== "md" ? … : "html"` 这类反向判断。
 */
function readExportFormat(): ExportFormat {
  try {
    return localStorage.getItem(EXPORT_FORMAT_KEY) === "html" ? "html" : "md";
  } catch {
    return "md"; // localStorage 被禁（配额满 / 隐私模式）⇒ 退回默认
  }
}

/**
 * 导出成哪种格式（【P2-8】）。
 *
 * ⚠️ 存 `localStorage` 而不是加密库：它是**界面偏好**（与"折叠日历栏"同一类），
 *    不是日记内容、也不需要加密；⛔ 进加密库要动后端四处，不值当。
 *    用户 2026-09-29 拍板"记住，存 localStorage"。
 */
const exportFormat = ref<ExportFormat>(readExportFormat());

/** 切换格式。⚠️ 写失败**不许打断选择**（界面照切，只是下次记不住）。 */
function onChangeExportFormat(e: Event) {
  exportFormat.value = (e.target as HTMLSelectElement).value === "html" ? "html" : "md";
  try {
    localStorage.setItem(EXPORT_FORMAT_KEY, exportFormat.value);
  } catch {
    /* 存不下就算了 —— 它只是个偏好 */
  }
}

/**
 * 导出全部日记。
 *
 * 与备份三项（emit 给 App.vue）不同，这一项**自己调后端**：得拿到
 * "导出了几篇""有没有重名"才知道显示什么，而 emit 是单向的、
 * 父组件没法把结果回传进来。与自动锁定时长同一个套路。
 *
 * 日记多时后端会跑几秒，所以期间按钮变文案为「正在导出…」并禁用 ——
 * 不这么做用户会以为点坏了，然后连点，然后又导一遍。
 *
 * ⚠️ 两种格式的**返回结构完全相同**（都是 `ExportResult`）⇒ 下面那段回填
 *    与结果文案不必分叉，只有"调哪条命令"这一个岔路口（【P2-8】）。
 */
async function doExport() {
  if (exportBusy.value) return;
  const dir = exportDir.value.trim();
  if (!dir) {
    exportError.value = "请先填一个导出目录";
    exportDone.value = null;
    return;
  }

  exportBusy.value = true;
  exportError.value = "";
  exportDone.value = null;
  try {
    const res =
      exportFormat.value === "html"
        ? await exportHtml(dir)
        : await exportMarkdown(dir);
    exportDone.value = res;
    exportDoneFormat.value = exportFormat.value;
    // 用后端**实际写入**的目录回填输入框：用户填的可能是相对路径或带 `..`，
    // 后端已把它归一化成绝对路径 —— 这样输入框和「打开文件夹」指向同一处。
    exportDir.value = res.dest_dir;
  } catch (err) {
    exportError.value = toAppError(err).message;
  } finally {
    exportBusy.value = false;
  }
}

/** 在文件管理器里打开刚导出的目录。失败只提示，不改写"导出成功"这个事实。 */
async function openExportDir() {
  if (!exportDone.value) return;
  try {
    await revealDir(exportDone.value.dest_dir);
  } catch (err) {
    emit("notice", toAppError(err).message);
  }
}

// ---------------------------------------------------------------------------
// 图片缓存（P1 #10）
// ---------------------------------------------------------------------------

const pruneBusy = ref(false);
const pruneError = ref("");
const pruneDone = ref<PruneReport | null>(null);

/**
 * 一句话说清清理结果。
 *
 * 没东西可清时也**必须**说出来 —— 否则用户不知道按钮到底起没起作用
 *（一个什么都不显示的按钮，跟坏了没区别）。
 */
const pruneSummary = computed(() => {
  const r = pruneDone.value;
  if (!r) return "";
  if (r.files_removed === 0 && r.rows_removed === 0) {
    return "没有需要清理的东西，图片缓存是干净的";
  }
  const parts: string[] = [];
  if (r.files_removed > 0) {
    parts.push(
      `删掉 ${r.files_removed} 个没人引用的图片文件，释放 ${humanBytes(
        r.bytes_freed
      )}`
    );
  }
  if (r.rows_removed > 0) {
    parts.push(`清掉 ${r.rows_removed} 条指向已丢失文件的记录`);
  }
  return parts.join("；");
});

/**
 * 打开图片缓存目录。
 *
 * 路径来自后端（`AppStatus.attachments_dir`），界面**只显示不改** ——
 * 附件必须和数据库待在同一个数据目录里，否则换台电脑库和图就对不上了。
 * 目录在启动时已经建好（见 lib.rs 的 setup），所以这里不会遇到"目录不存在"。
 */
async function openAttachmentsDir() {
  try {
    await revealDir(props.status.attachments_dir);
  } catch (err) {
    emit("notice", toAppError(err).message);
  }
}

/**
 * 清理图片缓存。
 *
 * ⚠️ 它会**真的删文件**，所以结果必须如实报出来（删了几个、释放多少空间）。
 *    只说一句"清理完成"，用户根本不知道刚才动了什么。
 */
async function doPrune() {
  if (pruneBusy.value) return;
  pruneBusy.value = true;
  pruneError.value = "";
  pruneDone.value = null;
  try {
    pruneDone.value = await pruneOrphanAttachments();
  } catch (err) {
    pruneError.value = toAppError(err).message;
  } finally {
    pruneBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// 备份恢复（P2-5）
// ---------------------------------------------------------------------------

/**
 * 「从备份恢复」的路径输入框。
 *
 * 为什么**留空**、而不是预填备份目录：预填一个**目录**会让人以为"点一下就恢复"，
 * 而这里要的是一个**具体文件**（`.db`）。留空 + 占位符写清要填什么，
 * 最不容易误点 —— 这是全应用唯一会覆盖整库的按钮。
 *
 * 与「导出全部日记」同一做法：只给文本框，**不引入系统文件选择器**
 *（本机拉不到那个 crate；顺带也让这一批零新依赖）。
 */
const restorePath = ref("");

/**
 * 「复制备份到…」的目标目录。
 *
 * ⚠️ 同样**留空**，而且刻意不给任何默认值：能想到的默认值（数据目录旁边）
 *    恰好是最不该推荐的那个 —— 复制到同一个盘上，硬盘一坏还是一起没。
 *    用户必须自己写一个**别的盘**。
 */
const copyDest = ref("");
const copyBusy = ref(false);
const copyError = ref("");
const copyDone = ref<CopyBackupsResult | null>(null);

/** 只把路径交给 App.vue —— 真正的流程（flushNow → 恢复 → 重取派生数据）住在那里。 */
function openRestore() {
  const p = restorePath.value.trim();
  if (!p) return;
  emit("restore", p);
}

/**
 * 把整个 `backups/` 复制到别的盘。
 *
 * ⚠️ 目标路径的合法性（存在、是目录、**不在数据目录内部**）全部由后端判 ——
 *    前端只负责把结果如实报出来，不自己猜"这个路径行不行"。
 */
async function doCopyBackups() {
  const dir = copyDest.value.trim();
  if (!dir || copyBusy.value) return;
  copyBusy.value = true;
  copyError.value = "";
  copyDone.value = null;
  try {
    copyDone.value = await copyBackupsTo(dir);
  } catch (err) {
    copyError.value = toAppError(err).message;
  } finally {
    copyBusy.value = false;
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <header class="head">
        <h2>设置</h2>
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </header>

      <div class="pane">
        <!-- 左栏：分类导航。固定宽度，不跟随右栏滚动。 -->
        <nav class="side">
          <button
            v-for="t in TABS"
            :key="t.key"
            :class="{ on: tab === t.key }"
            @click="tab = t.key"
          >
            {{ t.label }}
          </button>
        </nav>

        <!-- 右栏：当前分类的内容，超高可滚。 -->
        <div class="content">
          <!-- ── 安全 ─────────────────────────────────────────────── -->
          <section v-if="tab === 'security'">
            <div class="row">
              <div class="label">
                <div class="t">主密码</div>
                <div class="d">用于解锁日记，也用于打开备份文件</div>
              </div>
              <div class="ctl">
                <button v-if="!changePinOpen" class="btn" @click="openChangePin">
                  修改
                </button>
                <button v-else class="btn ghost" @click="closeChangePin">取消</button>
              </div>
            </div>

            <!-- 改密码子表单：就地展开，不叠第二层弹窗 -->
            <form v-if="changePinOpen" class="sub" @submit.prevent="submitChangePin">
              <div class="field">
                <label for="cp-old">当前密码</label>
                <input
                  id="cp-old"
                  ref="oldPinInput"
                  v-model="pinForm.old"
                  type="password"
                  inputmode="numeric"
                  autocomplete="off"
                  :disabled="pinBusy"
                />
              </div>

              <div class="field">
                <label for="cp-new">新密码</label>
                <input
                  id="cp-new"
                  v-model="pinForm.next"
                  type="password"
                  inputmode="numeric"
                  autocomplete="new-password"
                  :disabled="pinBusy"
                  :placeholder="`${status.pin_min_len} 位以上数字`"
                />
              </div>

              <div class="field">
                <label for="cp-confirm">确认新密码</label>
                <input
                  id="cp-confirm"
                  v-model="pinForm.confirm"
                  type="password"
                  inputmode="numeric"
                  autocomplete="new-password"
                  :disabled="pinBusy"
                />
              </div>

              <div class="field">
                <label for="cp-hint">新提示语（可留空）</label>
                <input
                  id="cp-hint"
                  v-model="pinForm.hint"
                  type="text"
                  maxlength="60"
                  :disabled="pinBusy"
                  :placeholder="`当前：${currentHint}`"
                />
                <p class="tip">
                  提示是<strong>明文</strong>存在数据目录里的 —— 它要在解锁之前
                  就显示在锁屏界面，所以放不进加密库。写得模糊一些，别写成密码本身。
                  留空 = 不要提示。
                </p>
              </div>

              <p v-if="pinError" class="err">{{ pinError }}</p>

              <p class="warn">
                ⚠️ 改完密码后，<strong>此前的备份仍需用旧密码打开</strong> ——
                重新加密只作用于主库，备份文件不会被改动（那正是备份的意义）。
                换完会自动备份一份<strong>新</strong>的，那一份用新密码。
              </p>

              <div class="actions">
                <button class="btn" type="submit" :disabled="pinBusy">
                  {{ pinBusy ? "更换中…" : "确认更换" }}
                </button>
                <button
                  class="btn ghost"
                  type="button"
                  :disabled="pinBusy"
                  @click="closeChangePin"
                >
                  取消
                </button>
              </div>
            </form>

            <div class="row">
              <div class="label">
                <div class="t">免密打开</div>
                <div class="d">
                  {{
                    autoLoginOn
                      ? "已开启：打开软件时跳过密码，直接进入"
                      : "打开软件时跳过密码，直接进入"
                  }}
                </div>
              </div>
              <div class="ctl">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="autoLoginOn"
                    @click.prevent="openAutoLogin"
                  />
                </label>
              </div>
            </div>

            <!--
              免密开关子表单：开、关都要密码，就地展开（与改密码同一手法）。
              ⚠️ 用 @click.prevent 而不是 v-model：见 openAutoLogin 的说明 ——
                 勾选状态必须等密码验证通过后才允许变化。
            -->
            <form v-if="autoLoginOpen" class="sub" @submit.prevent="submitAutoLogin">
              <p class="sub-lead">
                {{
                  autoLoginIntent === "enable"
                    ? "开启免密打开需要确认密码 —— 否则任何人趁你屏幕还解锁着点两下，就能把它变成永久免密入口。"
                    : "关闭同样要确认密码 —— 这不是防人，是帮你确认自己还记得密码，否则关掉之后下次启动就进不去了。"
                }}
              </p>

              <div class="field">
                <label for="al-pin">当前密码</label>
                <input
                  id="al-pin"
                  ref="autoLoginInput"
                  v-model="autoLoginPin"
                  type="password"
                  inputmode="numeric"
                  autocomplete="off"
                  :disabled="autoLoginBusy"
                />
              </div>

              <p v-if="autoLoginError" class="err">{{ autoLoginError }}</p>

              <!--
                开与关的说明分开写：两件事的风险不是一回事 ——
                开启要交代"钥匙明文躺在磁盘上"，关闭要交代"删文件不等于
                钥匙作废"。合成一句必然有一半是错的，而这两条都属于
                用户有权知道、且不说他就会误判自己数据安全程度的事。
              -->
              <p v-if="autoLoginIntent === 'enable'" class="warn">
                ⚠️ 开启后，库的钥匙会以<strong>明文</strong>保存在
                <code>data/auto_login.json</code> 里 —— 这是免密能生效的前提，
                不是漏了加密。它挡得住误点，挡不住能打开这台电脑的人；
                <strong>整个 data 目录被拷走 = 日记能被直接打开</strong>。
                要真正锁上，请关掉这个开关。
              </p>
              <p v-else class="warn">
                关掉之后，下次启动需要输入密码。
                ⚠️ 但<strong>钥匙只是不再被读取，不等于作废</strong> ——
                磁盘上可能仍有残留。要真正作废那把钥匙，必须
                <strong>更换主密码</strong>（那会用新密钥把整库重新加密）。
              </p>

              <div class="actions">
                <button class="btn" type="submit" :disabled="autoLoginBusy">
                  {{
                    autoLoginBusy
                      ? "处理中…"
                      : autoLoginIntent === "enable"
                        ? "确认开启"
                        : "确认关闭"
                  }}
                </button>
                <button
                  class="btn ghost"
                  type="button"
                  :disabled="autoLoginBusy"
                  @click="closeAutoLogin"
                >
                  取消
                </button>
              </div>
            </form>

            <div class="row">
              <div class="label">
                <div class="t">自动锁定时长</div>
                <div class="d">离开多久之后自动锁定</div>
              </div>
              <div class="ctl">
                <select
                  :value="String(autoLockSecs)"
                  @change="onChangeAutoLock"
                >
                  <option v-for="o in AUTO_LOCK_OPTIONS" :key="o.value" :value="o.value">
                    {{ o.label }}
                  </option>
                </select>
              </div>
            </div>

            <!--
              ⚠️ 这一行必须**紧挨着**上面那条"自动锁定时长"：
              两个开关都叫"自动锁定"，含义却完全不同 ——
              上面锁的是整个应用，这一条锁的是单篇日记。
              分开放，用户一定会以为是自己看错了。
            -->
            <div class="row">
              <div class="label">
                <div class="t">离开日记时自动锁定</div>
                <div class="d">
                  切到别的日子、或重开软件时，把写过的日记自动锁上，防止误删误改。关掉后可以随时回来接着写。
                </div>
              </div>
              <div class="ctl">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="autoLockEntries"
                    @change="onToggleAutoLockEntries"
                  />
                </label>
              </div>
            </div>

            <!--
              三击左键快速解锁（指令 15）。
              紧跟着上面两条"锁定"相关的项 —— 它们同属【安全】里
              "日记锁上之后怎么解开"这一族，放一起用户才好找。
              ⚠️ 这条**只管手势**：关掉它不会解锁任何已经锁上的日记。
            -->
            <div class="row">
              <div class="label">
                <div class="t">三击左键快速解锁</div>
                <div class="d">
                  日记锁定时，在正文里连续点三下左键即可解锁，手不用移到右上角。关掉后只能用 🔒 按钮解锁。
                </div>
              </div>
              <div class="ctl">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="tripleClickUnlock"
                    @change="onToggleTripleClickUnlock"
                  />
                </label>
              </div>
            </div>

            <div class="row">
              <div class="label">
                <div class="t">密码尝试与锁定期</div>
                <div class="d">{{ attemptText }}</div>
              </div>
            </div>
          </section>

          <!-- ── 数据与备份 ───────────────────────────────────────── -->
          <section v-else-if="tab === 'data'">
            <div class="row">
              <div class="label">
                <div class="t">每天自动备份</div>
                <div class="d">对日记来说，"忘了开备份"等于"没有备份"</div>
              </div>
              <div class="ctl">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="backup?.auto_enabled === true"
                    :disabled="!backup"
                    @change="emit('toggle-auto-backup')"
                  />
                </label>
              </div>
            </div>

            <div class="row">
              <div class="label">
                <div class="t">立即备份</div>
                <div class="d">现在导出一份加密副本</div>
              </div>
              <div class="ctl">
                <button class="btn" :disabled="!backup" @click="emit('backup')">
                  立即备份
                </button>
              </div>
            </div>

            <!--
              复制备份到…（P2-5 决定 ③）。
              补的是"备份和日记在**同一块硬盘**上"这个缺口 —— 那块盘坏了，
              备份跟着一起没。与上面「立即备份」是一对：
              那个是"再多留几份"，这个是"搬到别的盘去"。
            -->
            <div class="row stacked">
              <div class="label">
                <div class="t">复制备份到…</div>
                <div class="d">
                  把整个 backups 目录（含后悔药）搬到别的盘。原有文件一个都不会被覆盖
                </div>
              </div>
              <div class="ctl">
                <input
                  v-model="copyDest"
                  class="path-input"
                  type="text"
                  spellcheck="false"
                  placeholder="目标目录，例如 E:\日记备份"
                  :disabled="copyBusy"
                  @keyup.enter="doCopyBackups"
                />
                <button
                  class="btn"
                  :disabled="copyBusy || !copyDest.trim()"
                  @click="doCopyBackups"
                >
                  {{ copyBusy ? "正在复制…" : "复制" }}
                </button>
              </div>
            </div>

            <div v-if="copyError" class="row">
              <div class="label">
                <div class="t">复制失败</div>
                <div class="d">{{ copyError }}</div>
              </div>
            </div>

            <div v-else-if="copyDone" class="row">
              <div class="label">
                <div class="t">已复制 {{ copyDone.copied }} 个文件</div>
                <div class="d">
                  共 {{ humanBytes(copyDone.bytes) }}，写进
                  {{ copyDone.dest_dir }} 下的 backups 子目录；
                  目标里原有文件一个都没被覆盖
                </div>
              </div>
            </div>

            <!--
              导出全部日记（指令 7 ＋【P2-8】）。
              与上面「立即备份」正好是一对：备份是**密文**副本（防丢，还得用本软件打开），
              导出是**明文**（防被这个软件锁死）—— 而导出有两种格式，选哪个只看
              "给谁读"：Markdown 给别的编辑器，网页给浏览器双击。
            -->
            <div class="row stacked">
              <div class="label">
                <div class="t">导出全部日记</div>
                <div class="d">
                  导出成明文 —— Markdown 换台电脑、换个软件也读得出来；
                  网页则双击就能在浏览器里看，格式（粗体 / 高亮）也保留
                </div>
              </div>
              <div class="ctl export-ctl">
                <select
                  :value="exportFormat"
                  :disabled="exportBusy"
                  aria-label="导出格式"
                  @change="onChangeExportFormat"
                >
                  <option v-for="o in EXPORT_FORMAT_OPTIONS" :key="o.value" :value="o.value">
                    {{ o.label }}
                  </option>
                </select>
                <input
                  v-model="exportDir"
                  class="path-input"
                  type="text"
                  spellcheck="false"
                  placeholder="导出到哪个目录"
                  :disabled="exportBusy"
                  @keyup.enter="doExport"
                />
                <button
                  class="btn"
                  :disabled="exportBusy || !exportDir.trim()"
                  @click="doExport"
                >
                  {{ exportBusy ? "正在导出…" : "导出" }}
                </button>
              </div>
            </div>

            <div v-if="exportError" class="row">
              <div class="label">
                <div class="t">导出失败</div>
                <div class="d">{{ exportError }}</div>
              </div>
            </div>

            <div v-else-if="exportDone" class="row">
              <div class="label">
                <div class="t">已导出 {{ exportDone.entry_count }} 篇</div>
                <div class="d">
                  <template v-if="exportDoneFormat === 'html'">
                    一篇一个 .html，另有 index.html 目录页（双击就能打开）
                  </template>
                  <template v-else>
                    一篇一个 .md，另有 index.md 汇总
                  </template>
                  <template v-if="exportDone.renamed > 0">
                    ；{{ exportDone.renamed }} 个重名已加后缀，原有文件没被覆盖
                  </template>
                </div>
              </div>
              <div class="ctl">
                <button class="btn" @click="openExportDir">打开文件夹</button>
              </div>
            </div>

            <!--
              图片缓存（P1 #10）。
              附件是**明文**文件、躺在数据目录的 attachments/ 里，所以位置必须让
              用户看得见：完整路径 + 「打开文件夹」。
              「清理图片缓存」清两样：① 有记录、文件没了的死记录；
              ② 有文件、没人认领的孤儿。删日记时外键只清表行、**不动文件**，
              所以这条清理是必须的（详见 db.rs::prune_orphan_attachments）。
            -->
            <div class="row stacked">
              <div class="label">
                <div class="t">图片缓存</div>
                <div class="d">
                  图片不加密、明文放在这个目录里（当初拍板接受的风险）；
                  删图片会连文件一起删，删日记则要在这里清一次
                </div>
              </div>
              <div class="ctl">
                <input
                  class="path-input"
                  type="text"
                  spellcheck="false"
                  readonly
                  :value="props.status.attachments_dir"
                />
                <button class="btn" @click="openAttachmentsDir">
                  打开文件夹
                </button>
                <button class="btn" :disabled="pruneBusy" @click="doPrune">
                  {{ pruneBusy ? "正在清理…" : "清理图片缓存" }}
                </button>
              </div>
            </div>

            <div v-if="pruneError" class="row">
              <div class="label">
                <div class="t">清理失败</div>
                <div class="d">{{ pruneError }}</div>
              </div>
            </div>

            <div v-else-if="pruneDone" class="row">
              <div class="label">
                <div class="t">清理完成</div>
                <div class="d">{{ pruneSummary }}</div>
              </div>
            </div>

            <div class="row">
              <div class="label">
                <div class="t">检查索引一致性</div>
                <div class="d">核对搜索索引和正文对不对得上</div>
              </div>
              <div class="ctl">
                <button class="btn" @click="emit('integrity')">检查</button>
              </div>
            </div>

            <div v-if="backup" class="block">
              <div class="block-title">备份情况</div>
              <p class="block-text">
                已有 {{ backup.backup_count }} 份<template
                  v-if="backup.auto_enabled"
                >
                  · 下次{{ humanInterval(backup.secs_until_next) }}</template
                >
                <br />保留最近 {{ backup.keep_recent }} 份，并按月各留一份
              </p>
              <p class="mono">{{ backup.dest_dir }}</p>
            </div>

            <!--
              从备份恢复（P2-5）—— 全应用**唯一会覆盖整库**的操作。
              刻意放在这一栏的最下面：多滚一点才碰上它，不容易误点。
              ⚠️ 真正的流程不住在这里：App.vue 要先 flushNow 落库、恢复后还要
                 重取全部派生数据（见 App.vue 顶部那张「派生数据登记处」）。
            -->
            <div class="row stacked">
              <div class="label">
                <div class="t">从备份恢复</div>
                <div class="d">
                  ⚠️ 会用备份<strong>整库替换</strong>当前所有日记；恢复前会自动留一份后悔药。
                  填上面那个目录里某一份备份的 <code>.db</code> 完整路径
                </div>
              </div>
              <div class="ctl">
                <input
                  v-model="restorePath"
                  class="path-input"
                  type="text"
                  spellcheck="false"
                  placeholder="例如 …\data\backups\diary-20260923-161500.db"
                />
                <button class="btn" :disabled="!restorePath.trim()" @click="openRestore">
                  恢复…
                </button>
              </div>
            </div>
            <p v-if="backup" class="mono">备份文件在：{{ backup.dest_dir }}</p>

            <p class="warn">
              备份是<strong>密文</strong>，与数据库使用同一个密码，恢复时用那个密码即可打开。
              可以直接把 <code>backups</code> 目录整体复制到网盘或其他硬盘 ——
              上面那个「复制备份到…」就是替你干这件事（连后悔药一起搬）。
            </p>
          </section>

          <!-- ── 通用（【P2-21】新增；【P2-13】加了三项） ──────────────
               这一栏回答的是"让写日记这件事**自己发生**"：
               关掉窗口还留在后台、到点提醒、开机自己起来。
               顺序：写作提醒 → 提醒节奏 → 提醒时间 → 开机自启 → 点击关闭时
                   → **每日字数目标**。
               ⚠️ 前四项是**一条链**（"让提醒响得了"）；每日字数目标与它们无关，
                  所以另起一段、排在**最末**（【P2-12】落地时加，指令原文：
                  "往 P2-13 那 5 行后面接着排，别插到中间"）。 -->
          <section v-else-if="tab === 'general'">
            <!--
              ⚠️ 说明文字**每项一句**：用户 2026-09-28 当场定的规矩 ——
                 "界面上的解释最多一句话、最好没有"。这里留下的两句都是
                 "不写他真会做错事"的那种（提醒要靠软件在后台跑，
                 不写他会以为关了窗口提醒照样响）。
            -->
            <div class="row">
              <div class="label">
                <div class="t">写作提醒</div>
                <div class="d">每天到点，那天还没写日记就提醒你。</div>
              </div>
              <div class="ctl">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="reminderEnabled"
                    @change="onToggleReminder"
                  />
                </label>
              </div>
            </div>

            <!-- 三档的差别，选项文字自己就说清了 ⇒ 这一行不写说明。 -->
            <div class="row">
              <div class="label">
                <div class="t">提醒节奏</div>
              </div>
              <div class="ctl">
                <select :value="reminderMode" @change="onChangeReminderMode">
                  <option v-for="o in REMINDER_MODE_OPTIONS" :key="o.value" :value="o.value">
                    {{ o.label }}
                  </option>
                </select>
              </div>
            </div>

            <div class="row">
              <div class="label">
                <div class="t">提醒时间</div>
                <!--
                  ⚠️ `on_open` 档**不看到点**，这一行也就没意义了 ——
                  置灰 + 一句状态说明。留着能点会让用户以为"设了却不生效"。
                -->
                <div v-if="reminderMode === 'on_open'" class="d">
                  这一档不看到点
                </div>
              </div>
              <div class="ctl">
                <input
                  type="time"
                  :value="reminderTime"
                  :disabled="reminderMode === 'on_open'"
                  @change="onChangeReminderTime"
                />
              </div>
            </div>

            <div class="row">
              <div class="label">
                <div class="t">开机自启</div>
                <div class="d">开机后在后台运行，关掉它提醒就不会响。</div>
              </div>
              <div class="ctl">
                <label class="toggle">
                  <input type="checkbox" :checked="autoStart" @change="onToggleAutoStart" />
                </label>
              </div>
            </div>

            <div class="row">
              <div class="label">
                <div class="t">点击关闭时</div>
                <!--
                  ⚠️ 只有这一句，且必须如实：用户很容易把"窗口关了"当成"安全了"。
                  藏进托盘时进程还活着、**密钥也还在内存里** —— 这是刻意的
                  （提醒要靠它），所以不能一个字都不说。
                -->
                <div class="d">
                  关上窗口后软件仍在后台运行，密钥不会从内存清除。
                </div>
              </div>
              <div class="ctl">
                <select :value="closeAction" @change="onChangeCloseAction">
                  <option v-for="o in CLOSE_ACTION_OPTIONS" :key="o.value" :value="o.value">
                    {{ o.label }}
                  </option>
                </select>
              </div>
            </div>

            <!--
              每日字数目标（【P2-12】）。
              ⚠️ 排在**最末** —— 指令原文："往 P2-13 那 5 行后面接着排，别插到中间"。
                 它跟上面四项不是一族（那四项都在"让提醒响得了"这条链上），
                 所以另起一段、放在末尾。
              ⚠️ 这一行**不写说明**（用户 2026-09-28 当场定的："不写"）——
                 标题自己说清了；"留空 ＝ 不用"清空那个框就知道了。
                 ⛔ 别为了"好懂"再加一句解释，那会破 9-28 立的那条规矩。
              ⚠️ 它是**自己填**的数字（填 `137` 就是 `137`），
                 ⛔ 不是 50 / 100 / 200 那种固定档位 —— 用户明确否掉过。
            -->
            <div class="row">
              <div class="label">
                <div class="t">每日字数目标</div>
              </div>
              <div class="ctl">
                <input
                  type="number"
                  min="0"
                  :max="MAX_DAILY_WORD_GOAL"
                  step="1"
                  :value="dailyWordGoal > 0 ? dailyWordGoal : ''"
                  @change="onChangeDailyWordGoal"
                />
                <span class="unit">字</span>
              </div>
            </div>
          </section>

          <!-- ── 关于（只读） ─────────────────────────────────────── -->
          <section v-else>
            <dl>
              <dt>版本号</dt>
              <dd>{{ pkg.version }}</dd>

              <dt>数据目录</dt>
              <dd class="mono">{{ status.data_dir }}</dd>

              <dt>加密算法</dt>
              <dd>
                SQLCipher（整库加密）+ Argon2id 密钥派生
                <span v-if="crypto">
                  （{{ crypto.m_cost_mib }} MiB / {{ crypto.t_cost }} 轮 /
                  {{ crypto.p_cost }} 并行）
                </span>
              </dd>

              <dt>搜索索引</dt>
              <dd>中文分词双索引（jieba 词索引 + 单字兜底索引）</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩与弹窗沿用 App.vue 里现成的写法，保持一致 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.modal {
  width: 100%;
  /* 最小窗口是 720×520：632px 加左右各 24px 内边距刚好放得下，
     再加 vw 兜底，窄窗也不会溢出。 */
  max-width: min(632px, 93vw);
  /* 高度封顶后由右栏内部滚动，弹窗本身不会把整个窗口撑满 */
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.pane {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 左栏：固定宽度，不跟着右栏滚 —— 否则滚到下面就看不清自己在哪个分类 */
.side {
  width: 148px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  border-right: 1px solid var(--border);
}
.side button {
  padding: 7px 10px;
  text-align: left;
  font-size: 13px;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
}
.side button:hover {
  background: var(--hover);
}
/* 选中态照搬顶栏 tabs 的 .on */
.side button.on {
  color: var(--text-1);
  background: var(--hover);
  font-weight: 500;
}

.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 6px 20px 18px;
}

/* 一行设置：左边说明，右边控件 */
.row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 13px 0;
  border-bottom: 1px solid var(--border);
}
.row:last-child {
  border-bottom: none;
}
.label {
  flex: 1;
  min-width: 0;
}
.label .t {
  font-size: 13px;
  color: var(--text-1);
}
.label .d {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.ctl {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/*
 * 控件本身很宽的行（如"导出到哪个目录"的路径输入框）改成上下两段：
 * 横着放会把左边的说明文字挤到没法读，而这个弹窗右栏本来就不宽。
 */
.row.stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}
.row.stacked .ctl {
  width: 100%;
}

/*
 * 导出那一行有三件控件（格式 / 目录 / 按钮），窄栏里允许换行 ——
 * 否则目录输入框会被挤到只剩几十像素，用户根本没法核对路径。
 */
.export-ctl {
  flex-wrap: wrap;
}

/* 路径输入框：等宽字体，便于用户核对盘符与目录层级 */
.path-input {
  flex: 1;
  min-width: 0;
  padding: 5px 9px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
}
.path-input:disabled {
  color: var(--text-3);
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
.btn:hover:enabled {
  border-color: var(--accent);
}
.btn:disabled {
  color: var(--text-3);
  cursor: default;
}
.btn.ghost {
  background: transparent;
}

select {
  padding: 5px 9px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
}

/* 时间选择器：与上面那个 select 同一套外观（原生控件不描一遍会跟旁边不搭） */
input[type="time"] {
  padding: 5px 9px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
}
input[type="time"]:disabled {
  color: var(--text-3);
  cursor: default;
}

/*
 * 数字框（每日字数目标，【P2-12】）：同一套外观，但要**窄**。
 * ⚠️ 默认宽度是"填满一行的长度"，而后面的单位「字」会被甩到很远的地方，
 *    看着像两个不相干的控件。宽度按"6 位数 ＋ 上下箭头"留够即可
 *    （后端上限十万，所以最长就是 6 位）。
 */
input[type="number"] {
  width: 84px;
  padding: 5px 9px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
}

/*
 * 数字框后面的单位（【P2-12】）。
 * ⚠️ 它是**单位**、不是说明文字 —— 所以不占 `.d` 那一行，
 *    也就没有破"界面上的解释最多一句、最好没有"那条规矩。
 */
.unit {
  font-size: 12px;
  color: var(--text-3);
}

/* 开关：朴素的原生 checkbox，不引组件库 */
.toggle {
  display: flex;
  align-items: center;
  cursor: pointer;
}
.toggle input {
  cursor: pointer;
  accent-color: var(--accent);
}
.toggle input:disabled {
  cursor: default;
}

/* 改密码子表单：贴在「主密码」那一行下面就地展开 */
.sub {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 14px 0 16px;
  border-bottom: 1px solid var(--border);
}
/* 子表单的引导句：说清"为什么这里还要再输一次密码" */
.sub-lead {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field label {
  font-size: 12px;
  color: var(--text-3);
}
.field input {
  width: 100%;
  padding: 7px 10px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
}
/* 密码格：等宽 + 字距，纯数字串更好数位，少输错一位 */
.field input[type="password"] {
  max-width: 230px;
  font-family: var(--mono);
  letter-spacing: 2px;
}
.field input:focus {
  border-color: var(--accent);
  outline: none;
}
.field input:disabled {
  color: var(--text-3);
}
.tip {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-3);
}
.err {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--danger);
}
.actions {
  display: flex;
  gap: 8px;
}

/* 只读信息块 */
.block {
  padding: 13px 0 0;
}
.block-title {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 5px;
}
.block-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}
.mono {
  margin: 5px 0 0;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-3);
  word-break: break-all;
}

dl {
  margin: 10px 0 0;
}
dt {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 3px;
}
dd {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-1);
}

.warn {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-3);
}
.warn code {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 4px;
  background: var(--hover);
  border-radius: 3px;
}
</style>
