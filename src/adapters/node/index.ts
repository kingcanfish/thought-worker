import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Config } from "../../core/config";
import { createReceiverApp } from "../../core/http/app";
import type { BlobStore, Database } from "../../core/ports";

export interface ServerOptions {
  config: Config;
  /** 收件箱写在这里；和构建端用同一个 SQLite 文件 */
  db: Database;
  media: BlobStore;
  fetch?: typeof fetch;
  /** 构建输出目录（静态站点） */
  siteDir: string;
}

/** 自建服务器：接收 webhook + 提供构建好的静态站点 + 媒体 */
export function createNodeServer(opts: ServerOptions) {
  const app = new Hono();
  const receiver = createReceiverApp(() => ({ config: opts.config, db: opts.db, media: opts.media, fetch: opts.fetch ?? fetch }));
  app.route("/", receiver);
  app.use(
    "*",
    serveStatic({
      root: opts.siteDir,
      onFound: (path, c) => {
        // 页面和数据每次构建都会变；assets 带版本号
        c.header("Cache-Control", path.includes("/assets/") ? "public, max-age=3600" : "public, max-age=0, must-revalidate");
      },
    }),
  );
  app.notFound(async (c) => {
    const html = await readFile(join(opts.siteDir, "404.html"), "utf8").catch(() => "Not Found");
    return c.html(html, 404);
  });
  return app;
}
