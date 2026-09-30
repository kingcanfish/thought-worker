// Cloudflare Workers 入口：静态文件由 [assets] 直接提供（不经过这里），
// 没有匹配到静态文件的请求才进来：/tg/webhook、/m/*，其余交回静态资源处理成 404 页。
import type { Context } from "hono";
import { loadConfig } from "../../core/config";
import { createReceiverApp } from "../../core/http/app";
import type { MediaCache } from "../../core/ports";
import { R2Adapter } from "./r2";

interface Env {
  /** 图片视频，可以公开 */
  MEDIA: R2Bucket;
  /** 收件箱、数据库，不能公开 */
  DATA: R2Bucket;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

/**
 * 媒体放进当前边缘节点的缓存，命中后不再读 R2（Worker 仍然会执行，请求数照算）。
 * 缓存自己处理 Range（从完整文件里切出 206）和 If-None-Match（304）。
 * 注意：*.workers.dev 上 Cache API 不生效，要绑自定义域名。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function edgeCache(c: Context<any>): MediaCache {
  const cache = caches.default;
  return {
    match: (key, req) => cache.match(new Request(key, { headers: req.headers })),
    put: (key, res) => c.executionCtx.waitUntil(cache.put(key, res).catch((e) => console.warn("cache put failed", key, e))),
  };
}

const app = createReceiverApp((c) => {
  const env = c.env as Env;
  return {
    config: loadConfig(env),
    stores: { media: new R2Adapter(env.MEDIA), data: new R2Adapter(env.DATA) },
    fetch: (input, init) => fetch(input, init),
    mediaCache: edgeCache(c),
  };
});
app.notFound((c) => (c.env as Env).ASSETS.fetch(c.req.raw));

export default app;
