/*
 * 3.16 —— 【P2-20】搜索历史 ＋ 【P2-2 追加】启动画面至少停 1 秒。
 *
 * ⚠️ 这一版有**两件事**，合记一个版本号（P2-2 追加是"已交付项的微调、不单独占号"）。
 *
 * 一、【P2-20】搜索历史
 *   ① 搜过的词自动记下来（回车、点胶囊都算），**最新的排最前**；
 *   ② 存**加密库**（`app_setting` 表的 `search_history` 键，值是 JSON 数组）
 *      —— ⛔ 不进 `localStorage`（搜索词往往就是日记里的字）；
 *   ③ 去重（再搜同一个词 ⇒ 挪到最前、不重复）＋ 上限 20 条；
 *   ④ trim 后为空、或超过 50 字的查询**不记**；
 *   ⑤ 让位规则：**搜过就让位**（连"一条都没搜到"也算搜过 ⇒ 历史整块收起），
 *      点输入框的 × 清空后才回来；
 *   ⑥ 位置：**紧贴搜索框正下方**（搜索框 → 搜索历史 → 状态提示 → 结果列表）。
 *
 * 二、【P2-2 追加】启动画面**至少**停 1 秒
 *   ① 用 `Math.max(0, 1000 - performance.now())` **抵扣**已经花掉的启动时间
 *      —— ⛔ 不是 `setTimeout(…, 1000)`（那会变成"启动耗时 ＋ 1 秒"）；
 *   ② 呼吸动画**纯 CSS**、只动透明度、尊重 `prefers-reduced-motion`。
 *
 * ⚠️ 这一份是**从 3.15 那份整份拿过来的**：3.13 的 116 条 ＋ 3.14 的 46 条
 *    ＋ 3.15 的 O 组必须**照样全绿** —— 本件只在搜索页加了一块历史区、
 *    在启动画面加了个等待，其它地方一个字节没动。
 *    新增部分见末尾的 **P 组**（搜索历史）＋ **Q 组**（启动画面）。
 *
 * ⚠️ 与上一版一样，**验收对象必须是发布件本身**（`发布\日记.exe`）——
 *    验过的那个必须等于用户拿到的那个。
 *
 * 铁律遵循（技能 `tauri-webview2-ui-verify`）：
 *   · 一次性临时目录（且要清 `localStorage`，否则上一轮的界面偏好让人误判）；
 *   · 钉主题用 `Emulation.setEmulatedMedia`；
 *   · 等状态变化要**亲眼看它经过中间态**（⭐ 异步搜索必须先清空再搜，见铁律 13）；
 *   · 判据必须**有反向对照**。
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = "D:\\Users\\Lenovo\\Desktop\\Diary";
// ⚠️ 可以用 `DIARY_EXE` 覆盖 —— 铁律：**验收对象必须是"用户拿到的那个文件"**。
//     `tauri build` 的产物与裸 `cargo build` 的产物**体积不同**（3.13 那次差 32,256 字节）
//     ⇒ 验过的那个不等于用户拿到的那个 ⇒ 最后一遍必须钉在 `发布\日记.exe` 上。
const EXE = process.env.DIARY_EXE || (() => {
  const pub = path.join(REPO, "发布", "日记.exe");
  return fs.existsSync(pub) ? pub : path.join(REPO, "target", "release", "app.exe");
})();
const ROOT = path.join(REPO, "_ui-verify-316");
const PIN = "135790";
const PORT = 9386;
/** 本版版本号 —— 界面【关于】里显示的应当是它。
 *  ⚠️ 三处版本号里**只有 `app/package.json` 能写两段**（`"3.16"`）；
 *     `tauri.conf.json` 与 `Cargo.toml` 必须三段（`3.16.0`），否则 cargo 拒绝加载 manifest。 */
const EXPECT_VERSION = "3.16";

const results = [];
function rec(k, v) {
  results.push([k, v]);
  console.log(`  [${k}] ${typeof v === "string" ? v : JSON.stringify(v)}`);
}
let bad = 0;
function ok(cond, k, v) {
  if (!cond) bad++;
  rec(`${cond ? "OK  " : "FAIL"} ${k}`, v);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(script) {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  try {
    return execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return `PS_ERROR: ${String((e && e.message) || e).slice(0, 200)}`;
  }
}

function killLeftovers() {
  return ps(`
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*com.dsh.diary*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++ } catch {} }
$exe = '${EXE}'
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
  try { if ($p.Path -eq $exe) { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed++ } } catch {}
}
"killed=$killed"
`);
}

async function findTarget(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(
        (t) => t.type === "page" && t.url && t.url !== "about:blank" && !t.url.startsWith("devtools")
      );
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`端口 ${port} 上始终没有可用的 page 目标`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    let closed = false;
    const failAll = (why) => {
      closed = true;
      for (const [, { rej }] of pending) rej(new Error(why));
      pending.clear();
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      }
    };
    ws.onerror = () => reject(new Error("WebSocket 连接失败"));
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            if (closed) return rej(new Error("CDP 已关闭（应用可能已退出）"));
            const i = ++id;
            let done = false;
            const timer = setTimeout(() => {
              if (done) return;
              done = true;
              pending.delete(i);
              rej(new Error(`CDP 超时未回包: ${method}`));
            }, 6000);
            pending.set(i, {
              res: (v) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                res(v);
              },
              rej: (e) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                rej(e);
              },
            });
            try {
              ws.send(JSON.stringify({ id: i, method, params }));
            } catch (e) {
              done = true;
              clearTimeout(timer);
              pending.delete(i);
              rej(new Error(`CDP 发送失败: ${String((e && e.message) || e)}`));
            }
          });
        },
        isClosed: () => closed,
        close: () => ws.close(),
      });
    ws.onclose = () => failAll("CDP 连接已关闭（应用可能已退出）");
  });
}

async function evalFn(client, fn, ...args) {
  const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await client.send("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result ? r.result.value : null;
    } catch (e) {
      lastErr = e;
      await sleep(400);
    }
  }
  throw lastErr;
}

async function waitFor(client, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = null;
    try {
      v = await evalFn(client, fn);
    } catch {
      /* 页面可能正忙 */
    }
    if (v) return { ok: true, value: v, ms: Date.now() - t0 };
    await sleep(400);
  }
  return { ok: false, value: null, ms: Date.now() - t0 };
}

/**
 * ⭐ 确保编辑器处于**可编辑**态（铁律 8：本软件每次 `load()` 都 `lockAllEntries()`，
 * 所以"切了日期 / 重挂了组件 / 重启"之后一律回到锁定态）。
 *
 * ⛔ 不复用这个函数、直接 `Input.insertText` 或点工具栏按钮的话：
 *    · `Input.insertText` 走真实输入管线，`contenteditable=false` 时**一个字符都进不去**；
 *    · 工具栏按钮此时是 `disabled`，`el.click()` 是空操作。
 *    于是所有"打字 / 加粗"类断言会**假红**（看着像应用坏了，其实是脚本没解锁）。
 */
async function ensureUnlocked(client, label) {
  // 先等编辑器挂出来（否则 `contenteditable` 读到 null，判不出方向）。
  await waitFor(client, () => !!document.querySelector(".rich-body .tiptap, .rich-body .ProseMirror"), 8000);
  const lk = await evalFn(client, R_locked);
  if (lk.contenteditable === "true") {
    return { ok: true, note: `本来就开着(${label}) contenteditable=true 按钮=${lk.lockBtn}` };
  }
  // ⛔ 只有**明确读到 false**（= 锁着）才去点解锁。
  //    读到 null（编辑器还没挂）时盲点一下会把"本来就开着"反锁上。
  if (lk.contenteditable !== "false") {
    return { ok: false, note: `读不到可编辑态(${label}): ${JSON.stringify(lk.contenteditable)}` };
  }
  await evalFn(client, A_toggleLock);
  const opened = await waitFor(
    client,
    () => {
      const b = document.querySelector(".rich-body .tiptap, .rich-body .ProseMirror");
      return b && b.getAttribute("contenteditable") === "true";
    },
    10000
  );
  return { ok: opened.ok, note: opened.ok ? `已解锁(${label})` : `解锁失败(${label})` };
}

// --------------------------------------------------------------------------
// 页面侧探针（自包含，不依赖页面里的任何变量）
// --------------------------------------------------------------------------

/** 建库 / 解锁。 */
const P_init = async (pin) => {
  const out = [];
  const rec = (k, v) => out.push([k, v]);
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  if (q("input.pin-input")) {
    const ins = qa("input.pin-input");
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      s.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    if (ins.length >= 2) {
      set(ins[0], pin);
      set(ins[1], pin);
      await nap(400);
      const b = qa("button").find((x) => /创建日记|解锁|进入/.test(x.textContent));
      if (b) b.click();
      rec("path", "建库（两个输入框）");
    } else {
      set(ins[0], pin);
      await nap(400);
      const b = qa("button").find((x) => /解锁|进入/.test(x.textContent));
      if (b) b.click();
      rec("path", "解锁（一个输入框）");
    }
  } else {
    rec("path", "无锁屏");
  }

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (q(".topbar")) {
      rec("boot", `顶栏出现（${Date.now() - t0}ms）`);
      return out;
    }
    await nap(400);
  }
  rec("boot", "顶栏始终没出现");
  return out;
};

/** 切到「写日记」并等编辑器就绪（铁律 20：先等中间态、再等终态）。 */
const S_write = async () => {
  const out = [];
  const rec = (k, v) => out.push([k, v]);
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  const tab = qa("nav.tabs button").find((x) => x.textContent.includes("写日记"));
  if (!tab) {
    rec("tab", "找不到「写日记」按钮");
    return out;
  }
  tab.click();

  // ⭐ 第 2 步起编辑器是 Tiptap：要等的是 `.tiptap`（ProseMirror 根）真的挂进
  //    `.rich-body` —— 只看 `.rich-body` 会被"空壳"骗过（踩过：探针读到空的
  //    `.rich-body`、连 `.tiptap` 都没有）。
  // 等占位挂出 —— 可能一闪而过，允许 MISS（但记下来）。
  let sawPlaceholder = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 3500) {
    if (q(".editor p.is-editor-empty")) {
      sawPlaceholder = true;
      break;
    }
    await nap(80);
  }

  const t1 = Date.now();
  while (Date.now() - t1 < 15000) {
    if (q(".rich-body .tiptap") || q(".rich-body .ProseMirror")) {
      rec("ready", `编辑器就绪（${Date.now() - t1}ms, sawPlaceholder=${sawPlaceholder}）`);
      return out;
    }
    await nap(150);
  }
  rec("ready", "编辑器始终没就绪（.tiptap 没挂出来）");
  return out;
};

/** 读编辑器的完整状态（第 2 步的核心探针）。 */
const R_editor = async () => {
  const q = (s) => document.querySelector(s);
  // ⛔ 判"编辑器在"必须是 Tiptap 的根（.tiptap / .ProseMirror），
  //    裸 `.rich-body` 空壳也命中 —— 那是判据漏洞（踩过一次）。
  const body =
    q(".rich-body .tiptap") || q(".rich-body .ProseMirror");
  const paper = q(".editor .paper");
  const toolbar = q(".toolbar");
  if (!body) return { found: false, legacyTextarea: !!q("textarea.content-input") };

  const cs = getComputedStyle(body);
  const pcs = paper ? getComputedStyle(paper) : null;
  const btns = toolbar ? Array.from(toolbar.querySelectorAll(".tool-btn")) : [];
  const sels = toolbar ? Array.from(toolbar.querySelectorAll(".tool-select")) : [];

  return {
    found: true,
    html: body.innerHTML,
    text: body.innerText,
    editable: body.getAttribute("contenteditable"),
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    lineHeight: cs.lineHeight,
    paperBg: pcs ? pcs.backgroundColor : "",
    paperRadius: pcs ? pcs.borderRadius : "",
    hasToolbar: !!toolbar,
    toolButtons: btns.map((b) => b.textContent.trim()),
    toolSelects: sels.map((s) => ({
      title: s.getAttribute("title"),
      value: s.value,
      options: Array.from(s.options).map((o) => o.textContent.trim()),
      disabled: s.disabled,
    })),
    hasPlaceholderAttr: !!body.querySelector("p.is-editor-empty"),
    legacyTextarea: !!q("textarea.content-input"),
  };
};

/**
 * ⭐ 用 CDP 的 `Input.insertText` 真输入一段文字，然后等它落库。
 *
 * 拆成"页面侧准备 + Node 侧输入"两步，是因为 `Input.insertText` 是
 * CDP 域的方法、**在页面里调不到**（页面里只有 `Runtime`）。
 */
async function typeAndWait(client, text) {
  // 先选中全部（这样插进去的内容会替换掉旧的）。
  await evalFn(client, async () => {
    const body =
      document.querySelector(".rich-body .tiptap") ||
      document.querySelector(".rich-body .ProseMirror");
    if (!body) return false;
    body.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(body);
    sel.removeAllRanges();
    sel.addRange(range);
    await new Promise((r) => setTimeout(r, 120));
    return true;
  });
  await client.send("Input.insertText", { text });
  await sleep(300);

  // 两段式等落库。
  // ⚠️ 判定跑在**页面里**（用 evalFn），⛔ 不能在 Node 侧读 `document` —— 踩过一次。
  let sawPending = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    const t = await evalFn(client, () => document.body.innerText);
    if (/未保存|保存中/.test(t)) {
      sawPending = true;
      break;
    }
    await sleep(60);
  }
  const t1 = Date.now();
  while (Date.now() - t1 < 12000) {
    const t = await evalFn(client, () => document.body.innerText);
    if (/已保存/.test(t)) break;
    await sleep(150);
  }
  return { sawPending, ms: Date.now() - t1 };
}

/**
 * ⭐ 取 IPC 的 `invoke`。
 *
 * ⚠️ 本项目的 `tauri.conf.json` **没有开 `withGlobalTauri`** ⇒ `window.__TAURI__`
 *    **不存在**（默认 false）。真正的通道是 `window.__TAURI_INTERNALS__.invoke`。
 *    ⛔ 只写 `window.__TAURI__.core.invoke` 会得到 `undefined`，
 *       然后所有读库 / 塞库的断言集体假红（踩过，28 条里大半是这条引起的连锁）。
 * ⚠️ 这个函数必须在**每个页面侧探针内部**再写一遍 —— 探针是 `toString()` 之后
 *    丢进页面执行的，**闭包里的东西在页面里根本不存在**（踩过：`pickInvoke is not defined`）。
 */

