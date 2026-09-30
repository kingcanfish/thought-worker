import { Hono } from "hono";
import { storeUpdate } from "../../services/inbox";
import { deleteCommandNow } from "../../services/instant-delete";
import type { AppEnv } from "../app";

/** 常量时间比较，避免通过响应时间猜出密钥 */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

// 只做校验和写收件箱，处理全部放到构建端；唯一的例外是 /del，要赶在 48 小时内删掉频道里的消息
export const webhookRoutes = new Hono<AppEnv>().post("/webhook", async (c) => {
  const { db, config } = c.var.deps;
  if (!config.webhookSecret) return c.text("webhook not configured", 503);
  if (!safeEqual(c.req.header("x-telegram-bot-api-secret-token") ?? "", config.webhookSecret)) {
    return c.text("unauthorized", 401);
  }
  const result = await storeUpdate(db, await c.req.text());
  if (!result.ok) return c.text(result.reason, result.status);
  await deleteCommandNow(c.var.deps, result.update);
  return c.json({ ok: true });
});
