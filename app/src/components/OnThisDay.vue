<script setup lang="ts">
/**
 * 「N 年前的今天写过 · 去看看」—— 编辑器日期下方的一行入口。
 *
 * 它不是"一个需要你去点的功能"，而是**自己找上门**的那一类：
 * 日记的价值在回看，而回看最难的是"想不起来去回看"。
 * 所以它**常驻**（不做自动消失、不做关闭按钮）—— 你翻到别的日期它自然就不出现了，
 * 等于自带关闭；一年也只出现那么一次。
 *
 * ⚠️ **它只管展示，不拥有规则、也不拥有数据**：
 *   - 判定在 `utils/date.ts::sameDayInPastYears()` —— 【P2-23】的回顾页要用**同一句**；
 *   - "写过的日期"由 `App.vue` 缓存好、经 `EditorPane` 传进来 ⇒ 本组件**不调任何 IPC**。
 *
 * ⚠️ **这一行不显示摘要 / 心情 / 字数**，也**不读正文一个字**：
 *    "往年今天"逐条展开是【P2-23】回顾页的活，两处都写就是重复。
 *    附带好处：往年那篇"只有图片、没有文字"时，这一行照常显示（它压根不关心正文）。
 *
 * ⚠️ 正因为将来它会被**搬进回顾页**，文案里不能出现"点这里"这种指代词 ——
 *    写清"去看看"就够了。
 */
import { computed } from "vue";
import { sameDayInPastYears } from "../utils/date";

const props = defineProps<{
  /** 当前正在看的那一天（'YYYY-MM-DD'） */
  date: string;
  /** 所有**写过**的日子（App.vue 缓存的那一份；未解锁时是空数组） */
  dates?: string[];
}>();

const emit = defineEmits<{
  /** 点「去看看」—— 参数**只传日期字符串**，【P2-23】要接这根线。 */
  (e: "open", date: string): void;
}>();

/** 最近的那一个"往年同一天"，没有则是空串（模板靠它决定整行渲不渲染）。 */
const hit = computed(
  () => sameDayInPastYears(props.dates ?? [], props.date)[0] ?? ""
);

/**
 * "N 年前的今天"里的那个 N。
 *
 * 只看年份差是对的：判定已经保证"月日相同"，年和年一减就是年数。
 * ⚠️ 不在这里做任何日期加减 —— 那才会撞上 2/29（见 date.ts 里的说明）。
 */
const yearsAgo = computed(
  () => Number(props.date.slice(0, 4)) - Number(hit.value.slice(0, 4))
);
</script>

<template>
  <!--
    ⛔ 没有往年同一天时**整行不渲染** —— 不是显示"暂无"，也不是留一块空白占位。
  -->
  <p v-if="hit" class="on-this-day">
    {{ yearsAgo }} 年前的今天写过 ·
    <button class="link" :title="`跳到 ${hit}`" @click="emit('open', hit)">
      去看看
    </button>
  </p>
</template>

<style scoped>
.on-this-day {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-3);
}
/*
  「去看看」做成**文字链接**而不是按钮：它是一次"指路"，不是本节的主操作。
  颜色一律走变量，深浅两套主题都不能出现写死的色号。
*/
.link {
  padding: 0;
  font-size: 12px;
  font-family: inherit;
  color: var(--accent);
  background: transparent;
  border: none;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.link:hover {
  color: var(--text-1);
}
</style>
