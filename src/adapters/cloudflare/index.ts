// Cloudflare Workers 入口：静态文件由 [assets] 直接提供（不经过这里），
// 没有匹配到静态文件的请求才进来：/tg/webhook、/m/*，其余交回静态资源处理成 404 页。
import { loadConfig } from "../../core/config";
import { createReceiverApp } from "../../core/http/app";
import { R2Adapter } from "./r2";

interface Env {
  /** 图片视频，可以公开 */
  MEDIA: R2Bucket;
  /** 收件箱、数据库，不能公开 */
  DATA: R2Bucket;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

const app = createReceiverApp((c) => {
  const env = c.env as Env;
  return {
    config: loadConfig(env),
    stores: { media: new R2Adapter(env.MEDIA), data: new R2Adapter(env.DATA) },
    fetch: (input, init) => fetch(input, init),
  };
});
app.notFound((c) => (c.env as Env).ASSETS.fetch(c.req.raw));

export default app;
