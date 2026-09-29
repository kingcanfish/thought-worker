// 自建服务器入口：接收 webhook、提供静态站点。构建由 cron 定时跑 `npm run build:site`。
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../core/config";
import { createNodeServer } from "./index";
import { storesFromEnv } from "../../build/storage";

for (const f of ["site.env", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

const app = createNodeServer({
  config: loadConfig(process.env),
  stores: storesFromEnv(process.env),
  siteDir: resolve(process.env.SITE_DIR ?? "./dist/site"),
});
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`thought-worker listening on http://localhost:${info.port}`);
});
