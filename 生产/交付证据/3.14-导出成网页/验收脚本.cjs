/*
 * 3.14 —— 【P2-8】导出成 HTML（＋ 顺手把老的 Markdown 导出修干净）。
 *
 * 本件范围：
 *   ① 设置页「导出全部日记」那一行加**格式选择**（Markdown / 网页）；
 *   ② 「网页」⇒ 目录里是 `index.html` ＋ `YYYY/MM/YYYY-MM-DD.html`，
 *      双击就能在浏览器里看、**断网也能看**（样式内嵌、零外部依赖）；
 *   ③ 正文里的危险写法（手打的 `<script>`）导出后**只是一行字**；
 *   ④ 图片附件**一张都不复制**，只在头部写"另有 N 张图片"；
 *   ⑤ 与 Markdown 导出共守"**绝不覆盖**"（重名加 ` (1)`）。
 *
 * ⚠️ 这一份是**从 `_verify-313b.cjs` 整份拿过来的**：3.13 那 116 条必须**照样全绿**
 *    （本件只加了一条退出路径，⛔ 一行都没改编辑器）。新增部分见末尾的 **N 组**。
 *
 * ⚠️ 与上一版一样，**验收对象必须是发布件本身**（`发布\日记.exe`）——
 *    验过的那个必须等于用户拿到的那个。
 *
 * 铁律遵循（技能 `tauri-webview2-ui-verify`）：
 *   · 一次性临时目录（且要清 `localStorage`，否则上一轮的界面偏好让人误判）；
 *   · 钉主题用 `Emulation.setEmulatedMedia`；
 *   · 等状态变化要**亲眼看它经过中间态**；
 *   · 判据必须**有反向对照**。
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = "D:\\Users\\Lenovo\\Desktop\\Diary";
// ⚠️ 可以用 `DIARY_EXE` 覆盖 —— 铁律：**验收对象必须是"用户拿到的那个文件"**。
//     `tauri build` 的产物与裸 `cargo build` 的产物**体积不同**（15,939,584 vs 15,907,840）
//     ⇒ 验过的那个不等于用户拿到的那个 ⇒ 最后一遍必须钉在 `发布\日记.exe` 上。
const EXE = process.env.DIARY_EXE || (() => {
  const pub = path.join(REPO, "发布", "日记.exe");
  return fs.existsSync(pub) ? pub : path.join(REPO, "target", "release", "app.exe");
})();
const ROOT = path.join(REPO, "_ui-verify-314");
const PIN = "135790";
const PORT = 9384;
/** 本版版本号 —— 界面【关于】里显示的应当是它。
 *  ⚠️ 三处版本号里**只有 `app/package.json` 能写两段**（`"3.13"`）；
 *     `tauri.conf.json` 与 `Cargo.toml` 必须三段（`3.13.0`），否则 cargo 拒绝加载 manifest。 */
const EXPECT_VERSION = "3.14";

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
