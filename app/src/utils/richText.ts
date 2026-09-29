/**
 * 【P2-3】第 2 步：正文格式的**唯一入口**。
 *
 * 背景：正文从"纯文本"升级成"带格式的正文"。但格式必须**受控**——
 * 不能把编辑器吐出来的任意 HTML 原样落库（那是无穷无尽的安全 / 兼容坑，
 * 而且会让导出、字数统计、搜索高亮全部失控）。
 *
 * 所以这里做三件事，全部只此一份实现：
 *   1. `ALLOWED_TAGS` —— 允许出现的标签白名单（只有下面这 8 个 + 结构标签）。
 *   2. `sanitizeHtml()` —— 把任意 HTML 洗成"只留白名单标签、只留白名单
 *      属性、其余一律降级成纯文本"。
 *   3. `htmlToPlainText()` —— 把 HTML 还原成"看得见的文字"（字数统计用）。
 *
 * ⚠️ **旧日记是纯文本**（里面一个标签都没有）。它读进来后，会被当作
 *    "没有格式的正文"照常显示，**一个字都不改**。所以本文件对旧数据是
 *    "恒等变换"——这也是【P2-3】拍板第 2 条（旧日记原样显示）的落点。
 *
 * ⚠️ 与新依赖 Tiptap 的关系：Tiptap 负责**编辑时的交互**，但**不负责落库**。
 *    落库前一律过 `sanitizeHtml()`；从库里读出来也一律过一遍
 *    （防止手改数据库 / 旧版本残留塞进非法标签）。
 */

/**
 * 允许的标签白名单。
 *
 * 为什么是这几个：
 *   - `strong` / `em` / `u` / `s` —— 工具栏上的 B / I / U / S 四个按钮；
 *   - `p` / `br` —— 段落与换行（Tiptap 的基础结构，没有它段落会挤成一行）；
 *   - `span` —— **字体 / 字号**的载体（Tiptap 的 TextStyle 扩展就是这么存的）；
 *   - `mark` —— 预留给将来的"高亮"（搜索命中的高亮走另一条路，不落库）。
 *
 * ⛔ 明确**不在**白名单里的：`a`（外链，本项目完全离线、不该有可点外链）、
 *    `img`（图片走 attachments 表，正文里不再存图片 —— 见 stripAttachmentImages）、
 *    `script` / `style` / `iframe`（安全），以及一切其它标签。
 */
export const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "u",
  "s",
  "span",
  "mark",
] as const;

/**
 * 允许保留的内联样式属性白名单。
 *
 * ⚠️ **只留字体和字号** —— 颜色、背景、边框、定位一律不许进正文。
 *    理由：正文颜色必须跟着**主题**走（深浅两套），一旦允许把颜色写死进
 *    正文，切到深色主题时那几段就会变成"看不清的死色"。
 *    这与项目铁律"颜色绝不硬编码"是同一件事。
 *
 * ⚠️ 字号也不存"绝对像素"更好，但 Tiptap 的默认行为就是存 `font-size:16px`。
 *    接受它 —— 因为 P2-3 只提供"大 / 中 / 小"三档，写进去的就是这三档之一，
 *    不会出现 13.7px 这种随机值。
 */
const ALLOWED_STYLE_PROPS = ["font-family", "font-size", "font-weight", "font-style", "text-decoration"];

/**
 * 允许保留的属性白名单（按标签分）。
 *
 * 目前只有 `span` 需要 `style`（承载字体/字号）。其它标签一个属性都不留 ——
 * 尤其是**剥掉 Tiptap 的内部标记**（`data-*`、`class` 里的编辑器临时类）。
 */
const ALLOWED_ATTRS: Record<string, string[]> = {
  span: ["style"],
};

/** 标签降级表：不在白名单里的这些标签，**只去掉标签本身、内容留下**。 */
const UNWRAP_TAGS = new Set([
  "div",
  "section",
  "article",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "code",
  "pre",
  "font",
]);

