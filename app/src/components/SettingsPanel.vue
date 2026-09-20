<script setup lang="ts">
/**
 * 设置面板 —— 集中放"可以改的东西"。
 *
 * 与「关于」的分界线只有一条：**能改的进设置，只能看的留关于**。
 * 只读信息（版本、数据目录、加密参数、统计）在【关于】分类里，
 * 这里是全应用**唯一**的只读出口（顶栏那个「关于」入口已经删掉了）。
 *
 * 已接线的项：
 *   - 数据与备份 三项 —— 逻辑留在 App.vue，这里只发信号
 *   - **自动锁定时长**（指令 11）—— 见下面 onChangeAutoLock 的说明
 *   - **修改主密码**（指令 3）—— 见下面 submitChangePin 的说明
 * 仍是占位的项（点了会明说"尚未接入"并立刻复位，不留"看着开了其实没开"）：
 *   - 免密打开 → 指令 4
 *
 * ⚠️ 【外观】分类已撤销（2026-09-20）：它当初只为装"窗口模式"而建，
 * 而窗口模式（指令 12）连同【全屏】档一起被用户否掉了 —— 他不需要沉浸式，
 * 保留"窗口 / 最大化"两档也没有意义（系统标题栏本来就有那两个按钮）。
 * 唯一的项没了，分类就成了空壳，点进去什么都没有 = 界面骗人，故整组删除。
 * 将来真要做主题切换，再按需要重建这个分类。
 *
 * 组件不自己拉状态：status / backup / crypto / stats / autoLockSecs
 * 全部从 App.vue 传入，免得两份状态各走各的、切个分类就对不上。
 * 例外只有一处：改密码成功后由 App.vue 用返回的新状态覆盖（见 password-changed）。
 */
import { computed, nextTick, ref } from "vue";
import pkg from "../../package.json";
import {
  AUTO_LOCK_OPTIONS,
  changePassword,
  setAutoLockSecs,
  toAppError,
  type AppStatus,
  type BackupStatus,
  type ChangePasswordResult,
  type CryptoInfo,
  type Stats,
} from "../api";

const props = defineProps<{
  status: AppStatus;
  backup: BackupStatus | null;
  crypto: CryptoInfo | null;
  stats: Stats | null;
  /** 自动锁定时长（秒）。0 = 永不。由 App.vue 持有，是唯一真值源。 */
  autoLockSecs: number;
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
  /** 主密码已更换。带上后端返回的最新状态与收尾警告，由 App.vue 落库。 */
  (e: "password-changed", res: ChangePasswordResult): void;
  /** 请 App.vue 重新拉一次 status（改密码失败会改变剩余尝试次数 / 锁定状态）。 */
  (e: "refresh-status"): void;
  /** 一句提示，由 App.vue 的 toast 显示。 */
  (e: "notice", message: string): void;
}>();

type TabKey = "security" | "data" | "about";

const TABS: { key: TabKey; label: string }[] = [
  { key: "security", label: "安全" },
  { key: "data", label: "数据与备份" },
  { key: "about", label: "关于" },
];

const tab = ref<TabKey>("security");

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
// 占位控件（还没接线的那些）
// ---------------------------------------------------------------------------

/**
 * 占位控件统一反馈：明确说"还没接"。
 * 界面上宁可直接承认"没接"，也不要让它看起来已经生效。
 */
function notYet(what: string, cmd: string) {
  emit("notice", `${what}尚未接入（${cmd}），本次只搭了界面`);
}

/** 免密打开。未接入前只显示"关"，点了立刻拨回去，绝不留假状态。 */
const autoUnlock = ref(false);

function onToggleAutoUnlock(e: Event) {
  // TODO(指令 4)：写免密开关，并联动解锁页 / 锁定页（遮蔽页）。
  (e.target as HTMLInputElement).checked = autoUnlock.value;
  notYet("免密打开", "指令 4");
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
                <div class="d">打开软件时跳过密码，直接进入</div>
              </div>
              <div class="ctl">
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="autoUnlock"
                    @change="onToggleAutoUnlock"
                  />
                </label>
              </div>
            </div>

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

            <p class="warn">
              备份是<strong>密文</strong>，与数据库使用同一个密码，恢复时用那个密码即可打开。
              可以直接把 <code>backups</code> 目录整体复制到网盘或其他硬盘。
            </p>
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

              <dt v-if="stats">统计</dt>
              <dd v-if="stats">
                {{ stats.total_entries }} 篇 · 累计 {{ stats.total_words }} 字 ·
                连续 {{ stats.streak_days }} 天
                <template v-if="stats.first_date">
                  <br />从 {{ stats.first_date }} 到 {{ stats.last_date }}
                </template>
              </dd>
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
