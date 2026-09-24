<script setup lang="ts">
/**
 * 解锁 / 初始化界面。
 *
 * 两种模式由 status.initialized 决定：
 *   - false：首次使用，设置密码（可选写提示）
 *   - true ：输入密码解锁
 *
 * 几个必须做对的行为：
 *   1. 锁定期倒计时必须**基于后端状态**，不能只靠前端计时器。
 *      否则刷新页面就能跳过等待。
 *   2. 达到阈值后显示提示，提示文本来自后端（它存在加密库之外）。
 *   3. 密码错误不透露任何"错在哪一位"的信息。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  getStatus,
  initializeVault,
  unlockVault,
  toAppError,
  type AppStatus,
} from "../api";

const props = defineProps<{
  status: AppStatus;
  /**
   * 上一次启动时免密解锁失败过（钥匙文件已失效，后端已把它删掉）。
   *
   * 为真时界面要多做两件事：副标题固定说"输入密码"，并在密码框上方
   * 加一条红条解释原因。理由是用户的心理预期是"应该直接进去"——
   * 突然要求输密码而不给解释，他第一个念头是"密码被改了 / 软件坏了"。
   */
  autoLoginFailed?: boolean;
}>();
const emit = defineEmits<{
  (e: "unlocked", status: AppStatus): void;
  (e: "status", status: AppStatus): void;
  /**
   * 请求"从这份备份恢复"（P2-5 决定 ①）。
   *
   * 只发信号，**不自己调恢复**：恢复完要重取全部派生数据、还要判断
   * "回不回解锁页"，那是 App.vue 的活；而且确认弹窗是两处入口共用的
   * 同一个组件，不能在这里再复制一份。
   */
  (e: "restore", dbPath: string): void;
}>();

const pin = ref("");
const pinConfirm = ref("");
const hint = ref("");
const busy = ref(false);
const errorText = ref("");
const local = ref<AppStatus>(props.status);

/**
 * 「有备份？从这里恢复」那块次级入口是否展开（P2-5）。
 *
 * 默认收起：它是**少数人才用得上**的路（换电脑、重装系统之后），
 * 而这一屏的主角永远是"创建密码"。展开是用户主动的动作。
 */
const showRestore = ref(false);
const restorePath = ref("");

/** 把路径交给 App.vue；真正的流程（含二次确认弹窗）住在那里。 */
function requestRestore() {
  const p = restorePath.value.trim();
  if (!p) return;
  emit("restore", p);
}

/** 剩余锁定秒数。用本地倒计时显示，但每秒向后端核对一次真值。 */
const remaining = ref(props.status.remaining_lock_secs);
let timer: number | null = null;

const isInit = computed(() => !local.value.initialized);
const locked = computed(() => remaining.value > 0);
const minLen = computed(() => local.value.pin_min_len);

/**
 * 副标题文案。
 *
 * 抽成 computed 而不是写在模板里三目：免密失败那条分支要和正常解锁
 * 用同一句"输入密码，继续写下去"，将来改文案时不会只改动其中一处。
 */
const subtitle = computed(() => {
  if (props.autoLoginFailed) return "输入密码，继续写下去";
  return isInit.value ? "记录每天的自己" : "输入密码，继续写下去";
});

const canSubmit = computed(() => {
  if (busy.value || locked.value) return false;
  if (pin.value.length < minLen.value) return false;
  if (isInit.value && pin.value !== pinConfirm.value) return false;
  return true;
});

function fmtCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m} 分 ${String(s).padStart(2, "0")} 秒`;
}

/**
 * 向后端核对状态。
 *
 * 为什么每秒都问后端而不是纯前端倒计时：前端计时器会在后台标签页被节流，
 * 也可能被用户改系统时间绕过。以后端为准才是可信的。
 */
async function refreshStatus() {
  try {
    const s = await getStatus();
    local.value = s;
    remaining.value = s.remaining_lock_secs;
    emit("status", s);
    if (s.unlocked) emit("unlocked", s);
  } catch (e) {
    const err = toAppError(e);
    errorText.value = err.message;
  }
}

function startTimer() {
  stopTimer();
  // 只在需要时跑计时器，且间隔设为 1 秒。
  timer = window.setInterval(() => {
    if (remaining.value > 0) {
      remaining.value -= 1;
      if (remaining.value <= 0) {
        remaining.value = 0;
        void refreshStatus();
      }
    }
  }, 1000);
}

function stopTimer() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

onMounted(() => {
  remaining.value = props.status.remaining_lock_secs;
  startTimer();
});
onUnmounted(stopTimer);
watch(() => props.status, (s) => {
  local.value = s;
  remaining.value = s.remaining_lock_secs;
});

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  errorText.value = "";
  try {
    if (isInit.value) {
      await initializeVault(pin.value, hint.value.trim() || null);
      // 初始化成功即视为已解锁，但状态要重新拉一次。
      await refreshStatus();
    } else {
      const s = await unlockVault(pin.value);
      pin.value = "";
      emit("unlocked", s);
    }
  } catch (e) {
    const err = toAppError(e);
    if (err.kind === "locked") {
      remaining.value = err.remainingSecs ?? local.value.lockout_secs;
      errorText.value = `密码错误次数过多，请等待 ${fmtCountdown(remaining.value)} 后重试。`;
    } else if (err.kind === "wrong_pin") {
      errorText.value = "";
    } else {
      errorText.value = err.message;
    }
    // 无论如何都刷新一次：剩余次数、是否已锁定都可能变了。
    await refreshStatus();
    pin.value = "";
    pinConfirm.value = "";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="unlock">
    <div class="card">
      <!-- 标题居中，两行：主标题 + 副标题 -->
      <header class="hero">
        <h1>日记</h1>
        <p class="subtitle">{{ subtitle }}</p>
      </header>

      <p v-if="isInit" class="lead">
        日记内容会加密保存在这台电脑上。请设置一个密码 ——
        <strong>忘记密码将无法恢复内容</strong>，因为密钥只由这个密码推导，
        我们不保存任何能帮你找回的东西。
      </p>
      <p v-else class="lead">输入密码以打开你的日记。</p>

      <div v-if="locked" class="locked-box">
        <div class="locked-title">已暂时锁定</div>
        <div class="locked-time">{{ fmtCountdown(remaining) }}</div>
        <div class="locked-note">
          连续输错 {{ local.max_attempts }} 次后会锁定
          {{ Math.round(local.lockout_secs / 60) }} 分钟。
        </div>
      </div>

      <template v-else>
        <!--
          免密打开失效的说明条。
          ⚠️ 必须明说"你原来的密码仍然有效"：用户此刻的状态是
          "本来该直接进，却要输密码"，最容易联想到"密码被改了 / 库坏了"，
          而真相只是那把**额外的**钥匙过期了，主密码从来没被动过。
          用现成的 .error 样式（同色系的提示条），不另造一套。
        -->
        <div v-if="autoLoginFailed && !isInit" class="error">
          免密打开已失效，已自动关闭。请输入密码 —— 你原来的密码仍然有效。
        </div>

        <label class="field">
          <span class="label">{{ isInit ? "设置密码" : "密码" }}</span>
          <input
            v-model="pin"
            class="pin-input"
            type="password"
            inputmode="numeric"
            autocomplete="off"
            :placeholder="`${minLen} 位数字`"
            :maxlength="32"
            autofocus
            @keyup.enter="submit"
          />
        </label>

        <label v-if="isInit" class="field">
          <span class="label">再输一次</span>
          <input
            v-model="pinConfirm"
            class="pin-input"
            type="password"
            inputmode="numeric"
            autocomplete="off"
            :maxlength="32"
            @keyup.enter="submit"
          />
          <span
            v-if="pinConfirm && pin !== pinConfirm"
            class="field-hint warn"
          >
            两次输入不一致
          </span>
        </label>

        <label v-if="isInit" class="field">
          <span class="label">提示（可选）</span>
          <input
            v-model="hint"
            class="text-input"
            type="text"
            :maxlength="60"
            placeholder="例如：和你常用的数字有关"
          />
          <span class="field-hint">
            ⚠️ 提示会以<strong>明文</strong>保存并在锁屏界面显示 ——
            因为解锁前无法读取加密内容。所以写得模糊一点，不要写成能直接推出密码的内容。
          </span>
        </label>

        <!-- 提示在出错达到阈值后才显示 -->
        <div v-if="!isInit && local.show_hint && local.hint" class="hint-box">
          <span class="hint-label">你写的提示</span>
          <span class="hint-text">{{ local.hint }}</span>
        </div>

        <div v-if="errorText" class="error">{{ errorText }}</div>
        <div
          v-else-if="!isInit && !local.locked && local.remaining_attempts < local.max_attempts"
          class="attempts"
        >
          密码不正确。还可尝试 {{ local.remaining_attempts }} 次。
        </div>

        <button class="primary" :disabled="!canSubmit" @click="submit">
          {{ busy ? "处理中…" : isInit ? "创建日记" : "解锁" }}
        </button>

        <p v-if="isInit" class="footnote">
          首次创建需要约 1 秒 —— 这是在用 Argon2id 把密码推导成加密密钥，
          高计算成本正是为了抵抗暴力破解。
        </p>

        <!--
          数据目录只在**首次创建**时告知一次，日常解锁界面不显示。
          理由：解锁页每次打开都会看到，重复显示一个用户改变不了的路径
          只是噪音。但它又必须被说过一次，否则用户不知道自己的日记存在哪、
          该备份什么。
        -->
        <p v-if="isInit" class="path-note">
          日记会保存在：<code>{{ local.data_dir }}</code>
        </p>

        <!--
          有备份？从这里恢复（P2-5 决定 ①）。
          为什么必须放在"首次创建"这一屏：换电脑 / 重装系统之后，用户手上只剩
          一份备份，而软件此刻停在"设置密码" —— 他要是先设了个新密码，
          那份备份就得绕"先建库、再从设置页恢复"一大圈。
          这是"软件都还打不开时就能把数据救回来"的唯一一条路。

          ⚠️ 一行都不要碰上面「创建密码」的主流程：那是 2.5 定下的东西，
             也是全应用改动风险最高的一段。这里只是挂在卡片末尾的一个次级入口。
        -->
        <div v-if="isInit" class="restore-entry">
          <button class="link-btn" type="button" @click="showRestore = !showRestore">
            {{ showRestore ? "收起" : "有备份？从这里恢复" }}
          </button>

          <div v-if="showRestore" class="restore-box">
            <p>
              如果这台电脑上还没有日记本、而你手上有以前备份的
              <code>diary-….db</code>，可以直接恢复回来 —— 恢复后用
              <strong>那份备份当时那个密码</strong>解锁，不必先设新密码。
            </p>
            <p class="restore-note">
              备份永远是 <code>.db</code> ＋ <code>.meta.json</code> 两个文件一组，
              缺一个就永远打不开。两个要一起找出来。
            </p>
            <div class="restore-row">
              <input
                v-model="restorePath"
                class="text-input"
                type="text"
                spellcheck="false"
                placeholder="备份 .db 文件的完整路径"
                @keyup.enter="requestRestore"
              />
              <button
                class="btn"
                :disabled="!restorePath.trim()"
                @click="requestRestore"
              >
                恢复…
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.unlock {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
}
.card {
  width: 100%;
  max-width: 460px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 32px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.06);
}
/* 标题区：居中，主标题 + 副标题 */
.hero {
  text-align: center;
  margin-bottom: 24px;
}
h1 {
  margin: 0 0 6px;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: 2px;
  color: var(--text-1);
}
.subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
  letter-spacing: 0.5px;
}
.lead {
  margin: 0 0 22px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-2);
}
.lead strong {
  color: var(--danger);
}
.field {
  display: block;
  margin-bottom: 18px;
}
.label {
  display: block;
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.pin-input,
.text-input {
  width: 100%;
  padding: 11px 13px;
  font-size: 15px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-1);
  outline: none;
  transition: border-color 0.15s;
}
.pin-input {
  letter-spacing: 5px;
  font-family: var(--mono);
}
.pin-input:focus,
.text-input:focus {
  border-color: var(--accent);
}
.field-hint {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.field-hint.warn {
  color: var(--danger);
}
.hint-box {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 10px 12px;
  margin-bottom: 16px;
  background: var(--warn-bg);
  border-radius: 8px;
  font-size: 13px;
}
.hint-label {
  color: var(--text-3);
  flex-shrink: 0;
}
.hint-text {
  color: var(--text-1);
}
.error,
.attempts {
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
}
.error {
  background: var(--danger-bg);
  color: var(--danger);
}
.attempts {
  background: var(--warn-bg);
  color: var(--text-1);
}
.locked-box {
  text-align: center;
  padding: 22px;
  margin-bottom: 16px;
  background: var(--danger-bg);
  border-radius: 10px;
}
.locked-title {
  font-size: 13px;
  color: var(--danger);
  margin-bottom: 6px;
}
.locked-time {
  font-size: 26px;
  font-weight: 600;
  font-family: var(--mono);
  color: var(--text-1);
  margin-bottom: 8px;
}
.locked-note {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}
.primary {
  width: 100%;
  padding: 12px;
  font-size: 15px;
  font-weight: 500;
  color: #fff;
  background: var(--accent);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: opacity 0.15s;
}
.primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.primary:not(:disabled):hover {
  opacity: 0.9;
}
.footnote {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
/*
  「有备份？从这里恢复」次级入口（P2-5）。
  刻意做小、做轻：它不能跟「创建日记」抢注意力 —— 那是这一屏唯一的主线，
  而这个入口是少数人才走得上的路。颜色一律走主题变量，不写死色号。
*/
.restore-entry {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  text-align: center;
}
.link-btn {
  padding: 0;
  font-size: 12px;
  color: var(--text-3);
  background: transparent;
  border: none;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.link-btn:hover {
  color: var(--accent);
}
.restore-box {
  margin-top: 12px;
  padding: 12px;
  text-align: left;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}
.restore-box p {
  margin: 0 0 8px;
}
.restore-box strong {
  color: var(--text-1);
}
.restore-box code {
  font-family: var(--mono);
  font-size: 11px;
  word-break: break-all;
}
.restore-note {
  color: var(--text-3);
}
.restore-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.restore-row .text-input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font-size: 12px;
}
.restore-row .btn {
  flex-shrink: 0;
}
.btn {
  padding: 8px 13px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--accent);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 只在初始化时出现一次的数据目录提示 */
.path-note {
  margin: 18px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-3);
  text-align: center;
}
.path-note code {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-2);
  word-break: break-all;
}
</style>
