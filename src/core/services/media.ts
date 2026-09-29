// 从 Telegram 下载文件，流式写入对象存储
import type { Deps } from "../ports";
import { TelegramError, type TelegramClient } from "../telegram/client";
import type { FileRef, MediaRef } from "../telegram/normalize";

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
    // 标记失败而不是抛错：抛错会让 Telegram 反复重试，堵住后面的更新
    console.error("media transfer failed", ref.fileUniqueId, e);
    return { status: "failed", blobKey: null, thumbKey, mime: ref.mime ?? null, size: ref.size ?? null };
  }
}
