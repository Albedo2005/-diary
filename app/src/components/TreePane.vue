<script setup lang="ts">
/**
 * 「树语」的 3D 舞台 —— **一棵树**（第一期 · 批次 2）。
 *
 * 职责很窄：**拿骨架 → 起渲染器 → 跟着窗口尺寸走 → 卸载时拆干净**。
 * 数学在 `tree/grow.ts`，场景在 `tree/scene.ts`，贴图在 `tree/material.ts`。
 * ⛔ 这个文件里**不许**出现"树怎么长"或"颜色长什么样"的逻辑。
 *
 * ⭐ **一棵固定的树**（A2 拍板）：种子写死 ⇒ 每次打开都是同一棵。
 *    固定下来用户才判断得了"好不好看"。随机是以后的事。
 *
 * ⛔ **第一期不许读日记数据、不许发任何后端命令** —— 树不接数据。
 * ⛔ **颜色一律从 CSS 变量取**（`tree/material.ts` 的 `readPalette`），
 *    深浅主题各自成立；系统切主题时 `applyTheme()` 会把贴图重画一遍。
 *
 * ⚠️ 挂在 `window.__treeStage` 上的那个计数器是**给自动验收用的**，
 *    它要一直留到第一期验收做完（它证明不了好看，但它是"切走真的停了"
 *    那条纪律**唯一**能机器验的办法）。见文件末尾那段注释。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import * as THREE from "three";

import { growTree } from "../tree/grow.ts";
import { makeStage, type TreeStage } from "../tree/scene.ts";

/** 场景挂载点。盒子多大由 CSS 决定，相机与渲染器跟着它走。 */
const host = ref<HTMLDivElement | null>(null);

/**
 * ⭐ A2：**种子写死 ⇒ 永远同一棵树**。
 * ⚠️ 换这个数就是换一棵树（形态全变）。改完要重跑一遍批次 2 的验收。
 */
const SEED = 20260930;

/** 给自动验收看的快照。 */
type StageHook = {
  /** 只由"**真的画了一帧**"来加 —— 见 `onMounted` 里的说明。 */
  frames: number;
  stopped: boolean;
  stopFrame: number;
  /** 这棵树骨架的规模（证明"真长出来了"，不是一根光杆）。 */
  branches: number;
  tips: number;
  height: number;
  crownWidth: number;
  /** 显卡这一帧真的画了多少三角形（`renderer.info` 读数）。 */
  triangles: number;
  /** 视口尺寸（CSS 像素）—— 验"全屏时等比放大"要用。 */
  viewW: number;
  viewH: number;
};

const hookHost = window as unknown as { __treeStage?: StageHook };

let renderer: THREE.WebGLRenderer | null = null;
let stage: TreeStage | null = null;
let observer: ResizeObserver | null = null;
/** 系统主题变化监听（3D 场景自己不会跟着 CSS 变）。 */
let themeQuery: MediaQueryList | null = null;
let themeCleanup: (() => void) | null = null;

