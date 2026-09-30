import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNodeServer } from "../src/adapters/node";
import { FsBlobStore } from "../src/adapters/node/fs-store";
import { SqliteDatabase, migrate } from "../src/adapters/node/sqlite";
import { runBuild, type BuildOptions } from "../src/build/pipeline";
import type { SiteIndex } from "../src/core/build/site";
import { loadConfig } from "../src/core/config";
import type { TgMessage, TgUpdate } from "../src/core/telegram/types";

export const CHANNEL_ID = -1001234567890;
export const SECRET = "test-secret";
export const API = "https://tg.test";

/** 只有文件头的 PNG，够 imageSize 读尺寸 */
export function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

/** 假的 Telegram Bot API + 外部网页，记录所有调用 */
export function fakeFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const pages = new Map<string, () => Response>();
  /** 下载这些 file_id 时返回 500，模拟网络故障 */
  const failing = new Set<string>();
  /** 这些网页延迟返回（毫秒），模拟慢站点 */
  const delays = new Map<string, number>();
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });

    const method = /\/botTOKEN\/(\w+)$/.exec(url)?.[1];
    if (method === "getFile") {
      const id = (body as { file_id: string }).file_id;
      return Response.json({ ok: true, result: { file_id: id, file_unique_id: `u-${id}`, file_size: 64, file_path: `files/${id}.jpg` } });
    }
    if (method === "deleteMessages") return Response.json({ ok: true, result: true });
    const file = /\/file\/botTOKEN\/files\/(.+)\.jpg$/.exec(url)?.[1];
    if (file !== undefined) {
      if (failing.has(file)) return new Response("boom", { status: 500 });
      const bytes = pngBytes(100, 80);
      return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
    }
    const page = pages.get(url);
    if (page) {
      const ms = delays.get(url);
      if (ms) await new Promise((r) => setTimeout(r, ms));
      return page();
    }
    return new Response("not found", { status: 404 });
  };
  return { fn, calls, pages, failing, delays };
}

export function createTestEnv(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "thought-worker-"));
  const fake = fakeFetch();
  const config = loadConfig({
    BOT_TOKEN: "TOKEN",
    WEBHOOK_SECRET: SECRET,
    CHANNEL_ID: String(CHANNEL_ID),
    CHANNEL_USERNAME: "mychan",
    TELEGRAM_API_BASE: API,
    SITE_URL: "https://site.test",
    ...env,
  });
  const db = new SqliteDatabase(join(dir, "thought.db"));
  migrate(db, resolve("migrations"));
  const media = new FsBlobStore(join(dir, "media"));
  const siteDir = join(dir, "site");
  const server = createNodeServer({ config, db, media, fetch: fake.fn, siteDir });

  const send = (update: TgUpdate, secret = SECRET) =>
    server.request("/tg/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(update),
    });

  const build = (opts: Partial<BuildOptions> = {}) =>
    runBuild({
      config,
      db,
      media,
      fetch: fake.fn,
      outDir: siteDir,
      publicDir: resolve("public"),
      log: () => {},
      ...opts,
    });

  const file = (path: string) => readFileSync(join(siteDir, path), "utf8");
  const exists = (path: string) => existsSync(join(siteDir, path));
  const index = () => JSON.parse(file("data/index.json")) as SiteIndex;
  /** 某条帖子渲染出的 HTML（从按月分块里取） */
  const postHtml = (id: number) => {
    const entry = index().posts.find((p) => p.id === id);
    if (!entry) return null;
    return (JSON.parse(file(`data/month/${entry.d.slice(0, 7)}.json`)) as Record<string, string>)[id] ?? null;
  };

  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, config, db, media, server, fake, send, build, file, exists, index, postHtml, cleanup };
}

let updateId = 1;
let messageId = 100;
export const nextMessageId = () => ++messageId;

export function message(partial: Partial<TgMessage>): TgMessage {
  return {
    message_id: nextMessageId(),
    date: 1759132800, // 2025-09-29 16:00 +08
    chat: { id: CHANNEL_ID, type: "channel", title: "test", username: "mychan" },
    ...partial,
  };
}

export const post = (m: TgMessage): TgUpdate => ({ update_id: updateId++, channel_post: m });
export const edit = (m: TgMessage): TgUpdate => ({ update_id: updateId++, edited_channel_post: m });

/** 带实体的文字：hashtag / url 按出现位置自动标注 */
export function withEntities(text: string): Pick<TgMessage, "text" | "entities"> {
  const entities = [];
  for (const m of text.matchAll(/#[\p{L}\p{N}_]+/gu)) entities.push({ type: "hashtag", offset: m.index, length: m[0].length });
  for (const m of text.matchAll(/https?:\/\/\S+/g)) entities.push({ type: "url", offset: m.index, length: m[0].length });
  return { text, entities: entities.sort((a, b) => a.offset - b.offset) };
}

export const photo = (id: string, w = 1280, h = 960) => [
  { file_id: `${id}-s`, file_unique_id: `${id}-us`, width: 320, height: 240 },
  { file_id: `${id}-m`, file_unique_id: `${id}-um`, width: 800, height: 600 },
  { file_id: id, file_unique_id: `${id}-u`, width: w, height: h },
];