/** 从库里读正文（走真实 IPC）。 */
const R_dbBody = async (date) => {
  try {
    const inv =
      (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) ||
      (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
      null;
    if (!inv) return { error: "没有 IPC 通道（__TAURI_INTERNALS__ / __TAURI__ 都没有）" };
    const e = await inv("open_entry", { date });
    return { content_md: e.content_md, word_count: e.word_count, id: e.id, title: e.title };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
};

/** 直接调 save_entry（给"塞一篇旧日记"用）。 */
const A_seedPlain = async (date, text) => {
  try {
    const inv =
      (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) ||
      (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
      null;
    if (!inv) return { ok: false, error: "没有 IPC 通道" };
    const e = await inv("save_entry", {
      date,
      title: "旧日记",
      contentMd: text,
      mood: null,
    });
    return { ok: true, stored: e.content_md, words: e.word_count };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};

/** 同上，但内容**原样**塞（不做任何处理）—— 给"塞脏 HTML 看它怎么被洗"用。 */
const A_seedRaw = async (date, raw) => {
  try {
    const inv =
      (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) ||
      (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
      null;
    if (!inv) return { ok: false, error: "没有 IPC 通道" };
    const e = await inv("save_entry", {
      date,
      title: "脏数据",
      contentMd: raw,
      mood: null,
    });
    return { ok: true, stored: e.content_md, words: e.word_count };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};

/** 工具栏按钮的激活态 + 下拉当前值。 */
const R_marks = async () => {
  const tb = document.querySelector(".toolbar");
  if (!tb) return { found: false };
  const get = (cls) => {
    const b = tb.querySelector(".tool-btn." + cls);
    return b ? b.classList.contains("on") : null;
  };
  const sel = tb.querySelectorAll(".tool-select");
  return {
    found: true,
    bold: get("bold"),
    italic: get("italic"),
    underline: get("underline"),
    strike: get("strike"),
    font: sel[0] ? sel[0].value : null,
    size: sel[1] ? sel[1].value : null,
  };
};

/** 点工具栏按钮。 */
const A_clickTool = async (which) => {
  const tb = document.querySelector(".toolbar");
  if (!tb) return "no-toolbar";
  let el = null;
  if (["bold", "italic", "underline", "strike"].includes(which)) {
    el = tb.querySelector(".tool-btn." + which);
  } else if (which === "clear") {
    el = tb.querySelector(".tool-btn.clear");
  }
  if (!el) return "not-found";
  if (el.disabled) return "disabled";
  el.click();
  await new Promise((r) => setTimeout(r, 400));
  return "clicked";
};

/** 全选正文。 */
const A_selectAll = async () => {
  const body =
    document.querySelector(".rich-body .tiptap") ||
    document.querySelector(".rich-body .ProseMirror");
  if (!body) return "no-body";
  body.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(body);
  sel.removeAllRanges();
  sel.addRange(range);
  await new Promise((r) => setTimeout(r, 250));
  return sel.toString().length;
};

/** 只选前 N 个字符（验"只有选中那段被加粗"）。 */
const A_selectFirst = async (n) => {
  const body =
    document.querySelector(".rich-body .tiptap") ||
    document.querySelector(".rich-body .ProseMirror");
  if (!body) return "no-body";
  body.focus();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.nodeValue.trim().length === 0) node = walker.nextNode();
  if (!node) return "no-text";
  const len = Math.min(n, node.nodeValue.length);
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, len);
  sel.removeAllRanges();
  sel.addRange(range);
  await new Promise((r) => setTimeout(r, 250));
  return sel.toString();
};

/** 切字体 / 字号下拉。 */
const A_setSelect = async (idx, value) => {
  const tb = document.querySelector(".toolbar");
  if (!tb) return "no-toolbar";
  const sel = tb.querySelectorAll(".tool-select")[idx];
  if (!sel) return "no-select";
  if (sel.disabled) return "disabled";
  sel.value = value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  return sel.value;
};

/** 读锁定态。 */
const R_locked = async () => {
  const body =
    document.querySelector(".rich-body .tiptap") ||
    document.querySelector(".rich-body .ProseMirror");
  const paper = document.querySelector(".editor .paper");
  const tb = document.querySelector(".toolbar");
  const btns = tb ? Array.from(tb.querySelectorAll(".tool-btn")) : [];
  const lockBtn = Array.from(document.querySelectorAll(".editor button.toggle")).find((x) =>
    /🔒|🔓/.test(x.textContent)
  );
  return {
    contenteditable: body ? body.getAttribute("contenteditable") : null,
    paperLockedClass: paper ? paper.classList.contains("locked") : null,
    // 界面自己怎么说（按钮文案）—— 用来跟 contenteditable 对账。
    lockBtn: lockBtn ? lockBtn.textContent.trim() : "(no lock btn)",
    toolDisabled: btns.length > 0 ? btns[0].disabled : null,
    canSelect: (() => {
      if (!body) return null;
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(body);
        sel.removeAllRanges();
        sel.addRange(range);
        return sel.toString().length;
      } catch {
        return -1;
      }
    })(),
  };
};

/** 点界面上的锁定 / 解锁按钮。
 *
 *  ⭐ 必须精确定位到"正文那半"的锁定开关：
 *    ⛔ 全页扫 `/锁定/` 会先撞上顶栏那个全局「锁定」按钮（点它是"拉帘子"，
 *       不是"切换这一篇的锁"），判据会张冠李戴；
 *    ⛔ `.editor .toggle` 也不行 —— 那两个 `.toggle` 里第一个是「🖼 插入图片」。
 *    所以：限定在 `.editor button.toggle` 里，再按 `🔒/🔓` 图标挑。
 */
const A_toggleLock = async () => {
  const cands = Array.from(document.querySelectorAll(".editor button.toggle"));
  const b = cands.find((x) => /🔒|🔓/.test(x.textContent));
  if (!b) return "not-found";
  const before = b.textContent.trim();
  if (b.disabled) return `disabled(${before})`;
  b.click();
  await new Promise((r) => setTimeout(r, 1500));
  return `${before} -> ${b.textContent.trim()}`;
};

/** 切离开「写日记」再切回来 —— 逼 `EditorPane` 卸载重挂、重走一次 `load()`。 */
const A_reloadByTab = async () => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const away = qa("nav.tabs button").find((x) => /搜索|年轮|筛选/.test(x.textContent));
  if (!away) return "no-away-tab";
  away.click();
  await nap(700);
  const back = qa("nav.tabs button").find((x) => x.textContent.includes("写日记"));
  if (!back) return "no-write-tab";
  back.click();
  // 等 `.tiptap` 重新挂出来。
  for (let i = 0; i < 60; i++) {
    if (document.querySelector(".rich-body .tiptap, .rich-body .ProseMirror")) return "reloaded";
    await nap(150);
  }
  return "reload-timeout";
};

/** 点日历上某一天（按"日"号找格）。
 *
 *  ⚠️ 这里**只点一下、立刻返回**，⛔ 不在页面里做长等待 ——
 *    `Runtime.evaluate` 的一次调用有 CDP 超时（6 秒），
 *    页面里 `await` 15 秒会直接抛 `CDP 超时未回包`（踩过）。
 *    要等的话走 Node 侧的 `waitFor`（见调用处）。
 */
const A_openDate = async (date) => {
  const dayNum = String(Number(date.slice(8, 10)));
  const cells = Array.from(document.querySelectorAll("button.cell"));
  const el = cells.find((c) => {
    const m = c.textContent.trim().match(/^(\d+)/);
    return m && m[1] === dayNum;
  });
  if (!el) return `no-cell(day=${dayNum}, cells=${cells.length})`;
  el.click();
  return `clicked:${dayNum}`;
};

/** 读编辑器里**看得见的文字**（用于"旧日记原样显示"的比对）。 */
const R_editorText = async () => {
  const body = document.querySelector(".rich-body .tiptap, .rich-body .ProseMirror");
  if (!body) return null;
  return { text: body.innerText, html: body.innerHTML };
};

/**
 * ⛔ **不要再用"给 IPC 装记录器"这一招查"谁在写库"—— 拦不到。**
 *
 * 试过：把 `window.__TAURI_INTERNALS__.invoke` 换成带日志的包装函数。
 * 结果 `save_entry` 明明被调用了（库里数据确实变了），日志却**一条都没有**：
 * 应用是在模块初始化时就把 `invoke` 取走/绑定了，之后不走 `window` 上那个属性。
 *
 * ✅ 要查"谁改的库"，改用这两种办法（本项目都验证有效）：
 *    · **看现象的时间线**（保存标签 pending→消失/已保存 的**中间态**），
 *      从"哪一个状态分支能产生这个现象"反推（见 _probe-db.cjs 的用法）；
 *    · **直接读库对照**（`R_dbBody` 读同一个日期，前后对比）。
 */
const A_hookIpc = async () => {
  const I = window.__TAURI_INTERNALS__;
  if (!I || !I.invoke) return "no-internals";
  if (I.invoke.__hooked) return "already";
  const orig = I.invoke.bind(I);
  const logs = [];
  window.__IPCLOG = logs;
  const WRITES = ["save_entry", "delete_entry", "set_entry_locked", "lock_all_entries"];
  const wrapped = async (cmd, args) => {
    const r = await orig(cmd, args);
    if (WRITES.includes(cmd)) {
      let a = null;
      try { a = JSON.parse(JSON.stringify(args ?? {})); } catch { a = String(args); }
      logs.push({
        cmd,
        date: a && a.date,
        contentMd: a && typeof a.contentMd === "string" ? a.contentMd.slice(0, 120) : undefined,
        locked: a && a.locked,
        at: Date.now(),
      });
    }
    return r;
  };
  wrapped.__hooked = true;
  I.invoke = wrapped;
  return "hooked";
};

/** 读 IPC 记录（⚠️ 一般是空的 —— 见上面 A_hookIpc 的说明）。 */
const R_ipcLog = async () => window.__IPCLOG || [];

/* ---------------------------------------------------------------------------
 * L 组用：搜索（【P2-3】第 3 步 —— 摘要必须是"看得见的文字"）
 * ------------------------------------------------------------------------- */

/** 切到「搜索」tab、填词、回车 —— **只点一下就返回**。
 *
 *  ⚠️ 长等待一律交给 Node 侧 `waitFor`：`Runtime.evaluate` 一次调用有 6 秒
 *     超时，页面里 `await` 十几秒会直接抛 `CDP 超时未回包`（踩过）。
 */
const A_search = async (term) => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = qa("nav.tabs button").find((x) => x.textContent.includes("搜索"));
  if (!tab) return "no-search-tab";
  tab.click();
  await nap(600);
  const input =
    document.querySelector("input.input[type=search]") || document.querySelector(".search input");
  if (!input) return "no-input";
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(input, term);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // `@keyup.enter="run"` —— 直接回车，不必等防抖那条路。
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  return `submitted:${term}`;
};

/** 读搜索结果：摘要文字（已拼好）+ 高亮片段 + 提示语。 */
const R_search = async () => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const snippets = qa(".search .item-snippet").map((x) => x.textContent);
  const marks = qa(".search .item-snippet mark").map((x) => x.textContent);
  const noteEl = qa(".search .note")[0] || null;
  return {
    note: noteEl ? noteEl.textContent.trim() : null,
    count: snippets.length,
    snippets,
    marks,
  };
};

/** 切到「设置」→「关于」，读那几行只读信息（验收版本号就一条）。 */
const R_aboutVersion = async () => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  // ⚠️ 设置**不是顶栏的 tab，是一个弹窗** —— 入口是右上角那个 `title="设置"` 的按钮
  //    （顶栏 tab 只有 写日记 / 搜索 / 年轮 / 筛选 四个，`nav.tabs` 里没有「设置」）。
  const openBtn = document.querySelector('button[title="设置"]');
  if (!openBtn) return { error: "no-settings-button" };
  openBtn.click();
  await nap(900);
  // 弹窗左侧分类导航里的「关于」（文本**恰好**是这两个字，避开标题与说明）。
  const about = qa("nav.side button").find((x) => x.textContent.trim() === "关于");
  if (about) {
    about.click();
    await nap(700);
  }
  const dds = qa("dd").map((x) => x.textContent.trim());
  return { clickedAbout: !!about, dds };
};


// --------------------------------------------------------------------------
// 【P2-8】导出（网页 / Markdown）用的探针
// --------------------------------------------------------------------------

/**
 * 清掉「导出格式」这个界面偏好。
 *
 * ⚠️ ⭐ **`localStorage` 不在一次性数据目录里**（它活在 WebView 的用户数据目录）
 *    ⇒ 光删数据目录**清不掉它**。不清就等于带着上一轮的选择开局，
 *    "默认是 Markdown"那条断言会**随上一轮跑没跑过而变红**。
 */
const A_clearExportFormat = () => {
  try {
    localStorage.removeItem("diary.export-format");
    return { ok: true, now: localStorage.getItem("diary.export-format") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};

/** 读一下本地存储里那个偏好（验证"记没记住"）。 */
const R_exportFormatStored = () => {
  try {
    return { value: localStorage.getItem("diary.export-format") };
  } catch (e) {
    return { value: null, error: String((e && e.message) || e) };
  }
};

/**
 * 打开【设置】→【数据与备份】，读出「导出全部日记」那一行的控件。
 *
 * ⚠️ 设置**不是顶栏 tab、是一个弹窗**（`v-if="showSettings"`，所以每次打开都是
 *    **新组件实例** —— 这正是"记住上次选的格式"能被验出来的前提）。
 * ⚠️ 默认分类是「安全」，必须**点一下**「数据与备份」，否则那一行根本不在 DOM 里。
 */
const R_exportRow = async () => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const openBtn = document.querySelector('button[title="设置"]');
  if (!openBtn) return { error: "no-settings-button" };
  openBtn.click();
  await nap(900);
  const nav = qa("nav.side button").find((x) => x.textContent.trim() === "数据与备份");
  if (!nav) return { error: "no-data-tab" };
  nav.click();
  await nap(700);

  const sel = document.querySelector('select[aria-label="导出格式"]');
  if (!sel) return { clickedNav: true, error: "no-format-select" };
  const row = sel.closest(".row");
  const input = row ? row.querySelector("input.path-input") : null;
  const btn = row ? row.querySelector("button.btn") : null;
  return {
    clickedNav: true,
    hasSelect: true,
    value: sel.value,
    options: Array.from(sel.options).map((o) => `${o.value}:${o.textContent.trim()}`),
    hasInput: !!input,
    hasButton: !!btn,
    rowText: row ? row.textContent.replace(/\s+/g, " ").trim().slice(0, 160) : null,
  };
};

/** 关掉设置弹窗（下一次打开才是**新实例**，才验得出"记住了没"）。 */
const A_closeSettings = async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = Array.from(document.querySelectorAll("button.btn.ghost")).find(
    (b) => b.textContent.trim() === "关闭"
  );
  if (!btn) return { closed: false };
  btn.click();
  await nap(700);
  return { closed: !document.querySelector('select[aria-label="导出格式"]') };
};

/** 把「导出格式」拨到指定值（`md` / `html`），并回报本地存储里存成了什么。 */
const A_setExportFormat = async (fmt) => {
  const sel = document.querySelector('select[aria-label="导出格式"]');
  if (!sel) return { error: "no-select" };
  sel.value = fmt;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  let stored = null;
  try {
    stored = localStorage.getItem("diary.export-format");
  } catch {
    /* 读不到就算了 */
  }
  return { value: sel.value, stored };
};

/** 填目录、点「导出」。**只点一下就返回**，等结果交给 `waitFor`。 */
const A_doExport = async (dir) => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const sel = document.querySelector('select[aria-label="导出格式"]');
  if (!sel) return { error: "no-select" };
  const row = sel.closest(".row");
  const input = row && row.querySelector("input.path-input");
  const btn = row && row.querySelector("button.btn");
  if (!input || !btn) return { error: "no-input-or-button" };
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  ).set;
  setter.call(input, dir);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nap(250);
  btn.click();
  return { started: true, disabled: btn.disabled };
};

/** 读导出那一行的结果 / 报错。 */
const R_exportResult = () => {
  const rows = Array.from(document.querySelectorAll(".row"));
  const pick = (label) => {
    const r = rows.find((x) => {
      const t = x.querySelector(".t");
      return t && t.textContent.trim().startsWith(label);
    });
    return r ? r.textContent.replace(/\s+/g, " ").trim() : null;
  };
  return { done: pick("已导出"), err: pick("导出失败") };
};

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

/**
 * ⭐ 判据：一段"落库的正文"是不是合法。
 *
 * 第 2 步最关键的两条是：
 *   ① **落库的 HTML 必须被洗过**（白名单之外的不许进库）；
 *   ② **旧日记（纯文本）必须被原样保存**（不许被"帮忙"加上 `<p>`）。
 *
 * 只测合格样本的判据不算判据 —— 下面 0b 会给它喂不合格样本，必须判 false。
 */