/**
 * 把任意 HTML 洗成"只留白名单标签"的安全 HTML。
 *
 * 做法是**白名单制**（不是黑名单制）：不认识的标签一律降级成纯文本，
 * 这样"新出现的危险标签"天然挡在外面 —— 黑名单永远会漏。
 *
 * ⚠️ 用 DOMParser 解析（浏览器原生），不自己写正则。
 *    自己写正则剥标签是经典的安全事故（`<scr<b>ipt>` 这类绕过）。
 * ⚠️ 输出前把文本节点里的 `<` `>` 转义掉，保证结果**再喂给编辑器也不会
 *    被当成标签解析**（幂等）。
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  // 纯文本（一个 `<` 都没有）直接走快速通道：旧日记全走这条，
  // 保证"旧日记原样返回"是**恒等变换**，一个字符都不动。
  if (!html.includes("<")) return html;

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = doc.body;
  // ⚠️⚠️ 必须序列化 **body 的子节点**，⛔ 不能 `serializeNode(body)` 把 body 自己传进去：
  //      `body` 这个标签名既不在白名单、也不在"可拆容器"名单里 ⇒ 会走
  //      "整块丢掉"那条分支 ⇒ **返回空串** ⇒ 任何 HTML 输入都被洗成空。
  //      （踩过：打完字保存标签从「未保存…」直接消失 —— 因为
  //       `content.value = sanitizeHtml(...)` 拿到的是 ""，
  //        `hasContent()` 判空 ⇒ 那次保存被当成"没内容"跳过 ⇒ 一个字都没落库。）
  return Array.from(body.childNodes)
    .map(serializeNode)
    .join("")
    .trim();
}

/** 递归把一个节点序列化成"白名单 HTML"。 */
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText(node.nodeValue ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(serializeNode).join("");

  if (ALLOWED_TAGS.includes(tag as (typeof ALLOWED_TAGS)[number])) {
    // `br` 没有内容，单独处理（否则会输出 `<br></br>`）。
    if (tag === "br") return "<br>";
    const attrs = buildAttrs(el, tag);
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  // 不在白名单但属于"可拆的容器"⇒ 去掉标签、留下内容（保住他的字）。
  if (UNWRAP_TAGS.has(tag)) return inner;

  // 其余（script / style / iframe / img / a …）⇒ **整块丢掉**，
  // 连内容一起 —— 这些标签的内容本来就不是"他要写的字"。
  return "";
}

/** 按标签的白名单拼出属性串。 */
function buildAttrs(el: Element, tag: string): string {
  const allow = ALLOWED_ATTRS[tag];
  if (!allow || allow.length === 0) return "";
  const parts: string[] = [];
  for (const name of allow) {
    if (name === "style") {
      const style = cleanStyle(el.getAttribute("style") ?? "");
      if (style) parts.push(`style="${escapeAttr(style)}"`);
    }
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

/** 按属性白名单过滤 style 串。 */
function cleanStyle(raw: string): string {
  if (!raw) return "";
  const out: string[] = [];
  for (const piece of raw.split(";")) {
    const idx = piece.indexOf(":");
    if (idx < 0) continue;
    const prop = piece.slice(0, idx).trim().toLowerCase();
    const value = piece.slice(idx + 1).trim();
    if (!value) continue;
    if (!ALLOWED_STYLE_PROPS.includes(prop)) continue;
    // 值里带 `url(` / `expression(` 这类的一律丢（防注入）。
    if (/url\(|expression\(|javascript:/i.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * 把 HTML 还原成"看得见的文字"（**字数统计**用）。
 *
 * ⚠️ 这是 `utils/text.ts::visibleText()` 的后半段实现，由它统一调用。
 *    "哪些算字"的口径收在那一处，这里只负责"剥标签"这一半。
 *
 * 规则：
 *   - 块级标签（`p` / `br`）转成换行 —— 否则两段会粘成一个词；
 *   - 其余标签只脱壳；
 *   - HTML 实体（`&amp;` `&lt;` `&nbsp;` 等）还原成真字符；
 *   - 结尾统一 trim（首尾空白不计字）。
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (!html.includes("<")) return decodeEntities(html);

  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(withBreaks).replace(/\n{3,}/g, "\n\n").trim();
}

/** 还原常见 HTML 实体。用 textarea 解 —— 浏览器原生、覆盖面最全。 */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  const ta = document.createElement("textarea");
  ta.innerHTML = s;
  return ta.value;
}

/**
 * 判断一段正文**是否有实质内容**（供 `hasContent()` 用）。
 *
 * ⚠️ 必须走"剥标签后的纯文本"，**不能**拿原始 HTML 去 `trim()` ——
 *    Tiptap 清空后留下的往往是 `<p></p>`，那玩意 `.trim()` 之后非空，
 *    会让"删空了正文"被误判成"还有内容"，于是库里留下一篇空日记。
 */
export function htmlHasContent(html: string): boolean {
  return htmlToPlainText(html).length > 0;
}

/**
 * 把纯文本转成 Tiptap 能吃的初始 HTML（**旧日记进门时的转换**）。
 *
 * ⚠️ 只做最小的转义 + 换行变段落，**不猜格式**：
 *    旧日记是纯文本，就原样显示成纯文本，不替他决定哪句该加粗。
 * ⚠️ 空行保留成**空段落** —— 用户在纯文本里敲的空行是有意义的
 *    （分段），不能被吞掉。
 */
export function plainTextToHtml(text: string): string {
  if (!text) return "";
  // 已经有标签的（新格式）原样返回，交给 sanitizeHtml 把关。
  if (text.includes("<")) return sanitizeHtml(text);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "<p></p>" : `<p>${escapeText(line)}</p>`))
    .join("");
}
