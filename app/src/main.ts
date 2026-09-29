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

/**
 * 启动画面**最少停留**多久（【P2-2】追加，2026-09-23 用户提的：
 * "**我都没看清是什么，他就过去了**"）。
 *
 * ⭐ **这是"最少 1 秒"，不是"固定再加 1 秒"** —— 这是这条补充唯一容易做错的地方。
 *    写成 `setTimeout(..., 1000)` 会变成「启动耗时 **＋** 1 秒」：
 *    机器慢时（挂载本来就要 3 秒）总时长直接变 4 秒，**比现在更烦**。
 *
 * 正确做法是拿**已经过去的时间去抵扣**：
 * `performance.now()` 从**页面导航开始**计时，所以它已经包含了
 * "创建窗口 → 解析 HTML → 下载并执行 bundle → Vue 挂载"的全部耗时；
 * 而用户看到启动画面的起点也是这一刻（那块 HTML 不依赖 JS）—— 两者正好对齐。
 * 这就是为什么**不用**在 `index.html` 里额外埋一个时间戳。
 */
const SPLASH_MIN_MS = 1000;

const splash = document.getElementById("boot-splash");
if (splash) {
  const wait = Math.max(0, SPLASH_MIN_MS - performance.now());

  window.setTimeout(() => {
    // ⚠️ 这个 `requestAnimationFrame` 是**故意留在里面**的（它是从外面挪进来的）：
    //    "等够时间 → 再等一帧 → 淡出"。少了它，Vue 的 DOM 刚写进去、
    //    浏览器还没合成成画面就撤帘子，会闪。
    requestAnimationFrame(() => {
      splash.classList.add("is-gone");
      splash.addEventListener("transitionend", () => splash.remove(), {
        once: true,
      });
      // 保险丝：万一 transitionend 没来（例如系统里关了动画），也得把它摘掉。
      // 对已经移除的节点再 remove() 是空操作，重复调用无害。
      // ⚠️ 它从"加上 is-gone"那一刻起算，与上面那个 `wait` **无关** —— 别动。
      window.setTimeout(() => splash.remove(), 420);
    });
  }, wait);
}
