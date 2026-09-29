// Webhook 更新 → 入库。幂等：同一条消息重复投递只会覆盖，不会重复。
import type { Deps, SqlStatement } from "../ports";
import { TelegramClient } from "../telegram/client";
import { extractTags, renderEntities } from "../telegram/entities";
import { normalizeMessage, type LinkPreviewPrefs, type MediaRef, type NormalizedMessage } from "../telegram/normalize";
import type { TgUpdate } from "../telegram/types";
import { nowSeconds } from "../lib/time";
import { transferMedia, type TransferResult } from "./media";

export type IngestResult =
  | { action: "ignored"; reason: string }
  /** textOnly：纯文字消息，需要（重新）生成链接预览，prefs 为这条消息的预览偏好 */
  | { action: "saved"; postId: number; textOnly: boolean; prefs?: LinkPreviewPrefs }
  | { action: "deleted"; postId: number | null };

export const tagHref = (tag: string): string => `/?tag=${encodeURIComponent(tag)}`;

export const telegramClient = (deps: Deps): TelegramClient =>
  new TelegramClient(deps.config.botToken, deps.config.telegramApiBase, deps.fetch);

export async function handleUpdate(deps: Deps, update: TgUpdate): Promise<IngestResult> {
  const msg = update.channel_post ?? update.edited_channel_post;
  if (!msg) return { action: "ignored", reason: "not a channel post" };
  if (deps.config.channelId === null || msg.chat.id !== deps.config.channelId) {
    return { action: "ignored", reason: `unexpected chat ${msg.chat.id}` };
  }

  const n = normalizeMessage(msg);
  const tg = telegramClient(deps);
  if (n.command === "del") return deletePost(deps, tg, n);
  if (!n.text && n.media.length === 0) return { action: "ignored", reason: "unsupported message type" };

  const postId = await savePost(deps, n, !!update.edited_channel_post);
  for (const ref of n.media) await saveMedia(deps, tg, postId, n.messageId, ref);
  // 链接预览不在这里抓：同一批里可能还有这条消息的编辑，由调用方在整批处理完后按最后的状态抓一次
  return { action: "saved", postId, textOnly: n.media.length === 0, prefs: n.linkPreview };
}

async function savePost(deps: Deps, n: NormalizedMessage, isEdit: boolean): Promise<number> {
  // 先查再插：直接 upsert 在命中已有帖子时也会消耗自增 id，帖子 id（出现在 /p/:id 里）会跳号
  type Row = { id: number; text_message_id: number | null };
  const find = () =>
    deps.db.first<Row>("SELECT id, text_message_id FROM posts WHERE chat_id = ? AND group_key = ?", [n.chatId, n.groupKey]);
  const post =
    (await find()) ??
    (await deps.db.first<Row>(
      `INSERT INTO posts (chat_id, group_key, tg_message_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (chat_id, group_key) DO NOTHING RETURNING id, text_message_id`,
      [n.chatId, n.groupKey, n.messageId, n.date],
    )) ??
    // 相册的几条消息并发到达时，另一条可能刚插入
    (await find());
  if (!post) throw new Error("failed to upsert post");

  const stmts: SqlStatement[] = [
    {
      sql: "INSERT INTO messages (chat_id, message_id, post_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      params: [n.chatId, n.messageId, post.id],
    },
    {
      // 相册的回链和时间取最早的那条消息
      sql: "UPDATE posts SET tg_message_id = min(tg_message_id, ?), created_at = min(created_at, ?) WHERE id = ?",
      params: [n.messageId, n.date, post.id],
    },
  ];

  // 相册里只有一条消息带 caption；其他消息的空 caption 不能把文字覆盖掉
  const ownsText = !n.isAlbum || n.text !== "" || post.text_message_id === n.messageId;
  if (ownsText) {
    const html = renderEntities(n.text, n.entities, { tagHref });
    stmts.push(
      {
        sql: "UPDATE posts SET text = ?, entities = ?, html = ?, text_message_id = ? WHERE id = ?",
        params: [n.text, n.entities.length ? JSON.stringify(n.entities) : null, html, n.messageId, post.id],
      },
      { sql: "DELETE FROM post_tags WHERE post_id = ?", params: [post.id] },
      ...extractTags(n.text, n.entities).map((tag) => ({
        sql: "INSERT INTO post_tags (post_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING",
        params: [post.id, tag],
      })),
    );
  }
  if (isEdit) {
    stmts.push({ sql: "UPDATE posts SET edited_at = ? WHERE id = ?", params: [n.editDate ?? nowSeconds(), post.id] });
  }
  if (n.forward) {
    stmts.push({
      sql: "UPDATE posts SET forward = coalesce(forward, ?) WHERE id = ?",
      params: [JSON.stringify(n.forward), post.id],
    });
  }
  await deps.db.batch(stmts);
  return post.id;
}

