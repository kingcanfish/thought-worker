import { Hono, type Context } from "hono";
import type { Deps } from "../ports";
import { apiRoutes } from "./routes/api";
import { mediaRoutes } from "./routes/media";
import { notFoundPage, pageRoutes } from "./routes/pages";
import { webhookRoutes } from "./routes/webhook";

export type AppEnv = { Variables: { deps: Deps } };

/**
 * 与平台无关的应用。resolveDeps 由适配器提供：
 * Cloudflare 按请求从 env / ctx 构造，Node 直接返回同一份实例。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createApp(resolveDeps: (c: Context<any>) => Deps) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", resolveDeps(c));
    await next();
  });
  app.route("/tg", webhookRoutes);
  app.route("/api", apiRoutes);
  app.route("/m", mediaRoutes);
  app.route("/", pageRoutes);
  app.notFound(notFoundPage);
  app.onError((err, c) => {
    console.error(c.req.method, c.req.path, err);
    return c.text("Internal Server Error", 500);
  });
  return app;
}
