// MEDIA_BASE=/m 时由应用转发对象存储里的文件；换成对象存储直出域名后这个路由就用不到了
import { Hono } from "hono";
import type { Config } from "../../config";
import { RangeNotSatisfiableError, type BlobObject, type ByteRange } from "../../ports";
import type { AppEnv } from "../app";

// 只放行媒体目录（收件箱和数据库在另一个存储里，这里再多挡一层）
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
 * 防盗链：没有 Referer（直接打开、RSS 阅读器、抓取分享卡片的爬虫）放行；
 * 有 Referer 时只放行本站、SITE_URL 和 MEDIA_ALLOWED_REFERERS 里的站点。
 * 挡的是别的网页直接引用；对方用 referrerpolicy="no-referrer" 仍然能绕过，所以只是减少，不是杜绝。
 */
export function isHotlink(referer: string | undefined, requestUrl: string, config: Config): boolean {
  if (!referer) return false;
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
  const { config, stores, mediaCache } = c.var.deps;
  if (isHotlink(c.req.header("referer"), c.req.url, config)) return c.body(null, 403, { "Cache-Control": "no-store" });

  // 缓存键只用路径：带随机查询参数也命中同一份，没法用来绕过缓存反复读存储
  const cacheKey = new URL(`/m/${key}`, c.req.url).href;
  const cache = c.req.method === "GET" ? mediaCache : undefined;
  const hit = await cache?.match(cacheKey, c.req.raw);
  if (hit) return hit;

  const range = parseRange(c.req.header("range"));
  if (range === "invalid") return c.body(null, 416);
  let obj: BlobObject | null;
  try {
    obj = await stores.media.get(key, range);
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
