// 收件箱：接收端把 webhook 原样存进对象存储，构建端按顺序取出处理。
// update_id 单调递增，补零后字典序 = Telegram 的投递顺序；重复投递写同一个 key，天然幂等。
import type { BlobStore } from "../ports";
import type { TgUpdate } from "../telegram/types";

export const INBOX_PREFIX = "inbox/";
const MAX_UPDATE_BYTES = 1024 * 1024;

export const inboxKey = (updateId: number): string => `${INBOX_PREFIX}${String(updateId).padStart(16, "0")}.json`;

export type StoreResult = { ok: true; key: string; update: TgUpdate } | { ok: false; status: 400 | 413; reason: string };

export async function storeUpdate(blobs: BlobStore, raw: string): Promise<StoreResult> {
  if (raw.length > MAX_UPDATE_BYTES) return { ok: false, status: 413, reason: "update too large" };
  let update: TgUpdate;
  try {
    update = JSON.parse(raw) as TgUpdate;
  } catch {
    return { ok: false, status: 400, reason: "invalid json" };
  }
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return { ok: false, status: 400, reason: "missing update_id" };
  }
  const key = inboxKey(update.update_id);
  const bytes = new TextEncoder().encode(raw);
  await blobs.put(key, bytes, { contentType: "application/json", size: bytes.byteLength });
  return { ok: true, key, update };
}

export async function readUpdate(blobs: BlobStore, key: string): Promise<TgUpdate | null> {
  const obj = await blobs.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await new Response(obj.body).text()) as TgUpdate;
  } catch {
    return null;
  }
}

export const listInbox = (blobs: BlobStore): Promise<string[]> => blobs.list(INBOX_PREFIX);
