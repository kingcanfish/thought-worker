// 环境变量 → 数据库 / 媒体存储：空字符串当作没设置
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { D1HttpDatabase } from "../src/adapters/d1/http";
import { S3BlobStore } from "../src/adapters/s3/s3-store";
import { databaseFromEnv, mediaFromEnv } from "../src/build/storage";

const r2 = { STORAGE: "r2", R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" };

describe("storage from env", () => {
  it("falls back to the default bucket when R2_BUCKET is empty", async () => {
    const urls: string[] = [];
    const media = mediaFromEnv({ ...r2, R2_BUCKET: "" });
    expect(media).toBeInstanceOf(S3BlobStore);
    // 通过一次请求看实际拼出的地址
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      await media.head("photo/x.jpg");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toEqual(["https://acc.r2.cloudflarestorage.com/thought-worker-media/photo/x.jpg"]);
  });

  it("creates DATA_DIR on first run and applies migrations", async () => {
    const root = mkdtempSync(join(tmpdir(), "thought-storage-"));
    try {
      const dir = join(root, "not", "yet");
      const opened = databaseFromEnv({ DATA_DIR: dir }, resolve("migrations"));
      expect(existsSync(join(dir, "thought.db"))).toBe(true);
      expect(await opened.db.first("SELECT publish_pending FROM site_state")).toEqual({ publish_pending: 0 });
      opened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats empty credentials as missing instead of sending them", () => {
    expect(() => mediaFromEnv({ ...r2, R2_ACCESS_KEY_ID: " " })).toThrow("R2_ACCESS_KEY_ID");
    const d1 = { DB: "d1", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok", D1_DATABASE_ID: "id" };
    // D1_API_TOKEN="" 回退到 CLOUDFLARE_API_TOKEN
    expect(databaseFromEnv({ ...d1, D1_API_TOKEN: "" }, "migrations").db).toBeInstanceOf(D1HttpDatabase);
    expect(() => databaseFromEnv({ ...d1, CLOUDFLARE_API_TOKEN: "" }, "migrations")).toThrow("CLOUDFLARE_API_TOKEN");
  });
});
