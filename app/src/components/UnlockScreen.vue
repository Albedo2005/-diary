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

const props = defineProps<{ status: AppStatus }>();
const emit = defineEmits<{
  (e: "unlocked", status: AppStatus): void;
  (e: "status", status: AppStatus): void;
}>();

const pin = ref("");
const pinConfirm = ref("");
const hint = ref("");
const busy = ref(false);
const errorText = ref("");
const local = ref<AppStatus>(props.status);

/** 剩余锁定秒数。用本地倒计时显示，但每秒向后端核对一次真值。 */
const remaining = ref(props.status.remaining_lock_secs);
let timer: number | null = null;

const isInit = computed(() => !local.value.initialized);
const locked = computed(() => remaining.value > 0);
const minLen = computed(() => local.value.pin_min_len);

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
      <h1>{{ isInit ? "创建你的日记" : "解锁" }}</h1>

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
      </template>

      <p class="path-note">数据目录：{{ local.data_dir }}</p>
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
h1 {
  margin: 0 0 12px;
  font-size: 22px;
  font-weight: 600;
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
.path-note {
  margin: 20px 0 0;
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
}
</style>
