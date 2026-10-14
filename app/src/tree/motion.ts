/**
 * 「树语动不动」这一个偏好 —— **纯读写，⛔ 不 import vue、不 import three**。
 *
 * 为什么单独一个文件：**三个地方要用它** ——
 * 设置页（切换）、`App.vue`（持有状态）、`TreePane.vue`（按它决定动不动）。
 * 放组件里会出现"设置页说关着、树上还在摆"这种两头各说各话的局面。
 *
 * ⚠️ 它存 `localStorage`（键 `diary.tree-motion`），**不进加密库** ——
 *    这是项目通用口径：**`localStorage` 只许存界面偏好**（与"折叠日历栏"、
 *    "导出格式"同一类）。它是"我喜不喜欢看东西动"，不含一个字的日记内容。
 *    ⇒ 也就不用动后端的四处（db / commands / lib.rs / api），符合本期"不碰 Rust"的红线。
 */

/** localStorage 的键。只存一个"动不动"的布尔值。 */
export const MOTION_KEY = "diary.tree-motion";

/**
 * 读：树语的动效**开不开**。
 *
 * ⚠️ **兜底方向 ＝ 开** —— 只有精确的 `"0"` 才算"关掉"；
 *    其它一切（`null` / 垃圾值 / `localStorage` 被禁 / 抛异常）都算**开着**。
 *    理由：这个功能的全部意思就是"它会轻轻摆"，兜底关掉等于把功能藏起来。
 *    ⛔ 别写成 `=== "1" ? true : false` 之类的反向判断（本项目的开关一律
 *       "认那一个明确值，其余全走兜底"）。
 */
export function readTreeMotion(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) !== "0";
  } catch {
    return true; // localStorage 被禁（配额满 / 隐私模式）⇒ 退回默认（开着）
  }
}

/** 写。⚠️ 写失败**不许打断这个动作**（界面照切，只是下次记不住）。 */
export function writeTreeMotion(on: boolean): void {
  try {
    localStorage.setItem(MOTION_KEY, on ? "1" : "0");
  } catch {
    /* 存不下就算了 —— 它只是个偏好 */
  }
}
