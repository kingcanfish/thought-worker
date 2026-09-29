// 端到端：webhook → 入库 → 接口 / 页面 / 媒体 / 缓存，跑在 Node 适配器上
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TgUpdate } from "../src/core/telegram/types";
import { CHANNEL_ID, SECRET, createTestServer, edit, message, nextMessageId, pngBytes, post, withEntities } from "./helpers";

let t: ReturnType<typeof createTestServer>;
beforeEach(() => {
  t = createTestServer();
});
afterEach(() => t.cleanup());

const send = (update: TgUpdate, secret = SECRET) =>
  t.app.request("/tg/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  });

const posts = async (qs = "") => ((await (await t.app.request(`/api/posts${qs}`)).json()) as { items: any[]; next_cursor: string | null });

const photo = (id: string, w = 1280, h = 960) => [
  { file_id: `${id}-s`, file_unique_id: `${id}-us`, width: 320, height: 240 },
  { file_id: `${id}-m`, file_unique_id: `${id}-um`, width: 800, height: 600 },
  { file_id: id, file_unique_id: `${id}-u`, width: w, height: h },
];

describe("webhook", () => {
  it("rejects requests without the secret", async () => {
    expect((await send(post(message({ text: "x" })), "wrong")).status).toBe(401);
  });

  it("ignores other chats and unsupported messages", async () => {
    const other = message({ text: "x" });
    other.chat = { id: -100999, type: "channel" };
    expect(await (await send(post(other))).json()).toMatchObject({ action: "ignored" });
    expect(await (await send(post(message({})))).json()).toMatchObject({ action: "ignored" });
    expect((await posts()).items).toHaveLength(0);
  });

  it("saves a text post with tags and is idempotent", async () => {
    const m = message(withEntities("第一条碎碎念 #日常"));
    await send(post(m));
    await send(post(m)); // Telegram 重试
    const { items } = await posts();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "第一条碎碎念 #日常", tags: ["日常"], tg_link: `https://t.me/mychan/${m.message_id}` });
    expect(items[0].html).toContain('class="hashtag"');
  });

  it("merges an album into one post and keeps the caption", async () => {
    const a = message({ media_group_id: "album1", photo: photo("p1") });
    const b = message({ media_group_id: "album1", photo: photo("p2"), caption: "两张图" });
    await send(post(a));
    await send(post(b));
    const { items } = await posts();
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("两张图");
    expect(items[0].tg_link).toBe(`https://t.me/mychan/${a.message_id}`);
    // 后面的新帖子 id 紧接着，不跳号
    await send(post(message({ text: "下一条" })));
    expect((await posts()).items[0].id).toBe(items[0].id + 1);
    expect(items[0].media.map((m: any) => m.url)).toEqual(["/m/photo/p1-u.jpg", "/m/photo/p2-u.jpg"]);
    expect(items[0].media[0].thumb).toBe("/m/thumb/p1-um.jpg");

    // 编辑没有 caption 的那张，不能把文字清掉
    await send(edit({ ...a, edit_date: a.date + 60 }));
    expect((await posts()).items.find((p) => p.id === items[0].id).text).toBe("两张图");
  });

  it("applies edits", async () => {
    const m = message({ text: "旧的" });
    await send(post(m));
    await send(edit({ ...m, text: "新的", edit_date: m.date + 60 }));
    const { items } = await posts();
    expect(items[0]).toMatchObject({ text: "新的", edited_at: m.date + 60 });
  });

  it("records forward origin", async () => {
    await send(
      post(
        message({
          text: "转发的",
          forward_origin: { type: "channel", date: 1, chat: { id: 1, type: "channel", title: "每日一图", username: "daily" }, message_id: 5 },
        }),
      ),
    );
    expect((await posts()).items[0].forward).toEqual({ type: "channel", name: "每日一图", url: "https://t.me/daily/5" });
  });

  it("deletes a post via /del reply and cleans up channel messages", async () => {
    const a = message({ media_group_id: "album2", photo: photo("d1") });
    const b = message({ media_group_id: "album2", photo: photo("d2") });
    await send(post(a));
    await send(post(b));
    const cmdId = nextMessageId();
    const res = await send(
      post(
        message({
          message_id: cmdId,
          text: "/del",
          entities: [{ type: "bot_command", offset: 0, length: 4 }],
          reply_to_message: b,
        }),
      ),
    );
    expect(await res.json()).toMatchObject({ action: "deleted" });
    expect((await posts()).items).toHaveLength(0);
    const deletes = t.fake.calls.filter((c) => c.url.endsWith("/deleteMessages")).map((c) => (c.body as any).message_ids);
    expect(deletes).toEqual([[cmdId], [a.message_id, b.message_id]]);
  });

  it("marks videos over the download limit as too_large but keeps the cover", async () => {
    await send(
      post(
        message({
          caption: "长视频",
          video: {
            file_id: "v1",
            file_unique_id: "v1-u",
            width: 1280,
            height: 720,
            duration: 312,
            file_size: 50 * 1024 * 1024,
            thumbnail: { file_id: "v1-t", file_unique_id: "v1-tu", width: 320, height: 180 },
          },
        }),
      ),
    );
    const media = (await posts()).items[0].media[0];
    expect(media).toMatchObject({ kind: "video", status: "too_large", url: null, thumb: "/m/thumb/v1-tu.jpg", duration: 312 });
    expect(t.fake.calls.some((c) => (c.body as any)?.file_id === "v1")).toBe(false);
    const html = await (await t.app.request("/")).text();
    expect(html).toContain("在 Telegram 中观看");
  });

  it("builds a link preview card in the background", async () => {
    t.fake.pages.set(
      "https://example.com/article",
      () =>
        new Response(
          `<head><meta property="og:title" content="文章标题"><meta property="og:description" content="描述"><meta property="og:image" content="https://example.com/cover.png"></head>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );
    t.fake.pages.set("https://example.com/cover.png", () => new Response(pngBytes(1200, 630)));
    await send(post(message(withEntities("好文 https://example.com/article"))));
    await t.tasks.idle();
    const lp = (await posts()).items[0].link_preview;
    expect(lp).toMatchObject({ title: "文章标题", description: "描述", layout: "large" });
    expect(lp.image).toMatch(/^\/m\/link\/[0-9a-f]{32}\.png$/);
  });

  it("skips link preview when disabled", async () => {
    await send(post(message({ ...withEntities("https://example.com/x"), link_preview_options: { is_disabled: true } })));
    await t.tasks.idle();
    expect((await posts()).items[0].link_preview).toBeNull();
  });
});

describe("reading", () => {
  const day = (d: string, h = 12) => Date.parse(`${d}T${String(h).padStart(2, "0")}:00:00+08:00`) / 1000;

  beforeEach(async () => {
    await send(post(message({ ...withEntities("博客迁移到 Cloudflare #折腾"), date: day("2026-09-27") })));
    await send(post(message({ ...withEntities("猫又推杯子 #猫"), date: day("2026-09-28") })));
    await send(post(message({ ...withEntities("深夜的面 #吃"), date: day("2026-09-29", 1) })));
  });

  it("filters by tag, search and date", async () => {
    expect((await posts("?tag=猫")).items.map((p) => p.text)).toEqual(["猫又推杯子 #猫"]);
    expect((await posts("?q=Cloudflare")).items).toHaveLength(1); // FTS trigram
    expect((await posts("?q=的面")).items).toHaveLength(1); // 两个字走 LIKE
    expect((await posts("?from=2026-09-28&to=2026-09-29")).items).toHaveLength(2);
    // 上海时间 9/29 01:00 属于 29 号，不属于 28 号
    expect((await posts("?from=2026-09-28")).items.map((p) => p.text)).toEqual(["猫又推杯子 #猫"]);
  });

  it("paginates with a cursor", async () => {
    const first = await posts("?limit=2");
    expect(first.items).toHaveLength(2);
    const second = await posts(`?limit=2&cursor=${first.next_cursor}`);
    expect(second.items.map((p) => p.text)).toEqual(["博客迁移到 Cloudflare #折腾"]);
    expect(second.next_cursor).toBeNull();
  });

  it("serves heatmap counts in the site timezone", async () => {
    const res = await (await t.app.request("/api/stats/heatmap?from=2026-09-27&to=2026-09-29")).json();
    expect(res.counts).toEqual({ "2026-09-27": 1, "2026-09-28": 1, "2026-09-29": 1 });
  });

  it("renders the home page and fragments", async () => {
    const res = await t.app.request("/?tag=猫");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-tag")).toBe("content");
    const html = await res.text();
    expect(html).toContain("猫又推杯子");
    expect(html).not.toContain("深夜的面");
    expect(html).toContain("1 条结果");

    const frag = await (await t.app.request("/fragments/timeline?q=Cloudflare")).json();
    expect(frag.html).toContain("博客迁移到");
    expect(frag.filter).toContain("“Cloudflare”");
  });

  it("renders post detail, 404 and rss", async () => {
    const { items } = await posts();
    const detail = await t.app.request(`/p/${items[0].id}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain('property="og:type" content="article"');
    expect((await t.app.request("/p/999999")).status).toBe(404);
    const rss = await (await t.app.request("/rss.xml")).text();
    expect(rss.match(/<item>/g)).toHaveLength(3);
    expect(rss).toContain('href="http://localhost/?tag=');
  });

  it("caches pages and purges them when content changes", async () => {
    await t.app.request("/");
    expect((await t.app.request("/")).headers.get("x-cache")).toBe("HIT");
    await send(post(message({ text: "新的一条" })));
    const res = await t.app.request("/");
    expect(res.headers.get("x-cache")).toBeNull();
    expect(await res.text()).toContain("新的一条");
  });
});

describe("media route", () => {
  it("serves stored files with range support", async () => {
    await send(post(message({ photo: photo("r1") })));
    const full = await t.app.request("/m/photo/r1-u.jpg");
    expect(full.status).toBe(200);
    expect(full.headers.get("cache-control")).toContain("immutable");
    expect((await full.arrayBuffer()).byteLength).toBe(64);

    const part = await t.app.request("/m/photo/r1-u.jpg", { headers: { range: "bytes=0-3" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-3/64");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    expect((await t.app.request("/m/photo/r1-u.jpg", { headers: { range: "bytes=100-" } })).status).toBe(404);
    expect((await t.app.request("/m/../etc/passwd")).status).toBe(404);
  });
});

it("uses the configured channel id", () => {
  expect(t.deps.config.channelId).toBe(CHANNEL_ID);
});