async function saveMedia(deps: Deps, tg: TelegramClient, postId: number, messageId: number, ref: MediaRef) {
  const existing = await deps.db.first<{ file_unique_id: string; status: string }>(
    "SELECT file_unique_id, status FROM media WHERE post_id = ? AND message_id = ?",
    [postId, messageId],
  );
  // 同一个文件已经处理过（重复投递 / 只改了文字的编辑），跳过；失败的会重试
  if (existing?.file_unique_id === ref.fileUniqueId && (existing.status === "ready" || existing.status === "too_large")) {
    return;
  }

  // 同一个文件在别的帖子里已经转存过（例如重复转发），直接复用
  const reuse = await deps.db.first<{ blob_key: string; thumb_key: string | null; mime: string | null; size: number | null }>(
    "SELECT blob_key, thumb_key, mime, size FROM media WHERE file_unique_id = ? AND status = 'ready' LIMIT 1",
    [ref.fileUniqueId],
  );
  const r: TransferResult = reuse
    ? { status: "ready", blobKey: reuse.blob_key, thumbKey: reuse.thumb_key, mime: reuse.mime, size: reuse.size }
    : await transferMedia(deps, tg, ref);

  await deps.db.run(
    `INSERT INTO media (post_id, message_id, kind, file_id, file_unique_id, thumb_file_id, thumb_unique_id,
                        blob_key, thumb_key, mime, width, height, duration, size, status, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (post_id, message_id) DO UPDATE SET
       kind = excluded.kind, file_id = excluded.file_id, file_unique_id = excluded.file_unique_id,
       thumb_file_id = excluded.thumb_file_id, thumb_unique_id = excluded.thumb_unique_id,
       blob_key = excluded.blob_key, thumb_key = excluded.thumb_key, mime = excluded.mime,
       width = excluded.width, height = excluded.height, duration = excluded.duration,
       size = excluded.size, status = excluded.status, attempts = 1`,
    [
      postId,
      messageId,
      ref.kind,
      ref.fileId,
      ref.fileUniqueId,
      ref.thumb?.fileId ?? null,
      ref.thumb?.fileUniqueId ?? null,
      r.blobKey,
      r.thumbKey,
      r.mime,
      ref.width ?? null,
      ref.height ?? null,
      ref.duration ?? null,
      r.size,
      r.status,
    ],
  );
}

/** 回复某条消息发 /del：软删对应帖子，再尽量删掉频道里的指令和原消息 */
async function deletePost(deps: Deps, tg: TelegramClient, n: NormalizedMessage): Promise<IngestResult> {
  const tryDelete = async (ids: number[]) => {
    if (!ids.length) return;
    try {
      await tg.deleteMessages(n.chatId, ids);
    } catch (e) {
      // 超过 48 小时的消息 bot 删不掉，留给作者手动删
      console.warn("deleteMessages failed", ids, e);
    }
  };

  const target = n.replyToMessageId
    ? await deps.db.first<{ post_id: number }>("SELECT post_id FROM messages WHERE chat_id = ? AND message_id = ?", [
        n.chatId,
        n.replyToMessageId,
      ])
    : null;

  if (target) await deps.db.run("UPDATE posts SET deleted = 1 WHERE id = ?", [target.post_id]);
  await tryDelete([n.messageId]);
  if (target) {
    const rows = await deps.db.all<{ message_id: number }>("SELECT message_id FROM messages WHERE post_id = ?", [target.post_id]);
    await tryDelete(rows.map((r) => r.message_id));
  }
  return { action: "deleted", postId: target?.post_id ?? null };
}
