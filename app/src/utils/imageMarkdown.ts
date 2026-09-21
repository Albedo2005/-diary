/**
 * 正文里**指向附件的图片语法**（`![名](attachments/<sha256>.<ext>)`）的清理。
 *
 * 背景：2.2 一度把图片写进正文（正文里就地显示成图）；2.3 起改为
 * “图片只挂在‘这一天’上，正文永远只有用户自己打的字”，所以旧记录里
 * 残留的那段语法要在打开时清掉。
 *
 * ⚠️ 只认 `attachments/` 开头的相对路径。别的图片语法（比如用户自己写的
 *    外链 `![x](https://…)`）**一个字都不动** —— 清不掉顶多留下一行原文，
 *    清错了就是删用户的日记，两边的代价完全不对等。
 *
 * 刻意做成不依赖 DOM 的纯字符串函数：能单独跑断言，不必开浏览器。
 */

/** 一整段 `![…](attachments/…)`。`[^\]]` / `[^)]` 保证不会跨过括号乱吃。 */
const ATTACHMENT_IMAGE = /!\[[^\]]*\]\(\s*attachments\/[^)]*\)/g;

/**
 * 把正文里指向附件的图片语法删掉，其余内容一个字不动。
 *
 * 整行只剩这一张图时，那一行也一并去掉（否则会留下一行空行）；
 * 行里还有别的文字时，只抠掉那段语法，顺手抹平行尾多余的空格。
 */
export function stripAttachmentImages(md: string): string {
  // 绝大多数日记里根本没有 `attachments/` 这几个字，先走快路径，别白白拆行重组。
  if (!md.includes("attachments/")) return md;

  const kept: string[] = [];
  for (const line of md.split("\n")) {
    if (!line.includes("attachments/")) {
      kept.push(line);
      continue;
    }
    const cleaned = line.replace(ATTACHMENT_IMAGE, "");
    if (cleaned.trim() === "") continue; // 整行只有一张图 → 这行不要了
    kept.push(cleaned.replace(/[ \t]+$/, ""));
  }
  return kept.join("\n");
}
