// 设置 / 查看 / 删除 Telegram webhook。
//   npm run tg:webhook -- https://thought-worker.xxx.workers.dev   设置（自动拼上 /tg/webhook）
//   npm run tg:webhook -- --info                                   查看当前状态
//   npm run tg:webhook -- --delete                                 删除
// BOT_TOKEN / WEBHOOK_SECRET 从环境变量、.dev.vars 或 .env 读取。
import { existsSync } from "node:fs";

for (const f of [".dev.vars", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

const token = process.env.BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
if (!token) {
  console.error("缺少 BOT_TOKEN（写在 .dev.vars / .env 或环境变量里）");
  process.exit(1);
}
const api = (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/+$/, "");

async function call(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${api}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  if (!data.ok) process.exit(1);
}

const arg = process.argv[2];
if (!arg || arg === "--info") {
  await call("getWebhookInfo");
} else if (arg === "--delete") {
  await call("deleteWebhook");
} else {
  if (!secret) {
    console.error("缺少 WEBHOOK_SECRET");
    process.exit(1);
  }
  const url = new URL("/tg/webhook", arg).href;
  console.log(`setWebhook → ${url}`);
  await call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["channel_post", "edited_channel_post"],
    drop_pending_updates: false,
  });
}
