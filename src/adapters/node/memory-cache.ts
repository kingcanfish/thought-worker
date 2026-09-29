import type { MiddlewareHandler } from "hono";
import type { ResponseCache } from "../../core/ports";

interface Entry {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
  expires: number;
  tags: string[];
}

const MAX_BODY = 2 * 1024 * 1024;

/**
 * 进程内的响应缓存，语义与 Workers Cache 对齐：缓存带 Cache-Tag 且有 s-maxage 的 GET 响应，按标签清除。
 * 前面有 nginx / CDN 时也可以不用它，让它们按同样的响应头缓存。
 */
export class MemoryResponseCache implements ResponseCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = 500) {}

  async purge(tags: string[]): Promise<void> {
    for (const [k, e] of this.entries) if (e.tags.some((t) => tags.includes(t))) this.entries.delete(k);
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      if (c.req.method !== "GET") return next();
      const key = c.req.url;
      const hit = this.entries.get(key);
      if (hit && hit.expires > Date.now()) {
        // 重新插入，维持 LRU 顺序
        this.entries.delete(key);
        this.entries.set(key, hit);
        return new Response(hit.body, { status: hit.status, headers: [...hit.headers, ["x-cache", "HIT"]] });
      }
      await next();
      const res = c.res;
      const tags = res.headers.get("cache-tag");
      const maxAge = /s-maxage=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
      if (res.status !== 200 || !tags || !maxAge || res.headers.has("set-cookie")) return;
      const body = await res.clone().arrayBuffer();
      if (body.byteLength > MAX_BODY) return;
      this.entries.set(key, {
        status: res.status,
        headers: [...res.headers.entries()],
        body,
        expires: Date.now() + Number(maxAge) * 1000,
        tags: tags.split(",").map((t) => t.trim()),
      });
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    };
  }
}