onMounted(() => {
  const el = host.value;
  if (!el) return;

  const tree = growTree({ seed: SEED });
  stage = makeStage(tree);

  let maxSide = 0;
  for (const b of tree.branches) maxSide = Math.max(maxSide, Math.abs(b.to.x), Math.abs(b.to.z));

  /**
   * 自动验收用的帧计数。
   * ⭐ **只能由"真的画了一帧"来加** —— ⛔ 不许拿浏览器的动画帧冒充
   *    （那个即使 3D 已经停了也照样跳，拿它当判据会在功能坏掉时依然全绿）。
   *    切走 ⇒ 本组件被卸载 ⇒ 循环停 ⇒ `frames` 必须**冻住**。
   */
  const hook: StageHook = {
    frames: 0,
    stopped: false,
    stopFrame: -1,
    branches: tree.branches.length,
    tips: tree.tips.length,
    height: tree.height,
    crownWidth: maxSide * 2,
    triangles: 0,
    viewW: 0,
    viewH: 0,
  };
  hookHost.__treeStage = hook;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  // D4：**画质按屏幕密度封顶 2 倍**。不封顶的话 4K 屏会傻乎乎按 4 倍画，白烧一倍显卡。
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // D2：地上一片淡淡的树影 —— "像不像真的"里性价比最高的一项。
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  el.appendChild(canvas);

  /** 画布尺寸 → 渲染器 + 相机取景。⭐ "全屏时等比例放大"就发生在这一条路上。 */
  function resize(): void {
    const box = host.value;
    if (!box || !renderer || !stage) return;
    const w = Math.max(1, box.clientWidth);
    const h = Math.max(1, box.clientHeight);
    // ⚠️ 第三个参数 `updateStyle = false`：**不让 three 往画布上写内联宽高**，
    //    尺寸交给 CSS（`.tree-stage :deep(canvas)` 的 100%）。
    //    这样"填充多大"只有一个来源（CSS），不会出现两套尺寸打架。
    renderer.setSize(w, h, false);
    stage.fit(w, h);
    hook.viewW = w;
    hook.viewH = h;
    // 尺寸刚变的那一下先把画面画出来，免得拖窗口时看到一格旧画面。
    renderer.render(stage.scene, stage.camera);
  }

  // ⚠️ 用 ResizeObserver 而不是 `window.resize`：折叠日历栏这类**不改窗口尺寸**的
  //    版式变化一样会改变画布大小（P2-22 栽过），听窗口是听不到的。
  observer = new ResizeObserver(resize);
  observer.observe(el);
  resize();

  /*
   * ⚠️ **这一版是"无条件每帧都画"的** —— 因为批次 2 树上还没有风，画面其实是静的。
   *    这是**有意留的**：批次 3 的风要靠这个循环驱动，纪律六条（切走停 /
   *    切后台停 / 系统"减弱动态效果" / 画质封顶 …）也在那一批一起做。
   *    ⛔ 别在这儿提前加"静止就不画"的优化 —— 会和批次 3 的风打架。
   */
  renderer.setAnimationLoop(() => {
    if (!renderer || !stage) return;
    hook.frames += 1;
    renderer.render(stage.scene, stage.camera);
    hook.triangles = renderer.info.render.triangles;
  });

  // 系统深浅主题一变，3D 那边的贴图/光色得跟着重做（CSS 变量管不到 canvas 里面）。
  themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onTheme = (): void => stage?.applyTheme();
  themeQuery.addEventListener("change", onTheme);
  themeCleanup = () => themeQuery?.removeEventListener("change", onTheme);
});

onBeforeUnmount(() => {
  const hook = hookHost.__treeStage;
  if (hook) {
    hook.stopped = true;
    hook.stopFrame = hook.frames;
  }
  observer?.disconnect();
  observer = null;
  themeCleanup?.();
  themeCleanup = null;
  themeQuery = null;

  renderer?.setAnimationLoop(null);
  const canvas = renderer?.domElement;
  stage?.dispose();
  stage = null;
  renderer?.dispose();
  canvas?.remove();
  renderer = null;
});
</script>

<template>
  <div ref="host" class="tree-stage" role="img" aria-label="树语：一棵会随时间变化的树"></div>
</template>

<style scoped>
/*
  ⚠️ 这一块要**撑满内容区**（用户 2026-09-30 拍板：「撑满，而且全屏的时候也要
     等比例放大」）。所以这里给的是 `100%` 而不是一个 `vh` 下限 ——
     "多大"由外层容器（`StatsPanel.vue` 的 `.tree-slot` ＋ `App.vue` 的
     `.stats-wrap--tree`）决定，本组件只负责铺满它。
  ⛔ 别在这儿写死高度：写死了，"全屏时等比放大"就断在这一层了。
*/
.tree-stage {
  width: 100%;
  height: 100%;
  min-height: 0;
  border-radius: 10px;
  overflow: hidden;
}

.tree-stage :deep(canvas) {
  display: block;
  /*
    ⚠️⚠️ 这两行**不能省**（2026-09-30 栽过一次）：
    `renderer.setSize(w, h, false)` 的第三个参数是"⛔ 不要往画布上写内联宽高"，
    所以画布的**显示尺寸**只能由这里给。
    一旦漏了：画布会拿**背衬尺寸**当自己的 CSS 尺寸（＝可用宽 × 屏密度，
    例如 785 × 1.875 ＝ 1471px），于是**撑破容器**、被 `.tree-stage` 的
    `overflow: hidden` 裁掉 —— 症状是**树被挤到右下角、只剩一角**。
    而 `width: 100%` 之后：显示尺寸 ＝容器，背衬 ＝ 容器 × 屏密度
    ⇒ 正好 1:1 映射到物理像素，清晰度一点不丢。
  */
  width: 100%;
  height: 100%;
}
</style>
