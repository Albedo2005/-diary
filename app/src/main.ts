/**
 * 前端入口。
 *
 * 只做三件事：引入全局样式、挂载根组件、撤掉启动画面。
 * 所有数据访问都经 src/api/，组件不直接接触 Tauri invoke。
 */
import { createApp } from "vue";
import App from "./App.vue";
import "./styles/global.css";

createApp(App).mount("#app");

/**
 * 撤掉 index.html 里那块启动画面（P2-2）。
 *
 * 时机是刻意选的 —— 挂在 mount **之后**、并且**等一帧**：
 *   * 挂在 mount 之前：Vue 还没把界面画出来，撤掉帘子等于露出空窗；
 *   * 不等一帧：Vue 的 DOM 刚写进去、浏览器还没合成成画面，撤掉同样会闪。
 * 淡出交给 CSS 的 transition，动画结束后再**真正移除节点**，
 * 免得留一个透明的全屏层挡着（虽然它 pointer-events: none，但留着是隐患）。
 */
const splash = document.getElementById("boot-splash");
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add("is-gone");
    splash.addEventListener("transitionend", () => splash.remove(), {
      once: true,
    });
    // 保险丝：万一 transitionend 没来（例如系统里关了动画），也得把它摘掉。
    // 对已经移除的节点再 remove() 是空操作，重复调用无害。
    window.setTimeout(() => splash.remove(), 420);
  });
}
