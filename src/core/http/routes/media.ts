// MEDIA_BASE=/m 时由应用转发对象存储里的文件；换成对象存储直出域名后这个路由就用不到了
import { Hono } from "hono";
import type { Config } from "../../config";
import { RangeNotSatisfiableError, type BlobObject, type ByteRange } from "../../ports";
import type { AppEnv } from "../app";

// 只放行媒体目录（媒体存储里本来也只有这些，这里再多挡一层）
const KEY_RE = /^(photo|video|gif|thumb|link)\/[\w.-]+$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** 只支持单段 Range：bytes=a-b / bytes=a- / bytes=-n */
export function parseRange(header: string | undefined): ByteRange | "invalid" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (m[1] === "") return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === "") return { offset };
  const end = Number(m[2]);
  return end < offset ? "invalid" : { offset, length: end - offset + 1 };
}

/**
 * 防盗链，挡的是别的网页把图片直接嵌进去：
 * - 没有 Referer 放行：直接打开、桌面 RSS 阅读器、抓取分享卡片的爬虫；
 * - 页面跳转（Sec-Fetch-Dest: document）放行：别的网站上指向图片的普通链接，点开能看；
 * - 其余只放行本站、SITE_URL 和 MEDIA_ALLOWED_REFERERS。网页版 RSS 阅读器直接嵌图时带的是阅读器的域名，
 *   需要的话把它加进 MEDIA_ALLOWED_REFERERS。
 * 对方用 referrerpolicy="no-referrer" 仍然能绕过，所以只是减少，不是杜绝。
 */
export function isHotlink(headers: { referer?: string; fetchDest?: string }, requestUrl: string, config: Config): boolean {
  const { referer } = headers;
  if (!referer || headers.fetchDest === "document") return false;
  let host: string;
  try {
    host = new URL(referer).host.toLowerCase();
  } catch {
    return true;
  }
  const allowed = new Set([new URL(requestUrl).host.toLowerCase(), ...config.mediaReferers]);
  if (config.siteUrl) allowed.add(new URL(config.siteUrl).host.toLowerCase());
  return !allowed.has(host);
}

export const mediaRoutes = new Hono<AppEnv>().on(["GET", "HEAD"], "/*", async (c) => {
  let key: string;
  try {
    key = decodeURIComponent(c.req.path.replace(/^\/m\//, ""));
  } catch {
    return c.notFound(); // 非法的百分号编码
  }
  if (!KEY_RE.test(key) || key.includes("..")) return c.notFound();
  const { config, media, mediaCache } = c.var.deps;
  if (isHotlink({ referer: c.req.header("referer"), fetchDest: c.req.header("sec-fetch-dest") }, c.req.url, config)) return c.body(null, 403, { "Cache-Control": "no-store" });

  // 缓存键只用路径：带随机查询参数也命中同一份，没法用来绕过缓存反复读存储
  const cacheKey = new URL(`/m/${key}`, c.req.url).href;
  const cache = c.req.method === "GET" ? mediaCache : undefined;
  const hit = await cache?.match(cacheKey, c.req.raw);
  if (hit) return hit;

  const range = parseRange(c.req.header("range"));
  if (range === "invalid") return c.body(null, 416);
  let obj: BlobObject | null;
  try {
    obj = await media.get(key, range);
  } catch (e) {
    if (!(e instanceof RangeNotSatisfiableError)) throw e;
    return c.body(null, 416, { "Content-Range": `bytes */${e.size}` });
  }
  if (!obj) return c.notFound();

  const headers = new Headers({
    "Content-Type": obj.contentType,
    "Cache-Control": IMMUTABLE,
    "Accept-Ranges": "bytes",
    ETag: obj.etag,
  });
  if (c.req.header("if-none-match") === obj.etag) {
    obj.body.cancel().catch(() => {});
    return new Response(null, { status: 304, headers });
  }
  if (obj.range) {
    headers.set("Content-Range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
    headers.set("Content-Length", String(obj.range.length));
  } else {
    headers.set("Content-Length", String(obj.size));
  }
  if (c.req.method === "HEAD") {
    obj.body.cancel().catch(() => {});
    return new Response(null, { status: obj.range ? 206 : 200, headers });
  }
  const res = new Response(obj.body, { status: obj.range ? 206 : 200, headers });
  // 只缓存完整文件；之后的 Range 请求由缓存从完整文件里切
  if (cache && !obj.range) cache.put(cacheKey, res.clone());
  return res;
});
