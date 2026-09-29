# Thought Worker

在 Telegram 频道里发碎碎念（文字 / 图片 / 视频），Bot 通过 Webhook 同步到网站。

- 默认部署在 **Cloudflare 免费套餐**（Workers + D1 + R2）
- 核心代码与平台无关，同一份代码也能用 **Node / Docker 部署到自己的服务器**（SQLite + 本地磁盘）
- 设计文档：[docs/DESIGN.md](docs/DESIGN.md)；UI 原型：[demo/index.html](demo/index.html)

## 准备 Telegram

1. 找 [@BotFather](https://t.me/BotFather) 创建 Bot，拿到 `BOT_TOKEN`。
2. 把 Bot 加进频道并设为**管理员**，只开「删除消息」权限（`/del` 用）。
3. 拿到频道 ID（`-100` 开头）：往频道发一条消息，转发给 [@userinfobot](https://t.me/userinfobot) 之类的工具查看；公开频道再记下 @用户名。
4. 生成一个随机字符串作为 `WEBHOOK_SECRET`：`openssl rand -hex 32`。

## 部署到 Cloudflare

```bash
npm install
npx wrangler login

# 1. 创建 D1（亚太）和 R2，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create thought-worker --location apac
npx wrangler r2 bucket create thought-worker-media

# 2. 在 wrangler.toml 的 [vars] 里填 CHANNEL_ID / CHANNEL_USERNAME / SITE_*，然后设置密钥
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET

# 3. 建表并部署
npm run db:migrate:remote
npm run deploy

# 4. 把 webhook 指向部署地址（BOT_TOKEN / WEBHOOK_SECRET 从 .dev.vars 读取，或临时写在环境变量里）
cp .dev.vars.example .dev.vars   # 填好里面的值
npm run tg:webhook -- https://thought-worker.<你的子域>.workers.dev
npm run tg:webhook -- --info     # 确认 last_error_message 为空
```

然后在频道里发一条消息，刷新网站就能看到。

> R2 需要先在 Cloudflare 后台绑定支付方式才能开通（免费额度内不扣费）。
> `[cache]`（Workers Cache）开启后静态文件请求也计入请求数；不需要可以删掉 `wrangler.toml` 里那一段。

## 部署到自己的服务器

需要 Node ≥ 22.13（用到内置的 `node:sqlite`）。

```bash
cp .env.example .env   # 填好配置
npm install
npm run build:node
npm run start:node     # 默认 http://0.0.0.0:8787，数据在 ./data（SQLite + 媒体文件）
npm run tg:webhook -- https://你的域名
```

或者用 Docker：

```bash
docker build -t thought-worker .
docker run -d --name thought-worker --restart unless-stopped -p 8787:8787 -v thought-data:/data --env-file .env thought-worker
```

容器以 `node` 用户（uid 1000）运行。想把数据放在宿主机目录（`-v /srv/thought:/data`）的话，先 `chown 1000:1000 /srv/thought`。

前面放 nginx / Caddy 做 HTTPS（Telegram 要求 webhook 必须是 HTTPS）。自建时还可以把 `TELEGRAM_API_BASE`
指向自己部署的 [Local Bot API Server](https://github.com/tdlib/telegram-bot-api)，突破 20MB 的下载限制。

## 本地开发

```bash
npm run dev          # wrangler dev，本地模拟 D1 / R2（先 npm run db:migrate:local）
npm run dev:node     # 或用 Node 适配器
npm test             # 单元 + 端到端测试（Node 适配器 + 假 Telegram API）
npm run typecheck
```

本地没有公网地址时，Telegram 推不进来：可以用 `cloudflared tunnel --url http://localhost:8787` 临时暴露，
或者直接 `curl` 模拟一条 update（格式见 `test/helpers.ts`）。

## 配置

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `BOT_TOKEN` | Bot token（密钥） | — |
| `WEBHOOK_SECRET` | webhook 校验串（密钥） | — |
| `CHANNEL_ID` | 只接收这个频道的消息 | — |
| `CHANNEL_USERNAME` | 公开频道 @用户名（不带 @），生成 t.me 回链 | — |
| `SITE_TITLE` / `SITE_DESCRIPTION` | 站点名 / 简介 | 碎碎念 |
| `SITE_AVATAR` | 头像：图片 URL，或一个字 | 念 |
| `SITE_URL` | 对外地址（RSS / OG 用），不填取请求域名 | — |
| `SITE_TZ` | 按天分组、日期筛选用的时区 | Asia/Shanghai |
| `MEDIA_BASE` | 媒体地址前缀：`/m`（应用转发）或对象存储直出域名 | /m |
| `MAX_DOWNLOAD_BYTES` | 超过的视频只存封面 | 20MB |
| `TELEGRAM_API_BASE` | Bot API 地址 | https://api.telegram.org |
| `PAGE_SIZE` | 每页条数 | 20 |
| `PORT` / `HOST` / `DATA_DIR` | 仅 Node | 8787 / 0.0.0.0 / ./data |

## 在频道里怎么用

- 直接发文字、图片、相册、视频、GIF，支持 Telegram 自带的所有格式（粗体、链接、代码、引用、剧透……）
- `#标签` 自动成为网站上的标签
- 编辑消息，网站同步更新
- **删除**：回复要删的消息发 `/del`，网站隐藏该条，并尝试删掉频道里的原消息和这条指令（超过 48 小时的消息 bot 删不掉，需手动删）
