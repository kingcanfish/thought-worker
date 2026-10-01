// 端到端：webhook → 收件箱 → 构建 → 静态文件，跑在 Node 适配器（本地磁盘存储）上
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInbox } from "../src/core/services/inbox";
import { SECRET, createTestEnv, edit, message, nextMessageId, photo, pngBytes, post, withEntities } from "./helpers";

let t: ReturnType<typeof createTestEnv>;
beforeEach(() => {
  t = createTestEnv();
});
afterEach(() => t.cleanup());

const ids = () => t.index().posts.map((p) => p.id);
const inboxIds = async () => (await readInbox(t.db)).map((i) => i.updateId);
const lockRow = () => t.db.first<{ token: string; acquired_at: number }>("SELECT token, acquired_at FROM build_lock");
const texts = () => t.index().posts.map((p) => p.s);

describe("receiver", () => {
  it("rejects requests without the secret or with bad bodies", async () => {
    expect((await t.send(post(message({ text: "x" })), "wrong")).status).toBe(401);
    const bad = await t.server.request("/tg/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: "not json",
    });
    expect(bad.status).toBe(400);
    expect(await inboxIds()).toEqual([]);
  });

  it("stores updates in order and dedupes redeliveries", async () => {
    const u1 = post(message({ text: "a" }));
    const u2 = post(message({ text: "b" }));
    await t.send(u2);
    await t.send(u1);
    await t.send(u1); // Telegram 重试
    // 按 update_id 排序，重复投递被忽略
    expect(await inboxIds()).toEqual([u1.update_id, u2.update_id]);
    expect(await t.media.list("")).toEqual([]); // 收件箱不在媒体存储里
  });
});

