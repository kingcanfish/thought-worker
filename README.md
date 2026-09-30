# Thought Worker

在 Telegram 频道里发碎碎念（文字 / 图片 / 视频），网站每天自动更新一次。

- **接收端**：一个很小的 Cloudflare Worker，收到 webhook 就把消息原样写进 D1 的收件箱（`/del` 会立即删除频道里的消息）
- **构建端**：GitHub Actions 每天定时跑一次，把新消息入库、转存图片视频（图片压缩成 WebP），生成整站静态文件并部署；没有新消息就不构建
- **网站**：纯静态文件，筛选 / 搜索 / 翻页都在浏览器里完成
- 核心代码与平台无关，同一份代码也能用 **Node / Docker 部署到自己的服务器**

设计文档：[docs/DESIGN.md](docs/DESIGN.md)；UI 原型：[demo/index.html](demo/index.html)

## 部署到 Cloudflare

### 1. 准备 Telegram

1. 找 [@BotFather](https://t.me/BotFather) 创建 Bot，拿到 `BOT_TOKEN`。
2. 把 Bot 加进频道并设为**管理员**，只开「删除消息」权限（`/del` 用）。
3. 拿到频道 ID（`-100` 开头），公开频道再记下 @用户名。
4. 生成一个随机字符串作为 `WEBHOOK_SECRET`：`openssl rand -hex 32`。

### 2. 准备 Cloudflare

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create thought-worker-media   # 图片视频，不要开公开访问
npx wrangler d1 create thought-worker                # 帖子 + 收件箱；把输出的 database_id 填进 wrangler.toml
npx wrangler d1 migrations apply thought-worker --remote
```

在 Cloudflare 后台再创建两个 token：

- **R2 API Token**（R2 → Manage API Tokens，权限 Object Read & Write，只限定 `thought-worker-media`）：得到 Access Key ID 和 Secret Access Key。
- **API Token**（My Profile → API Tokens，用「Edit Cloudflare Workers」模板，**再加一项 Account → D1 → Edit**）：给 GitHub Actions 迁移、部署、读写 D1 用。

> R2 需要先在后台绑定支付方式才能开通。Cloudflare 没有消费上限，只要桶不公开、Workers 留在免费版，R2 读取就被每天 10 万次 Worker 请求封顶（见 [DESIGN §2.2](docs/DESIGN.md)）；建议在 Billing 里设一个 $1 的预算提醒。

### 3. 填站点配置

编辑 `site.env`（不是密钥，提交到仓库）：`CHANNEL_ID`、`CHANNEL_USERNAME`、`SITE_URL`
（第一次部署前不知道地址的话，先填 `https://thought-worker.<你的子域>.workers.dev`）等。
`wrangler.toml` 的 `[vars]` 里也填上同一个 `CHANNEL_ID`（接收端处理 `/del` 用）。

### 4. 配置 GitHub Secrets

仓库 Settings → Secrets and variables → Actions，添加：

| Secret | 值 |
| --- | --- |
| `BOT_TOKEN` | Bot token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API Token |
| `CLOUDFLARE_API_TOKEN` | 部署用的 API Token（含 D1 编辑权限） |

### 5. 首次部署

1. Actions → build → **Run workflow**：生成站点并部署 Worker。
2. 给 Worker 设置 webhook 密钥，并把 webhook 指向它：

```bash
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put BOT_TOKEN   # 可选：/del 立即删除频道消息；不配就等构建时再删
cp .env.example .env              # 填 BOT_TOKEN、WEBHOOK_SECRET
npm run tg:webhook -- https://thought-worker.<你的子域>.workers.dev
npm run tg:webhook -- --info      # 确认 last_error_message 为空
```

之后在频道里发的消息，会在第二天 04:00（上海）的构建后出现在网站上。想马上看到，就在 Actions 里手动 Run workflow。

## 部署到自己的服务器

需要 Node ≥ 22.13（用到内置的 `node:sqlite`），数据都在 `DATA_DIR`：`thought.db`（帖子 + 收件箱，接收端和构建端共用）和 `media/`（图片视频）。

```bash
cp .env.example .env     # 填 BOT_TOKEN、WEBHOOK_SECRET，STORAGE=fs
npm install && npm run build:node
FORCE=1 npm run build:site:node   # 首次生成站点
npm run start:node                # 接收 webhook + 提供站点，默认 :8787
npm run tg:webhook -- https://你的域名
```

每天构建一次（crontab）。构建自带锁，同时只会有一个在跑：

```
0 4 * * * cd /srv/thought-worker && npm run build:site:node >> build.log 2>&1
```

或者用 Docker：

```bash
docker build -t thought-worker .
docker run -d --name thought-worker --restart unless-stopped -p 8787:8787 \
  -v thought-data:/data --env-file .env thought-worker
docker exec -e FORCE=1 thought-worker node dist/node/build/main.js   # 首次生成站点
# crontab：0 4 * * * docker exec thought-worker node dist/node/build/main.js
```

容器以 `node` 用户（uid 1000）运行；数据放宿主机目录（`-v /srv/thought:/data`）时先 `chown 1000:1000 /srv/thought`。
前面放 nginx / Caddy 做 HTTPS（Telegram 要求 webhook 是 HTTPS）。自建时还可以把 `TELEGRAM_API_BASE`
指向自己部署的 [Local Bot API Server](https://github.com/tdlib/telegram-bot-api)，突破 20MB 的下载限制。

## 本地开发

```bash
npm test                  # 单元 + 端到端测试（Node 适配器 + 假 Telegram API）
npm run typecheck

# 用本地磁盘跑一遍完整流程
STORAGE=fs DATA_DIR=./data npm run dev:node           # 接收端 + 站点，:8787
STORAGE=fs DATA_DIR=./data FORCE=1 npm run build:site  # 构建到 dist/site

npm run dev               # 或用 wrangler dev 在 Workers 运行时里跑（先构建出 dist/site）
```

本地没有公网地址时 Telegram 推不进来：可以用 `cloudflared tunnel --url http://localhost:8787` 临时暴露，
或者直接 `curl` 模拟一条 update（格式见 `test/helpers.ts`）。

## 配置

站点信息在 `site.env`，密钥和运行环境用环境变量（或 `.env`），同名时环境变量优先。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `BOT_TOKEN` | Bot token（构建时下载媒体、执行 `/del`） | — |
| `WEBHOOK_SECRET` | webhook 校验串（接收端） | — |
| `CHANNEL_ID` | 只处理这个频道的消息 | — |
| `CHANNEL_USERNAME` | 公开频道 @用户名（不带 @），生成 t.me 回链 | — |
| `SITE_TITLE` / `SITE_DESCRIPTION` / `SITE_AVATAR` | 站点名 / 简介 / 头像（图片 URL 或一个字） | 碎碎念 / — / 念 |
| `SITE_URL` | 站点地址，RSS 和分享卡片要用 | — |
| `SITE_TZ` | 按天分组、日期筛选用的时区 | Asia/Shanghai |
| `MEDIA_BASE` | 媒体地址前缀：`/m`（Worker 转发）或对象存储直出域名 | /m |
| `MEDIA_ALLOWED_REFERERS` | 防盗链：除本站和 `SITE_URL` 外，还允许嵌入 `/m` 媒体的站点，逗号分隔（写 host 或完整地址都行；没有 Referer 的请求和页面跳转总是放行） | — |
| `PAGE_SIZE` | 每次加载的条数 | 20 |
| `DB` | 数据库：`sqlite`（`DATA_DIR/thought.db`）/ `d1`（需要 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`D1_DATABASE_ID`） | sqlite |
| `STORAGE` | 媒体存储：`fs`（本地磁盘）/ `r2` / `s3` | fs |
| `DATA_DIR` | 数据目录（`thought.db` + `media/`） | ./data |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | `STORAGE=r2` | — |
| `R2_BUCKET` | 媒体桶 | thought-worker-media |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` | `STORAGE=s3`（MinIO / AWS S3 / Backblaze B2 …） | — |
| `SITE_DIR` | 站点输出目录 | ./dist/site |
| `FORCE` | 没有新消息也构建 | — |
| `DEPLOY_COMMAND` | 渲染后执行的部署命令，成功后才清理收件箱 | — |
| `MAX_DOWNLOAD_BYTES` | 超过的文件只存封面 | 20MB |
| `IMAGE_OPTIMIZE` | 设为 `0` 时不压缩，图片原样转存 | 压缩 |
| `IMAGE_QUALITY` / `IMAGE_MAX_SIDE` | 转存图片时转成 WebP 的质量 / 最长边（没变小就保留原图） | 80 / 2560 |
| `IMAGE_MAX_BYTES` | 压缩后单张图片的大小上限：超过就先降质量（最低 50），再缩尺寸（最小 640） | 2MB |
| `TELEGRAM_API_BASE` | Bot API 地址 | https://api.telegram.org |
| `PORT` / `HOST` | 自建服务器监听地址 | 8787 / 0.0.0.0 |

## 在频道里怎么用

- 直接发文字、图片、相册、视频、GIF，支持 Telegram 自带的所有格式（粗体、链接、代码、引用、剧透……）
- `#标签` 自动成为网站上的标签
- 编辑消息，下次构建后网站同步更新
- **删除**：回复要删的消息发 `/del`。接收端会立即删掉这条指令和被回复的消息（需要 Worker 配了 `BOT_TOKEN` 和 `CHANNEL_ID`），下次构建时网站隐藏该条、删掉相册里其余的消息。超过 48 小时的消息 bot 删不掉，需手动删
