// /m 媒体：防盗链、边缘缓存、转存时压缩图片
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImageOptimizer } from "../src/build/image";
import { createReceiverApp } from "../src/core/http/app";
import type { BlobStore, ImageOptimizer, MediaCache } from "../src/core/ports";
import { createTestEnv, message, photo, post } from "./helpers";

let t: ReturnType<typeof createTestEnv>;
beforeEach(() => {
  t = createTestEnv({ MEDIA_ALLOWED_REFERERS: "friend.test, Reader.test" });
});
afterEach(() => t.cleanup());

const get = (path: string, headers: Record<string, string> = {}) => t.server.request(path, { headers });

describe("hotlink protection", () => {
  beforeEach(async () => {
    await t.send(post(message({ photo: photo("h1") })));
    await t.build();
  });

  it("allows requests without a referer, from the site itself and from allowed hosts", async () => {
    expect((await get("/m/photo/h1-u.jpg")).status).toBe(200);
    expect((await get("/m/photo/h1-u.jpg", { referer: "https://site.test/p/1/" })).status).toBe(200);
    // 请求自己的域名（例如还没配 SITE_URL 时用的 workers.dev）
    expect((await get("http://localhost/m/photo/h1-u.jpg", { referer: "http://localhost/" })).status).toBe(200);
    expect((await get("/m/photo/h1-u.jpg", { referer: "https://friend.test/x" })).status).toBe(200);
    expect((await get("/m/photo/h1-u.jpg", { referer: "https://reader.test/" })).status).toBe(200);
  });

  it("blocks other sites and malformed referers without caching the refusal", async () => {
    const res = await get("/m/photo/h1-u.jpg", { referer: "https://evil.test/page" });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // 子域名不算
    expect((await get("/m/photo/h1-u.jpg", { referer: "https://evil.site.test/" })).status).toBe(403);
    expect((await get("/m/photo/h1-u.jpg", { referer: "not a url" })).status).toBe(403);
  });
});

describe("edge cache", () => {
  /** 记录读取次数的媒体存储 + 用 Map 模拟的缓存（按键存完整响应，命中时原样返回） */
  function setup() {
    let reads = 0;
    const media: BlobStore = new Proxy(t.stores.media, {
      get(target, prop, receiver) {
        if (prop === "get") return (...args: Parameters<BlobStore["get"]>) => (reads++, target.get(...args));
        return Reflect.get(target, prop, receiver);
      },
    });
    const store = new Map<string, Response>();
    const cache: MediaCache = {
      match: async (key) => store.get(key)?.clone(),
      put: (key, res) => void store.set(key, res),
    };
    const app = createReceiverApp(() => ({ config: t.config, stores: { media, data: t.stores.data }, fetch: t.fake.fn, mediaCache: cache }));
    return { app, store, reads: () => reads };
  }

  beforeEach(async () => {
    await t.send(post(message({ photo: photo("c1") })));
    await t.build();
  });

  it("serves repeat requests from the cache, ignoring query strings", async () => {
    const { app, store, reads } = setup();
    const first = await app.request("https://site.test/m/photo/c1-u.jpg");
    expect(first.status).toBe(200);
    expect([...store.keys()]).toEqual(["https://site.test/m/photo/c1-u.jpg"]);

    const again = await app.request("https://site.test/m/photo/c1-u.jpg?bust=1");
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(new Uint8Array(await first.arrayBuffer()));
    expect(reads()).toBe(1);
  });

  it("does not cache partial responses, HEAD requests or hotlinks", async () => {
    const { app, store } = setup();
    expect((await app.request("https://site.test/m/photo/c1-u.jpg", { headers: { range: "bytes=0-3" } })).status).toBe(206);
    expect((await app.request("https://site.test/m/photo/c1-u.jpg", { method: "HEAD" })).status).toBe(200);
    expect((await app.request("https://site.test/m/photo/c1-u.jpg", { headers: { referer: "https://evil.test/" } })).status).toBe(403);
    expect(store.size).toBe(0);
  });

  it("checks the referer before looking in the cache", async () => {
    const { app } = setup();
    await app.request("https://site.test/m/photo/c1-u.jpg");
    expect((await app.request("https://site.test/m/photo/c1-u.jpg", { headers: { referer: "https://evil.test/" } })).status).toBe(403);
  });
});

