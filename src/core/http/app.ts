import { Hono, type Context } from "hono";
import type { ReceiverDeps } from "../ports";
import { mediaRoutes } from "./routes/media";
import { webhookRoutes } from "./routes/webhook";

export type AppEnv = { Variables: { deps: ReceiverDeps } };

/**
 * 接收端：只有两个动态路由，其余都是构建出来的静态文件（由平台直接提供）。
 *   POST /tg/webhook  校验后把 update 原样存进收件箱（data 存储）
 *   GET  /m/*         MEDIA_BASE=/m 时转发媒体存储里的文件
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createReceiverApp(resolveDeps: (c: Context<any>) => ReceiverDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", resolveDeps(c));
    await next();
  });
  app.route("/tg", webhookRoutes);
  app.route("/m", mediaRoutes);
  app.onError((err, c) => {
    console.error(c.req.method, c.req.path, err);
    return c.text("Internal Server Error", 500);
  });
  return app;
}
