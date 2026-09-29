import type { Config } from "../../config";
import { escapeHtml } from "../../lib/html";
import type { PostView } from "../../services/timeline";
import { excerpt } from "./format";

const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

/** 把 html 里的站内相对链接补成绝对地址，阅读器才能打开 */
const absolutize = (html: string, origin: string) => html.replace(/(href|src)="\//g, `$1="${origin}/`);

function itemHtml(p: PostView, origin: string): string {
  const abs = (u: string) => (u.startsWith("/") ? `${origin}${u}` : u);
  let html = p.html ? `<div style="white-space:pre-wrap">${absolutize(p.html, origin)}</div>` : "";
  for (const m of p.media) {
    if (m.status !== "ready" || !m.url) continue;
    html +=
      m.kind === "photo"
        ? `<p><img src="${escapeHtml(abs(m.url))}" /></p>`
        : `<p><video src="${escapeHtml(abs(m.url))}" controls${m.thumb ? ` poster="${escapeHtml(abs(m.thumb))}"` : ""}></video></p>`;
  }
  const lp = p.linkPreview;
  if (lp) html += `<p><a href="${escapeHtml(lp.url)}">${escapeHtml(lp.title ?? lp.url)}</a></p>`;
  return html;
}

export function renderRss(config: Config, origin: string, posts: PostView[]): string {
  const items = posts
    .map((p) => {
      const link = `${origin}/p/${p.id}`;
      const title = excerpt(p.text, 60) || new Date(p.createdAt * 1000).toISOString().slice(0, 10);
      return `<item><title>${escapeHtml(title)}</title><link>${link}</link><guid isPermaLink="true">${link}</guid><pubDate>${new Date(p.createdAt * 1000).toUTCString()}</pubDate><description>${cdata(itemHtml(p, origin))}</description></item>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${escapeHtml(config.siteTitle)}</title><link>${origin}/</link><description>${escapeHtml(config.siteDescription)}</description><language>zh-CN</language><atom:link href="${origin}/rss.xml" rel="self" type="application/rss+xml" />${items}</channel></rss>`;
}
