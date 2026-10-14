<script setup lang="ts">
/**
 * 「树语」的 3D 舞台 —— **一棵有花有叶、会随风轻摆的树**（第一期 · 批次 3）。
 *
 * 职责很窄：**拿骨架与花叶 → 起渲染器 → 跟着窗口尺寸走 → 什么时候动、什么时候停 → 卸载时拆干净**。
 * 数学在 `tree/grow.ts` ＋ `tree/foliage.ts`，场景与风在 `tree/scene.ts`，
 * 贴图在 `tree/material.ts`。⛔ 这个文件里**不许**出现"树怎么长""花叶怎么挂"的逻辑。
 *
 * ⭐ **一棵固定的树**（A2 拍板）：种子写死 ⇒ 每次打开都是同一棵、同一身花叶。
 * ⛔ **第一期不许读日记数据、不许发任何后端命令** —— 树不接数据（花多花少跟数据无关）。
 * ⛔ **颜色一律从 CSS 变量取**；系统切主题时 `applyTheme()` 会把贴图重画一遍。
 *
 * ── ⭐ 纪律六条（指令 §五-4，**都在这儿落实**） ──────────────────────
 * | # | 规矩 | 落点 |
 * |---|---|---|
 * | 1 | 切走这个 tab ⇒ **立刻停** | 组件被 `v-if` 卸载 → `onBeforeUnmount` 关循环 |
 * | 2 | 软件切到后台 ⇒ 停 | `visibilitychange` → `syncLoop()` |
 * | 3 | 系统"减弱动态效果"开着 ⇒ 静态 | `matchMedia("(prefers-reduced-motion: reduce)")` |
 * | 4 | 界面上有个**找得到**的开关 | 设置页「通用」里的那一行（`props.motion`） |
 * | 5 | 画质按屏幕密度封顶 | `setPixelRatio(min(dpr, 2))`（D4） |
 * | 6 | 花叶**不出现在写日记 / 搜索 / 筛选页** | 本组件只在年轮页的「树语」里挂载 ⇒ 结构上就不可能出现 |
 *
 * ⚠️ 纪律 3 与 4 都是"停"，但**停的方式不同**：不是把循环关掉就完事 ——
 *    静态时也要**把那一帧画出来**（`renderNow()`），否则用户看到的是一片空白。
 *
 * ⚠️ 挂在 `window.__treeStage` 上的那个计数器是**给自动验收用的**，
 *    它要一直留到第一期验收做完（它证明不了好看，但"切走真的停了""关了就真不动了"
 *    这几条纪律**只能靠它机器验**）。见文件末尾那段注释。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";

import { growTree } from "../tree/grow.ts";
import { growFoliage } from "../tree/foliage.ts";
import { makeStage, type TreeStage } from "../tree/scene.ts";

const props = defineProps<{
  /**
   * 动效开不开（设置页那个开关，存 `localStorage` 的 `diary.tree-motion`）。
   * ⚠️ 关掉 ⇒ **树还在、只是不动**（⛔ 不是把树藏起来）。
   */
  motion: boolean;
}>();

/** 场景挂载点。盒子多大由 CSS 决定，相机与渲染器跟着它走。 */
const host = ref<HTMLDivElement | null>(null);

/**
 * ⭐ A2：**种子写死 ⇒ 永远同一棵树**。
 * ⚠️ 换这个数就是换一棵树（连花叶一起换）。改完要重跑整批界面验收。
 */
const SEED = 20260930;

