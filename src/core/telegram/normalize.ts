// 把 Telegram 消息归一化成内部结构，屏蔽 text / caption、photo / video / document 等差异
import { describeForward, type ForwardInfo } from "./forward";
import type { TgEntity, TgMessage, TgPhotoSize } from "./types";

export type MediaKind = "photo" | "video" | "gif";

export interface FileRef {
  fileId: string;
  fileUniqueId: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface MediaRef extends FileRef {
  kind: MediaKind;
  mime?: string;
  fileName?: string;
  duration?: number;
  /** 图片：中等尺寸；视频 / GIF：封面 */
  thumb?: FileRef;
}

export interface LinkPreviewPrefs {
  disabled: boolean;
  url?: string;
  preferSmall: boolean;
  preferLarge: boolean;
  aboveText: boolean;
}

export interface NormalizedMessage {
  chatId: number;
  messageId: number;
  date: number;
  editDate?: number;
  /** 帖子归属：相册里的多条消息共享同一个 key */
  groupKey: string;
  isAlbum: boolean;
  text: string;
  entities: TgEntity[];
  media: MediaRef[];
  forward?: ForwardInfo;
  linkPreview?: LinkPreviewPrefs;
  replyToMessageId?: number;
  command?: "del";
}

/** 浏览器能直接显示、且不会执行脚本的格式；SVG（可含脚本）、HEIC、TIFF 等不当作图片 */
const WEB_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const WEB_VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

/** 缩略图的目标边长：选不小于它的最小一档 */
const THUMB_TARGET = 720;

export function normalizeMessage(m: TgMessage): NormalizedMessage {
  const text = m.text ?? m.caption ?? "";
  const entities = m.entities ?? m.caption_entities ?? [];
  const lp = m.link_preview_options;
  return {
    chatId: m.chat.id,
    messageId: m.message_id,
    date: m.date,
    editDate: m.edit_date,
    groupKey: m.media_group_id ? `g:${m.media_group_id}` : `m:${m.message_id}`,
    isAlbum: !!m.media_group_id,
    text,
    entities,
    media: extractMedia(m),
    forward: m.forward_origin ? describeForward(m.forward_origin) : undefined,
    linkPreview: lp
      ? {
          disabled: !!lp.is_disabled,
          url: lp.url,
          preferSmall: !!lp.prefer_small_media,
          preferLarge: !!lp.prefer_large_media,
          aboveText: !!lp.show_above_text,
        }
      : undefined,
    replyToMessageId: m.reply_to_message?.message_id,
    command: parseCommand(text, entities),
  };
}

function parseCommand(text: string, entities: TgEntity[]): "del" | undefined {
  const first = entities[0];
  if (!first || first.type !== "bot_command" || first.offset !== 0) return undefined;
  return /^\/del(@\w+)?$/i.test(text.slice(0, first.length)) ? "del" : undefined;
}

const fileRef = (p: TgPhotoSize | undefined): FileRef | undefined =>
  p && { fileId: p.file_id, fileUniqueId: p.file_unique_id, size: p.file_size, width: p.width, height: p.height };

function extractMedia(m: TgMessage): MediaRef[] {
  if (m.photo?.length) {
    const sizes = [...m.photo].sort((a, b) => a.width * a.height - b.width * b.height);
    const full = sizes[sizes.length - 1]!;
    const thumb = sizes.find((s) => Math.max(s.width, s.height) >= THUMB_TARGET);
    return [
      {
        kind: "photo",
        ...fileRef(full)!,
        mime: "image/jpeg",
        thumb: thumb && thumb !== full ? fileRef(thumb) : undefined,
      },
    ];
  }
  // animation 消息同时带 document 字段，必须先判断
  const video = m.animation ?? m.video;
  if (video) {
    return [
      {
        kind: m.animation ? "gif" : "video",
        fileId: video.file_id,
        fileUniqueId: video.file_unique_id,
        size: video.file_size,
        width: video.width,
        height: video.height,
        duration: video.duration,
        mime: video.mime_type ?? "video/mp4",
        fileName: video.file_name,
        thumb: fileRef(video.thumbnail),
      },
    ];
  }
  const doc = m.document;
  const mime = doc?.mime_type ?? "";
  if (doc && (WEB_IMAGE_MIMES.has(mime) || WEB_VIDEO_MIMES.has(mime))) {
    return [
      {
        kind: WEB_IMAGE_MIMES.has(mime) ? "photo" : "video",
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        size: doc.file_size,
        width: doc.thumbnail?.width,
        height: doc.thumbnail?.height,
        mime,
        fileName: doc.file_name,
        thumb: fileRef(doc.thumbnail),
      },
    ];
  }
  return [];
}
