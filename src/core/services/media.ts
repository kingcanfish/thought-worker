// 从 Telegram 下载文件，流式写入对象存储
import type { Deps } from "../ports";
import { TelegramError, type TelegramClient } from "../telegram/client";
import type { FileRef, MediaKind, MediaRef } from "../telegram/normalize";

export type MediaStatus = "ready" | "too_large" | "failed";

export interface TransferResult {
  status: MediaStatus;
  blobKey: string | null;
  thumbKey: string | null;
  mime: string | null;
  size: number | null;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXT)
    .filter(([ext]) => ext !== "jpeg")
    .map(([ext, mime]) => [mime, ext]),
);

const extOf = (path: string): string | undefined => /\.([a-z0-9]{1,5})$/i.exec(path)?.[1]?.toLowerCase();

export const mimeForKey = (key: string): string => MIME_BY_EXT[extOf(key) ?? ""] ?? "application/octet-stream";

interface Stored {
  status: "ready" | "too_large";
  key: string | null;
  mime: string | null;
  size: number | null;
}

async function storeFile(deps: Deps, tg: TelegramClient, ref: FileRef, prefix: string, mime?: string): Promise<Stored> {
  const max = deps.config.maxDownloadBytes;
  const tooLarge: Stored = { status: "too_large", key: null, mime: mime ?? null, size: ref.size ?? null };
  if (ref.size && ref.size > max) return tooLarge;

  let file;
  try {
    file = await tg.getFile(ref.fileId);
  } catch (e) {
    if (e instanceof TelegramError && /too big/i.test(e.message)) return tooLarge;
    throw e;
  }
  if (file.file_size && file.file_size > max) return tooLarge;
  if (!file.file_path) throw new Error(`getFile returned no file_path for ${ref.fileUniqueId}`);

  const ext = extOf(file.file_path) ?? (mime && EXT_BY_MIME[mime]);
  const key = `${prefix}/${ref.fileUniqueId}${ext ? `.${ext}` : ""}`;
  const contentType = mime ?? mimeForKey(key);
  const res = await tg.download(file.file_path);
  const size = Number(res.headers.get("content-length")) || file.file_size || undefined;
  await deps.blobs.put(key, res.body!, { contentType, size });
  return { status: "ready", key, mime: contentType, size: size ?? null };
}

export async function transferMedia(deps: Deps, tg: TelegramClient, ref: MediaRef): Promise<TransferResult> {
  let thumbKey: string | null = null;
  if (ref.thumb) {
    try {
      thumbKey = (await storeFile(deps, tg, ref.thumb, "thumb", "image/jpeg")).key;
    } catch (e) {
      console.warn("thumbnail transfer failed", ref.thumb.fileUniqueId, e);
    }
  }
  try {
    const main = await storeFile(deps, tg, ref, ref.kind, ref.mime);
    return { status: main.status, blobKey: main.key, thumbKey, mime: main.mime, size: main.size ?? ref.size ?? null };
  } catch (e) {
    // 标记失败而不是抛错：一个文件出问题不影响整批构建，下次构建再重试（retryFailedMedia）
    console.error("media transfer failed", ref.fileUniqueId, e);
    return { status: "failed", blobKey: null, thumbKey, mime: ref.mime ?? null, size: ref.size ?? null };
  }
}

/** 下载失败的媒体最多尝试几次（含第一次） */
export const MAX_ATTEMPTS = 5;

/** 重试下载失败的媒体。attempted：这次尝试了几个（重试次数有变化，数据库需要回写）；fixed：成功了几个 */
export async function retryFailedMedia(deps: Deps, tg: TelegramClient): Promise<{ attempted: number; fixed: number }> {
  const rows = await deps.db.all<{
    id: number;
    kind: MediaKind;
    file_id: string;
    file_unique_id: string;
    thumb_file_id: string | null;
    thumb_unique_id: string | null;
    thumb_key: string | null;
    mime: string | null;
    size: number | null;
  }>(
    `SELECT m.id, m.kind, m.file_id, m.file_unique_id, m.thumb_file_id, m.thumb_unique_id, m.thumb_key, m.mime, m.size
     FROM media m JOIN posts p ON p.id = m.post_id
     WHERE m.status = 'failed' AND m.attempts < ? AND p.deleted = 0`,
    [MAX_ATTEMPTS],
  );
  let fixed = 0;
  for (const m of rows) {
    const ref: MediaRef = {
      kind: m.kind,
      fileId: m.file_id,
      fileUniqueId: m.file_unique_id,
      size: m.size ?? undefined,
      mime: m.mime ?? undefined,
      // 封面已经有了就不再下载
      thumb: m.thumb_file_id && m.thumb_unique_id && !m.thumb_key ? { fileId: m.thumb_file_id, fileUniqueId: m.thumb_unique_id } : undefined,
    };
    const r = await transferMedia(deps, tg, ref);
    await deps.db.run(
      `UPDATE media SET status = ?, blob_key = ?, thumb_key = coalesce(?, thumb_key), mime = coalesce(?, mime),
         size = coalesce(?, size), attempts = attempts + 1 WHERE id = ?`,
      [r.status, r.blobKey, r.thumbKey, r.mime, r.size, m.id],
    );
    if (r.status !== "failed") fixed++;
  }
  return { attempted: rows.length, fixed };
}
