/**
 * 前端入口。
 *
 * 只做两件事：引入全局样式、挂载根组件。
 * 所有数据访问都经 src/api/，组件不直接接触 Tauri invoke。
 */
import { createApp } from "vue";
import App from "./App.vue";
import "./styles/global.css";

createApp(App).mount("#app");
