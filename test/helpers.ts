import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/core/config";
import { createNodeServer } from "../src/adapters/node";
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
    if (url.startsWith(`${API}/file/botTOKEN/`)) {
      const bytes = pngBytes(100, 80);
      return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
    }
    const page = pages.get(url);
    if (page) return page();
    return new Response("not found", { status: 404 });
  };
  return { fn, calls, pages };
}

export function createTestServer(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "thought-worker-"));
  const fake = fakeFetch();
  const server = createNodeServer({
    config: loadConfig({
      BOT_TOKEN: "TOKEN",
      WEBHOOK_SECRET: SECRET,
      CHANNEL_ID: String(CHANNEL_ID),
      CHANNEL_USERNAME: "mychan",
      TELEGRAM_API_BASE: API,
      ...env,
    }),
    dbPath: ":memory:",
    mediaDir: join(dir, "media"),
    migrationsDir: resolve("migrations"),
    publicDir: "./public",
    fetch: fake.fn,
  });
  return { ...server, fake, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