/** 给自动验收看的快照。 */
type StageHook = {
  /** 只由"**真的画了一帧**"来加 —— 见 `renderNow` 里的说明。 */
  frames: number;
  stopped: boolean;
  stopFrame: number;
  /** 这棵树骨架的规模（证明"真长出来了"，不是一根光杆）。 */
  branches: number;
  tips: number;
  height: number;
  crownWidth: number;
  /** 花与叶的片数（证明"花叶真挂上去了"）。 */
  leaves: number;
  blossoms: number;
  /** 显卡这一帧真的画了多少三角形、几次绘制（`renderer.info` 读数）。 */
  triangles: number;
  drawCalls: number;
  /** 视口尺寸（CSS 像素）—— 验"全屏时等比放大"要用。 */
  viewW: number;
  viewH: number;
  /** 画布背衬尺寸与像素倍率 —— 验"画质封顶 2 倍"要用。 */
  backingW: number;
  backingH: number;
  pixelRatio: number;
  /** 这一刻到底在不在动（纪律 1~4 都看它）。 */
  animating: boolean;
  /** 三种"该停"的原因，分开记 —— 验纪律时要知道是哪一条摁住的。 */
  motionPref: boolean;
  reducedMotion: boolean;
  hidden: boolean;
  /** 渲染一帧的耗时（毫秒，滚动平均）—— 验"帧时间在预算内"。 */
  frameMs: number;
};

const hookHost = window as unknown as { __treeStage?: StageHook };

let renderer: THREE.WebGLRenderer | null = null;
let stage: TreeStage | null = null;
let observer: ResizeObserver | null = null;
/** 系统主题变化监听（3D 场景自己不会跟着 CSS 变）。 */
let themeQuery: MediaQueryList | null = null;
let themeCleanup: (() => void) | null = null;
/** 系统"减弱动态效果"（纪律 3）。 */
let reduceQuery: MediaQueryList | null = null;
let reduceCleanup: (() => void) | null = null;
/** 现在是不是挂着动画循环。 */
let looping = false;
/** 风的时钟 —— ⚠️ **只在"真的在动"的帧里走**（见 `tick`）。 */
let windClock = 0;
let lastTick = 0;
/** 一帧渲染耗时（毫秒）的滚动平均。 */
let frameMs = 0;
let frameCount = 0;
/** 卸载时要摘掉的监听（`onMounted` 里装配，`onBeforeUnmount` 里执行）。 */
let cleanup: (() => void) | null = null;

