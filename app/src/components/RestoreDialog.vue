<script setup lang="ts">
/**
 * 恢复备份的二次确认弹窗。
 *
 * ⚠️ 这是全应用**唯一一处"必须吓住用户"**的地方：它按下去会整库替换。
 *
 * 为什么单独抽成一个组件：它有两个入口 —— 设置页【数据与备份】、
 * 以及**未初始化时的解锁页**（换电脑那个场景）。两处必须**一模一样**。
 * 确认弹窗是最不能出现"两个版本"的界面：只要有一处少写了危害提示，
 * 用户就可能恰好从那处按下去。
 *
 * 职责边界：自己负责"取信息 → 展示 → 调恢复"，只在**成功后**把新状态交给
 * App.vue（`@done`）。这样两个入口都不必各自复制一遍这段流程，
 * 它们只需要把弹窗挂起来。
 *
 * ⚠️ 这里**不做"打字确认"**（输入日期/密码才放行）：因为有"后悔药"
 *    兜着，而且每次恢复都要打一遍字会让人以后直接不看内容就按。
 *    真正的防线是"把危害写清楚"＋"按钮上带『替换』两个字"。
 */
import { computed, onMounted, ref } from "vue";
import {
  inspectBackup,
  restoreBackup,
  revealDir,
  toAppError,
  type AppStatus,
  type BackupInfo,
} from "../api";
import { humanBytes } from "../utils/date";

const props = defineProps<{
  /** 要恢复的那份备份（`.db` 的完整路径）。用户可以在弹窗里改。 */
  dbPath: string;
  /** 「后悔药」目录 —— 恢复前当前这份库会被快照到这里。 */
  preRestoreDir: string;
  /**
   * 这次恢复会不会留"后悔药"。
   *
   * ⚠️ 为 `false` 只有一种情况：**当前还没有任何日记库**（换电脑的场景），
   *    没有东西可保。界面必须说实话，不能承诺一份并不存在的保险。
   */
  willKeepPreRestore: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  /** 恢复成功。带上恢复后的状态，由 App.vue 覆盖本地状态并重取派生数据。 */
  (e: "done", status: AppStatus): void;
}>();

const path = ref(props.dbPath);
const info = ref<BackupInfo | null>(null);
const loading = ref(false);
const busy = ref(false);
const errorText = ref("");

/** 本地时间，**精确到秒** —— 用户要能跟"我什么时候备份的"对上。 */
const createdText = computed(() => {
  const secs = info.value?.created_at ?? 0;
  if (!secs) return "时间未知（文件名里没有时间戳）";
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
});

/**
 * 篇数那一栏 —— **三种情况必须分开说**。
 *
 * 把它们混成一句"读不出篇数"，用户会以为自己密码记错了；
 * 而真相可能是"这份备份缺了 meta、永远打不开"，或者是"我们手里根本没有钥匙"。
 * 三种真相指向三种完全不同的下一步动作，说错了他会走错方向。
 */
const countText = computed(() => {
  const i = info.value;
  if (!i) return "—";
  if (!i.meta_found) return "读不出（缺配对的 .meta.json）";
  if (i.entry_count !== null) return `${i.entry_count} 篇`;
  if (!i.key_available) return "读不出（未开启免密打开，无法预先核对）";
  return "读不出（不是用当前密码加密的）";
});

/** 「用当时的密码解锁」这条提示也得按原因分开说。 */
const openWarnText = computed(() => {
  const i = info.value;
  if (!i || i.openable_now) return "";
  if (!i.key_available) {
    return "恢复后可能需要用【这份备份当时那个密码】解锁 —— 现在无法预先核对。";
  }
  return "恢复后需要用【这份备份当时那个密码】解锁（当前密码打不开它）。";
});

const canRestore = computed(
  () => !!info.value && info.value.meta_found && !busy.value && !loading.value
);

