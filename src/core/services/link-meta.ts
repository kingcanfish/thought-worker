// 抓取网页的 OG / Twitter Card 信息。只用 fetch + 正则，不依赖平台专有的 HTML 解析器。
import { decodeEntities, safeUrl } from "../lib/html";

export interface LinkMeta {
  url: string;
  siteName: string;
  title: string | null;
  description: string | null;
  image: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

const UA = "Mozilla/5.0 (compatible; ThoughtWorker/1.0; link preview; like TwitterBot)";
const TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 512 * 1024;

/** 读取响应体，最多 limit 字节；超出时 truncate 为 true 则截断，否则返回 null */
export async function readLimited(body: ReadableStream<Uint8Array>, limit: number, truncate: boolean): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= limit) {
        if (!truncate) return null;
        break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, limit));
  let pos = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, out.length - pos);
    out.set(c.subarray(0, n), pos);
    pos += n;
    if (pos >= out.length) break;
  }
  return out;
}

export async function fetchLinkMeta(fetchFn: typeof fetch, url: string): Promise<LinkMeta | null> {
  const res = await fetchFn(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok || !res.body) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (!/html|xml/i.test(contentType)) {
    res.body.cancel().catch(() => {});
    return null;
  }
  const bytes = await readLimited(res.body, MAX_HTML_BYTES, true);
  if (!bytes) return null;
  return parseLinkMeta(decodeHtml(bytes, contentType), res.url || url);
}

function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const clean = (s: string | undefined, max: number): string | null => {
  if (!s) return null;
  const v = decodeEntities(s).replace(/\s+/g, " ").trim();
  return v ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : null;
};

export function parseLinkMeta(html: string, pageUrl: string): LinkMeta {
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html;

  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(ATTR_RE)) attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop)?.toLowerCase();
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
  }
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v?.trim());

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const rawImage = pick("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "image");
  let image: string | null = null;
  if (rawImage) {
    try {
      image = safeUrl(new URL(decodeEntities(rawImage.trim()), pageUrl).href);
    } catch {
      image = null;
    }
  }
  const num = (v: string | undefined) => (v && /^\d+$/.test(v.trim()) ? Number(v) : null);

  return {
    url: pageUrl,
    siteName: clean(pick("og:site_name", "application-name"), 60) ?? new URL(pageUrl).hostname.replace(/^www\./, ""),
    title: clean(pick("og:title", "twitter:title") ?? titleTag, 200),
    description: clean(pick("og:description", "twitter:description", "description"), 300),
    image: image?.startsWith("http") ? image : null,
    imageWidth: num(meta.get("og:image:width")),
    imageHeight: num(meta.get("og:image:height")),
  };
}