onMounted(() => {
  const el = host.value;
  if (!el) return;

  const tree = growTree({ seed: SEED });
  const foliage = growFoliage(tree, { seed: SEED });
  stage = makeStage(tree, foliage);

  let maxSide = 0;
  for (const b of tree.branches) maxSide = Math.max(maxSide, Math.abs(b.to.x), Math.abs(b.to.z));

  /**
   * 自动验收用的计数。
   * ⭐ `frames` **只能由"真的画了一帧"来加** —— ⛔ 不许拿浏览器的动画帧冒充
   *    （那个即使 3D 已经停了也照样跳，拿它当判据会在功能坏掉时依然全绿）。
   */
  const hook: StageHook = {
    frames: 0,
    stopped: false,
    stopFrame: -1,
    branches: tree.branches.length,
    tips: tree.tips.length,
    height: tree.height,
    crownWidth: maxSide * 2,
    leaves: foliage.leaves.length,
    blossoms: foliage.blossoms.length,
    triangles: 0,
    drawCalls: 0,
    viewW: 0,
    viewH: 0,
    backingW: 0,
    backingH: 0,
    pixelRatio: 0,
    animating: false,
    motionPref: props.motion,
    reducedMotion: false,
    hidden: false,
    frameMs: 0,
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

  /** 画一帧，并把它记进账（帧数＋耗时＋三角形数）。 */
  function renderNow(): void {
    if (!renderer || !stage) return;
    const t0 = performance.now();
    renderer.render(stage.scene, stage.camera);
    const dt = performance.now() - t0;
    frameCount += 1;
    // 滚动平均：头 30 帧用 1/n 收敛，之后按 1/30 平滑 —— 免得被某一帧的抖动带偏。
    frameMs += (dt - frameMs) / Math.min(frameCount, 30);
    hook.frames += 1;
    hook.frameMs = frameMs;
    hook.triangles = renderer.info.render.triangles;
    hook.drawCalls = renderer.info.render.calls;
  }

  /** 纪律 3：系统"减弱动态效果"开着 ⇒ 静态。 */
  const wantsMotion = (): boolean => props.motion && !hook.reducedMotion && !hook.hidden;

  /**
   * 动还是停 —— **纪律 1~4 唯一的开关**，每次状态变化都调它一次。
   * ⚠️ 停下时**必须补画一帧**：循环关了、画面还停在上一帧的话，
   *    第一次进入页面就会看到一片空白（画布是黑的）。
   */
  function syncLoop(): void {
    if (!renderer || !stage) return;
    const want = wantsMotion();
    hook.animating = want;
    if (want) {
      if (!looping) {
        looping = true;
        lastTick = 0; // ⚠️ 清零：不然"暂停了 10 分钟"会在恢复的一瞬间全砸进 windClock
        renderer.setAnimationLoop(tick);
      }
    } else {
      if (looping) {
        looping = false;
        renderer.setAnimationLoop(null);
      }
      renderNow();
    }
  }

  function tick(): void {
    if (!renderer || !stage) return;
    const now = performance.now();
    // ⚠️ 时钟只在"真的在动"的帧里累加 ⇒ 暂停期间风不会继续往前跑。
    if (lastTick) windClock += (now - lastTick) / 1000;
    lastTick = now;
    stage.setTime(windClock);
    renderNow();
  }

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
    hook.backingW = canvas.width;
    hook.backingH = canvas.height;
    hook.pixelRatio = renderer.getPixelRatio();
    // 尺寸刚变的那一下先画出来，免得拖窗口时看到一格旧画面。
    renderNow();
  }

  // ⚠️ 用 ResizeObserver 而不是 `window.resize`：折叠日历栏这类**不改窗口尺寸**的
  //    版式变化一样会改变画布大小（P2-22 栽过），听窗口是听不到的。
  observer = new ResizeObserver(resize);
  observer.observe(el);
  resize();

  /** 纪律 2：软件切到后台（页面不可见）⇒ 停。 */
  const onVisibility = (): void => {
    hook.hidden = document.visibilityState === "hidden";
    syncLoop();
  };
  document.addEventListener("visibilitychange", onVisibility);

  /**
   * 纪律 3：系统"减弱动态效果"。⚠️ 本机这个开关**是开着的** ——
   * 所以不光是"读一次"，还得**听它的变化**（用户在系统里改了我们得立刻跟上）。
   */
  reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onReduce = (): void => {
    hook.reducedMotion = reduceQuery?.matches === true;
    syncLoop();
  };
  reduceQuery.addEventListener("change", onReduce);
  reduceCleanup = () => reduceQuery?.removeEventListener("change", onReduce);
  hook.reducedMotion = reduceQuery.matches;

  // 系统深浅主题一变，3D 那边的贴图/光色得跟着重做（CSS 变量管不到 canvas 里面）。
  themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onTheme = (): void => {
    stage?.applyTheme();
    // ⚠️ 换主题要重画贴图，静止状态下也得画一帧，否则看到的是旧主题的画面。
    if (!looping) renderNow();
  };
  themeQuery.addEventListener("change", onTheme);
  themeCleanup = () => themeQuery?.removeEventListener("change", onTheme);

  /** 纪律 4：设置页那个开关。 */
  watch(
    () => props.motion,
    (on) => {
      hook.motionPref = on;
      syncLoop();
    }
  );

  // 开局先按当前状态定一次（可能系统就开着"减弱动态效果"）。
  hook.motionPref = props.motion;
  syncLoop();

  cleanup = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    reduceCleanup?.();
    themeCleanup?.();
  };
});

onBeforeUnmount(() => {
  const hook = hookHost.__treeStage;
  if (hook) {
    hook.stopped = true;
    hook.stopFrame = hook.frames;
    hook.animating = false;
  }
  observer?.disconnect();
  observer = null;
  cleanup?.();
  cleanup = null;
  themeCleanup = null;
  themeQuery = null;
  reduceCleanup = null;
  reduceQuery = null;

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
  <div ref="host" class="tree-stage" role="img" aria-label="树语：一棵会随风轻摆的树"></div>
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