function isValidStoredHtml(html) {
  if (html === "") return true;
  // 纯文本（不含 `<`）合法 —— 旧日记就是这种，**必须放行**。
  if (!html.includes("<")) return true;
  const allowed = ["p", "br", "strong", "em", "u", "s", "span", "mark"];
  const found = Array.from(html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)).map((m) =>
    m[1].toLowerCase()
  );
  if (found.some((t) => !allowed.includes(t))) return false;
  if (/\son[a-z]+\s*=/i.test(html)) return false;
  if (/<script|<img|<iframe/i.test(html)) return false;
  const styles = Array.from(html.matchAll(/style\s*=\s*"([^"]*)"/g)).map((m) => m[1]);
  for (const raw of styles) {
    // ⚠️⚠️ **必须先还原实体再按 `;` 切** —— `&quot;` 这个实体**自己就带一个分号**，
    //      直接切会把它拦腰截断，切出 `songti sc&quot` 这种假属性名，
    //      于是**完全合法的 `font-family: &quot;Songti SC&quot;, serif` 被判为非法**
    //      （踩过：F.4 假红 —— 判据坏的，不是应用坏的）。
    //      应用那边的 `cleanStyle` 读的是 `getAttribute` 解码后的值，不受这个坑影响。
    const s = raw
      .replace(/&quot;/gi, '"')
      .replace(/&#0*34;/g, '"')
      .replace(/&amp;/gi, "&")
      .replace(/&#0*39;/g, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
    for (const piece of s.split(";")) {
      const p = (piece.split(":")[0] || "").trim().toLowerCase();
      if (!p) continue;
      if (
        !["font-family", "font-size", "font-weight", "font-style", "text-decoration"].includes(p)
      ) {
        return false;
      }
    }
  }
  return true;
}

const D = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d;
};
const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function launch(dataDir) {
  const child = spawn(EXE, [], {
    stdio: "ignore",
    windowsHide: false,
    env: {
      ...process.env,
      DSH_DIARY_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
  });
  const target = await findTarget(PORT);
  const client = await connect(target.webSocketDebuggerUrl);
  await waitFor(
    client,
    async () => {
      const q = (s) => document.querySelector(s);
      return !!q(".topbar") || document.querySelectorAll("input.pin-input").length > 0;
    },
    20000
  );
  return { child, client };
}

async function shutdown(child, client) {
  try {
    if (client && !client.isClosed()) client.close();
  } catch {}
  await sleep(300);
  try {
    if (child && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {}
  await sleep(700);
  killLeftovers();
}

async function setTheme(client, value) {
  await client.send("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-color-scheme", value }],
  });
  await sleep(400);
}