describe("image optimization", () => {
  it("stores photos and thumbnails as WebP when the optimizer makes them smaller", async () => {
    const optimizeImage: ImageOptimizer = async (bytes) => ({ bytes: bytes.slice(0, 10), mime: "image/webp" });
    await t.send(post(message({ photo: photo("o1") })));
    await t.build({ optimizeImage });
    const [entry] = t.index().posts;
    const html = t.postHtml(entry!.id)!;
    expect(html).toContain("/m/photo/o1-u.webp");
    expect(html).toContain("/m/thumb/o1-um.webp");
    const obj = await t.stores.media.get("photo/o1-u.webp");
    expect(obj?.size).toBe(10);
    expect(obj?.contentType).toBe("image/webp");
    expect(await t.stores.media.head("photo/o1-u.jpg")).toBeNull();
  });

  it("keeps the original when the optimizer fails or does not help", async () => {
    await t.send(post(message({ photo: photo("o2") })));
    // 测试用的假图片只有 PNG 文件头，sharp 解不开：应当保留原图而不是标记失败
    await t.build({ optimizeImage: createImageOptimizer({ quality: 80, maxSide: 2560, maxBytes: 2 * 1024 * 1024 }) });
    await t.send(post(message({ photo: photo("o3") })));
    await t.build({ optimizeImage: async (bytes) => ({ bytes: new Uint8Array(bytes.byteLength * 2), mime: "image/webp" }) });
    expect(await t.stores.media.head("photo/o2-u.jpg")).not.toBeNull();
    expect(await t.stores.media.head("photo/o3-u.jpg")).not.toBeNull();
    expect(t.index().posts).toHaveLength(2);
  });

  it("converts real images to WebP, fixes orientation, shrinks oversized ones and drops metadata", async () => {
    const optimize = createImageOptimizer({ quality: 80, maxSide: 2560, maxBytes: 2 * 1024 * 1024 });
    // 3000×2000 的噪点图，EXIF 方向 6（需要顺时针转 90°）
    const raw = Buffer.alloc(3000 * 2000 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const jpeg = await sharp(raw, { raw: { width: 3000, height: 2000, channels: 3 } })
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const out = await optimize(new Uint8Array(jpeg), "image/jpeg");
    expect(out?.mime).toBe("image/webp");
    expect(out!.bytes.byteLength).toBeLessThan(jpeg.byteLength);
    const meta = await sharp(out!.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([1707, 2560]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it("lowers quality, then size, until the image fits the byte limit", async () => {
    // 噪点图几乎压不动，逼着它一路降到上限以内
    const raw = Buffer.alloc(2000 * 2000 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const png = await sharp(raw, { raw: { width: 2000, height: 2000, channels: 3 } }).png().toBuffer();
    const limit = 300 * 1024;

    const out = await createImageOptimizer({ quality: 80, maxSide: 2560, maxBytes: limit })(new Uint8Array(png), "image/png");
    expect(out!.bytes.byteLength).toBeLessThanOrEqual(limit);
    const meta = await sharp(out!.bytes).metadata();
    expect(meta.width).toBeLessThan(2000);
    expect(meta.width).toBe(meta.height);

    // 本来就在上限以内的图不缩尺寸
    const small = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#88aacc" } }).jpeg().toBuffer();
    const kept = await createImageOptimizer({ quality: 80, maxSide: 2560, maxBytes: limit })(new Uint8Array(small), "image/jpeg");
    expect((await sharp(kept!.bytes).metadata()).width).toBe(1200);
  });

  it("leaves GIFs and unknown formats alone", async () => {
    const optimize = createImageOptimizer({ quality: 80, maxSide: 2560, maxBytes: 2 * 1024 * 1024 });
    expect(await optimize(new Uint8Array(10), "image/gif")).toBeNull();
    expect(await optimize(new Uint8Array(10), "image/heic")).toBeNull();
  });
});
