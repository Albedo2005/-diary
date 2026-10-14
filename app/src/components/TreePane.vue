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
import { ringLayout, seasonMonths, type Ring } from "../tree/rings.ts";

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
  /**
   * ⭐ 调整轮新增：**树冠枝条的垂直角分布**（园艺学分档：直立／斜生／水平／下垂）。
   *
   * 为什么要把它放进钩子 —— 用户这一轮的核心要求是「**大部分向斜上方生长，
   * 一部分向平行于地面的四周生长，向下生长的不好看都被裁剪掉了**」。
   * 做成四个计数后，验收脚本就能**从真实 DOM 里直接读数**断言，
   * ⛔ 不用靠"我觉得这张图像真树"来判。
   */
  angleBins: { 直立: number; 斜生: number; 水平: number; 下垂: number };
  /** 树冠枝条垂直角的平均值（度）。 */
  angleMean: number;
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

  /* ── 第二期 · 年轮环 ─────────────────────────────────────────────
   * ⭐ 为什么要全放进钩子：这一期验的是**看得见的东西**（三圈在不在主干上、
   *    一样不一样大、点一下开不开）。光靠"看图觉得像"判不了，得能从真实
   *    DOM 里读数断言。⛔ 这些字段只读不改。
   */
  /** 三圈的条数（应当永远是 3）。 */
  ringCount: number;
  /** 三圈各自的半径 —— 验"一样大"。 */
  ringRadii: number[];
  /** 三圈的世界坐标（环心）—— 验"套在主干上"。 */
  ringPositions: { x: number; y: number; z: number }[];
  /**
   * 三圈**各自在屏幕上的中心点**（页面 CSS 像素）。
   * ⚠️ 验收脚本要按它在画布上**真的派发一次指针事件** —— 没有这个，
   *    就只能靠猜坐标，等于验了个寂寞。
   */
  ringScreen: { x: number; y: number }[];
  /** 三圈各是几月。 */
  ringMonths: number[];
  /** 三圈各有多少格（＝那个月的实际天数）。 */
  ringDays: number[];
  /** 现在开着哪一圈（`null` ＝ 全收回）。 */
  ringOpen: number | null;
  /** 鼠标现在悬在哪一圈上（`null` ＝ 没悬停）。 */
  ringHover: number | null;
  /** 拾取**命中**过多少次 —— 证明"指针事件真的接上了"，而不是个死场景。 */
  ringPickHits: number;
  /** 这个季度是哪三个月（`["2026-09","2026-10","2026-11"]`）—— 批次 2 接数据要用。 */
  ringMonthKeys: string[];
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

  /*
   * ⭐ 第二期：把年轮环摆到主干上。
   *   · **一棵树 ＝ 一个自然季**（今天 10 月 ⇒ 秋 **9 / 10 / 11** 三圈）；
   *   · 位置由 `rings.ts` 的纯函数算 —— 主干长度在 `grow.ts` 里带 ±5% 抖动，
   *     ⛔ 不能写死坐标；
   *   · ⚠️ 这一批（批次 1）**还没接数据**，环里全是暗格 —— 点亮是批次 2 的事。
   */
  const now = new Date();
  const ringMonthKeys = seasonMonths(now.getFullYear(), now.getMonth() + 1);
  const trunk = tree.branches.find((b) => b.depth === 0);
  const rings: Ring[] = trunk
    ? ringLayout(trunk.from, trunk.to, trunk.r0, trunk.r1, ringMonthKeys)
    : [];
  stage.setRings(rings);

  let maxSide = 0;
  for (const b of tree.branches) maxSide = Math.max(maxSide, Math.abs(b.to.x), Math.abs(b.to.z));

  /*
   * ⭐ 调整轮新增：算树冠枝条的**垂直角分布**（园艺学分档）。
   *    尺子：垂直角 ＝ 枝条与竖直主干的夹角。
   *      <30° 直立 ｜ 30~60° 斜生 ｜ 60~90° 水平 ｜ >90° 下垂（真树里要剪掉）。
   *    ⚠️ 只看 `depth ≥ 2` 的枝 —— 主干和它下面那一级是"骨架"，不算树冠形态。
   */
  const angleBins = { 直立: 0, 斜生: 0, 水平: 0, 下垂: 0 };
  let angleSum = 0;
  let angleN = 0;
  for (const b of tree.branches) {
    if (b.depth < 2) continue;
    const dy = b.to.y - b.from.y;
    const len = Math.hypot(b.to.x - b.from.x, dy, b.to.z - b.from.z);
    if (len < 1e-9) continue;
    const deg = (Math.acos(Math.max(-1, Math.min(1, dy / len))) * 180) / Math.PI;
    angleSum += deg;
    angleN++;
    if (deg < 30) angleBins.直立++;
    else if (deg < 60) angleBins.斜生++;
    else if (deg <= 90) angleBins.水平++;
    else angleBins.下垂++;
  }

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
    angleBins,
    angleMean: angleN > 0 ? angleSum / angleN : 0,
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
    // ── 第二期 · 年轮环 ──
    ringCount: rings.length,
    ringRadii: rings.map((r) => r.radius),
    ringPositions: rings.map((r) => ({ x: r.center.x, y: r.center.y, z: r.center.z })),
    ringScreen: [],
    ringMonths: rings.map((r) => r.month),
    ringDays: rings.map((r) => r.days),
    ringOpen: null,
    ringHover: null,
    ringPickHits: 0,
    ringMonthKeys,
  };
  hookHost.__treeStage = hook;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  /*
   * D4：**画质按屏幕密度封顶 2 倍**。不封顶的话 4K 屏会傻乎乎按 4 倍画，白烧一倍显卡。
   * ⚠️ 调整轮：这里的**初值**保留（挂载时先按当前屏画一帧），但真正的
   *    "封顶"改由 `resize()` 每次重算 —— 见那个函数里的注释（换显示器的问题）。
   */
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // D2：地上一片淡淡的树影 —— "像不像真的"里性价比最高的一项。
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  el.appendChild(canvas);

  /**
   * 把三圈的**环心**投到屏幕上（页面 CSS 像素），写进钩子。
   *
   * ⭐ 这是给**自动验收**用的：脚本拿到这个点，就能在画布上**真的派发一次
   *    指针事件** —— 而不是靠猜坐标（猜坐标等于没验）。
   * ⚠️ 只在 `resize()` 之后更新：它要 `getBoundingClientRect()`，每帧调会拖帧
   *    （跟环的颜色同一个道理）。
   */
  function updateRingScreen(): void {
    const st = stage;
    const cv = renderer?.domElement;
    if (!st || !cv) return;
    const rect = cv.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    st.camera.updateMatrixWorld();
    const p = new THREE.Vector3();
    hook.ringScreen = rings.map((r) => {
      p.set(r.center.x, r.center.y, r.center.z).project(st.camera);
      return {
        x: rect.left + ((p.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - p.y) / 2) * rect.height,
      };
    });
  }

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

  /**
   * 年轮环的状态刚变了一下 —— 如果现在**是停着的**，必须补画一帧。
   *
   * ⚠️ 停着的原因有三种（系统「减弱动态效果」／设置页那个开关关了／切到别的 tab），
   *    那时**没有任何东西在画**。不补这一帧，用户点半天画面纹丝不动 ——
   *    看着就像"点不动"，功能其实是对的。
   * ⚠️ 这也是验收脚本 M14 能成立的前提：静止态下比"点开前 / 点开后"两张像素，
   *    画面必须真的变（否则那条会红，而且红得莫名其妙）。
   */
  function paintIfStill(): void {
    if (looping) return; // 动画循环在跑，它下一帧自己会画
    renderNow();
  }

  /** 画布尺寸 → 渲染器 + 相机取景。⭐ "全屏时等比例放大"就发生在这一条路上。 */
  function resize(): void {
    const box = host.value;
    if (!box || !renderer || !stage) return;
    const w = Math.max(1, box.clientWidth);
    const h = Math.max(1, box.clientHeight);
    /*
     * ⭐ 调整轮：**把"画质封顶"挪进 `resize()`**（用户拍板"换显示器那条也补"）。
     *
     * ⚠️ 原来它只在挂载时算一次（`renderer.setPixelRatio(...)` 那一行），
     *    所以**把窗口拖到另一块缩放比不同的屏幕上时，画布不会按新密度重画**
     *    —— 现象是字和叶子在新屏幕上发虚／发糊。
     * ⭐ 放在这里就跟着 `ResizeObserver` 一起跑：换屏通常伴随可用尺寸变化，
     *    所以几乎一定会触发；即使尺寸恰好不变，下面的 `setSize` 也会接着重算。
     * ⚠️ 上限仍是 **2**（D4 定的），只是现在**每次都重新读一遍** `devicePixelRatio`。
     */
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
    // 三圈的屏幕位置也跟着尺寸变 —— 验收脚本要靠它定位。
    updateRingScreen();
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

  /*
   * ── 第二期 · 指针（点树出年轮） ────────────────────────────────────
   * ⚠️ 归一化坐标一律用 `getBoundingClientRect()` 换算 —— ⛔ 不用
   *    `canvas.width/height`（那是**背衬**尺寸，差一个屏密度倍率；第一期栽过）。
   * ⚠️ 要区分**点击**和**拖拽**：位移超过几个像素就当作拖拽、不触发展开
   *    （不然以后加了转视角，一拖动就把年轮点开了）。
   */
  const DRAG_PX = 8;
  let pointerDown: { x: number; y: number } | null = null;

  function toNdc(ev: PointerEvent): { nx: number; ny: number } | null {
    const el = renderer?.domElement;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      nx: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      ny: -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    };
  }

  function onPointerMove(ev: PointerEvent): void {
    if (!stage) return;
    const at = toNdc(ev);
    if (!at) return;
    const hit = stage.pickRing(at.nx, at.ny);
    hook.ringHover = hit;
    if (hit !== null) hook.ringPickHits += 1;
    stage.setRingHover(hit);
    // ⚠️ 光标只改在**画布**上（改容器会把整个组件的鼠标样式一起改了）
    canvas.style.cursor = hit === null ? "" : "pointer";
    paintIfStill(); // 停着的时候得补一帧，否则"亮起来"看不见
  }

  function onPointerDown(ev: PointerEvent): void {
    pointerDown = { x: ev.clientX, y: ev.clientY };
  }

  function onPointerUp(ev: PointerEvent): void {
    const down = pointerDown;
    pointerDown = null;
    if (!down || !stage) return;
    // ⚠️ 位移 > 8px ⇒ 当作拖拽，不算点击（见上面那条说明）
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > DRAG_PX) return;
    const at = toNdc(ev);
    if (!at) return;
    const hit = stage.pickRing(at.nx, at.ny);
    if (hit !== null) hook.ringPickHits += 1;
    /*
     * ⭐ 点击口径（第二期指令 B 段）：
     *   · 点空白（含树干）⇒ 全收回；
     *   · 点某一圈 ⇒ 开那一圈；**再点同一圈 ⇒ 收回**；点另一圈 ⇒ 换成那一圈；
     *   · ⚠️ 同时**只开一圈**。
     */
    const open = hook.ringOpen;
    const next = hit === null ? null : open === hit ? null : hit;
    hook.ringOpen = next;
    stage.setRingOpen(next);
    paintIfStill(); // 同上：停着的时候得补一帧
  }

  /** 鼠标离开画布 ⇒ 只是不再"悬停"，⛔ 不收回已经点开的那一圈。 */
  function onPointerLeave(): void {
    pointerDown = null;
    hook.ringHover = null;
    stage?.setRingHover(null);
    canvas.style.cursor = "";
    paintIfStill(); // 停着的时候得补一帧，否则"提亮"会留在画面上
  }

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("pointercancel", onPointerLeave);

  cleanup = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("pointercancel", onPointerLeave);
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
