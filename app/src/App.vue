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
import SearchPanel from "./components/SearchPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import UnlockScreen from "./components/UnlockScreen.vue";
import {
  backupNow,
  cryptoInfo,
  DEFAULT_AUTO_LOCK_SECS,
  getBackupStatus,
  getSettings,
  getStats,
  getStatus,
  integrityCheck,
  lockVault,
  setAutoBackup,
  toAppError,
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
const mode = ref<"write" | "search">("write");
/** 递增以要求日历刷新标记。 */
const refreshToken = ref(0);

const stats = ref<Stats | null>(null);
const crypto = ref<CryptoInfo | null>(null);
const backup = ref<BackupStatus | null>(null);
/** 设置弹窗。日历与编辑器不被卸载，所以这里悬着也不影响未保存的草稿。 */
const showSettings = ref(false);

/**
 * 自动锁定时长（秒）。`0` = 永不。
 *
 * 先用默认值起步，解锁成功后由 loadSettings() 换成库里的真实值 ——
 * 设置存在**加密库**里，未解锁时根本读不到，所以这里必须可变，
 * 不能像以前那样写死成一个常量。
 */
const autoLockSecs = ref(DEFAULT_AUTO_LOCK_SECS);

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
  try {
    status.value = await getStatus();
    if (status.value.unlocked) {
      await loadAux();
      // 设置也得跟着读一次：库里存的可能是 1 分钟或永不，
      // 先用默认值起步会让自动锁定在启动后的一小段时间里用错时长。
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
 * 读取应用设置（目前只有自动锁定时长）。
 *
 * 只能在**解锁后**调 —— 设置在加密库里，未解锁读不到。
 * 读失败不阻塞主流程：留用默认值也比卡住强，何况这一项有个安全的落点。
 */
async function loadSettings() {
  try {
    autoLockSecs.value = (await getSettings()).auto_lock_secs;
  } catch {
    // 保持默认值。不值得为这一项弹错误。
  }
}

function onUnlocked(s: AppStatus) {
  status.value = s;
  void loadAux();
  // 解锁成功后必须把设置读回来 —— 包括将来"免密自动解锁"那条路径，
  // 它同样会走到这里。否则会一直用启动时的默认值。
  void loadSettings();
}

function onSaved() {
  refreshToken.value++;
  void loadAux();
}

async function doLock() {
  // 先撤掉自动锁定的计时器：已经锁上了，它再响一次是空跑；
  // 更糟的是万一定时器残留到解锁之后，会突袭式地把刚解开的库又锁上。
  clearLockTimer();
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
    <div v-if="booting" class="boot">正在启动…</div>

    <div v-else-if="fatal" class="boot error">
      <p>启动失败：{{ fatal }}</p>
      <button class="btn" @click="boot">重试</button>
    </div>

    <UnlockScreen
      v-else-if="status && !unlocked"
      :status="status"
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
        </nav>
        <div class="right">
          <span v-if="stats" class="stat">
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
            @select="(d) => (selected = d)"
          />
          <EditorPane :date="selected" @saved="onSaved" />
        </template>
        <div v-else class="search-wrap">
          <SearchPanel
            @open="
              (d) => {
                selected = d;
                mode = 'write';
              }
            "
          />
        </div>
      </main>

      <div v-if="toast" class="toast">{{ toast }}</div>

      <!--
        设置：可以改的东西都在这儿。
        状态一律从 App.vue 传进去 —— 它自己不再拉一次 status，
        免得出现"弹窗里的备份状态和顶栏统计各说各话"。
      -->
      <SettingsPanel
        v-if="showSettings"
        :status="status"
        :backup="backup"
        :crypto="crypto"
        :stats="stats"
        :auto-lock-secs="autoLockSecs"
        @close="showSettings = false"
        @backup="doBackup"
        @integrity="doIntegrity"
        @toggle-auto-backup="toggleAutoBackup"
        @auto-lock-secs="(s) => (autoLockSecs = s)"
        @password-changed="onPasswordChanged"
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
.search-wrap {
  flex: 1;
  min-width: 0;
  padding: 20px 24px;
  max-width: 720px;
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
