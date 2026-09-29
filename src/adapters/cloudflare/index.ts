// Cloudflare Workers 入口
import { loadConfig } from "../../core/config";
import { createApp } from "../../core/http/app";
import type { Deps, ResponseCache } from "../../core/ports";
import { D1Adapter } from "./d1";
import { R2Adapter } from "./r2";

interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  [key: string]: unknown;
}

/** Workers Cache 的标签清除；未开启 [cache] 时 ctx.cache 不存在，直接跳过 */
class WorkersCache implements ResponseCache {
  constructor(private readonly ctx: { cache?: { purge(opts: { tags: string[] }): Promise<unknown> } }) {}

  async purge(tags: string[]): Promise<void> {
    const cache = this.ctx.cache;
    if (!cache?.purge) return;
    try {
      await cache.purge({ tags });
    } catch (e) {
      console.warn("cache purge failed", e);
    }
  }
}

const app = createApp((c): Deps => {
  const env = c.env as Env;
  const ctx = c.executionCtx;
  return {
    config: loadConfig(env),
    db: new D1Adapter(env.DB),
    blobs: new R2Adapter(env.MEDIA),
    cache: new WorkersCache(ctx as ConstructorParameters<typeof WorkersCache>[0]),
    tasks: { run: (task) => ctx.waitUntil(task().catch((e) => console.error("background task failed", e))) },
    fetch: (input, init) => fetch(input, init),
  };
});

export default app;
