<script setup lang="ts">
/**
 * 应用外壳：决定显示解锁页还是主界面，并组织各面板。
 *
 * 界面顺序遵循一个原则：**打开就能写**。
 * 所以主界面直接是"日历 + 编辑器"，没有首页、没有列表页中转。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import CalendarPanel from "./components/CalendarPanel.vue";
import EditorPane from "./components/EditorPane.vue";
import SearchPanel from "./components/SearchPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import UnlockScreen from "./components/UnlockScreen.vue";
import {
  backupNow,
  cryptoInfo,
  getBackupStatus,
  getStats,
  getStatus,
  integrityCheck,
  lockVault,
  setAutoBackup,
  toAppError,
  type AppStatus,
  type BackupStatus,
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
const showAbout = ref(false);
/** 设置弹窗。日历与编辑器不被卸载，所以这里悬着也不影响未保存的草稿。 */
const showSettings = ref(false);

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
    if (status.value.unlocked) await loadAux();
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

function onUnlocked(s: AppStatus) {
  status.value = s;
  void loadAux();
}

function onSaved() {
  refreshToken.value++;
  void loadAux();
}

async function doLock() {
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

/** 离开电脑自动锁定的兜底：窗口失去焦点 15 分钟后清除内存中的密钥。 */
let blurTimer: number | null = null;
const AUTO_LOCK_MS = 15 * 60 * 1000;
function onBlur() {
  if (!unlocked.value) return;
  if (blurTimer !== null) window.clearTimeout(blurTimer);
  blurTimer = window.setTimeout(() => {
    if (unlocked.value) void doLock();
  }, AUTO_LOCK_MS);
}
function onFocus() {
  if (blurTimer !== null) {
    window.clearTimeout(blurTimer);
    blurTimer = null;
  }
}

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
          <button class="btn ghost" title="关于" @click="showAbout = true">
            关于
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
        只读出口。可操作项（备份三项）已搬进设置页。
        划分标准只有一条：**能改的进设置，只能看的留关于**。
        这个弹窗保留不删，因为它是个用惯了的快捷入口。
      -->
      <div v-if="showAbout" class="modal-mask" @click.self="showAbout = false">
        <div class="modal">
          <h2>关于</h2>
          <dl>
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
            <dt v-if="stats">统计</dt>
            <dd v-if="stats">
              {{ stats.total_entries }} 篇 · 累计 {{ stats.total_words }} 字 ·
              连续 {{ stats.streak_days }} 天
              <template v-if="stats.first_date">
                <br />从 {{ stats.first_date }} 到 {{ stats.last_date }}
              </template>
            </dd>
          </dl>

          <div class="actions">
            <button class="btn ghost" @click="showAbout = false">关闭</button>
          </div>
        </div>
      </div>

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
        @close="showSettings = false"
        @backup="doBackup"
        @integrity="doIntegrity"
        @toggle-auto-backup="toggleAutoBackup"
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
  max-width: 520px;
  background: var(--surface);
  border-radius: 12px;
  padding: 26px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.18);
}
.modal h2 {
  margin: 0 0 18px;
  font-size: 17px;
  font-weight: 600;
}
dl {
  margin: 0 0 18px;
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
.mono {
  font-family: var(--mono);
  font-size: 12px;
  word-break: break-all;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
