// Telegram entities → HTML。offset / length 以 UTF-16 code unit 计，和 JS 字符串一致，直接 slice。
// 换行不转 <br>，由 CSS white-space: pre-wrap 保留。
import { escapeHtml, safeUrl } from "../lib/html";
import type { TgEntity } from "./types";

export interface RenderOptions {
  tagHref: (tag: string) => string;
}

interface Span extends TgEntity {
  end: number;
}

export function renderEntities(text: string, entities: TgEntity[] | undefined, opts: RenderOptions): string {
  const spans: Span[] = (entities ?? [])
    .filter((e) => e.length > 0 && e.offset >= 0 && e.offset < text.length)
    .map((e) => ({ ...e, end: Math.min(e.offset + e.length, text.length) }))
    .sort((a, b) => a.offset - b.offset || b.end - a.end);
  return tidyBlocks(renderRange(text, 0, text.length, spans, opts));
}

function renderRange(text: string, start: number, end: number, spans: Span[], opts: RenderOptions): string {
  let out = "";
  let pos = start;
  let i = 0;
  while (i < spans.length) {
    const s = spans[i]!;
    // 和前一个兄弟节点部分重叠的实体（不合法），直接丢弃
    if (s.offset < pos) {
      i++;
      continue;
    }
    out += escapeHtml(text.slice(pos, s.offset));
    const sEnd = Math.min(s.end, end);
    const children: Span[] = [];
    let j = i + 1;
    while (j < spans.length && spans[j]!.offset < sEnd) {
      const c = spans[j]!;
      children.push({ ...c, end: Math.min(c.end, sEnd) });
      j++;
    }
    const raw = text.slice(s.offset, sEnd);
    out += wrap(s, renderRange(text, s.offset, sEnd, children, opts), raw, opts);
    pos = sEnd;
    i = j;
  }
  return out + escapeHtml(text.slice(pos, end));
}

const link = (href: string | null, inner: string, cls?: string): string =>
  href
    ? `<a href="${escapeHtml(href)}"${cls ? ` class="${cls}"` : ""} target="_blank" rel="noopener nofollow">${inner}</a>`
    : inner;

function wrap(e: TgEntity, inner: string, raw: string, opts: RenderOptions): string {
  switch (e.type) {
    case "bold":
      return `<strong>${inner}</strong>`;
    case "italic":
      return `<em>${inner}</em>`;
    case "underline":
      return `<u>${inner}</u>`;
    case "strikethrough":
      return `<s>${inner}</s>`;
    case "spoiler":
      return `<span class="spoiler">${inner}</span>`;
    case "code":
      return `<code>${escapeHtml(raw)}</code>`;
    case "pre": {
      const lang = e.language?.replace(/[^\w+#-]/g, "");
      return `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(raw)}</code></pre>`;
    }
    case "blockquote":
      return `<blockquote>${inner}</blockquote>`;
    case "expandable_blockquote":
      return `<blockquote class="expandable">${inner}</blockquote>`;
    case "text_link":
      return link(safeUrl(e.url ?? ""), inner);
    case "url":
      return link(safeUrl(/^[a-z][\w+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`), inner);
    case "email":
      return link(safeUrl(`mailto:${raw}`), inner);
    case "phone_number":
      return link(safeUrl(`tel:${raw.replace(/[^\d+]/g, "")}`), inner);
    case "mention":
      return link(`https://t.me/${raw.slice(1)}`, inner);
    case "text_mention":
      return e.user?.username ? link(`https://t.me/${e.user.username}`, inner) : inner;
    case "hashtag": {
      const tag = hashtagName(raw);
      return tag ? `<a class="hashtag" href="${escapeHtml(opts.tagHref(tag))}">${inner}</a>` : inner;
    }
    default:
      // cashtag / bot_command / custom_emoji（退回普通 emoji 文本）等
      return inner;
  }
}

/** 块级元素前后紧挨的一个换行会在 pre-wrap 下多出空行，去掉 */
const tidyBlocks = (html: string): string =>
  html.replace(/(<\/(?:blockquote|pre)>)\n/g, "$1").replace(/\n(<(?:blockquote|pre)[\s>])/g, "$1");

/** "#标签@频道" → "标签" */
const hashtagName = (raw: string): string => raw.replace(/^#/, "").replace(/@\w+$/, "");

export function extractTags(text: string, entities: TgEntity[] | undefined): string[] {
  const tags = new Set<string>();
  for (const e of entities ?? []) {
    if (e.type !== "hashtag") continue;
    const tag = hashtagName(text.slice(e.offset, e.offset + e.length));
    if (tag) tags.add(tag);
  }
  return [...tags];
}

/** 第一个链接（url / text_link），用于链接预览 */
export function firstLink(text: string, entities: TgEntity[] | undefined): string | null {
  for (const e of entities ?? []) {
    if (e.type === "text_link" && e.url) {
      const u = safeUrl(e.url);
      if (u?.startsWith("http")) return u;
    }
    if (e.type === "url") {
      const raw = text.slice(e.offset, e.offset + e.length);
      const u = safeUrl(/^[a-z][\w+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (u?.startsWith("http")) return u;
    }
  }
  return null;
}
