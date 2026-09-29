import type { Context } from "hono";
import { CONTENT_TAG } from "../ports";

/**
 * 标记为可被共享缓存（Workers Cache / CDN / 反向代理）缓存的内容响应。
 * 浏览器每次都回源校验（max-age=0），共享缓存保留 1 小时，内容变化时按标签清除。
 */
export function cacheContent(c: Context) {
  c.header("Cache-Control", "public, max-age=0, s-maxage=3600");
  c.header("Cache-Tag", CONTENT_TAG);
}

export const IMMUTABLE = "public, max-age=31536000, immutable";
