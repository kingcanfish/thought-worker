// 自建服务器入口：node dist/node/main.js（或 npm run dev:node）
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../core/config";
import { createNodeServer } from "./index";

if (existsSync(".env")) process.loadEnvFile(".env");

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const { app, applied } = createNodeServer({
  config: loadConfig(process.env),
  dbPath: resolve(dataDir, "thought.db"),
  mediaDir: resolve(dataDir, "media"),
  migrationsDir: resolve(process.env.MIGRATIONS_DIR ?? "./migrations"),
  publicDir: process.env.PUBLIC_DIR ?? "./public",
});
if (applied.length) console.log("applied migrations:", applied.join(", "));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`thought-worker listening on http://localhost:${info.port}`);
});
