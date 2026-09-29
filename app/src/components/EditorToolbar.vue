<script setup lang="ts">
/**
 * 【P2-3】第 2 步：正文的**格式工具栏**。
 *
 * 它是一排"贴在纸面上沿"的按钮：字体 / 字号 / B / I / U / S / 清除格式。
 * ⚠️ 它**不认识 Tiptap** —— 只往外抛"我要加粗"这类意图（`format` 事件），
 *    由父组件（`EditorPane`）去调编辑器。这样工具栏本身好测、也好换。
 *
 * ⚠️ **颜色一律走 CSS 变量**（项目铁律）：这里一个色号都没写。
 * ⚠️ 字体 / 字号下拉**只有三档**（拍板决定）：档位多了反而选不出来。
 */
const props = defineProps<{
  /** 当前字体的档位键；空串 ＝ 跟随全局默认。 */
  font: string;
  /** 当前字号的档位键；空串 ＝ 跟随全局默认。 */
  size: string;
  /** 当前是不是加粗 / 斜体 / 下划线 / 删除线（按钮高亮用）。 */
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** 锁定态：整排置灰、点不动。 */
  disabled: boolean;
}>();

const emit = defineEmits<{
  (e: "format", kind: string): void;
  (e: "font", value: string): void;
  (e: "size", value: string): void;
}>();

/**
 * 字体档位。
 *
 * ⚠️ `value` 是**真正写进正文的字体栈**，`label` 只是按钮上的字。
 *    写进去的是字体栈（不是"宋体"两个字）—— 因为最终渲染发生在浏览器里，
 *    只有完整字体栈才能保证"有宋体就用宋体、没有就退回系统字体"。
 * ⚠️ 第一档是空串 ⇒ 表示**不加任何 font-family**，跟随全局 `--reading-font`。
 *    这样"默认"这一档永远跟着主题走，不会因为系统缺字体而变成方框。
 */
const FONTS = [
  { key: "", label: "默认", value: "" },
  { key: "song", label: "宋体", value: '"Songti SC", SimSun, "Source Han Serif SC", serif' },
  { key: "hei", label: "黑体", value: '"Heiti SC", SimHei, "Source Han Sans SC", sans-serif' },
  { key: "kai", label: "楷体", value: '"Kaiti SC", KaiTi, "STKaiti", serif' },
];

/**
 * 字号档位。用**相对倍数**（`em`）而不是绝对像素 ——
 * 这样用户在设置里改正文基准字号时，正文里"大 / 中 / 小"会跟着一起缩放，
 * 不会出现"设置里调大了、某些段落却顽固不动"。
 */
const SIZES = [
  { key: "", label: "中", value: "" },
  { key: "s", label: "小", value: "0.875em" },
  { key: "l", label: "大", value: "1.25em" },
];

function onFontChange(ev: Event) {
  const key = (ev.target as HTMLSelectElement).value;
  const hit = FONTS.find((f) => f.key === key);
  emit("font", hit ? hit.value : "");
}
function onSizeChange(ev: Event) {
  const key = (ev.target as HTMLSelectElement).value;
  const hit = SIZES.find((s) => s.key === key);
  emit("size", hit ? hit.value : "");
}
</script>

<template>
  <div class="toolbar" :class="{ disabled }">
    <!--
      字体 / 字号用原生 <select>：体积为零、键盘可用、深浅主题自动跟系统。
      ⚠️ 它们**只是入口**，真正的"选中了没有"由父组件从编辑器实时读回。
    -->
    <select
      class="tool-select"
      :value="font"
      :disabled="disabled"
      title="正文字体"
      @change="onFontChange"
    >
      <option v-for="f in FONTS" :key="f.key" :value="f.key">{{ f.label }}</option>
    </select>

    <select
      class="tool-select size"
      :value="size"
      :disabled="disabled"
      title="字号"
      @change="onSizeChange"
    >
      <option v-for="s in SIZES" :key="s.key" :value="s.key">{{ s.label }}</option>
    </select>

    <span class="tool-sep" aria-hidden="true"></span>

    <button
      type="button"
      class="tool-btn bold"
      :class="{ on: bold }"
      :disabled="disabled"
      title="加粗（Ctrl+B）"
      @click="emit('format', 'bold')"
    >
      B
    </button>
    <button
      type="button"
      class="tool-btn italic"
      :class="{ on: italic }"
      :disabled="disabled"
      title="斜体（Ctrl+I）"
      @click="emit('format', 'italic')"
    >
      I
    </button>
    <button
      type="button"
      class="tool-btn underline"
      :class="{ on: underline }"
      :disabled="disabled"
      title="下划线（Ctrl+U）"
      @click="emit('format', 'underline')"
    >
      U
    </button>
    <button
      type="button"
      class="tool-btn strike"
      :class="{ on: strike }"
      :disabled="disabled"
      title="删除线"
      @click="emit('format', 'strike')"
    >
      S
    </button>

    <span class="tool-sep" aria-hidden="true"></span>

    <button
      type="button"
      class="tool-btn clear"
      :disabled="disabled"
      title="清除格式（只留文字）"
      @click="emit('format', 'clear')"
    >
      清除格式
    </button>
  </div>
</template>

<style scoped>
/*
  ⭐ 整排的观感目标是"**它是纸的一部分**"，不是一个浮在上面的插件：
    底色用 --hover（比纸面 --surface 略深一点点）、只有下边框、
     与纸面左右两侧同宽 —— 于是它读起来像"纸的抬头栏"。
  ⚠️ 高度刻意压低（34px）：正文写作时工具栏不该抢戏。
*/
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 20px;
  background: var(--hover);
  border-bottom: 1px solid var(--border);
  /* 上圆角与纸面一致，下边是直的（贴在正文上） */
  border-radius: 10px 10px 0 0;
  user-select: none;
}

/* 锁定态：整排置灰，但**不隐藏** —— 让用户看得见"这里本来有格式按钮"。 */
.toolbar.disabled {
  opacity: 0.5;
}

.tool-select {
  height: 24px;
  padding: 0 4px;
  font-size: 12px;
  font-family: var(--reading-font);
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 5px;
  cursor: pointer;
}

.tool-select.size {
  width: 46px;
}

.tool-select:disabled {
  cursor: default;
}

/* 两个下拉之间的竖分隔线（宽度 1px，不是 <hr>，不占额外行高）。 */
.tool-sep {
  width: 1px;
  height: 14px;
  margin: 0 3px;
  background: var(--border);
}

.tool-btn {
  min-width: 24px;
  height: 24px;
  padding: 0 7px;
  font-size: 12px;
  font-family: var(--reading-font);
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
  line-height: 1;
}

.tool-btn:hover:not(:disabled) {
  background: var(--surface);
  border-color: var(--border);
}

/* 激活（光标处已有这个格式）：用强调色底 —— 与心情按钮同一套"选中"语言。 */
.tool-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
}

.tool-btn:disabled {
  cursor: default;
}

/* B / I / U / S 各自用真正的字形，让按钮自己说明自己。 */
.tool-btn.bold {
  font-weight: 700;
}
.tool-btn.italic {
  font-style: italic;
}
.tool-btn.underline {
  text-decoration: underline;
}
.tool-btn.strike {
  text-decoration: line-through;
}

.tool-btn.clear {
  font-size: 11px;
}
</style>