describe("build", () => {
  it("skips when there is nothing new, unless forced", async () => {
    expect((await t.build()).changed).toBe(false);
    expect(t.exists("index.html")).toBe(false);
    expect((await t.build({ force: true })).changed).toBe(true);
    expect(t.file("index.html")).toContain("还没有碎碎念");
  });

  it("renders posts into pages, index and month chunks, then clears the inbox", async () => {
    const m = message(withEntities("第一条碎碎念 #日常"));
    await t.send(post(m));
    const r = await t.build();
    expect(r).toMatchObject({ changed: true, processed: 1, posts: 1 });

    const [entry] = t.index().posts;
    expect(entry).toMatchObject({ d: "2025-09-29", g: ["日常"], s: "第一条碎碎念 #日常" });
    expect(t.postHtml(entry!.id)).toContain('class="hashtag"');
    expect(t.postHtml(entry!.id)).toContain(`https://t.me/mychan/${m.message_id}`);

    const home = t.file("index.html");
    expect(home.startsWith("<!doctype html>")).toBe(true);
    expect(home).toContain("第一条碎碎念");
    expect(t.file(`p/${entry!.id}/index.html`)).toContain('property="og:type" content="article"');
    expect(t.file("rss.xml")).toContain("https://site.test/p/");
    expect(t.file("404.html")).toContain("不见了");
    expect(t.exists("assets/app.js")).toBe(true);

    expect(await inboxIds()).toEqual([]);
    expect(await lockRow()).toBeNull(); // 构建结束释放锁
    // 已处理过的消息被重新投递，不会重复
    await t.send(post(m));
    await t.build();
    expect(ids()).toHaveLength(1);
  });

  it("keeps state across builds", async () => {
    await t.send(post(message({ text: "第一条" })));
    await t.build();
    await t.send(post(message({ text: "第二条" })));
    await t.build();
    expect(texts()).toEqual(["第二条", "第一条"].map((s) => s)); // 同一时间，id 大的在前
  });

  it("merges albums, keeps the caption on edits and does not skip ids", async () => {
    const a = message({ media_group_id: "album1", photo: photo("p1") });
    const b = message({ media_group_id: "album1", photo: photo("p2"), caption: "两张图" });
    await t.send(post(a));
    await t.send(post(b));
    await t.send(edit({ ...a, edit_date: a.date + 60 })); // 编辑没有 caption 的那张
    await t.send(post(message({ text: "下一条" })));
    await t.build();

    const posts = t.index().posts;
    expect(posts).toHaveLength(2);
    const album = posts.find((p) => p.s === "两张图")!;
    expect(posts.find((p) => p.s === "下一条")!.id).toBe(album.id + 1);
    const html = t.postHtml(album.id)!;
    expect(html.match(/data-full="\/m\/photo\/p[12]-u\.jpg"/g)).toHaveLength(2);
    expect(html).toContain('src="/m/thumb/p1-um.jpg"');
    expect(html).toContain(`https://t.me/mychan/${a.message_id}`);
  });

  it("applies text edits", async () => {
    const m = message({ text: "旧的" });
    await t.send(post(m));
    await t.send(edit({ ...m, text: "新的", edit_date: m.date + 60 }));
    await t.build();
    expect(texts()).toEqual(["新的"]);
    expect(t.postHtml(ids()[0]!)).toContain("已编辑");
  });

  it("shows forward origin", async () => {
    await t.send(
      post(
        message({
          text: "转发的",
          forward_origin: { type: "channel", date: 1, chat: { id: 1, type: "channel", title: "每日一图", username: "daily" }, message_id: 5 },
        }),
      ),
    );
    await t.build();
    expect(t.postHtml(ids()[0]!)).toContain('href="https://t.me/daily/5"');
  });

  it("deletes via /del: the receiver removes the command and target right away, the build hides the post", async () => {
    const a = message({ media_group_id: "album2", photo: photo("d1") });
    const b = message({ media_group_id: "album2", photo: photo("d2") });
    await t.send(post(a));
    await t.send(post(b));
    await t.build();
    expect(ids()).toHaveLength(1);

    const cmdId = nextMessageId();
    const deletes = () => t.fake.calls.filter((c) => c.url.endsWith("/deleteMessages")).map((c) => (c.body as { message_ids: number[] }).message_ids);
    await t.send(post(message({ message_id: cmdId, text: "/del", entities: [{ type: "bot_command", offset: 0, length: 4 }], reply_to_message: b })));
    // 接收端立即删掉指令和被回复的那条（赶在 48 小时内），不等构建
    expect(deletes()).toEqual([[cmdId, b.message_id]]);

    await t.build();
    expect(ids()).toHaveLength(0);
    // 构建时再清理一遍：指令本身 + 相册里的所有消息（已删掉的会被 Telegram 跳过）
    expect(deletes()).toEqual([[cmdId, b.message_id], [cmdId], [a.message_id, b.message_id]]);
  });

  it("copies referenced images into the site with STATIC_MEDIA, reusing the cache and skipping deleted posts", async () => {
    const cacheDir = `${t.dir}/media-cache`;
    const keep = message({ photo: photo("s1"), caption: "留着" });
    const gone = message({ photo: photo("s2") });
    await t.send(post(keep));
    await t.send(post(gone));
    await t.send(post(message({ text: "/del", entities: [{ type: "bot_command", offset: 0, length: 4 }], reply_to_message: gone })));
    const r = await t.build({ staticMedia: { cacheDir } });
    expect(r.images).toBe(2);
    // 地址不变，还是 /m/<key>
    expect(t.file("m/photo/s1-u.jpg")).toBe(t.file("m/thumb/s1-um.jpg"));
    expect(t.postHtml(ids()[0]!)).toContain('src="/m/thumb/s1-um.jpg"');
    expect(t.exists("m/photo/s2-u.jpg")).toBe(false);

    // 下次构建从缓存拷，不再读媒体存储（存储里删掉了也照样有）
    await t.media.delete("photo/s1-u.jpg");
    await t.build({ force: true, staticMedia: { cacheDir } });
    expect(t.exists("m/photo/s1-u.jpg")).toBe(true);

    // 没开就不拷
    await t.build({ force: true });
    expect(t.exists("m")).toBe(false);
  });

  it("labels oversized videos and photos correctly", async () => {
    await t.send(
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
    await t.send(
      post(
        message({
          caption: "原图",
          document: { file_id: "big", file_unique_id: "big-u", mime_type: "image/jpeg", file_size: 30 * 1024 * 1024 },
        }),
      ),
    );
    await t.build();
    const [photoPost, videoPost] = ids();
    expect(t.postHtml(videoPost!)).toContain("视频较大");
    expect(t.postHtml(videoPost!)).toContain('src="/m/thumb/v1-tu.jpg"');
    expect(t.postHtml(photoPost!)).toContain("原图较大");
    expect(t.fake.calls.some((c) => (c.body as { file_id?: string })?.file_id === "v1")).toBe(false);
  });

  it("does not treat SVG documents as images", async () => {
    await t.send(post(message({ caption: "svg", document: { file_id: "svg", file_unique_id: "svg-u", mime_type: "image/svg+xml" } })));
    await t.build();
    expect(t.postHtml(ids()[0]!)).not.toContain("/m/");
    expect(t.fake.calls.some((c) => (c.body as { file_id?: string })?.file_id === "svg")).toBe(false);
  });

  const downloads = (id: string) => t.fake.calls.filter((c) => c.url.endsWith(`/files/${id}.jpg`)).length;

  it("retries failed media on later builds, not in the same build", async () => {
    t.fake.failing.add("r1");
    await t.send(post(message({ photo: photo("r1") })));
    await t.build();
    expect(downloads("r1")).toBe(1); // 刚失败的不会在同一次构建里再下载一次
    expect(t.postHtml(ids()[0]!)).not.toContain("photo/r1-u.jpg");

    t.fake.failing.clear();
    const r = await t.build(); // 收件箱是空的，但有待重试的媒体
    expect(r).toMatchObject({ changed: true, retried: 1 });
    expect(t.postHtml(ids()[0]!)).toContain("photo/r1-u.jpg");
  });

  it("stops retrying after MAX_ATTEMPTS even when every retry fails", async () => {
    t.fake.failing.add("gone");
    await t.send(post(message({ photo: photo("gone") })));
    for (let i = 0; i < 8; i++) {
      const r = await t.build();
      if (i > 0) expect(r.changed).toBe(false); // 重试失败不重新生成站点
    }
    // 第一次入库 + 4 次重试 = 5 次，之后不再尝试
    expect(downloads("gone")).toBe(5);
  });

  it("keeps the inbox when deploy fails and reprocesses it idempotently", async () => {
    await t.send(post(message({ text: "部署失败的那次" })));
    await expect(t.build({ deploy: async () => Promise.reject(new Error("boom")) })).rejects.toThrow("boom");
    expect(await inboxIds()).toHaveLength(1);
    expect(await lockRow()).toBeNull();
    // 下次构建重新处理，不会出现两条
    expect((await t.build()).processed).toBe(1);
    expect(texts()).toEqual(["部署失败的那次"]);
    expect(await inboxIds()).toEqual([]);
  });

  it("only clears the updates it processed", async () => {
    await t.send(post(message({ text: "构建前" })));
    const late = post(message({ text: "部署期间到达" }));
    await t.build({ deploy: async () => void (await t.send(late)) });
    expect(await inboxIds()).toEqual([late.update_id]);
    await t.build();
    expect(texts()).toEqual(["部署期间到达", "构建前"]);
  });

  it("republishes media fixed by a retry even when that deploy failed", async () => {
    t.fake.failing.add("rp");
    await t.send(post(message({ photo: photo("rp") })));
    await t.build();
    t.fake.failing.clear();
    // 重试成功（数据库里已是 ready），但这次部署失败
    await expect(t.build({ deploy: async () => Promise.reject(new Error("boom")) })).rejects.toThrow("boom");
    // 收件箱是空的、也没有待重试的媒体，仍然要重新发布
    const r = await t.build();
    expect(r.changed).toBe(true);
    expect(t.postHtml(ids()[0]!)).toContain("photo/rp-u.jpg");
    expect((await t.build()).changed).toBe(false); // 发布成功后标记清零
  });

  it("does not download a failed file twice or reset its attempts when the inbox is reprocessed", async () => {
    t.fake.failing.add("f2");
    await t.send(post(message({ photo: photo("f2") })));
    await expect(t.build({ deploy: async () => Promise.reject(new Error("boom")) })).rejects.toThrow("boom");
    expect(downloads("f2")).toBe(1);
    // 收件箱还在：这次构建重试一次，重新处理消息时不再下载
    await t.build();
    expect(downloads("f2")).toBe(2);
    expect(await t.db.first("SELECT status, attempts FROM media")).toEqual({ status: "failed", attempts: 2 });
  });

  it("does not deploy when the lock was taken over before deploying", async () => {
    await t.send(post(message({ photo: photo("lk") })));
    let deployed = false;
    await expect(
      t.build({
        // 处理收件箱期间锁被接管
        optimizeImage: async () => {
          await t.db.run("UPDATE build_lock SET token = 'other'");
          return null;
        },
        deploy: async () => void (deployed = true),
      }),
    ).rejects.toThrow("另一个构建正在进行");
    expect(deployed).toBe(false);
    expect(await inboxIds()).toHaveLength(1);
  });

  it("builds link preview cards and blocks private addresses", async () => {
    t.fake.pages.set(
      "https://example.com/article",
      () =>
        new Response(
          `<head><meta property="og:title" content="文章标题"><meta property="og:description" content="描述"><meta property="og:image" content="https://example.com/cover.png"></head>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );
    t.fake.pages.set("https://example.com/cover.png", () => new Response(pngBytes(1200, 630)));
    t.fake.pages.set(
      "https://evil.test/page",
      () => new Response(`<head><meta property="og:title" content="x"><meta property="og:image" content="http://169.254.169.254/latest"></head>`, { headers: { "content-type": "text/html" } }),
    );
    await t.send(post(message(withEntities("好文 https://example.com/article"))));
    await t.send(post(message(withEntities("内网 http://127.0.0.1:8080/admin"))));
    await t.send(post(message(withEntities("坏图 https://evil.test/page"))));
    await t.build();

    const [evil, internal, good] = ids();
    expect(t.postHtml(good!)).toMatch(/class="link-card"[\s\S]*文章标题/);
    expect(t.postHtml(good!)).toMatch(/src="\/m\/link\/[0-9a-f]{32}\.png"/);
    expect(t.postHtml(internal!)).not.toContain("link-card");
    expect(t.postHtml(evil!)).not.toContain("<img");
    const fetched = t.fake.calls.map((c) => c.url);
    expect(fetched.some((u) => u.includes("127.0.0.1") || u.includes("169.254"))).toBe(false);
  });

  it("fetches link previews once per post, using the latest edit in the batch", async () => {
    const html = (title: string) => () => new Response(`<head><meta property="og:title" content="${title}"></head>`, { headers: { "content-type": "text/html" } });
    t.fake.pages.set("https://slow.test/a", html("旧链接"));
    t.fake.delays.set("https://slow.test/a", 50);
    t.fake.pages.set("https://fast.test/b", html("新链接"));
    const m = message(withEntities("看这个 https://slow.test/a"));
    await t.send(post(m));
    await t.send(edit({ ...m, ...withEntities("看这个 https://fast.test/b"), edit_date: m.date + 60 }));
    await t.build();
    expect(t.postHtml(ids()[0]!)).toContain("新链接");
    expect(t.fake.calls.some((c) => c.url === "https://slow.test/a")).toBe(false);
  });

  it("skips link preview when disabled", async () => {
    t.fake.pages.set("https://example.com/x", () => new Response(`<head><meta property="og:title" content="标题"></head>`, { headers: { "content-type": "text/html" } }));
    await t.send(post(message({ ...withEntities("https://example.com/x"), link_preview_options: { is_disabled: true } })));
    await t.build();
    expect(t.postHtml(ids()[0]!)).not.toContain("link-card");
    expect(t.fake.calls.some((c) => c.url === "https://example.com/x")).toBe(false);
  });

  it("refuses to run two builds at once", async () => {
    await t.send(post(message({ text: "第一条" })));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = t.build({ deploy: () => gate });
    await new Promise((r) => setTimeout(r, 20));
    await expect(t.build()).rejects.toThrow("另一个构建正在进行");
    release();
    await first;
    expect(texts()).toEqual(["第一条"]);
    expect(await lockRow()).toBeNull();
  });

  it("takes over a stale lock", async () => {
    await t.db.run("INSERT INTO build_lock (id, token, acquired_at) VALUES (1, 'dead', ?)", [Date.now() - 2 * 60 * 60 * 1000]);
    await t.send(post(message({ text: "接管" })));
    expect((await t.build()).processed).toBe(1);
    expect(await lockRow()).toBeNull();
  });

  it("gives up when the lock is taken over mid-build, leaving the inbox and the other lock alone", async () => {
    await t.send(post(message({ text: "被抢锁的那次" })));
    await expect(
      t.build({
        deploy: async () => {
          // 这次构建超过了 TTL，另一个构建接管了锁
          await t.db.run("UPDATE build_lock SET token = 'other', acquired_at = ?", [Date.now()]);
        },
      }),
    ).rejects.toThrow("另一个构建正在进行");
    expect(await inboxIds()).toHaveLength(1); // 收件箱交给接管的那次构建清理
    expect((await lockRow())?.token).toBe("other"); // 别人的锁不能删
  });

  it("uses the site timezone for day keys", async () => {
    // 上海 9/29 01:00 = UTC 9/28 17:00
    await t.send(post(message({ text: "深夜", date: Date.parse("2026-09-29T01:00:00+08:00") / 1000 })));
    await t.build();
    expect(t.index().posts[0]!.d).toBe("2026-09-29");
  });
});

describe("serving", () => {
  it("serves the built site and a 404 page", async () => {
    await t.send(post(message({ text: "hello" })));
    await t.build();
    const home = await t.server.request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("hello");
    const missing = await t.server.request("/nope");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("不见了");
  });

  it("serves media with range support", async () => {
    await t.send(post(message({ photo: photo("r1") })));
    await t.build();
    const full = await t.server.request("/m/photo/r1-u.jpg");
    expect(full.status).toBe(200);
    expect(full.headers.get("cache-control")).toContain("immutable");

    const part = await t.server.request("/m/photo/r1-u.jpg", { headers: { range: "bytes=0-3" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-3/64");

    const beyond = await t.server.request("/m/photo/r1-u.jpg", { headers: { range: "bytes=100-" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */64");

    expect((await t.server.request("/m/photo/%E0")).status).toBe(404);
    // 媒体目录之外的路径一律 404
    expect((await t.server.request("/m/state/thought.db")).status).toBe(404);
    expect((await t.server.request("/m/inbox/0000000000000001.json")).status).toBe(404);
    expect((await t.server.request("/m/../etc/passwd")).status).toBe(404);
  });
});