async function load() {
  const p = path.value.trim();
  if (!p) return;
  loading.value = true;
  errorText.value = "";
  try {
    info.value = await inspectBackup(p);
  } catch (e) {
    info.value = null;
    errorText.value = toAppError(e).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function openPreRestore() {
  try {
    await revealDir(props.preRestoreDir);
  } catch (e) {
    errorText.value = toAppError(e).message;
  }
}

async function confirm() {
  if (!canRestore.value) return;
  busy.value = true;
  errorText.value = "";
  try {
    const s = await restoreBackup(path.value.trim());
    emit("done", s);
  } catch (e) {
    errorText.value = toAppError(e).message;
    // 失败后重新核对一次：文件可能被别人动过（比如配对 meta 被删了）。
    await load();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg">
      <header class="head">
        <h2>用这份备份替换当前所有日记？</h2>
      </header>

      <div class="body">
        <div class="row">
          <input
            v-model="path"
            class="path-input"
            type="text"
            spellcheck="false"
            placeholder="备份文件（.db）的完整路径"
            :disabled="busy"
            @keyup.enter="load"
          />
          <button class="btn" :disabled="loading || busy" @click="load">
            {{ loading ? "检查中…" : "检查" }}
          </button>
        </div>

        <dl v-if="info" class="facts">
          <dt>备份时间</dt>
          <dd>{{ createdText }}</dd>
          <dt>文件大小</dt>
          <dd>{{ humanBytes(info.bytes) }}</dd>
          <dt>篇数</dt>
          <dd>{{ countText }}</dd>
        </dl>

        <!-- 缺 meta：这不是警告，是死刑 —— 给结论，不给"也许能行"的错觉 -->
        <div v-if="info && !info.meta_found" class="box danger">
          <p class="box-title">这份备份<strong>永远打不开</strong>。</p>
          <p>
            它缺少配对的文件：<code>{{ info.meta_path }}</code
            >。备份永远是「<code>.db</code> ＋ <code>.meta.json</code>」两个文件一组 ——
            meta 里存着导出密钥所需的参数，少一个即使密码完全正确也没用。
            请把那一份也一起找出来再试。
          </p>
        </div>

        <div v-if="info && info.meta_found" class="box danger">
          <p class="box-title">
            当前库里的日记会被<strong>整库替换</strong>，恢复后无法在软件里撤销。
          </p>

          <template v-if="willKeepPreRestore">
            <p>
              恢复前会先把<strong>当前这份</strong>自动快照成一份「后悔药」，放在下面这个目录：
            </p>
            <div class="row">
              <input class="path-input" type="text" readonly :value="preRestoreDir" />
              <button class="btn" :disabled="busy" @click="openPreRestore">
                打开文件夹
              </button>
            </div>
            <p class="tip">
              不满意的话，从那个目录里挑一份按同样的方式恢复回来即可 ——
              它是完整的一组两个文件，本身就能用。
            </p>
          </template>
          <p v-else class="tip">
            当前还没有日记库，所以没有可以留的"后悔药" —— 恢复后这个库就直接变成备份里的样子。
          </p>

          <p v-if="openWarnText" class="strong">{{ openWarnText }}</p>
          <p class="strong">图片文件不在备份里 —— 恢复不会带回图片。</p>
        </div>

        <p v-if="errorText" class="box err">{{ errorText }}</p>
      </div>

      <footer class="foot">
        <button class="btn ghost" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn danger" :disabled="!canRestore" @click="confirm">
          {{ busy ? "正在恢复…" : "替换并恢复" }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/*
  遮罩与弹窗沿用设置页那套写法（同一个视觉语言）。
  ⚠️ z-index 必须显式给：设置弹窗的 `.modal-mask` 压根没有 z-index，
     而本弹窗既可能盖在设置弹窗上、也可能盖在解锁页上（换电脑那个场景）。
     取 60，确保压住设置弹窗与图片预览层；遮蔽页是 50，但它只在"免密假锁定"
     时出现，与本弹窗不会同时存在。
*/
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dlg {
  width: 100%;
  max-width: min(560px, 93vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
.head {
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.path-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
}
.path-input:focus {
  border-color: var(--accent);
}
.path-input:disabled {
  color: var(--text-3);
}
.facts {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 4px 10px;
  margin: 0 0 14px;
  font-size: 13px;
}
.facts dt {
  color: var(--text-3);
}
.facts dd {
  margin: 0;
  color: var(--text-1);
  word-break: break-all;
}
.box {
  padding: 12px 14px;
  margin-bottom: 12px;
  border-radius: 9px;
  font-size: 13px;
  line-height: 1.7;
}
.box.danger {
  background: var(--danger-bg);
  color: var(--text-1);
}
.box.err {
  background: var(--danger-bg);
  color: var(--danger);
}
.box-title {
  margin: 0 0 8px;
  color: var(--danger);
  font-weight: 500;
}
.box p {
  margin: 8px 0 0;
}
.box p:first-child {
  margin-top: 0;
}
.box code {
  font-family: var(--mono);
  font-size: 11px;
  word-break: break-all;
}
.tip {
  color: var(--text-2);
  font-size: 12px;
}
.strong {
  color: var(--danger);
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.btn {
  padding: 7px 14px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--accent);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.ghost {
  background: transparent;
}
/*
  危险按钮：文案里必须带"替换"两个字（这是用户按下前的最后一道自觉）。
  ⚠️ 颜色一律走主题变量，**一个色号都不写死** —— 这条栽过两轮了。
     文字色用 `--surface` 而不是 `#fff`：浅色主题下它是白（配深红底），
     深色主题下它是深色（配浅红底）—— 两个主题都可读，而且不引入硬编码。
*/
.btn.danger {
  color: var(--surface);
  background: var(--danger);
  border-color: var(--danger);
}
</style>
