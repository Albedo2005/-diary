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
import HiddenScreen from "./components/HiddenScreen.vue";
import SearchPanel from "./components/SearchPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import StatsPanel from "./components/StatsPanel.vue";
import UnlockScreen from "./components/UnlockScreen.vue";
import {
  backupNow,
  cryptoInfo,
  DEFAULT_AUTO_LOCK_ENTRIES,
  DEFAULT_AUTO_LOCK_SECS,
  DEFAULT_TRIPLE_CLICK_UNLOCK,
  getBackupStatus,
  getSettings,
  getStats,
  getStatus,
  integrityCheck,
  lockVault,
  setAutoBackup,
  toAppError,
  unlockWithAutoKey,
  type AppStatus,
  type BackupStatus,
  type ChangePasswordResult,
  type CryptoInfo,
  type Stats,
} from "./api";
import { humanBytes, todayKey } from "./utils/date";

const status = ref<AppStatus | null>(null);
const booting = ref(true);
const fatal = ref("");

const selected = ref(todayKey());
/**
 * 当前主视图：写日记 / 搜索 / 统计。
 *
 * ⚠️ 默认**永远是写日记** —— 三个 tab 里它是"家"。别把这个选择持久化：
 *    用户下次打开软件看到一屏统计，会以为软件坏了。
 *
 * ⚠️ 切走时正文区会**卸载**（`v-if` / `v-else-if`）。`EditorPane` 的
 *    `onUnmounted` 里有 `if (dirty) void flush()`，没落盘的字会先被存掉，
 *    所以**不丢内容**；代价是切回来属于重挂，光标与滚动位置归零。
 *    这与「搜索」的行为完全一致（它也是这么切的）。
 */
const mode = ref<"write" | "search" | "stats">("write");
/** 递增以要求日历刷新标记。 */
const refreshToken = ref(0);

/**
 * 递增以要求两处标签界面刷新。
 *
 * 标签同时出现在**侧栏列表**（CalendarPanel）与**编辑器 chip 行 + 下拉候选**
 * （EditorPane）里，而改标签的入口也在两处（编辑器的 ＋/×、侧栏的 ✎/✕）。
 * 用一个共享的令牌让两边互相同步，比"谁改了谁挨个去通知对方"少一半接线，
 * 也避免出现"侧栏删了标签、编辑器还挂着它"这种半新半旧的状态。
 *
 * 与自己无关的改动也会触发一次重读 —— 多查一次换来的是
 * "界面上的标签永远来自数据库"，这个买卖划算。
 */
const tagToken = ref(0);

const stats = ref<Stats | null>(null);
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
      await loadAux();
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

async function loadAux() {
  try {
    const [s, c, b] = await Promise.all([
      getStats(),
      cryptoInfo(),
      getBackupStatus(),
    ]);
    stats.value = s;
    crypto.value = c;
    backup.value = b;
  } catch {
    // 辅助信息失败不应阻塞主流程。
  }
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
  } catch {
    // 保持默认值。不值得为这一项弹错误。
  }
}

function onUnlocked(s: AppStatus) {
  status.value = s;
  // 已经进来了，那条"免密失效"的提示就没有意义了。
  autoLoginFailed.value = false;
  void loadAux();
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
 * 任何一处改了标签（编辑器加/撤、侧栏改名/删除）→ 让两处界面都重读。
 *
 * ⚠️ 只递增令牌，**不判断是谁改的**：判断"这次改动影响哪些视图"需要
 *    在前端复制一份标签与日记的关联关系，而那份镜像迟早会与数据库不一致
 *    （标签会被级联删除、会被改名）。让两边都去问后端，最简单也最准。
 */
function onTagsChanged() {
  tagToken.value++;
  // 标签改了不影响统计（统计只看正文），所以这里不重拉 loadAux。
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

  try {
    status.value = await lockVault();
    stats.value = null;
    crypto.value = null;
    backup.value = null;
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
  if (!ok) clearLockTimer();
});

onMounted(() => {
  void boot();
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
});
onUnmounted(() => {
  window.removeEventListener("blur", onBlur);
  window.removeEventListener("focus", onFocus);
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
    />

    <template v-else-if="status">
      <header class="topbar">
        <div class="brand">日记</div>
        <nav class="tabs">
          <button :class="{ on: mode === 'write' }" @click="mode = 'write'">
            写日记
          </button>
          <button :class="{ on: mode === 'search' }" @click="mode = 'search'">
            搜索
          </button>
          <!--
            统计是**整屏视图**，与「搜索」同级：都是"看"，不是"改"。
            它不在设置弹窗里 —— 一个用来鼓励坚持的数字，不该埋在配置项里。
          -->
          <button :class="{ on: mode === 'stats' }" @click="mode = 'stats'">
            统计
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
          <CalendarPanel
            :selected="selected"
            :refresh-token="refreshToken"
            :tag-token="tagToken"
            :first-date="stats?.first_date ?? null"
            :last-date="stats?.last_date ?? null"
            @select="(d) => (selected = d)"
            @tags-changed="onTagsChanged"
            @notice="flash"
          />
          <EditorPane
            :date="selected"
            :tag-token="tagToken"
            :auto-lock-entries="autoLockEntries"
            :triple-click-unlock="tripleClickUnlock"
            @saved="onSaved"
            @tags-changed="onTagsChanged"
            @notice="flash"
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
        <div v-else class="stats-wrap">
          <StatsPanel :stats="stats" />
        </div>
      </main>

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
        @close="showSettings = false"
        @backup="doBackup"
        @integrity="doIntegrity"
        @toggle-auto-backup="toggleAutoBackup"
        @auto-lock-secs="(s) => (autoLockSecs = s)"
        @auto-lock-entries="(on) => (autoLockEntries = on)"
        @triple-click-unlock="(on) => (tripleClickUnlock = on)"
        @password-changed="onPasswordChanged"
        @auto-login-changed="onAutoLoginChanged"
        @refresh-status="refreshStatus"
        @notice="flash"
      />
    </template>
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
  搜索与统计都是"整屏视图"，共用同一套留白与滚动。
  统计图表比搜索结果宽一些，所以各给自己的 max-width。
*/
.search-wrap,
.stats-wrap {
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
