// 收到 /del 时立即删除频道里的指令和被回复的那条消息。
// bot 只能删 48 小时内的消息，等每天一次的构建再删可能就晚了；网站上的隐藏、相册其余消息的删除仍由构建处理。
import type { ReceiverDeps } from "../ports";
import { TelegramClient } from "../telegram/client";
import { normalizeMessage } from "../telegram/normalize";
import type { TgUpdate } from "../telegram/types";

const TIMEOUT_MS = 5000;

export async function deleteCommandNow(deps: ReceiverDeps, update: TgUpdate): Promise<number[] | null> {
  const { botToken, channelId, telegramApiBase } = deps.config;
  const msg = update.channel_post;
  // 没配置 BOT_TOKEN / CHANNEL_ID 的接收端不做这一步，交给构建
  if (!msg || !botToken || channelId === null || msg.chat.id !== channelId) return null;
  const n = normalizeMessage(msg);
  if (n.command !== "del") return null;
  const ids = n.replyToMessageId ? [n.messageId, n.replyToMessageId] : [n.messageId];
  const timed: typeof fetch = (input, init) => deps.fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  try {
    await new TelegramClient(botToken, telegramApiBase, timed).deleteMessages(n.chatId, ids);
  } catch (e) {
    console.warn("instant /del failed, will retry at build", ids, e);
  }
  return ids;
}
