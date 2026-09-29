import { Hono } from "hono";
import { handleUpdate } from "../../services/ingest";
import type { TgUpdate } from "../../telegram/types";
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

export const webhookRoutes = new Hono<AppEnv>().post("/webhook", async (c) => {
  const deps = c.var.deps;
  const { botToken, webhookSecret } = deps.config;
  if (!botToken || !webhookSecret) return c.text("webhook not configured", 503);
  if (!safeEqual(c.req.header("x-telegram-bot-api-secret-token") ?? "", webhookSecret)) {
    return c.text("unauthorized", 401);
  }
  const update = await c.req.json<TgUpdate>().catch(() => null);
  if (!update || typeof update !== "object") return c.text("bad request", 400);
  const result = await handleUpdate(deps, update);
  return c.json({ ok: true, ...result });
});
