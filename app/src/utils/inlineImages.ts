/**
 * 正文里的图片，在「Markdown 文本」与「编辑区里的真图片」之间来回转换的最小工具集。
 *
 * ⚠️ 落库的永远是 Markdown（`![名](attachments/<sha256>.<ext>)`）—— 这是铁律。
 *    编辑区里看到的 `<img>` 只是**内存里的一张视图**，存库前必须转回文本。
 *    一旦让 HTML / 富文本 JSON 进库，导出、搜索、备份全要重写。
 *
 * 这里只做**纯字符串**的那一半（文本 ↔ 段落清单）；碰 DOM 的部分留在
 * `EditorPane.vue` 里。分开的理由：这一半没有 DOM 依赖，出问题的概率也最集中，
 * 想单独验的时候不必把整个组件拖进来。
 */

/** `![名](路径)`。名里不许有 `]`，路径里不许有空白与 `)`。 */
const IMAGE_MD = /!\[([^\]]*)\]\(([^)\s]+)\)/;

/** 一段正文：要么是一串文字，要么是一张图片的引用。 */
export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; name: string; rel: string };

/**
 * 把 Markdown 正文切成「文字 / 图片」相间的若干段。
 *
 * ⚠️ 不做完整 Markdown 解析，**只认图片**。其余一切（`#`、`**`、列表、缩进）
 *    都当普通文字原样留着 —— 与"正文即原文"的老行为完全一致。
 *    这不只是省事：2026-09-21 之前那个"阅读视图"就是因为渲染了整体 Markdown，
 *    把用户手工排的版全吃掉了，才被撤掉的。
 */
export function splitMarkdownImages(md: string): InlineSegment[] {
  const segs: InlineSegment[] = [];
  let last = 0;
  // ⚠️ 每次都新建一个正则：带 g 的正则带 lastIndex 状态，跨次调用会串味
  //    （上一次停在半截，下一次就从那儿接着找，图片会凭空漏掉）。
  const re = new RegExp(IMAGE_MD.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) segs.push({ kind: "text", text: md.slice(last, m.index) });
    segs.push({ kind: "image", name: m[1], rel: m[2] });
    last = m.index + m[0].length;
  }
  if (last < md.length) segs.push({ kind: "text", text: md.slice(last) });
  return segs;
}

/**
 * 只取纯文字部分。
 *
 * 算字数专用：图片那行 `![名](attachments/<sha256>.<ext>)` 有九十来个字符，
 * 把它算进去的话，贴一张图就等于"多写了九十多个字"。
 */
export function textOnly(md: string): string {
  return splitMarkdownImages(md)
    .map((s) => (s.kind === "text" ? s.text : ""))
    .join("");
}

/**
 * 拼一行图片语法。
 *
 * 名字里的 `[` `]` `(` `)` 会把语法自身撑破（`![a]b](...)` 解析出来是错的），
 * 先换成下划线。⚠️ 只动**显示名**，`rel` 一个字符都不许改 —— 它是找回文件的
 * 唯一依据，脏了这张图就变成打不开的图了。
 */
export function imageMd(name: string, rel: string): string {
  return `![${name.replace(/[[\]()]/g, "_")}](${rel})`;
}