(async () => {
  const D1 = path.join(ROOT, "data2");
  const TODAY = D(0);
  const OLD_DATE = D(-3);
  let child = null;
  let client = null;

  try {
    console.log("== 清场 ==");
    rec("0.1 清残留进程", killLeftovers());
    if (fs.existsSync(D1)) fs.rmSync(D1, { recursive: true, force: true });
    fs.mkdirSync(D1, { recursive: true });
    rec("0.2 一次性数据目录已重建", D1);
    rec("0.3 今天 =", fmt(TODAY));
    if (!fs.existsSync(EXE)) throw new Error(`找不到 exe：${EXE}`);
    rec("0.4 exe 体积", `${fs.statSync(EXE).size.toLocaleString()} B`);

    // ---- 0b. 判据自检 ----
    console.log("== 0b. 判据自检 ==");
    ok(
      isValidStoredHtml("今天下雨了，读了 P2。\n第二行。"),
      "0b.1 判据认「纯文本合法」",
      "旧日记那种一格标签都没有的正文，必须放行"
    );
    ok(
      isValidStoredHtml("<p>今天<strong>很好</strong></p>"),
      "0b.2 判据认「白名单标签合法」",
      "<p> + <strong>"
    );
    ok(
      isValidStoredHtml('<p><span style="font-size: 1.25em;">大字</span></p>'),
      "0b.3 判据认「字体字号 span 合法」",
      "style 里只有 font-size"
    );
    // ⭐ 反向对照：**带引号字体名的合法形态**必须放行。
    //    ⚠️ 0b.3 那个样本没带引号，兜不住"`&quot;` 自带分号"这个坑 ——
    //    漏了它，F.4 会拿一个**完全合法**的值判 false（假红）。
    ok(
      isValidStoredHtml(
        '<p><span style="font-family: &quot;Songti SC&quot;, SimSun, serif"><strong>正常</strong></span></p>'
      ),
      "0b.3b 判据认「带引号字体名的合法 span」",
      "字体名里的 &quot; 不能被当成 style 分隔符"
    );
    ok(
      !isValidStoredHtml("<p>危险<script>alert(1)</script></p>"),
      "0b.4 判据挡得住 <script>",
      "⛔ 必须为 false，否则判据是假的"
    );
    ok(!isValidStoredHtml("<h1>标题</h1>"), "0b.5 判据挡得住白名单外的 <h1>", "⛔ 必须为 false");
    ok(
      !isValidStoredHtml('<p><span style="color: red;">红字</span></p>'),
      "0b.6 判据挡得住写死颜色的 style",
      "颜色必须跟主题走 —— ⛔ 必须为 false"
    );
    ok(
      !isValidStoredHtml('<p onclick="x()">点我</p>'),
      "0b.7 判据挡得住内联事件",
      "⛔ 必须为 false"
    );

    // ---- 启动 ----
    console.log("== 启动 ==");
    let L = await launch(D1);
    child = L.child;
    client = L.client;
    rec("1.1 已启动", `pid=${child.pid}`);

    const initOut = await evalFn(client, P_init, PIN);
    initOut.forEach(([k, v]) => rec(`1.2 ${k}`, v));
    await sleep(1500);
    await setTheme(client, "light");

    // ---- A. 编辑器换了没 / 排版还在不在 ----
    console.log("== A. 编辑器与排版 ==");
    const sw = await evalFn(client, S_write);
    sw.forEach(([k, v]) => rec(`A.0 ${k}`, v));

    const ed = await evalFn(client, R_editor);
    ok(ed.found, "A.1 编辑器根节点存在（.tiptap）", ed.found ? "有 .tiptap" : "找不到");
    ok(
      ed.legacyTextarea === false,
      "A.2 ⭐ 旧 textarea 真的不存在了",
      `legacyTextarea=${ed.legacyTextarea}`
    );
    ok(
      !/mono|Consolas|Cascadia/i.test(ed.fontFamily),
      "A.3 正文不再是等宽（第 1 步成果还在）",
      ed.fontFamily.slice(0, 60)
    );
    ok(ed.fontSize === "16px", "A.4 字号仍是 16px（第 1 步成果还在）", ed.fontSize);
    ok(
      Math.abs(parseFloat(ed.lineHeight) - 30.4) < 0.8,
      "A.5 行高仍是 ≈30.4px",
      ed.lineHeight
    );

    // ---- B. 工具栏 ----
    console.log("== B. 工具栏 ==");
    ok(ed.hasToolbar, "B.1 工具栏存在", ed.hasToolbar);
    ok(
      ["B", "I", "U", "S"].every((t) => ed.toolButtons.includes(t)),
      "B.2 四个格式按钮齐（B I U S）",
      ed.toolButtons.join(" | ")
    );
    ok(
      ed.toolButtons.some((t) => t.includes("清除格式")),
      "B.3 有「清除格式」按钮",
      ed.toolButtons.join(" | ")
    );
    ok(
      ed.toolSelects.length === 2,
      "B.4 有字体 / 字号两个下拉",
      JSON.stringify(ed.toolSelects.map((s) => s.title))
    );
    ok(
      ed.toolSelects[0] && ed.toolSelects[0].options.join(",") === "默认,宋体,黑体,楷体",
      "B.5 字体下拉是「默认 / 宋体 / 黑体 / 楷体」",
      ed.toolSelects[0] ? ed.toolSelects[0].options.join(" | ") : "没有"
    );
    ok(
      ed.toolSelects[1] && ed.toolSelects[1].options.join(",") === "中,小,大",
      "B.6 字号下拉是「中 / 小 / 大」",
      ed.toolSelects[1] ? ed.toolSelects[1].options.join(" | ") : "没有"
    );
    ok(ed.hasPlaceholderAttr, "B.7 空内容时有占位（is-editor-empty）", `hasPlaceholderAttr=${ed.hasPlaceholderAttr}`);

    // ---- C. 加粗（只加选中那段）----
    console.log("== C. 加粗 ==");
    // ⭐ 铁律 8：本软件每次 load() 都 lockAllEntries()，编辑器开局是锁定态
    //    （contenteditable=false）—— `Input.insertText` 走真实输入管线，
    //    锁着是打不进去的；工具栏按钮此时也是 disabled。先解锁再打字。
    const c0 = await ensureUnlocked(client, "C");
    ok(c0.ok, "C.0 ⭐ 开局先解锁（铁律 8）", c0.note);
    const T1 = "今天下雨了，读了 dairy 的 P2 两节。";
    const T2 = "第二段。";
    const sw1 = await typeAndWait(client, T1 + "\n" + T2);
    ok(
      sw1.sawPending === true,
      "C.1 ⭐ 等落库时看见了中间态（未保存…）",
      `sawPending=${sw1.sawPending}, 到「已保存」用了 ${sw1.ms}ms`
    );

    const db0 = await evalFn(client, R_dbBody, fmt(TODAY));
    ok(!db0.error, "C.2 能通过 IPC 读到库里的正文", db0.error || `id=${db0.id}`);
    rec("C.3 库里正文（刚灌入）", JSON.stringify(db0.content_md || ""));

    const selText = await evalFn(client, A_selectFirst, 4);
    rec("C.4 选中的文字", JSON.stringify(selText));
    const clickRes = await evalFn(client, A_clickTool, "bold");
    rec("C.5 点 B 的结果", clickRes);
    await sleep(1600);

    const marks = await evalFn(client, R_marks);
    ok(marks.found && marks.bold === true, "C.6 B 按钮变成激活态", JSON.stringify(marks));

    const ed2 = await evalFn(client, R_editor);
    ok(/<strong>/.test(ed2.html), "C.7 ⭐ 编辑器里真的出现了 <strong>", ed2.html.slice(0, 130));
    // ⭐ 只有前 4 个字变粗，后面的不许跟着变
    const strongMatch = ed2.html.match(/<strong>([^<]*)<\/strong>/);
    ok(
      strongMatch && strongMatch[1].length <= 4,
      "C.8 ⭐ 只有选中的那 4 个字被加粗（不是整段）",
      strongMatch ? JSON.stringify(strongMatch[1]) : "没找到 strong"
    );

    // 再点一次取消
    await evalFn(client, A_selectFirst, 4);
    await evalFn(client, A_clickTool, "bold");
    await sleep(1600);
    const ed3 = await evalFn(client, R_editor);
    ok(!/<strong>/.test(ed3.html), "C.9 再点一次 B 能取消（toggle）", ed3.html.slice(0, 130));

    // ---- D. 落库内容必须被洗过 ----
    console.log("== D. 落库内容 ==");
    //
    // ⚠️ 这一段**故意绕开界面**：直接往库里塞一段"脏"HTML（含白名单外的标签 +
    //    写死的颜色 + script），然后：
    //      ① 验它读进界面时**编辑器把它洗成了什么**（sanitizeHtml 的入口）；
    //      ② 验用户只要一动它，落库的就是**洗过的版本**。
    //    为什么绕开：`Input.insertText` 只能插纯文本（HTML 会变字面文字），
    //    而 paste 事件会让 WebView2 卡死（上面记过）。而这一段的**验收对象**
    //    本来就是"脏数据进来之后会怎样" —— 直接塞脏数据正是最贴题的测法。
    const DIRTY = '<p>干净的一段</p><h1>这是标题标签</h1><p style="color: red;">红字</p><script>alert(1)</script>';
    const dirtySeed = await evalFn(client, A_seedRaw, fmt(TODAY), DIRTY);
    rec("D.0 往库里直接塞脏 HTML", JSON.stringify(dirtySeed).slice(0, 220));
    ok(dirtySeed.ok, "D.1 塞入成功（或后端本就拒绝）", dirtySeed.error || "ok");

    // ⭐ 逼界面重新读这一天。
    //    ⛔ 不能只调 `S_write`（点「写日记」tab）—— 我们**本来就在**这个 tab 上，
    //       点同一个 tab 什么都不会发生，`EditorPane` 不会重挂、`load()` 不会重跑，
    //       编辑器里还是上一段的内容 ⇒ D.3~D.6 会**假红**。
    //    ⭐ 切到别的 tab 再切回来：`App.vue` 里 EditorPane 住在 `v-if="mode==='write'"`
    //       的模板里 ⇒ 切走会**卸载**、切回会**重挂** ⇒ 重走 `load()` 读到新数据。
    const rl = await evalFn(client, A_reloadByTab);
    rec("D.1b 切走再切回（逼组件重挂）", rl);
    ok(rl === "reloaded", "D.1b ⭐ 切走再切回能重新读盘", rl);
    await sleep(1200);
    const edDirty = await evalFn(client, R_editor);
    rec("D.2 编辑器读进来之后的样子", JSON.stringify(edDirty.html).slice(0, 220));
    ok(!/<h1/i.test(edDirty.html), "D.3 ⭐ 白名单外的 <h1> 在界面上就没了", edDirty.html.slice(0, 140));
    ok(!/<script/i.test(edDirty.html), "D.4 ⭐ <script> 在界面上就没了", "（安全）");
    ok(
      !/color\s*:/i.test(edDirty.html),
      "D.5 ⭐ 写死的颜色在界面上就没了",
      edDirty.html.slice(0, 160)
    );
    ok(/干净的一段/.test(edDirty.html), "D.6 ⭐ 被拆掉的标签里的**文字**留下了", "（没丢字）");

    // 现在动一下它，逼一次保存 —— 落库的必须是洗过的版本。
    // ⚠️ 重挂之后 load() 又把它锁上了（铁律 8）⇒ 先解锁，否则工具栏是灰的、
    //    这次加粗点了等于没点，D.9~D.13 会假红。
    const d7 = await ensureUnlocked(client, "D");
    ok(d7.ok, "D.7pre ⭐ 重挂后先解锁再动它", d7.note);
    await evalFn(client, A_selectAll);
    await evalFn(client, A_clickTool, "bold");
    await sleep(1800);
    const db1 = await evalFn(client, R_dbBody, fmt(TODAY));
    const stored = db1.content_md || "";
    rec("D.7 库里存的正文（动过之后）", JSON.stringify(stored));
    ok(!db1.error, "D.8 读库成功", db1.error || "ok");
    ok(isValidStoredHtml(stored), "D.9 ⭐ 落库的正文通过了白名单校验", stored.slice(0, 140));
    ok(!/<h1/i.test(stored), "D.10 ⭐ <h1> 没进库", stored.slice(0, 120));
    ok(!/<script/i.test(stored), "D.11 ⭐ <script> 没进库", "（安全）");
    ok(!/color\s*:/i.test(stored), "D.12 ⭐ 写死的颜色没进库", stored.slice(0, 140));
    // ⭐ 字数必须是纯文字数。
    // ⚠️ 期望值**不含 script 里的 alert(1)**：前端洗的时候 `script` 是**整块丢掉**
    //    （连里面的文字一起丢），所以留下的只有「干净的一段 / 这是标题标签 / 红字」。
    const plainLen = "干净的一段这是标题标签红字".length;
    ok(
      db1.word_count === plainLen,
      "D.13 ⭐⭐ 库里的字数 ＝ 纯文字数（标签完全没被算）",
      `库=${db1.word_count} 期望=${plainLen}`
    );

    // ---- E. 字符实体 ----
    console.log("== E. 实体 ==");
    await typeAndWait(client, "a & b < c");
    await sleep(1000);
    const dbE = await evalFn(client, R_dbBody, fmt(TODAY));
    const storedE = dbE.content_md || "";
    rec("E.1 库存正文", JSON.stringify(storedE));
    ok(
      /&amp;/.test(storedE) && /&lt;/.test(storedE) && !/&amp;amp;/.test(storedE),
      "E.2 & 与 < 都按实体存、且没被重复转义",
      storedE.slice(0, 120)
    );
    ok(dbE.word_count === "a&b<c".length, "E.3 实体算一个字符", `库=${dbE.word_count} 期望=${"a&b<c".length}`);

    // ---- F. 字体 / 字号 ----
    console.log("== F. 字体 / 字号 ==");
    await typeAndWait(client, "一段用来试字体字号的话。");
    await sleep(1000);
    await evalFn(client, A_selectAll);
    const fr = await evalFn(client, A_setSelect, 0, "song");
    rec("F.1 字体下拉切到「宋体」", fr);
    await sleep(1600);
    const ed4 = await evalFn(client, R_editor);
    ok(/font-family/i.test(ed4.html), "F.2 ⭐ 编辑器里出现了 font-family", ed4.html.slice(0, 180));
    const db2 = await evalFn(client, R_dbBody, fmt(TODAY));
    ok(
      /font-family/i.test(db2.content_md || ""),
      "F.3 ⭐⭐ 字体选择真的落库了",
      (db2.content_md || "").slice(0, 220)
    );
    ok(isValidStoredHtml(db2.content_md || ""), "F.4 落库的 font-family 形态合法", "（白名单通过）");

    await evalFn(client, A_selectAll);
    const sr = await evalFn(client, A_setSelect, 1, "l");
    rec("F.5 字号下拉切到「大」", sr);
    await sleep(1600);
    const db3 = await evalFn(client, R_dbBody, fmt(TODAY));
    ok(/font-size/i.test(db3.content_md || ""), "F.6 ⭐⭐ 字号选择真的落库了", (db3.content_md || "").slice(0, 260));

    // —— 反查：下拉要能"读回"当前档位（不是自己记自己按过）
    // ⚠️ 先全选再读 —— `getAttributes("textStyle")` 读的是**光标 / 选区处**的格式。
    //    不先全选的话，`insertText` 之后光标停在文末，读到的可能是"没有格式"。
    await evalFn(client, A_selectAll);
    await sleep(600);
    const ed5 = await evalFn(client, R_editor);
    ok(
      ed5.toolSelects[0] && ed5.toolSelects[0].value === "song",
      "F.7 ⭐ 选区已有宋体时，下拉自己回到「宋体」（是从编辑器读回，不是自己记）",
      ed5.toolSelects[0] ? `value=${ed5.toolSelects[0].value}` : "没有"
    );
    ok(
      ed5.toolSelects[1] && ed5.toolSelects[1].value === "l",
      "F.8 ⭐ 选区字号为「大」时，字号下拉也自己回到「大」",
      ed5.toolSelects[1] ? `value=${ed5.toolSelects[1].value}` : "没有"
    );

    // ---- G. 清除格式 ----
    console.log("== G. 清除格式 ==");
    await evalFn(client, A_selectAll);
    const cr = await evalFn(client, A_clickTool, "clear");
    rec("G.1 点「清除格式」", cr);
    await sleep(1800);
    const db4 = await evalFn(client, R_dbBody, fmt(TODAY));
    const afterClear = db4.content_md || "";
    rec("G.2 清除后库存正文", JSON.stringify(afterClear));
    ok(!/font-family|font-size/i.test(afterClear), "G.3 ⭐ 字体 / 字号被清掉了", afterClear.slice(0, 140));
    const textAfter = afterClear.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ");
    ok(
      textAfter.includes("一段用来试字体字号的话"),
      "G.4 ⭐⭐ 清除格式只去样子、不丢字",
      JSON.stringify(textAfter)
    );

    // ---- H. 旧日记原样（拍板第 2 条）----
    console.log("== H. 旧日记（纯文本）不受影响 ==");
    const OLD_TEXT = "旧日记第一行\n  缩进的第二行\n\n**已经是 Markdown 了**\n- 列表项";
    const seed = await evalFn(client, A_seedPlain, fmt(OLD_DATE), OLD_TEXT);
    rec("H.1 往库里塞一篇纯文本旧日记", JSON.stringify(seed).slice(0, 200));
    ok(seed.ok, "H.2 塞入成功", seed.error || "ok");
    ok(
      seed.stored === OLD_TEXT,
      "H.3 ⭐⭐ 旧日记纯文本逐字节原样入库（没被加上 <p>）",
      JSON.stringify(seed.stored)
    );
    ok(
      seed.words === OLD_TEXT.replace(/\s/g, "").length,
      "H.4 旧日记字数口径不变",
      `库=${seed.words} 期望=${OLD_TEXT.replace(/\s/g, "").length}`
    );
    const dbOld = await evalFn(client, R_dbBody, fmt(OLD_DATE));
    ok(dbOld.content_md === OLD_TEXT, "H.5 读回来还是纯文本原文", JSON.stringify((dbOld.content_md || "").slice(0, 60)));

    // 把那篇旧日记在界面上打开，正文必须一字不差（拍板第 2 条的硬验收）。
    const op = await evalFn(client, A_openDate, fmt(OLD_DATE));
    rec("H.6 在日历上点开旧日记那天", op);
    ok(String(op).startsWith("clicked"), "H.6a ⭐ 能在日历上点开那一天", op);
    // ⭐ 等"那一篇真的读进来了" —— 用 Node 侧的 waitFor（页面里长等待会撞 CDP 超时）。
    //    ⛔ 只等"`.tiptap` 在不在"不够：编辑器本来就挂着，会立刻返回、什么也没证明。
    const shownOk = await waitFor(
      client,
      () => {
        const b = document.querySelector(".rich-body .tiptap, .rich-body .ProseMirror");
        return !!b && b.innerText.includes("旧日记第一行");
      },
      12000
    );
    ok(shownOk.ok, "H.6b ⭐⭐ 旧日记的内容真的读到了编辑器里", shownOk.ok ? `${shownOk.ms}ms` : "超时");
    await sleep(1200);
    const shown = await evalFn(client, R_editorText);
    const norm = (s) => (s || "").replace(/\s+/g, "");
    ok(
      norm(shown.text) === norm(OLD_TEXT),
      "H.7 ⭐⭐ 旧日记在界面上原样显示（去掉空白后逐字一致）",
      `界面=${JSON.stringify(norm(shown.text).slice(0, 60))}`
    );
    ok(
      !/<p>旧日记第一行<\/p>/.test(OLD_TEXT) && /旧日记第一行/.test(shown.text),
      "H.8 旧日记的文字没丢",
      shown.text.slice(0, 60)
    );
    // ⛔ 旧日记的库值绝不能被"顺手改写"成 HTML —— 看一眼库里是不是原文。
    const dbOld3 = await evalFn(client, R_dbBody, fmt(OLD_DATE));
    ok(
      dbOld3.content_md === OLD_TEXT,
      "H.9 ⭐⭐ 打开旧日记后，库里仍是纯文本原文（没被改写成 HTML）",
      JSON.stringify((dbOld3.content_md || "").slice(0, 60))
    );

    // ---- I. 锁定态 ----
    console.log("== I. 锁定态 ==");
    await sleep(800);
    const lk0 = await evalFn(client, R_locked);
    rec("I.1 当前锁定状态", JSON.stringify(lk0));

    if (lk0.contenteditable === "false") {
      const t = await evalFn(client, A_toggleLock);
      rec("I.2 点了解锁按钮", t);
      await sleep(1600);
    }
    const lk1 = await evalFn(client, R_locked);
    ok(lk1.contenteditable === "true", "I.3 解锁后编辑器可编辑", `contenteditable=${lk1.contenteditable}`);
    ok(lk1.canSelect >= 0, "I.4 解锁态可选中文字", `选中 ${lk1.canSelect} 字`);

    const t2 = await evalFn(client, A_toggleLock);
    rec("I.5 再点一次（上锁）", t2);
    await sleep(1600);
    const lk2 = await evalFn(client, R_locked);
    ok(lk2.contenteditable === "false", "I.6 ⭐ 锁定后编辑器不可编辑", `contenteditable=${lk2.contenteditable}`);
    ok(lk2.canSelect > 0, "I.7 ⭐ 锁定态仍能选中文字（可复制）", `选中 ${lk2.canSelect} 字`);
    ok(lk2.toolDisabled === true, "I.8 锁定态工具栏置灰", `disabled=${lk2.toolDisabled}`);

    // ⭐ I.9：**解锁 / 上锁本身绝不该改动库里的正文**。
    //    ⚠️ 这条是 K.7 那个 bug 的"当场版"：`setEditable()` 默认会抛 update 事件，
    //       `onUpdate` 被唤醒后会把编辑器规范化后的 HTML 当成"用户的改动"存回去
    //       ⇒ 一篇旧的纯文本日记，只因为点了下解锁/上锁，就被悄悄改写成 HTML。
    //       所以这里在读库前**不做任何输入**，只看"开合一次锁"有没有污染正文。
    const dbOld4 = await evalFn(client, R_dbBody, fmt(OLD_DATE));
    ok(
      dbOld4.content_md === OLD_TEXT,
      "I.9 ⭐⭐ 解锁 / 上锁之后，库里的旧日记仍是纯文本原文（一个字没被改写）",
      JSON.stringify((dbOld4.content_md || "").slice(0, 60))
    );

    // ---- J. 深浅两态 ----    console.log("== J. 深浅两态 ==");
    for (const mode of ["light", "dark"]) {
      await setTheme(client, mode);
      const e2 = await evalFn(client, R_editor);
      const tag = mode === "light" ? "J.1" : "J.2";
      ok(
        e2.fontSize === "16px" && e2.fontFamily.length > 0,
        `${tag} ${mode} 下排版仍生效`,
        `${e2.fontSize} / 纸面 ${e2.paperBg} / 圆角 ${e2.paperRadius}`
      );
    }

    // ---- K. 重启后数据还在 ----
    console.log("== K. 重启复读 ==");
    await shutdown(child, client);
    L = await launch(D1);
    child = L.child;
    client = L.client;
    await setTheme(client, "light");
    const initOut2 = await evalFn(client, P_init, PIN);
    initOut2.forEach(([k, v]) => rec(`K.0 ${k}`, v));
    await sleep(2000);
    const sw2 = await evalFn(client, S_write);
    sw2.forEach(([k, v]) => rec(`K.1 ${k}`, v));

    const edAfter = await evalFn(client, R_editor);
    rec("K.2 重启后编辑器 HTML", JSON.stringify(edAfter.html.slice(0, 200)));
    ok(edAfter.html.length > 0, "K.3 ⭐ 重启后正文还在", `${edAfter.html.length} 字符`);
    ok(isValidStoredHtml(edAfter.html), "K.4 重启后读到的 HTML 仍合法", "（白名单通过）");

    const dbFinal = await evalFn(client, R_dbBody, fmt(TODAY));
    ok(!dbFinal.error && (dbFinal.content_md || "").length > 0, "K.5 库里数据还在", "ok");
    rec("K.6 重启后库存正文", JSON.stringify((dbFinal.content_md || "").slice(0, 160)));

    const dbOld2 = await evalFn(client, R_dbBody, fmt(OLD_DATE));
    ok(
      dbOld2.content_md === OLD_TEXT,
      "K.7 ⭐⭐ 重启后旧日记仍是纯文本原文",
      JSON.stringify((dbOld2.content_md || "").slice(0, 60))
    );

    // ---- L. 搜索摘要不许夹着格式标记（【P2-3】第 3 步） ----
    //
    // 为什么这条必须验：`make_snippet` 早先是**直接在原文上开窗**的 ——
    // 正文变成带标签的 HTML 之后，摘要里就会露出 `<b>` 这几个字，
    // 而用户搜的明明是「下雨」。而前端 `SearchPanel.parts()` 又是在
    // **这段摘要**上 `indexOf` 定位的 ⇒ 摘要不干净，高亮跟着错。
    // 所以"摘要干净"和"高亮圈对"两件事一起验。
    console.log("== L. 搜索摘要 ==");
    const SEED_DATE = D(-5);
    const SEED_HTML = "<p>今天<b>下雨</b>了，只好待在家里看书，顺便把窗台的花搬了进来。</p>";
    const seedOut = await evalFn(client, A_seedRaw, fmt(SEED_DATE), SEED_HTML);
    rec("L.1 塞一篇带格式的日记", JSON.stringify(seedOut));

    // ⭐ **对照**：先确认"库里真的存着标签" —— 否则下面"摘要没标签"就是空转。
    //    ⚠️ 判据"永远为真"比"断言为假"更难发现。
    const seeded = await evalFn(client, R_dbBody, fmt(SEED_DATE));
    const seededBody = (seeded && seeded.content_md) || "";
    rec("L.2 库里那篇的原文", JSON.stringify(seededBody.slice(0, 90)));
    ok(
      /<b>|<strong>|<\/p>/.test(seededBody),
      "L.3 ⭐ 对照：库里的正文确实带标签",
      JSON.stringify(seededBody.slice(0, 90))
    );

    const subOut = await evalFn(client, A_search, "下雨");
    rec("L.4 提交搜索", subOut);
    // 先等结果行挂出来（中间态），再读终态 —— 铁律 20。
    const gotList = await waitFor(
      client,
      () => document.querySelectorAll(".search .item-snippet").length > 0,
      8000
    );
    ok(gotList.ok, "L.5 ⭐ 结果行出现了", `等了 ${gotList.ms}ms`);

    const sres = await evalFn(client, R_search);
    rec("L.6 提示语", sres.note);
    rec("L.7 结果条数", sres.count);
    rec("L.8 全部摘要", JSON.stringify(sres.snippets));
    rec("L.9 高亮片段", JSON.stringify(sres.marks));
    ok(sres.count > 0, "L.10 ⭐ 搜到了这一篇", JSON.stringify(sres.snippets[0] || ""));
    ok(
      sres.snippets.length > 0 && sres.snippets.every((t) => !t.includes("<") && !t.includes(">")),
      "L.11 ⭐⭐ 摘要里一个标签字符都没有",
      JSON.stringify(sres.snippets[0] || "")
    );
    ok(
      sres.marks.some((m) => m.includes("下雨")),
      "L.12 ⭐⭐ 命中词被高亮圈住",
      JSON.stringify(sres.marks)
    );

    // ---- N. 【P2-8】导出成 HTML（＋ 老 Markdown 导出没被弄坏） ----
    //
    // ⚠️ 本组**两边都验**：界面（下拉、记住、结果文案）＋ **磁盘上真实的文件**。
    //    "界面弹了成功"跟"文件真写对了"是两件事，后者只能真去读文件。
    console.log("== N. 导出（P2-8）==");

    /** 等一个文件真的出现（比等 DOM 靠谱：不怕"清空→重挂"的中间态一晃而过）。 */
    const waitFile = async (p, ms = 25000) => {
      const t0 = Date.now();
      while (!fs.existsSync(p) && Date.now() - t0 < ms) await sleep(300);
      return { ok: fs.existsSync(p), ms: Date.now() - t0 };
    };
    /** 递归列出目录下所有文件（验"一张图片都没被复制"）。 */
    const walkFiles = (d) => {
      let out = [];
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) out = out.concat(walkFiles(p));
        else out.push(p);
      }
      return out;
    };

    const EXPORT_DIR = path.join(ROOT, "data2", "导出-html");
    const EXPORT_MD_DIR = path.join(ROOT, "data2", "导出-md");
    const EX_DATE = D(-7);
    const XSS_DATE = D(-8);

    // ⭐ 起点：清掉界面偏好 —— `localStorage` 不在一次性数据目录里，不清就等于
    //    带着上一轮的选择开局，"默认是 Markdown"那条**会随上一轮跑没跑过而变红**。
    rec("N.0 清「导出格式」偏好", JSON.stringify(await evalFn(client, A_clearExportFormat)));

    const exSeed = await evalFn(
      client,
      A_seedRaw,
      fmt(EX_DATE),
      "<p>今天<strong>很好</strong>，<mark>这句要亮</mark>。</p><p>第二段。</p>"
    );
    rec("N.1 塞一篇带格式的日记", JSON.stringify(exSeed).slice(0, 150));
    const xssSeed = await evalFn(
      client,
      A_seedRaw,
      fmt(XSS_DATE),
      "我打了一行：<script>alert(1)</script>\n还有 2 < 3"
    );
    rec("N.2 塞一篇手打标签的", JSON.stringify(xssSeed).slice(0, 150));

    // ⭐ **反向对照**：先证明库里那串**确实是裸的 `<script>`** ——
    //    否则下面"导出的网页里没有 script"可能是空转（判据永远为真）。
    const dbXss = await evalFn(client, R_dbBody, fmt(XSS_DATE));
    const xssBody = (dbXss && dbXss.content_md) || "";
    ok(
      xssBody.includes("<script>"),
      "N.3 ⭐ 对照：库里确实存着裸的 <script>",
      JSON.stringify(xssBody.slice(0, 60))
    );

    const exRow = await evalFn(client, R_exportRow);
    rec("N.4 导出那一行", JSON.stringify(exRow));
    ok(exRow.hasSelect === true, "N.5 有「导出格式」下拉", exRow.error || "有");
    ok(
      Array.isArray(exRow.options) &&
        exRow.options.join("|") === "md:Markdown（.md）|html:网页（.html）",
      "N.6 两个选项：Markdown / 网页",
      JSON.stringify(exRow.options)
    );
    ok(
      exRow.hasInput === true && exRow.hasButton === true,
      "N.7 目录输入框与「导出」按钮都还在",
      `input=${exRow.hasInput} button=${exRow.hasButton}`
    );
    ok(exRow.value === "md", "N.8 ⭐ 没设过时默认 Markdown（兜底方向）", exRow.value);

    const toHtml = await evalFn(client, A_setExportFormat, "html");
    rec("N.9 拨到「网页」", JSON.stringify(toHtml));
    ok(toHtml.value === "html", "N.10 下拉切到网页", toHtml.value);
    ok(toHtml.stored === "html", "N.11 ⭐ 选择被记进 localStorage", String(toHtml.stored));

    rec("N.12 点导出（网页）", JSON.stringify(await evalFn(client, A_doExport, EXPORT_DIR)));
    const idxPath = path.join(EXPORT_DIR, "index.html");
    const wf1 = await waitFile(idxPath);
    ok(wf1.ok, "N.13 ⭐⭐ 产物里有 index.html", `${idxPath}（等了 ${wf1.ms}ms）`);
    await waitFor(
      client,
      () =>
        Array.from(document.querySelectorAll(".row .t")).some((x) =>
          x.textContent.trim().startsWith("已导出")
        ),
      8000
    );
    const exp1 = await evalFn(client, R_exportResult);
    rec("N.14 结果行", JSON.stringify(exp1));
    ok(!!exp1.done && !exp1.err, "N.15 导出成功、界面报的是成功", String(exp1.err || exp1.done));

    const idxHtml = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, "utf8") : "";
    ok(
      /^<!doctype html>/.test(idxHtml) && idxHtml.slice(0, 220).includes('<meta charset="utf-8">'),
      "N.16 ⭐ charset 排在最前面（否则部分浏览器中文乱码）",
      JSON.stringify(idxHtml.slice(0, 60))
    );
    ok(!/https?:\/\//.test(idxHtml), "N.17 ⭐ 零外部依赖（断网 / 整个目录搬走都能开）", "没搜到 http(s)://");

    const hrefs = Array.from(idxHtml.matchAll(/href="([^"]+)"/g)).map((m) => m[1]);
    rec("N.18 目录页链接", JSON.stringify(hrefs.slice(0, 5)));
    ok(hrefs.length > 0, "N.19 目录页有可点的链接", `${hrefs.length} 条`);
    ok(
      hrefs.every((h) => !h.includes("\\")),
      "N.20 ⭐ 链接一律用 / 而不是反斜杠",
      JSON.stringify(hrefs.slice(0, 3))
    );
    ok(
      hrefs.every((h) => fs.existsSync(path.join(EXPORT_DIR, h))),
      "N.21 ⭐⭐ 每一条链接都指到真实存在的文件",
      `${hrefs.length} 条全在`
    );

    const pageOf = (d) =>
      path.join(EXPORT_DIR, fmt(d).slice(0, 4), fmt(d).slice(5, 7), `${fmt(d)}.html`);
    const exPage = pageOf(EX_DATE);
    const xssPage = pageOf(XSS_DATE);
    ok(fs.existsSync(exPage), "N.22 带格式那篇落在 年/月/日期.html", exPage.replace(REPO, ""));
    ok(fs.existsSync(xssPage), "N.23 手打标签那篇也在", xssPage.replace(REPO, ""));

    const exHtml = fs.existsSync(exPage) ? fs.readFileSync(exPage, "utf8") : "";
    // ⚠️ 切片起点要连 `<div ` 一起算进去 —— 只从 `class="content"` 切，
    //    拿到的串自然不以 `<div class="content">` 开头（踩过：假红一条）。
    const divAt = exHtml.indexOf('<div class="content">');
    const exBody = divAt >= 0 ? exHtml.slice(divAt) : "";
    ok(
      exBody.startsWith('<div class="content"><p>今天<strong>很好</strong>，<mark>这句要亮</mark>。</p><p>第二段。</p></div>'),
      "N.24 ⭐⭐ 格式（粗体 / 高亮）在网页里看得见、且正文没被改字",
      JSON.stringify(exBody.slice(0, 110))
    );
    ok(
      exHtml.includes('href="../../index.html"'),
      "N.25 ⭐ 页脚「回到目录」指到导出根目录（单篇在年/月下，要上两级）",
      "href=../../index.html"
    );

    const xssHtml = fs.existsSync(xssPage) ? fs.readFileSync(xssPage, "utf8") : "";
    ok(
      !/<script/i.test(xssHtml),
      "N.26 ⭐⭐ 手打的 <script> 没有被原样放行（页面里搜不到 <script）",
      "OK"
    );
    ok(
      xssHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
      "N.27 ⭐⭐ 它是转义之后的一行字（打开只看到文字、不弹窗）",
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
    ok(
      xssHtml.includes("2 &lt; 3"),
      "N.28 没闭合的 `<` 也是他打的字（`3` 没被吃掉）",
      "2 &lt; 3"
    );
    ok(xssHtml.includes("<br>"), "N.29 ⭐ 旧日记（纯文本）的换行照旧保留", "有 <br>");

    const files = walkFiles(EXPORT_DIR);
    rec("N.30 导出目录文件数", `${files.length}`);
    ok(
      files.length > 0 && files.every((f) => f.endsWith(".html")),
      "N.31 ⭐⭐ 导出目录里只有 .html（图片一张都没被复制过来 —— 那是明文副本）",
      JSON.stringify(files.filter((f) => !f.endsWith(".html")).slice(0, 3))
    );

    // 再导一次到同一目录：**绝不覆盖**
    rec("N.32 再导一次（同一目录）", JSON.stringify(await evalFn(client, A_doExport, EXPORT_DIR)));
    const copyIdx = path.join(EXPORT_DIR, "index (1).html");
    const wf2 = await waitFile(copyIdx);
    ok(wf2.ok, "N.33 ⭐ 重名生成了 index (1).html", `等了 ${wf2.ms}ms`);
    await waitFor(
      client,
      () =>
        Array.from(document.querySelectorAll(".row .t")).some((x) =>
          x.textContent.trim().startsWith("已导出")
        ),
      8000
    );
    const exp2 = await evalFn(client, R_exportResult);
    rec("N.34 第二次结果行", JSON.stringify(exp2));
    ok(/重名已加后缀/.test(exp2.done || ""), "N.35 ⭐ 界面如实回报了重名", exp2.done);
    ok(
      fs.readFileSync(idxPath, "utf8") === idxHtml,
      "N.36 ⭐⭐ 第一份 index.html 一字未改（绝不覆盖）",
      "逐字节相同"
    );
    const copyPage = pageOf(EX_DATE).replace(/\.html$/, " (1).html");
    const copyPageText = fs.existsSync(copyPage) ? fs.readFileSync(copyPage, "utf8") : "";
    ok(
      copyPageText.includes('href="../../index (1).html"'),
      "N.37 ⭐ 第二批的页脚指回**第二批的**目录页（不是上一批）",
      "href=../../index (1).html"
    );

    // ⭐ "记住"：关掉再打开设置 —— 组件是 `v-if` 挂的，重开＝新实例＝重新读偏好
    rec("N.38 关闭设置弹窗", JSON.stringify(await evalFn(client, A_closeSettings)));
    const row2 = await evalFn(client, R_exportRow);
    ok(
      row2.value === "html",
      "N.39 ⭐⭐ 重开设置页仍是上次选的「网页」（记住生效）",
      row2.value
    );

    // 拨回 Markdown，验**老那条路没被弄坏**、且正文不再泄漏富文本标记
    const toMd = await evalFn(client, A_setExportFormat, "md");
    rec("N.40 拨回 Markdown", JSON.stringify(toMd));
    ok(toMd.stored === "md", "N.41 ⭐ 偏好又记成了 md", String(toMd.stored));
    rec("N.42 点导出（Markdown）", JSON.stringify(await evalFn(client, A_doExport, EXPORT_MD_DIR)));
    const mdIdxPath = path.join(EXPORT_MD_DIR, "index.md");
    const wf3 = await waitFile(mdIdxPath);
    ok(wf3.ok, "N.43 ⭐ 老路还在：index.md 生成了", `等了 ${wf3.ms}ms`);
    const mdPagePath = path.join(
      EXPORT_MD_DIR,
      fmt(EX_DATE).slice(0, 4),
      fmt(EX_DATE).slice(5, 7),
      `${fmt(EX_DATE)}.md`
    );
    const mdText = fs.existsSync(mdPagePath) ? fs.readFileSync(mdPagePath, "utf8") : "";
    const mdBody = mdText.slice(mdText.lastIndexOf("---\n") + 4);
    rec("N.44 那篇 .md 的正文", JSON.stringify(mdBody.slice(0, 120)));
    ok(
      !/<(p|strong|mark|span)>/.test(mdText),
      "N.45 ⭐⭐ md 正文里不再泄漏富文本内部标记（本件「顺手修干净」的那半件）",
      "没有 <p>/<strong>/<mark>/<span>"
    );
    ok(mdBody.includes("今天**很好**"), "N.46 ⭐⭐ 粗体被翻译成了 Markdown 的 **…**", JSON.stringify(mdBody.slice(0, 60)));

    // ---- M. 版本号有没有定档（发布件验收的最后一条） ----
    //
    // ⚠️ 版本号要**同时改三处**：`app/package.json` / `app/src-tauri/tauri.conf.json`
    //    / `app/src-tauri/Cargo.toml`。**界面【关于】显示的是 `package.json` 那个**
    //    （前端 `import pkg from "../../package.json"`）⇒ 只看 exe 版本字段不够，
    //    必须**看界面真的显示成什么**。
    console.log("== M. 版本号 ==");
    const mres = await evalFn(client, R_aboutVersion);
    rec("M.1 关于页只读信息", JSON.stringify(mres));
    ok(!!mres && mres.clickedAbout === true, "M.2 能切到「设置」→「关于」", JSON.stringify(mres));
    ok(
      !!mres && Array.isArray(mres.dds) && mres.dds.includes(EXPECT_VERSION),
      `M.3 ⭐⭐ 【关于】里显示的是 ${EXPECT_VERSION}`,
      JSON.stringify((mres && mres.dds) || [])
    );

    // ---- O. 搜索高亮：所有命中处都亮（【P2-16】） ----
    //
    // 改之前是 `SearchPanel.parts()` 里一行 `indexOf` —— **只找第一处**，
    // 所以同一个词在一篇里出现三次也只亮一处。本组钉住"全都亮"。
    // ⚠️ 顺带钉住三条**不许被破坏**的既有性质：
    //    ① 防 XSS（切段拼节点，绝不用 v-html）；
    //    ② `mark` 的颜色仍走 `--accent-soft` 这个变量（颜色栽过两轮）；
    //    ③ 摘要本身仍是纯可见文字（3.13 立的规矩）。
    console.log("== O. 搜索高亮（P2-16）==");

    /** 读**每一条**结果自己的摘要与高亮（分开数，免得互相干扰）。 */
    const R_searchItems = async () => {
      const qa = (s) => Array.from(document.querySelectorAll(s));
      return qa(".search .item-snippet").map((el) => ({
        text: el.textContent || "",
        marks: Array.from(el.querySelectorAll("mark")).map((m) => m.textContent || ""),
        // 摘要里只该有 span / mark 两种子元素 —— 这是"没用 v-html"的可观测证据
        tags: Array.from(el.children).map((c) => c.tagName.toLowerCase()),
        // 这条结果是不是"单字索引兜底"来的（界面上标「宽匹配」）
        badge: !!(
          el.closest(".item") && el.closest(".item").querySelector(".badge")
        ),
      }));
    };

    /** `mark` 的背景色，以及**同一个变量**解析出来的期望色（两者必须相等）。 */
    const R_markColor = async () => {
      const el = document.querySelector(".search .item-snippet mark");
      if (!el) return { found: false };
      const probe = document.createElement("div");
      probe.style.background = "var(--accent-soft)";
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { found: true, bg: getComputedStyle(el).backgroundColor, expected };
    };

    /** 装上"到底弹没弹窗"的探针 —— 防 XSS 那条要有**能发生**的对照。 */
    const A_armAlertSpy = async () => {
      window.__alerted = false;
      window.alert = function () {
        window.__alerted = true;
      };
      return { armed: true };
    };
    const R_alertSpy = async () => ({
      fired: window.__alerted === true,
      dangerous: document.querySelectorAll(".search script, .search img, .search iframe").length,
      onlySpanOrMark: Array.from(document.querySelectorAll(".search .item-snippet")).every((el) =>
        Array.from(el.children).every((c) => /^(mark|span)$/.test(c.tagName.toLowerCase()))
      ),
    });

    /**
     * 搜一个词、**确认真的是这一轮的结果**，再读每条的高亮。
     *
     * ⚠️⚠️ 这里必须**先清空、亲眼看结果区空掉**，再搜。
     *    `SearchPanel.run()` 是异步的（等 IPC 回来才换 results），
     *    上一轮的 `.item-snippet` 在那期间**还挂在 DOM 上** ⇒
     *    只写"等结果出现"的话它会**立刻**满足，读到的是**上一轮的结果**。
     *    这条竞态第一次跑因为时序凑巧躲过去了，第二次直接红了三条 ——
     *    也就是本项目的**铁律 13**：等状态变化必须亲眼看它经过中间态。
     */
    const searchAndRead = async (term, timeoutMs = 8000) => {
      // ① 中间态：清空 ⇒ 看着结果区真的空掉
      await evalFn(client, A_search, "");
      const cleared = await waitFor(
        client,
        () => document.querySelectorAll(".search .item-snippet").length === 0,
        5000
      );
      // ② 再搜这一轮的词
      await evalFn(client, A_search, term);
      const w = await waitFor(
        client,
        () => document.querySelectorAll(".search .item-snippet").length > 0,
        timeoutMs
      );
      return { ok: w.ok, ms: w.ms, cleared: cleared.ok, items: await evalFn(client, R_searchItems) };
    };

    // 三条"人肉造"的条目。日期刻意避开前面几组用掉的（0 / -3 / -5 / -8）。
    const O_SHORT_DATE = D(-2);
    const O_LONG_DATE = D(-7);
    const O_CASE_DATE = D(-1);
    const O_SHORT_TEXT = "青柠 红茶 青柠 绿茶 青柠";
    const O_SHORT_HTML = "<p>" + O_SHORT_TEXT + "</p>";
    // 够长（>40 字）⇒ 摘要是**窗口**、两头带 '…'，用来验"命中在中间"。
    const O_LONG_HTML =
      "<p>今天是周末，早上起得很晚，吃过早饭以后下楼绕了一大圈，回来给自己泡了一杯青柠水，接着把没看完的那本书翻完了，天就黑了。</p>";
    const O_CASE_HTML = "<p>Hello 世界，这是大小写那一组。</p>";
    // 「有结果、但一处都不亮」用这一条造：两个查询词都在**第 40 字之后**，
    // 而后端的 `make_snippet()` 拿**整个查询串**找位置、找不到就从第 0 字开窗
    // ⇒ 窗口里一个查询词都没有。见下面的 O.18。
    const O_FAR_DATE = D(-6);
    const O_FAR_HTML =
      "<p>今天是周末，但我没出门，早上把攒了一周的衣服都洗了，中午煮了面，下午一直在看书。阳台上的紫苏长得很好；至于旁边那盆薄荷，还是老样子。</p>";

    rec(
      "O.1 塞短条目（同一个词出现三次）",
      JSON.stringify(await evalFn(client, A_seedRaw, fmt(O_SHORT_DATE), O_SHORT_HTML))
    );
    rec(
      "O.2 塞长条目（命中落在摘要中间）",
      JSON.stringify(await evalFn(client, A_seedRaw, fmt(O_LONG_DATE), O_LONG_HTML))
    );
    rec(
      "O.3 塞大小写条目",
      JSON.stringify(await evalFn(client, A_seedRaw, fmt(O_CASE_DATE), O_CASE_HTML))
    );
    rec(
      "O.3b 塞「查询词落在窗口之外」的条目",
      JSON.stringify(await evalFn(client, A_seedRaw, fmt(O_FAR_DATE), O_FAR_HTML))
    );

    // ---- O.4~O.9 一个词出现三次 ⇒ 三处都亮 ----
    const oA = await searchAndRead("青柠");
    rec("O.4 搜「青柠」的结果条数", oA.items.length + "（等了 " + oA.ms + "ms）");
    const oShort = oA.items.find((x) => x.text.trim() === O_SHORT_TEXT) || null;
    rec("O.5 那条短条目的摘要", JSON.stringify(oShort && oShort.text));
    ok(!!oShort, "O.6 ⭐ 搜到了那条短条目（摘要是原文的子串）", JSON.stringify(oA.items.map((x) => x.text.slice(0, 16))));
    // ⭐⭐ 本件的正题：改前这里只有 1 个 mark。
    ok(
      !!oShort && oShort.marks.filter((m) => m === "青柠").length === 3,
      "O.7 ⭐⭐ 同一个词出现三次 ⇒ 三处都亮（改前只亮第一处）",
      JSON.stringify(oShort && oShort.marks)
    );
    // 反向对照：不许"多亮" —— 所有 mark 必须都是查询词本身。
    ok(
      !!oShort && oShort.marks.every((m) => m === "青柠"),
      "O.8 ⭐ 反向对照：没有凭空多出来的高亮（每个 mark 都是查询词）",
      JSON.stringify(oShort && oShort.marks)
    );
    // 高亮只能是摘要里真实存在的子串（不凭空造字）。
    ok(
      oA.items.every((x) => x.marks.every((m) => x.text.includes(m))),
      "O.9 ⭐ 高亮片段都是摘要里真实存在的子串（不凭空造字）",
      JSON.stringify(oA.items.map((x) => x.marks).slice(0, 6))
    );
    // 防 XSS 的可观测证据：摘要里的子元素**只允许** span / mark。
    ok(
      oA.items.every((x) => x.tags.every((t) => t === "span" || t === "mark")),
      "O.10 ⭐⭐ 摘要里只有 span / mark 两种子元素（没用 v-html）",
      JSON.stringify(oA.items.map((x) => x.tags).slice(0, 6))
    );

    // ---- O.11 多个词：按空白切开、分别亮 ----
    const oB = await searchAndRead("青柠 绿茶");
    const oShort2 = oB.items.find((x) => x.text.trim() === O_SHORT_TEXT) || null;
    rec("O.11 搜「青柠 绿茶」的高亮（DOM 顺序）", JSON.stringify(oShort2 && oShort2.marks));
    ok(
      !!oShort2 &&
        oShort2.marks.join("|") === ["青柠", "青柠", "绿茶", "青柠"].join("|"),
      "O.12 ⭐⭐ 两个词分别亮：青柠×3 ＋ 绿茶×1（按出现顺序）",
      JSON.stringify(oShort2 && oShort2.marks)
    );

    // ---- O.13 命中落在摘要**中间**（不是从开头切） ----
    const oC = await searchAndRead("青柠");
    const oLong = oC.items.find((x) => x.text.includes("青柠") && x.text.startsWith("…")) || null;
    rec("O.13 长条目的摘要", JSON.stringify(oLong && oLong.text));
    ok(
      !!oLong && oLong.marks.join("|") === "青柠",
      "O.14 ⭐ 长条目里命中的是**那一段**（亮的是「青柠」，不是从开头切）",
      JSON.stringify(oLong && { text: oLong.text, marks: oLong.marks })
    );
    ok(
      !!oLong && oLong.text.indexOf("青柠") > 1,
      "O.15 ⭐ 摘要是从中间开的窗（前面还有字），命中不在第 0 位",
      JSON.stringify(oLong && oLong.text)
    );

    // ---- O.16 大小写不敏感 ----
    const oD = await searchAndRead("hello");
    const oCase = oD.items.find((x) => x.text.includes("Hello")) || null;
    rec("O.16 搜「hello」（原文是 Hello）", JSON.stringify(oCase && { text: oCase.text, marks: oCase.marks }));
    ok(
      !!oCase && oCase.marks.join("|") === "Hello",
      "O.17 ⭐ 大小写不同也能亮（亮的是原文里的 Hello）",
      JSON.stringify(oCase && oCase.marks)
    );

    // ---- O.18 ⭐ **"一处都不亮"确实能发生，且不报错** ----
    //
    // 造法：那两个词（紫苏 / 薄荷）都排在正文**第 40 字之后**，
    // 而后端 `make_snippet()` 是拿**整个查询串**「紫苏 薄荷」去找位置的 ——
    // 正文里这两个词并不相邻 ⇒ 整串找不到 ⇒ **窗口从第 0 字开** ⇒
    // 40 字的窗口里**一个查询词都没有** ⇒ `splitByTerms` 自然一处都亮不出来。
    //
    // ⚠️ 这与 §八-5 说的「宽匹配那类」是同一件事的**确定版本**
    //    （单字索引兜底出来的结果同样可能整段不亮）。
    //    ⛔ **不许为了"必定亮一处"去改后端摘要** —— 那是另一件事。
    const oE = await searchAndRead("紫苏 薄荷");
    rec("O.18 搜「紫苏 薄荷」的条数", oE.items.length);
    rec("O.18b 每条的高亮与宽匹配标记", JSON.stringify(oE.items.map((x) => ({ m: x.marks, b: x.badge }))));
    ok(
      oE.items.length > 0,
      "O.19a ⭐ 这两个词的那篇确实被搜出来了（有结果）",
      JSON.stringify(oE.items.map((x) => x.text.slice(0, 14)))
    );
    const oEbad = oE.items.find((x) => x.marks.length === 0) || null;
    rec("O.18c 那条一处都没亮的", JSON.stringify(oEbad && { text: oEbad.text, badge: oEbad.badge }));
    ok(
      !!oEbad,
      "O.19b ⭐⭐ 「有结果、但一处都不亮」确实存在（且界面没报错）",
      JSON.stringify(oE.items.map((x) => ({ t: x.text.slice(0, 12), m: x.marks })))
    );
    ok(
      oE.items.every((x) => x.text.trim().length > 0),
      "O.20 ⭐ 没亮出来的那条，摘要照样完整显示（不是空白）",
      JSON.stringify(oE.items.map((x) => x.text.trim().length))
    );
    // ⭐ 反向对照：同一批里**必须有一条是亮的** —— 否则"没亮"可能只是功能整个坏了。
    //    （这条把 O.19b 从"可能是空转"变成"真的是这一条特殊"。）
    const oEhit = await searchAndRead("紫苏");
    ok(
      oEhit.items.some((x) => x.marks.length > 0),
      "O.20b ⭐ 反向对照：同一个词单独搜时**是亮的**（所以刚才那条不亮是窗口的锅，不是功能坏了）",
      JSON.stringify(oEhit.items.map((x) => x.marks))
    );

    // ---- O.21 长查询不卡 ----
    const longQ = "青柠 绿茶 红茶 zz1 zz2 zz3 zz4 zz5 zz6 zz7 zz8 zz9 zz10 zz11";
    await evalFn(client, A_search, longQ);
    const settled = await waitFor(
      client,
      () => {
        const n = document.querySelector(".search .note");
        return !!n && !n.textContent.includes("搜索中");
      },
      8000
    );
    rec("O.21 长查询（14 个词）结算耗时", settled.ms + "ms");
    ok(settled.ok, "O.22 ⭐ 十几词的查询不卡、不报错（8 秒内结算）", "等了 " + settled.ms + "ms");

    // ---- O.23 防 XSS 没被破坏 ----
    await evalFn(client, A_armAlertSpy);
    // 播一篇"正文里真带尖括号"的：`2 < 3`（未闭合的 `<`，按 P2-3 的规矩原样保留）
    const O_XSS_HTML = "<p>樱花树下 2 < 3 的对比</p>";
    await evalFn(client, A_seedRaw, fmt(D(-4)), O_XSS_HTML);
    const oF = await searchAndRead("樱花");
    const spy = await evalFn(client, R_alertSpy);
    rec("O.23 搜「樱花」的摘要与探针", JSON.stringify({ items: oF.items.map((x) => x.text), spy: spy }));
    ok(oF.items.length > 0, "O.24 ⭐ 那篇带尖括号的被搜到了", JSON.stringify(oF.items.map((x) => x.text)));
    ok(!spy.fired, "O.25 ⭐⭐ 没有弹出任何窗（防 XSS 那条没破）", JSON.stringify(spy));
    ok(spy.dangerous === 0, "O.26 ⭐⭐ 搜索页里没有 script / img / iframe 被插进来", String(spy.dangerous));
    ok(spy.onlySpanOrMark, "O.27 ⭐⭐ 摘要里的子元素仍然只有 span / mark", JSON.stringify(spy));

    // ---- O.28 深浅两态：`mark` 的颜色仍然等于 --accent-soft（没被改） ----
    for (const mode of ["light", "dark"]) {
      await setTheme(client, mode);
      await searchAndRead("青柠");
      const mc = await evalFn(client, R_markColor);
      rec("O.28 mark 颜色（" + mode + "）", JSON.stringify(mc));
      ok(
        mc.found && mc.bg === mc.expected,
        "O.29 ⭐⭐ " + mode + " 下 mark 的背景色仍等于 --accent-soft（颜色没被写死、没被改）",
        JSON.stringify(mc)
      );
      ok(
        mc.found && mc.bg !== "rgba(0, 0, 0, 0)",
        "O.30 ⭐ " + mode + " 下 mark 确实有底色（不是透明、不是浏览器默认黄）",
        JSON.stringify(mc)
      );
    }
    await setTheme(client, "light");


    // ══════════════════════════════════════════════════════════════════════
    // P. 搜索历史（【P2-20】）
    // ══════════════════════════════════════════════════════════════════════
    //
    // 本组要钉住的六件事：
    //   ① 搜过就记、**最新的排最前**；② 去重；③ 搜不到也记；
    //   ④ **搜过就让位**（历史整块收起，点 × 才回来）；⑤ 位置**紧贴搜索框正下方**；
    //   ⑥ ⭐ **存的是加密库、不是 `localStorage`**，且**关软件重开还在**。
    console.log("== P. 搜索历史（P2-20）==");

    /** 历史区的完整可观测状态（在不在、标题、清空按钮、胶囊、几何关系）。 */
    const R_histState = () => {
      const box = document.querySelector(".search .history");
      const pills = Array.from(document.querySelectorAll(".search .hist-pill"));
      const head = document.querySelector(".search .history-title");
      const clearBtn = document.querySelector(".search .history-clear");
      const input =
        document.querySelector(".search input.input[type=search]") ||
        document.querySelector(".search input");
      const panel = document.querySelector(".search");
      // 面板的**直接子节点顺序** —— 用来钉「紧贴搜索框正下方」。
      const topLevel = panel ? Array.from(panel.children).map((c) => c.className) : [];
      return {
        inSearch: !!panel,
        present: !!box,
        title: head ? head.textContent.trim() : null,
        hasClear: !!clearBtn,
        clearText: clearBtn ? clearBtn.textContent.trim() : null,
        pills: pills.map((x) => (x.textContent || "").trim()),
        inputValue: input ? input.value : null,
        resultCount: document.querySelectorAll(".search .item-snippet").length,
        note: (() => {
          const n = document.querySelector(".search .note");
          return n ? n.textContent.trim() : null;
        })(),
        hasList: !!document.querySelector(".search .list"),
        topLevel,
        histTop: box ? Math.round(box.getBoundingClientRect().top) : null,
        inputRowBottom: (() => {
          const r = document.querySelector(".search .input-row");
          return r ? Math.round(r.getBoundingClientRect().bottom) : null;
        })(),
      };
    };

    /** 只切 tab（不搜、不填词）。 */
    const A_switchTab = async (label) => {
      const qa = (s) => Array.from(document.querySelectorAll(s));
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const tab = qa("nav.tabs button").find((x) => x.textContent.includes(label));
      if (!tab) return "no-tab";
      tab.click();
      await nap(700);
      return `tab:${label}`;
    };

    /** 往搜索框填字 ＋ 回车（**不切 tab** —— 本组已经在搜索页上）。 */
    const A_searchOnly = async (term) => {
      const input =
        document.querySelector(".search input.input[type=search]") ||
        document.querySelector(".search input");
      if (!input) return "no-input";
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      set.call(input, term);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // `@keyup.enter="onEnter"` —— 只有这条路会「记一次历史」。
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      return `submitted:${term}`;
    };

    /**
     * 只填字、**不发回车** —— 用来验「打一半停一下不算搜过」。
     *
     * ⚠️ 但输入框一有字，260ms 防抖就会调 `run()`、`searched` 变 true、历史让位。
     *    所以本探针之后必须**再点 ×**才能读历史 —— 正是本组在做的事。
     */
    const A_typeOnly = async (term) => {
      const input =
        document.querySelector(".search input.input[type=search]") ||
        document.querySelector(".search input");
      if (!input) return "no-input";
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      set.call(input, term);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return `typed:${term}`;
    };

    /** 点输入框右边那个 ×（`clear()`）—— 「搜过就让位」后让历史回来的**唯一**官方入口。 */
    const A_clearSearch = async () => {
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = document.querySelector(".search .clear");
      if (btn) {
        btn.click();
        await nap(400);
        return "clicked-x";
      }
      const input =
        document.querySelector(".search input.input[type=search]") ||
        document.querySelector(".search input");
      if (!input) return "no-input";
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      set.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await nap(400);
      return "set-empty";
    };

    /** 点历史里某颗胶囊（按文字找）。 */
    const A_pickPill = async (word) => {
      const qa = (s) => Array.from(document.querySelectorAll(s));
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const p = qa(".search .hist-pill").find((x) => (x.textContent || "").trim() === word);
      if (!p) return "no-such-pill";
      p.click();
      await nap(500);
      return `picked:${word}`;
    };

    /** 点历史标题右边那个「清空」。 */
    const A_clickHistClear = async () => {
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = document.querySelector(".search .history-clear");
      if (!btn) return "no-clear-btn";
      btn.click();
      await nap(900);
      return "clicked";
    };

    /**
     * 胶囊的配色（深浅两态各读一次，比出「跟着主题走」）。
     *
     * ⚠️ 胶囊的**底色本来就是 `transparent`**（只在悬停时才上色）⇒ 拿底色比较会假红。
     *    要比的是**描边色 / 文字色**，而且要和"同一个变量解析出来的期望值"比 ——
     *    这才是"走变量、没写死颜色"的可观测证据（本项目的标准手法）。
     */
    const R_pillStyle = () => {
      const p = document.querySelector(".search .hist-pill");
      if (!p) return { found: false };
      const cs = getComputedStyle(p);
      const probe = document.createElement("div");
      probe.style.borderTopColor = "var(--border)";
      probe.style.color = "var(--text-2)";
      document.body.appendChild(probe);
      const pcs = getComputedStyle(probe);
      const expectedBorder = pcs.borderTopColor;
      const expectedColor = pcs.color;
      probe.remove();
      return {
        found: true,
        bg: cs.backgroundColor,
        color: cs.color,
        border: cs.borderTopColor,
        radius: cs.borderTopLeftRadius,
        expectedBorder,
        expectedColor,
      };
    };

    /** 胶囊的排布（折了几行、有没有捅出容器）。 */
    const R_pillLayout = () => {
      const pills = Array.from(document.querySelectorAll(".search .hist-pill"));
      const box = document.querySelector(".search .history-pills");
      const bb = box ? box.getBoundingClientRect() : null;
      return {
        n: pills.length,
        rows: new Set(pills.map((p) => Math.round(p.getBoundingClientRect().top))).size,
        containerOverflowX: box ? Math.round(box.scrollWidth - box.clientWidth) : null,
        panelOverflowX: (() => {
          const p = document.querySelector(".search");
          return p ? Math.round(p.scrollWidth - p.clientWidth) : null;
        })(),
        docOverflowX: Math.round(
          document.documentElement.scrollWidth - document.documentElement.clientWidth
        ),
        outOfBox: bb
          ? pills.filter((p) => p.getBoundingClientRect().right > bb.right + 1).length
          : -1,
      };
    };

    /**
     * ⭐ 搜索词**不许**落进 `localStorage`。
     *
     * 这是【P2-20】第 ②条需求的**直接反证** —— 搜索词往往就是日记里的字，
     * 存 `localStorage` 等于把日记的一部分明文摊在硬盘上。
     */
    const R_localStorageHits = (term) => {
      const keys = Object.keys(localStorage);
      const hits = keys.filter((k) => {
        try {
          return String(localStorage.getItem(k) || "").includes(term);
        } catch {
          return false;
        }
      });
      return { keys, hits };
    };

    /**
     * 搜一个词 → 等它落定 → 读「搜过时的历史区」（应为让位）→ 点 × → 读「让位后的历史区」。
     *
     * ⚠️ 这里的"等"是 `sleep` 而不是 `waitFor`：`SearchPanel.run()` 与 `remember()`
     *    都是异步的，而**历史区在 `searched` 一翻转就消失**（判据比结果先成立）
     *    ⇒ 用"等结果出现"会**立刻**满足、读到的是上一轮。铁律 13 的同一族坑。
     */
    const searchThenPeek = async (term, waitMs = 1000) => {
      await evalFn(client, A_searchOnly, term);
      await sleep(waitMs);
      const during = await evalFn(client, R_histState);
      await evalFn(client, A_clearSearch);
      await sleep(600);
      const after = await evalFn(client, R_histState);
      return { during, after };
    };

    // ---- P.1~P.5 开局：前面几组（L / O）搜过 ⇒ 历史里已经有货，且让位规则已生效 ----
    //
    // ⚠️ 必须**先切走再切回**：`App.vue` 用 `v-if` 切页 ⇒ 组件重新挂载、输入框归零。
    //    不然会带着 O 组最后那个长查询进来（`searched` 还是 true）⇒ 历史被让位、
    //    下面这条断言会**因为上一组的残留**而红（本项目踩过很多次的"开局前提"坑）。
    //
    // ⚠️ 另外必须**自己塞两条会命中的条目**（不能指望 L / O 组的）——
    //    本组最后那条 P.45「清空历史不影响搜索本身」需要真能搜到东西，
    //    否则它会在"功能正常"的情况下也红（第一轮就是这么假红掉的）。
    rec(
      "P.0 塞两条会命中的条目（末条 P.45 的正向对照要用）",
      JSON.stringify([
        await evalFn(client, A_seedRaw, fmt(D(-9)), "<p>今天的柠檬水很酸，柠檬片放多了，下次少放两片。</p>"),
        await evalFn(client, A_seedRaw, fmt(D(-10)), "<p>夜色很好，沿着河堤走了一大圈才回来。</p>"),
      ])
    );
    await evalFn(client, A_switchTab, "写日记");
    await evalFn(client, A_switchTab, "搜索");
    const h0 = await evalFn(client, R_histState);
    rec("P.1 开局的历史区", JSON.stringify({ present: h0.present, title: h0.title, pills: h0.pills }));
    ok(
      h0.inSearch && h0.present,
      "P.2 ⭐ 前面几组搜过 ⇒ 历史区自己冒出来了（历史真的在累积，不用手动开什么开关）",
      JSON.stringify({ inSearch: h0.inSearch, present: h0.present, pills: h0.pills })
    );
    ok(
      h0.title === "搜索历史" && h0.hasClear && h0.clearText === "清空",
      "P.3 历史区的样子：小标题「搜索历史」＋ 一个「清空」按钮",
      JSON.stringify({ title: h0.title, hasClear: h0.hasClear, clearText: h0.clearText })
    );
    // 位置：历史区必须是**面板的第 2 个直接子节点**（紧跟在输入框那一行后面）。
    ok(
      h0.topLevel.length >= 2 && String(h0.topLevel[0]).includes("input-row") &&
        String(h0.topLevel[1]).includes("history"),
      "P.4 ⭐ 「紧贴搜索框正下方」：历史区排在输入框那一行**后面一位**（用户 2026-09-29 拍板的位置）",
      JSON.stringify(h0.topLevel)
    );
    ok(
      h0.inputRowBottom !== null && h0.histTop !== null && h0.histTop >= h0.inputRowBottom - 1,
      "P.5 ⭐ 几何上也真的在下面（历史区顶边 ≥ 输入框底边）",
      JSON.stringify({ inputRowBottom: h0.inputRowBottom, histTop: h0.histTop })
    );

    // ---- P.6~P.8 点「清空」⇒ 消失，而且**是库里真清了**（切页回来仍不出现）----
    const oPills0 = h0.pills.length;
    rec("P.6 点「清空」", await evalFn(client, A_clickHistClear));
    const h1 = await evalFn(client, R_histState);
    ok(
      !h1.present && h1.pills.length === 0,
      "P.7 ⭐ 点「清空」⇒ 历史整块从界面上消失",
      JSON.stringify({ present: h1.present, pills: h1.pills })
    );
    // ⭐ 反向对照：切走再切回来 —— 组件会重新挂载、重新读库。
    //    如果只清了前端那个数组，这里历史会**又冒出来**。
    await evalFn(client, A_switchTab, "写日记");
    await evalFn(client, A_switchTab, "搜索");
    const h2 = await evalFn(client, R_histState);
    ok(
      !h2.present,
      "P.8 ⭐⭐ 切走再切回来，历史仍然不出现（说明清的是**库里的**那一份，不是只清了内存里的数组）",
      JSON.stringify({ present: h2.present, pills: h2.pills, 清空前有: oPills0 + " 条" })
    );

    // ---- P.9~P.17 搜过就记：最新的在最前、去重、点胶囊也记 ----
    const s1 = await searchThenPeek("柠檬");
    rec("P.9 搜「柠檬」时 / 让位后的历史区", JSON.stringify(s1));
    ok(
      s1.during.present === false,
      "P.10 ⭐ 搜过就让位：**历史非空也不显示**（一屏只放一样东西 —— 用户拍板的规则）",
      JSON.stringify({ present: s1.during.present, pills: s1.during.pills })
    );
    ok(
      s1.after.present && s1.after.pills.join("｜") === "柠檬" && s1.during.resultCount > 0,
      "P.11 ⭐ 点 × 之后历史回来，里面正好是刚搜的「柠檬」；而且这次搜索**真的搜到了东西**（种子条目确实在库里）",
      JSON.stringify({ pills: s1.after.pills, 结果数: s1.during.resultCount })
    );

    const s2 = await searchThenPeek("夜色");
    ok(
      s2.after.pills.join("｜") === "夜色｜柠檬",
      "P.12 ⭐⭐ 再搜「夜色」⇒ 新的排最前：`夜色 柠檬`（最近搜的在最前）",
      JSON.stringify(s2.after.pills)
    );

    const s3 = await searchThenPeek("柠檬");
    ok(
      s3.after.pills.join("｜") === "柠檬｜夜色" && s3.after.pills.length === 2,
      "P.13 ⭐⭐ 重复搜「柠檬」⇒ 挪到最前、**不重复**（长度仍是 2）",
      JSON.stringify(s3.after.pills)
    );

    // 点胶囊：填进输入框 ＋ 立刻搜 ＋ 也记一次（顺序会翻过来）
    rec("P.14 点「夜色」胶囊", await evalFn(client, A_pickPill, "夜色"));
    const h3 = await evalFn(client, R_histState);
    rec("P.15 点完之后（搜过 ⇒ 历史已让位）", JSON.stringify({ present: h3.present, note: h3.note }));
    ok(
      h3.present === false && !!h3.note,
      "P.16 ⭐ 点胶囊＝一次真正的搜索（历史让位 ＋ 状态提示出现）",
      JSON.stringify({ present: h3.present, note: h3.note })
    );
    await evalFn(client, A_clearSearch);
    await sleep(600);
    const h4 = await evalFn(client, R_histState);
    ok(
      h4.pills.join("｜") === "夜色｜柠檬",
      "P.17 ⭐⭐ 点胶囊**也算搜过** ⇒ 「夜色」被顶到最前（`夜色 柠檬`）",
      JSON.stringify(h4.pills)
    );

    // ---- P.18~P.20 「打一半停一下」不算搜过 ----
    const beforeTyping = h4.pills.join("｜");
    rec("P.18 只打字、不回车", await evalFn(client, A_typeOnly, "半路"));
    await sleep(900); // 260ms 输入防抖早就跑完了（`run()` 会被调到，但**不该**记历史）
    await evalFn(client, A_clearSearch);
    await sleep(600);
    const h5 = await evalFn(client, R_histState);
    ok(
      h5.pills.join("｜") === beforeTyping && !h5.pills.includes("半路"),
      "P.19 ⭐⭐ 「打一半停一下」不进历史（记历史的只有回車与点胶囊两条路，⛔ 没塞进输入防抖那条）",
      JSON.stringify({ 打字前: beforeTyping, 打字后: h5.pills })
    );
    ok(
      h5.pills.length === 2,
      "P.20 ⭐ 反向对照：历史**条数没变**（不是「没记，但把别的挤掉了」）",
      JSON.stringify(h5.pills)
    );

    // ---- P.21~P.24 「一条都没搜到」也算搜过、也记 ----
    const P_NOHIT = "完全搜不到的词zzq";
    const s4 = await searchThenPeek(P_NOHIT);
    rec("P.21 搜一个搜不到的词", JSON.stringify(s4));
    ok(
      s4.during.present === false,
      "P.22 ⭐⭐ 「连一条都没搜到」也算搜过 ⇒ 历史照样让位（用户 2026-09-29 特意点名的这一条）",
      JSON.stringify({ present: s4.during.present, note: s4.during.note })
    );
    ok(
      s4.during.note !== null && s4.during.note.includes("没有找到"),
      "P.23 这一轮的提示语是「没有找到包含…的日记」",
      JSON.stringify(s4.during.note)
    );
    ok(
      s4.after.pills.join("｜") === P_NOHIT + "｜夜色｜柠檬",
      "P.24 ⭐⭐ 搜不到的词**也被记下了**且在第一位（搜不到 ≠ 不算搜过）",
      JSON.stringify(s4.after.pills)
    );

    // ---- P.25~P.26 搜索词不许落进 localStorage ----
    const ls = await evalFn(client, R_localStorageHits, "柠檬");
    rec("P.25 localStorage 的键", JSON.stringify(ls.keys));
    ok(
      ls.hits.length === 0,
      "P.26 ⭐⭐ 搜索词**没有**出现在 localStorage 里（它在加密库里；搜索词往往就是日记里的字）",
      JSON.stringify(ls)
    );

    // ---- P.27~P.30 深浅两态：胶囊配色跟着主题走（没写死颜色）----
    const pillStyles = {};
    for (const mode of ["light", "dark"]) {
      await setTheme(client, mode);
      let st = await evalFn(client, R_pillStyle);
      if (!st.found) {
        // 上一轮清过、或正处在"让位"态 —— 兜底：搜一次再点 ×
        await evalFn(client, A_searchOnly, "柠檬");
        await sleep(900);
        await evalFn(client, A_clearSearch);
        await sleep(600);
        st = await evalFn(client, R_pillStyle);
      }
      pillStyles[mode] = st;
      rec("P.27 胶囊配色（" + mode + "）", JSON.stringify(st));
    }
    await setTheme(client, "light");
    ok(
      pillStyles.light.found && pillStyles.dark.found &&
        pillStyles.light.border === pillStyles.light.expectedBorder &&
        pillStyles.dark.border === pillStyles.dark.expectedBorder &&
        pillStyles.light.color === pillStyles.light.expectedColor &&
        pillStyles.dark.color === pillStyles.dark.expectedColor,
      "P.28 ⭐⭐ 胶囊的描边色 / 文字色**等于同一个 CSS 变量解析出来的值**（深浅两态都对得上 ⇒ 没写死颜色）",
      JSON.stringify({
        light: { border: pillStyles.light.border, expected: pillStyles.light.expectedBorder, color: pillStyles.light.color },
        dark: { border: pillStyles.dark.border, expected: pillStyles.dark.expectedBorder, color: pillStyles.dark.color },
      })
    );
    ok(
      pillStyles.light.border !== pillStyles.dark.border,
      "P.29 ⭐ 而且那个变量本身在深浅两态下**确实不同**（描边真的跟着主题换）",
      JSON.stringify({ light: pillStyles.light.border, dark: pillStyles.dark.border })
    );
    ok(
      pillStyles.light.found && pillStyles.light.border !== "rgba(0, 0, 0, 0)" &&
        pillStyles.light.radius === "999px",
      "P.30 ⭐ 胶囊是有描边的**圆角**小胶囊（不是方块、不是透明无痕的一块）",
      JSON.stringify({ border: pillStyles.light.border, radius: pillStyles.light.radius, bg: pillStyles.light.bg })
    );

    // ---- P.31~P.33 窄屏（720px）折行、不捅出去 ----
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(700);
    // 先造几条**长**的 —— 短的几条挤在一行里，折行就看不出来了。
    const LONG_TERMS = [
      "今天下午在楼下那条街上走了很久，风很大，叶子吹得到处都是",
      "晚饭煮了一锅面，放了两个蛋，吃完觉得有点撑就出去溜达了一圈",
      "阳台上的紫苏长得很好，旁边那盆薄荷还是老样子，一直没缓过来",
      "把上周没看完的那本书翻完了，结尾比想象中好，合上书天已经黑了",
    ];
    for (const t of LONG_TERMS) {
      await evalFn(client, A_searchOnly, t);
      await sleep(800);
      await evalFn(client, A_clearSearch);
      await sleep(500);
    }
    const lay = await evalFn(client, R_pillLayout);
    rec("P.31 720px 下的胶囊排布", JSON.stringify(lay));
    ok(
      lay.containerOverflowX <= 0 && lay.panelOverflowX <= 0 && lay.docOverflowX <= 0 && lay.outOfBox === 0,
      "P.32 ⭐⭐ 720px 窄屏下：胶囊**只折行、横向一个像素都不溢出**（容器/面板/整个文档都不出横向滚动条）",
      JSON.stringify(lay)
    );
    ok(
      lay.rows >= 2,
      "P.33 ⭐ 而且**真的折行了**（≥2 行）—— 不是靠「把内容挤成一行」混过去的",
      JSON.stringify({ rows: lay.rows, n: lay.n })
    );
    await client.send("Emulation.clearDeviceMetricsOverride");
    await sleep(600);

    // ---- P.34~P.39 ⭐⭐ 关软件重开：历史还在（这是"存加密库"最硬的证据）----
    //
    // ⚠️ 前两条（切页来回 / localStorage 没货）都只证明"不在内存、不在 localStorage"，
    //    **只有真重启**才能把它钉死在"落在库里了"。
    const beforeRestart = await evalFn(client, R_histState);
    rec("P.34 重启前的历史", JSON.stringify(beforeRestart.pills));
    await shutdown(child, client);
    child = null;
    client = null;
    let L2 = await launch(D1);
    child = L2.child;
    client = L2.client;
    const reInit = await evalFn(client, P_init, PIN);
    reInit.forEach(([k, v]) => rec(`P.35 重启后 ${k}`, v));
    await sleep(1200);
    await setTheme(client, "light");
    await evalFn(client, A_switchTab, "搜索");
    const h6 = await evalFn(client, R_histState);
    rec("P.36 重启后的历史区", JSON.stringify({ present: h6.present, pills: h6.pills }));
    ok(
      h6.present && h6.pills.length > 0,
      "P.37 ⭐⭐⭐ 关掉软件、重新打开 ⇒ 搜索历史**还在**（真的落在加密库里了）",
      JSON.stringify({ present: h6.present, pills: h6.pills })
    );
    ok(
      h6.pills.includes("柠檬") && h6.pills.includes("夜色"),
      "P.38 ⭐⭐ 重启后那几个词一条不少，且顺序还是「最近的在前」",
      JSON.stringify(h6.pills)
    );
    ok(
      h6.pills.length <= 20,
      "P.39 ⭐ 历史条数不超过上限 20（本组搜了十几次，仍然收在 20 以内）",
      JSON.stringify({ n: h6.pills.length })
    );

    // ---- P.40~P.45 「清空」只清历史：输入框与结果区都不动 ----
    const h7 = await evalFn(client, R_histState);
    const beforeClear = {
      inputValue: h7.inputValue,
      hasList: h7.hasList,
      note: h7.note,
      pills: h7.pills.length,
    };
    rec("P.40 点「清空」之前", JSON.stringify(beforeClear));
    rec("P.41 点「清空」", await evalFn(client, A_clickHistClear));
    const h8 = await evalFn(client, R_histState);
    rec("P.42 点「清空」之后", JSON.stringify({
      present: h8.present,
      inputValue: h8.inputValue,
      hasList: h8.hasList,
      note: h8.note,
      pills: h8.pills.length,
    }));
    ok(
      !h8.present && h8.pills.length === 0,
      "P.43 ⭐ 历史整块消失",
      JSON.stringify({ present: h8.present, pills: h8.pills })
    );
    ok(
      h8.inputValue === beforeClear.inputValue && h8.hasList === beforeClear.hasList &&
        h8.note === beforeClear.note,
      "P.44 ⭐⭐ 「清空」**只管历史** —— 输入框里的字、结果列表、状态提示一个都没动（与那个 × 是两件事，没被合并）",
      JSON.stringify({ 前: beforeClear, 后: { inputValue: h8.inputValue, hasList: h8.hasList, note: h8.note } })
    );
    // 反向对照：清完之后搜索本身照常能用。
    const s5 = await searchThenPeek("柠檬");
    ok(
      s5.during.resultCount > 0 && s5.after.pills.join("｜") === "柠檬",
      "P.45 ⭐ 反向对照：清空历史**不影响搜索本身**（还能搜到，且新的一笔又记上了，历史从 1 条重新开始）",
      JSON.stringify({ 结果数: s5.during.resultCount, pills: s5.after.pills })
    );

    // ══════════════════════════════════════════════════════════════════════
    // Q. 启动画面**至少**停 1 秒（【P2-2】追加）
    // ══════════════════════════════════════════════════════════════════════
    //
    // ⚠️ 怎么测：CDP 连上来的时候启动画面**早就撤掉了**（连一次要一两秒，
    //    而它只停 1 秒）⇒ 直接量是量不到的。
    //    办法是给页面装一个**在文档创建时、页面脚本之前**就跑的探针
    //    （`Page.addScriptToEvaluateOnNewDocument`），然后 `Page.reload()`
    //    完整重放一遍启动流程 —— 探针从第 0 毫秒开始逐帧记录。
    //
    // ⚠️ 它用到的 `performance.now()` 与 `main.ts` 里那个**同一个时间原点**
    //    （都是"本次导航开始"），所以两边可以直接比较。
    console.log("== Q. 启动画面至少停 1 秒（P2-2 追加）==");

    const Q_PROBE_SRC = `
(function () {
  var S = {
    t0: performance.now(),
    firstSeenAt: null, mountAt: null, fadeAt: null, goneAt: null,
    texts: [], frames: 0, samples: [], done: false, err: null
  };
  window.__SPLASH = S;
  function tick() {
    try {
      if (S.done) return;
      if (performance.now() > 10000) { S.done = true; return; }
      var el = document.getElementById("boot-splash");
      var app = document.getElementById("app");
      if (app && app.children.length > 0 && S.mountAt === null) S.mountAt = performance.now();
      if (el) {
        S.frames++;
        var mk = el.querySelector(".mark");
        var hd = el.querySelector(".hint");
        if (S.firstSeenAt === null) {
          S.firstSeenAt = performance.now();
          S.texts = [mk ? mk.textContent : null, hd ? hd.textContent : null];
          // ⭐ 判"在不在呼吸"**不能只看逐帧采样** —— 窗口一旦被别的窗口挡住，
          //    WebView2 会把 rAF 节流到 1 秒一次，采样点屈指可数（假红）。
          //    改用 getAnimations()：直接问「这个元素身上有没有正在跑的动画」，
          //    与帧率无关。再配一份 computed style 兜底。
          try {
            S.anims = (mk && mk.getAnimations ? mk.getAnimations() : []).map(function (a) {
              var t = (a.effect && a.effect.getTiming) ? a.effect.getTiming() : {};
              return {
                name: a.animationName || null,
                duration: t.duration,
                iterations: t.iterations,
                playState: a.playState,
              };
            });
          } catch (e) { S.animsErr = String((e && e.message) || e); }
          try {
            var cs = mk ? getComputedStyle(mk) : null;
            S.animStyle = cs ? {
              animationName: cs.animationName,
              animationDuration: cs.animationDuration,
              animationIterationCount: cs.animationIterationCount,
              // 只动透明度的证据：位移/缩放一律 none（"廉价感"就是这么来的）
              transform: cs.transform,
            } : null;
          } catch (e) { S.animStyleErr = String((e && e.message) || e); }
        }
        if (mk && S.samples.length < 90) S.samples.push(getComputedStyle(mk).opacity);
        if (el.classList.contains("is-gone") && S.fadeAt === null) S.fadeAt = performance.now();
      } else if (S.firstSeenAt !== null) {
        S.goneAt = performance.now();
        S.done = true;
        return;
      }
    } catch (e) { S.err = String((e && e.message) || e); }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
`;

    await client.send("Page.enable");
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: Q_PROBE_SRC });

    /** 重新加载一次、把启动画面完整重放一遍，然后读探针记录。 */
    const qRunOnce = async () => {
      await client.send("Page.reload", { ignoreCache: false });
      const w = await waitFor(
        client,
        () => {
          const s = window.__SPLASH;
          return !!(s && (s.done === true || s.goneAt !== null));
        },
        20000
      );
      const s = await evalFn(client, () => {
        const s = window.__SPLASH || {};
        const r = (v) => (v === null || v === undefined ? null : Math.round(v));
        return {
          firstSeenAt: r(s.firstSeenAt),
          mountAt: r(s.mountAt),
          fadeAt: r(s.fadeAt),
          goneAt: r(s.goneAt),
          texts: s.texts || [],
          anims: s.anims || [],
          animStyle: s.animStyle || null,
          frames: s.frames || 0,
          samples: s.samples || [],
          done: s.done === true,
          err: s.err || null,
        };
      });
      return { waited: w.ok, waitedMs: w.ms, ...s };
    };

    const qRuns = [];
    // ⚠️⚠️ 跑之前必须**先看一眼本机的「减弱动态效果」**，并**显式模拟"没有减弱"**。
    //    第一轮就是在这儿假红的：本机系统设置里「减弱动态效果」是**开着**的
    //    ⇒ 默认就命中 index.html 里那条 `@media (prefers-reduced-motion: reduce)`
    //    ⇒ `animation: none` ⇒ 探针读到 `animationName: "none"`、透明度恒定 1。
    //    **那是设计如此（尊重系统设置），不是 bug** —— 要验"动画真的存在"，
    //    就得把这一维显式拨到 `no-preference`（不然验的其实是"尊重系统设置"那条）。
    const rmDefault = await evalFn(client, () => ({
      减弱: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      不减弱: window.matchMedia("(prefers-reduced-motion: no-preference)").matches,
    }));
    rec("Q.5b 本机（未被模拟时）的「减弱动态效果」", JSON.stringify(rmDefault));
    await client.send("Emulation.setEmulatedMedia", {
      media: "",
      features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: "no-preference" },
      ],
    });
    await sleep(300);

    for (let i = 0; i < 5; i++) {
      const r = await qRunOnce();
      qRuns.push(r);
      rec(
        `Q.${i + 1} 第 ${i + 1} 次启动画面的观测`,
        JSON.stringify({
          两行字: r.texts,
          第一次看见: r.firstSeenAt,
          界面挂载: r.mountAt,
          开始淡出: r.fadeAt,
          节点移除: r.goneAt,
          画了几帧: r.frames,
          探针等待: r.waitedMs,
          身上的动画: r.anims,
          动画样式: r.animStyle,
        })
      );
    }

    ok(
      qRuns.every((r) => r.texts[0] === "日记" && r.texts[1] === "正在打开…"),
      "Q.6 ⭐⭐ 连续 5 次都看到了「日记」＋「正在打开…」两行（不是一闪而过 —— 用户原话「我都没看清是什么，他就过去了」）",
      JSON.stringify(qRuns.map((r) => r.texts))
    );
    ok(
      qRuns.every((r) => r.fadeAt !== null && r.fadeAt >= 1000 && r.fadeAt <= 1500),
      "Q.7 ⭐⭐⭐ 每一次的停留都在 1.0~1.5 秒之间（**最少** 1 秒，且没有变成「启动耗时＋1 秒」）",
      JSON.stringify(qRuns.map((r) => r.fadeAt))
    );
    ok(
      qRuns.every((r) => r.goneAt !== null && r.fadeAt !== null && r.goneAt - r.fadeAt >= 150),
      "Q.8 ⭐ 淡出是渐变的（「开始淡出」到「节点移除」之间 ≥150ms，不是啪一下没了）",
      JSON.stringify(qRuns.map((r) => (r.goneAt !== null && r.fadeAt !== null ? r.goneAt - r.fadeAt : null)))
    );
    ok(
      qRuns.every(
        (r) => r.mountAt !== null && r.fadeAt !== null && r.fadeAt <= Math.max(1000, r.mountAt) + 250
      ),
      "Q.9 ⭐⭐⭐ 「抵扣」而不是「叠加」：停留时刻 ≤ max(界面挂载时刻, 1000) ＋ 250ms —— 写成 setTimeout(…, 1000) 这条必红",
      JSON.stringify(qRuns.map((r) => ({ mount: r.mountAt, fade: r.fadeAt, 上限: Math.max(1000, r.mountAt || 0) + 250 })))
    );

    // ⭐ 呼吸：
    //   · 硬判据用 `getAnimations()` ＋ computed style —— **与帧率无关**
    //     （窗口被挡住时 rAF 会被节流到 1 秒一次，逐帧采样会假红）；
    //   · 逐帧采样只当**佐证**（采样点够多时才参与断言）。
    const qAnims = qRuns.map((r) => ({
      names: (r.anims || []).map((a) => a.name),
      durations: (r.anims || []).map((a) => a.duration),
      iterations: (r.anims || []).map((a) => a.iterations),
      playStates: (r.anims || []).map((a) => a.playState),
      styleName: r.animStyle ? r.animStyle.animationName : null,
      styleDuration: r.animStyle ? r.animStyle.animationDuration : null,
      styleIterations: r.animStyle ? r.animStyle.animationIterationCount : null,
      transform: r.animStyle ? r.animStyle.transform : null,
    }));
    rec("Q.10 呼吸（身上跑着的动画 ＋ computed style）", JSON.stringify(qAnims));
    ok(
      qAnims.every(
        (a) =>
          a.styleName === "boot-pulse" &&
          a.styleDuration === "1.4s" &&
          a.styleIterations === "infinite" &&
          a.names.includes("boot-pulse") &&
          a.playStates.every((s) => s === "running")
      ),
      "Q.11 ⭐⭐ 正常模式下「日记」两个字身上**真的跑着**一个 boot-pulse 动画（1.4 秒一轮、无限循环）",
      JSON.stringify(qAnims)
    );
    ok(
      qAnims.every((a) => a.transform === "none"),
      "Q.12 ⭐ 呼吸**只动透明度**：没有任何位移/缩放（transform 恒为 none —— 位移缩放会显得廉价）",
      JSON.stringify(qAnims.map((a) => a.transform))
    );
    const qPulse = qRuns.map((r) => {
      const s = r.samples.map(Number).filter((x) => !Number.isNaN(x));
      return {
        n: s.length,
        distinct: new Set(s).size,
        min: s.length ? Math.min(...s) : null,
        max: s.length ? Math.max(...s) : null,
      };
    });
    rec("Q.12b 呼吸（透明度逐帧采样，佐证用）", JSON.stringify(qPulse));
    ok(
      qPulse.every((p) => p.n < 5 || (p.distinct >= 2 && p.max - p.min >= 0.2)),
      "Q.12c ⭐ 帧采样也抓到了透明度的来回变化（⚠️ 采样点少于 5 个时这条不参与判定 —— 窗口被遮挡会节流动画帧）",
      JSON.stringify(qPulse)
    );

    // ---- Q.13~Q.15 系统开了「减弱动态效果」⇒ 呼吸停下，但**停留时长照旧** ----
    await client.send("Emulation.setEmulatedMedia", {
      media: "",
      features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
    await sleep(300);
    const rm = await qRunOnce();
    const rmSamples = rm.samples.map(Number).filter((x) => !Number.isNaN(x));
    rec("Q.13 减弱动态效果下的一次启动画面", JSON.stringify({
      两行字: rm.texts,
      第一次看见: rm.firstSeenAt,
      界面挂载: rm.mountAt,
      开始淡出: rm.fadeAt,
      节点移除: rm.goneAt,
      动画样式: rm.animStyle,
      身上的动画: rm.anims,
      透明度采样: { n: rmSamples.length, 去重: new Set(rmSamples).size, 样本: rmSamples.slice(0, 6) },
    }));
    ok(
      rm.animStyle !== null && rm.animStyle.animationName === "none" && (rm.anims || []).length === 0,
      "Q.14 ⭐⭐ 系统开了「减弱动态效果」⇒ 呼吸**停下**（动画被 @media 关掉、身上一个动画都没有）",
      JSON.stringify({ styleName: rm.animStyle && rm.animStyle.animationName, anims: (rm.anims || []).map((a) => a.name), 透明度去重: new Set(rmSamples).size })
    );
    ok(
      rm.fadeAt !== null && rm.fadeAt >= 1000 && rm.texts[0] === "日记",
      "Q.15 ⭐⭐ 但「减弱动态效果」**只关动画、不砍等待** —— 停留照旧 ≥1 秒、两行字照旧显示",
      JSON.stringify({ fadeAt: rm.fadeAt, texts: rm.texts })
    );
    await setTheme(client, "light");

    // ---- Q.16 真·冷启动（**软观测**）----
    //
    // 上面的 5 次都是 `Page.reload()`（热重放）。真正的冷启动只能从进程外面量，
    // 而 CDP 连上来通常已经晚于那 1 秒 ⇒ 大概率观测不到。
    // 所以这条**只记录、不断言**（写了硬断言会变成随机红）。
    await shutdown(child, client);
    child = null;
    client = null;
    {
      const t0 = Date.now();
      let coldNote = null;
      try {
        const L3 = await launch(D1);
        child = L3.child;
        client = L3.client;
        const seen = await evalFn(client, () => {
          const el = document.getElementById("boot-splash");
          return { present: !!el, atNavStart: Math.round(performance.now()) };
        });
        coldNote = { 连上耗时: Date.now() - t0 + "ms", 页面侧时钟: seen.atNavStart, 启动画面还在: seen.present };
        if (seen.present) {
          await waitFor(client, () => !document.getElementById("boot-splash"), 6000);
          const gone = await evalFn(client, () => Math.round(performance.now()));
          coldNote["页面侧撤掉时刻"] = gone;
        }
      } catch (e) {
        coldNote = { 异常: String((e && e.message) || e).slice(0, 160) };
      }
      rec("Q.16 真·冷启动（软观测，不断言）", JSON.stringify(coldNote));
    }

    // ---- 收尾 ----
    await shutdown(child, client);
    child = null;
    client = null;

    console.log(`\n=== 结果：${results.length} 条，失败 ${bad} 条 ===`);
    process.exit(bad === 0 ? 0 : 1);
  } catch (e) {
    console.error("!! 脚本异常:", (e && e.stack) || e);
    await shutdown(child, client);
    console.log(`\n=== 异常结束：${results.length} 条，失败 ${bad} 条 ===`);
    process.exit(2);
  }
})();
