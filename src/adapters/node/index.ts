import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Config } from "../../core/config";
import { createApp } from "../../core/http/app";
import type { BackgroundTasks, Deps } from "../../core/ports";
import { FsBlobStore } from "./fs-store";
import { MemoryResponseCache } from "./memory-cache";
import { SqliteDatabase, migrate } from "./sqlite";

/** 后台任务：不阻塞响应，记录未完成的任务以便测试 / 退出时等待 */
export class PromiseTasks implements BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();

  run(task: () => Promise<unknown>): void {
    const p = task()
      .catch((e) => console.error("background task failed", e))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
  }
}

export interface NodeOptions {
  config: Config;
  /** SQLite 文件路径，测试可用 ":memory:" */
  dbPath: string;
  mediaDir: string;
  migrationsDir: string;
  publicDir: string;
  fetch?: typeof fetch;
}

export function createNodeServer(opts: NodeOptions) {
  if (opts.dbPath !== ":memory:") mkdirSync(join(opts.dbPath, ".."), { recursive: true });
  const db = new SqliteDatabase(opts.dbPath);
  const applied = migrate(db, opts.migrationsDir);
  const cache = new MemoryResponseCache();
  const tasks = new PromiseTasks();
  const deps: Deps = {
    config: opts.config,
    db,
    blobs: new FsBlobStore(opts.mediaDir),
    cache,
    tasks,
    fetch: opts.fetch ?? fetch,
  };

  const app = new Hono();
  app.use(
    "/assets/*",
    serveStatic({ root: opts.publicDir, onFound: (_path, c) => c.header("Cache-Control", "public, max-age=3600") }),
  );
  app.use("*", cache.middleware());
  app.route("/", createApp(() => deps));
  return { app, deps, db, tasks, applied };
}
