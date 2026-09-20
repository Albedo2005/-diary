<script setup lang="ts">
/**
 * 遮蔽页 —— 免密打开下的"拉帘子"。
 *
 * 为什么需要它：免密打开意味着**库在启动时就已解锁**，密钥已在内存里。
 * 此时点「锁定」如果真去锁库，用户下一次打开会撞上"没有密码可输"的界面 ——
 * 那是个死锁。所以免密模式下的"锁定"只能是**纯前端的帘子**：
 * 盖住屏幕，回到主界面时不需要密码，草稿也不会丢。
 *
 * ⚠️ 它不是锁。必须如实告诉用户这一点（见模板底部那段说明）：
 *    库里没有新增任何密码校验，帘子挡住的是"路过的人"，
 *    挡不住"想打开这个程序的人"。
 *
 * 交互目标是"像 Windows 没设密码那样，按一下就回来"，
 * 所以给了三条路：点整层任意处 / 按任意键 / 点「继续」按钮。
 * 第三个不是多余的 —— 总有人不知道"点哪都行"，得给个明确的出口。
 */
import { onMounted, onUnmounted, ref } from "vue";

const emit = defineEmits<{ (e: "resume"): void }>();

/**
 * 出现后多久才接受"关闭"操作。
 *
 * ⚠️ 500ms 不是随手写的：自动锁定到点时，鼠标很可能**恰好**停在屏幕上，
 *    或者用户正从别的窗口切回来 —— 那第一下点击是用来激活窗口的，
 *    没有这段延迟，帘子会瞬间自己消失，等于没遮。
 */
const ARM_DELAY_MS = 500;

const armed = ref(false);
let armTimer: number | null = null;

function resume() {
  // 还没武装完就忽略：见上面那段说明。
  if (!armed.value) return;
  emit("resume");
}

/**
 * 任意键都能关。
 *
 * 不区分按键（Esc / 空格 / 字母都行）：这一页的目的不是拦截，
 * 而"按哪个键"这种规则一旦存在，用户就得先知道它。
 */
function onKeydown() {
  resume();
}

onMounted(() => {
  armTimer = window.setTimeout(() => (armed.value = true), ARM_DELAY_MS);
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  if (armTimer !== null) window.clearTimeout(armTimer);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="hidden-screen" @click="resume">
    <div class="inner">
      <div class="mark" aria-hidden="true"></div>

      <h1>日记已隐藏</h1>
      <p class="tip">点一下（或按任意键）就能回来，草稿不会丢</p>

      <button class="continue" @click.stop="resume">继续</button>

      <!--
        底部这段不能省：用户点开「锁定」时的心理预期是"锁上了"，
        而实际上库并没有锁。不说清楚，他会以为自己的日记现在是安全的。
      -->
      <p class="note">
        免密打开已开启 —— 这一页只挡得住路过的人，挡不住想打开的人。
        要真正锁上，请在设置里关掉免密打开。
      </p>
    </div>
  </div>
</template>

<style scoped>
/*
  占满整个窗口。z-index 明确给一个值：设置弹窗（.modal-mask）没有 z-index，
  靠 DOM 顺序压住主界面；遮蔽页必须盖住**包括弹窗在内**的一切，
  所以不能也靠顺序，得用数字把自己抬上去。
*/
.hidden-screen {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  cursor: pointer;
  user-select: none;
}
.inner {
  max-width: 420px;
  text-align: center;
}
/* 一个安静的圆环，替代 emoji 或图标字体 */
.mark {
  width: 34px;
  height: 34px;
  margin: 0 auto 18px;
  border: 2px solid var(--border);
  border-radius: 50%;
}
h1 {
  margin: 0 0 8px;
  font-size: 21px;
  font-weight: 600;
  color: var(--text-1);
  letter-spacing: 0.5px;
}
.tip {
  margin: 0 0 24px;
  font-size: 13px;
  color: var(--text-3);
}
.continue {
  padding: 9px 26px;
  font-size: 13px;
  color: #fff;
  background: var(--accent);
  border: none;
  border-radius: 8px;
  cursor: pointer;
}
.continue:hover {
  opacity: 0.9;
}
.note {
  margin: 28px 0 0;
  font-size: 11px;
  line-height: 1.8;
  color: var(--text-3);
  text-align: center;
}
</style>
