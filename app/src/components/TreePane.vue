<script setup lang="ts">
/**
 * 「树语」的 3D 舞台。
 *
 * ⚠️ **本文件目前是"批次 1"的一次性探针** —— 它只回答一个问题：
 *    「3D（WebGL2）在 WebView2 里到底能不能跑、切走之后会不会停」。
 *    所以这儿画的是**一个转着的方块**，不是树。批次 2 会把方块换成真树，
 *    届时文件末尾那个 `__treeProbe` 调试钩子**一并删掉**（它只为自动验证存在）。
 *
 * ⛔ **第一期不许读日记数据、不许发任何后端命令** —— 树不接数据。
 * ⛔ **颜色一律从 CSS 变量取**（深浅两套主题各自成立），别在这儿写死色号。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import * as THREE from "three";

/** 场景挂载点。盒子多大由 CSS 决定，渲染器跟着它走。 */
const host = ref<HTMLDivElement | null>(null);

let renderer: THREE.WebGLRenderer | null = null;
let observer: ResizeObserver | null = null;
/** 卸载时要把几何 / 材质显式释放，否则切来切去会一直往显卡里堆东西。 */
let disposables: { dispose(): void }[] = [];

/** 探针钩子的宿主（批次 1 专用，见文件头）。 */
const probeHost = window as unknown as {
  __treeProbe?: { frames: number; stopped: boolean; stopFrame: number };
};

/**
 * 取一个界面颜色（`--xxx`）。
 *
 * ⚠️ 走变量而不是写死色号：这个软件是 `prefers-color-scheme` 驱动的深浅两套色，
 *    写死的话换主题时这一块会变成一个突兀的窟窿（热力图早年栽过这个坑）。
 */
function cssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

onMounted(() => {
  const el = host.value;
  if (!el) return;

  /**
   * 自动验证用的帧计数。⭐ **只能由"真的画了一帧"来加** ——
   * ⛔ 不许拿浏览器的动画帧冒充（那个即使 3D 已经停了也照样跳）。
   * 切走 ⇒ 本组件被卸载 ⇒ 循环停 ⇒ `frames` 必须**冻住**，这就是那条判据。
   */
  const probe = { frames: 0, stopped: false, stopFrame: -1 };
  probeHost.__treeProbe = probe;

  const scene = new THREE.Scene();
  // 底色跟界面走，否则深浅主题一切换，这块会拍在那儿一块死色。
  scene.background = new THREE.Color(cssColor("--bg", "#faf9f7"));

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.set(0, 2.2, 6);
  camera.lookAt(0, 1.1, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  // ⭐ 像素比封顶 2 倍：4K 屏上按 4 倍画＝白烧一倍显卡，肉眼看不出差别。
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  el.appendChild(renderer.domElement);

  // 天光打底 ＋ 一束方向光投影 —— 有影才"落地"，没影看着像贴在纸上。
  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4238, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(4, 8, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  const groundGeo = new THREE.PlaneGeometry(40, 40);
  const groundMat = new THREE.MeshStandardMaterial({
    color: cssColor("--surface", "#ffffff"),
    roughness: 1,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const boxGeo = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  const boxMat = new THREE.MeshStandardMaterial({
    color: cssColor("--accent", "#3f6f5f"),
    roughness: 0.55,
  });
  const box = new THREE.Mesh(boxGeo, boxMat);
  box.position.y = 1.3;
  box.castShadow = true;
  scene.add(box);

  disposables = [groundGeo, groundMat, boxGeo, boxMat];

  const fit = () => {
    if (!renderer) return;
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  fit();
  observer = new ResizeObserver(fit);
  observer.observe(el);

  renderer.setAnimationLoop(() => {
    probe.frames += 1;
    box.rotation.y += 0.012;
    renderer?.render(scene, camera);
  });
});

onBeforeUnmount(() => {
  /**
   * ⚠️ 顺序要紧：**先停循环、再释放** ——
   *    反过来的话会有一帧落在已经释放的几何体上（报错刷屏，还是在"看不见"的时候）。
   */
  const probe = probeHost.__treeProbe;
  if (probe) {
    probe.stopped = true;
    probe.stopFrame = probe.frames;
  }
  renderer?.setAnimationLoop(null);
  observer?.disconnect();
  observer = null;
  disposables.forEach((d) => d.dispose());
  disposables = [];
  if (renderer) {
    renderer.domElement.remove();
    renderer.dispose();
    renderer = null;
  }
});
</script>

<template>
  <div ref="host" class="tree-stage" role="img" aria-label="树语：一棵会随时间变化的树"></div>
</template>

<style scoped>
.tree-stage {
  width: 100%;
  /* 撑出"一整屏"的观感；内容区没有固定高度，所以给个下限兜住。 */
  min-height: 62vh;
  border-radius: 10px;
  overflow: hidden;
}

.tree-stage :deep(canvas) {
  display: block;
}
</style>
