/**
 * 「树语动不动」这个偏好的单测（零依赖，Node 22 原生跑 `.ts`）。
 *
 * ⚠️ 跑法：在 `app/` 下 `pnpm test:fe`。
 *
 * ⭐ 这里守的是**兜底方向**，不是"能读能写" —— 能读能写谁都会，
 *    难的是"存的东西坏了 / 读不了的时候，用户看到的是哪一版界面"。
 *    本项目的口径：**只有明确那一个值才算数，其余一切走兜底**。
 * ⚠️ Node 默认没有 `localStorage` 这个全局对象 ⇒ 下面自己造一个假的塞进去；
 *    这同时也顺便验了「完全没有存储时」的那条兜底路径。
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { MOTION_KEY, readTreeMotion, writeTreeMotion } from "../src/tree/motion.ts";

type Fake = { store: Map<string, string> };

/** 塞一个最小的假存储（顺便把真的那个（如果有）顶掉）。 */
function installStorage(opts: { throwOnWrite?: boolean } = {}): Fake {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string): void => {
        if (opts.throwOnWrite) throw new Error("配额满了");
        store.set(k, String(v));
      },
      removeItem: (k: string): void => {
        store.delete(k);
      },
    },
  });
  return { store };
}

/** 把假存储摘掉，回到「这台机器根本没有存储」的状态。 */
function uninstallStorage(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

test("什么都没有时 ⇒ 兜底是「开着」（这个功能的意思就是它会摆）", () => {
  uninstallStorage();
  assert.equal(readTreeMotion(), true, "没有存储时应该退回「开着」");
  const { store } = installStorage();
  assert.equal(store.size, 0);
  assert.equal(readTreeMotion(), true, "存了个空 ⇒ 仍然应该是开着");
});

test("只有精确的 0 才算关掉", () => {
  const { store } = installStorage();
  store.set(MOTION_KEY, "0");
  assert.equal(readTreeMotion(), false, "写成 0 应该读成「关掉」");
  store.set(MOTION_KEY, "1");
  assert.equal(readTreeMotion(), true, "写成 1 应该读成「开着」");
});

test("垃圾值一律走兜底（⛔ 不是非真即假）", () => {
  const { store } = installStorage();
  for (const junk of ["", "yes", "false", "2", "01", "0 ", "null"]) {
    store.set(MOTION_KEY, junk);
    assert.equal(readTreeMotion(), true, `垃圾值 ${JSON.stringify(junk)} 不该把动效关掉`);
  }
});

test("写进去读得回来，而且键与取值都是约定好的那个", () => {
  const { store } = installStorage();
  writeTreeMotion(false);
  assert.equal(store.get(MOTION_KEY), "0", "关掉时应该往 diary.tree-motion 写 0");
  assert.equal(readTreeMotion(), false);
  writeTreeMotion(true);
  assert.equal(store.get(MOTION_KEY), "1");
  assert.equal(readTreeMotion(), true);
});

test("存储坏掉（写抛异常）也不许把动作打断，读到的仍走兜底", () => {
  installStorage({ throwOnWrite: true });
  assert.doesNotThrow(() => writeTreeMotion(false), "写失败不该抛出去打断用户的点击");
  assert.equal(readTreeMotion(), true, "没写成功 ⇒ 读到的应该是兜底值（开着）");
});
