# Thought Worker · 技术方案 & PRD（v0.3，已实现）

> 一句话：在 Telegram Channel 里发碎碎念，Bot 通过 Webhook 把内容（文字 / 图片 / 视频）同步进 Cloudflare，再由一个简约的网页渲染出来。

---

## 1. 产品需求（PRD）

### 1.1 目标用户与场景

- 只有一个作者（我），读者是任何访客：**站点完全公开**，频道里发的内容全部展示，不做隐藏 / 登录。
- 发布入口 **只有 Telegram**：手机上随手发，零额外操作。
- 网页只负责「读」：时间线浏览、按标签筛选、搜索、看图 / 看视频。

### 1.2 功能范围

| 优先级 | 功能 | 说明 |
| --- | --- | --- |
| P0 | Webhook 接收频道消息 | 文字、单图、多图相册、视频、GIF |
| P0 | 媒体转存 | 从 Telegram 下载，存进 R2，网页不依赖 Telegram |
| P0 | 时间线页 | 倒序、按天分组、游标分页（无限滚动） |
| P0 | 富文本还原 | 粗体 / 斜体 / 链接 / 代码 / 引用 / 剧透 等 Telegram entities |
| P0 | 编辑同步 | 频道里编辑消息，网页同步更新 |
| P1 | 标签 | `#标签` 自动提取，侧栏标签云 + 点击筛选 |
| P1 | 搜索 | D1 FTS5 全文检索 |
| P1 | 单条详情页 | `/p/:id`，可分享，带 OG 预览图 |
| P1 | 删除 | Bot API 收不到删除事件 → 在频道里回复 `/del`（见 §4.4） |
| P1 | 转发来源 | 转发的消息正常展示，并标注「转发自 xxx」（见 §4.7） |
| P1 | 链接预览卡片 | 纯文字帖里的链接抓取标题 / 描述 / 配图，渲染成卡片（见 §4.8） |
| P1 | 活跃热力图 | 类似 GitHub 贡献图，看每天发了多少；点格子按天筛选 |
| P1 | 日期筛选 | 日历选单日 / 区间，快捷「今天 / 近 7 天 / 近 30 天」，可与标签、搜索叠加 |
| P1 | 固定时区 | 按天分组、「今天 / 昨天」、日期筛选统一按 **Asia/Shanghai** 计算（见 §4.9） |
| P1 | 深色模式 | 跟随系统 |
| P2 | RSS | `/rss.xml` |

### 1.3 非目标

- 不做网页端发布 / 编辑器（Telegram 就是编辑器）。
- 不做评论、点赞、多用户。
- 不做私密条目 / 登录（站点完全公开）。
- 不导入 Bot 接入之前的频道历史，从接入之后开始记录。

---

## 2. 整体架构

```
 ┌──────────────┐  channel_post / edited_channel_post
 │ Telegram     │ ─────────────────────────────────┐
 │ Channel + Bot│                                  │ HTTPS Webhook
 └──────────────┘                                  ▼   (X-Telegram-Bot-Api-Secret-Token)
                                   ┌────────────────────────────────┐
                                   │ Cloudflare Worker (Hono)       │
                                   │                                │
                                   │  POST /tg/webhook  入库+转存    │
                                   │  GET  /api/posts   JSON 接口    │
                                   │  GET  /m/:key      R2 媒体代理  │
                                   │  GET  /  /p/:id  /rss.xml  SSR  │
                                   │  static assets (css/js)        │
                                   └──────┬──────────────┬──────────┘
                                          │              │
                                   ┌──────▼─────┐  ┌─────▼──────┐
                                   │ D1 (SQLite)│  │ R2 (对象)   │
                                   │ 帖子/媒体元 │  │ 图片/视频   │
                                   └────────────┘  └────────────┘
```

**只部署一个 Worker**，同时承担 Webhook、API、媒体代理和页面渲染，运维最省事。

### 2.1 选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 运行时 | Cloudflare Workers | 免费 10 万请求 / 天，个人站绰绰有余 |
| 路由框架 | Hono | 轻、原生支持 Workers、自带 JSX 可做 SSR |
| 数据库 | D1 | SQLite，免费 5GB，支持 FTS5 全文检索 |
| 媒体存储 | R2 | 免费 10GB 存储、**出站流量免费** |
| 前端 | Hono JSX 服务端渲染 + 少量原生 JS | 首屏快、利于 SEO/分享；交互（灯箱、无限滚动、主题）用几百行原生 JS |
| 缓存 | Workers Cache | 页面按「静态页」缓存，发帖时按标签清除（见 §2.3） |
| 静态资源 | Workers Static Assets | 和 Worker 同一次部署 |
| 部署 | Wrangler + GitHub Actions | `wrangler deploy` |

> 备选：如果后面前端交互变复杂，可以把前端换成 Astro（仍部署在 Workers），API 不变。

### 2.2 免费额度评估

| 资源 | 免费额度 | 预估用量（每天发 20 条、1k PV） |
| --- | --- | --- |
| Workers 请求 | 100k / 天 | 页面 + 媒体请求 ~ 16k（Workers Cache 命中也计入请求数，但不耗 CPU、不查 D1；静态资源不计入） |
| Workers CPU | 10ms / 请求 | 渲染 + 查询约 2~5ms；下载转存主要是 I/O 等待，不计 CPU |
| D1 | 5GB、500 万行读 / 天 | 远低于 |
| R2 存储 | 10GB | 主要瓶颈，视频多了要注意（见 §4.6） |
| R2 A 类 / B 类操作 | 100 万 / 1000 万 每月 | 远低于 |

⚠️ R2 需要在 Cloudflare 账户绑定支付方式才能开通（免费额度内不扣费）。

**请求数是第一个会碰到的上限**，主要被图片视频吃掉：

| 阶段 | 一次访问消耗的 Worker 请求 | 每天可承载 |
| --- | --- | --- |
| 现在：媒体经 Worker 转发（`MEDIA_BASE=/m`） | 1 页面 + 首屏约 15 张图 ≈ 16 | ≈ 6000 次访问 |
| 域名迁入后：媒体由 R2 自定义域名直出 | 1~2（页面 / 接口） | ≈ 5 万次访问以上 |

- 回访者的浏览器缓存会让实际消耗更低；按 1k 次访问 / 天只用到约 16%。
- 超出免费额度不会扣费：当天剩余请求返回错误 1027，次日自动恢复。
- CPU 不是瓶颈；存储（10GB）取决于视频数量。

### 2.2.1 访问速度

- **无冷启动**：Worker 启动只要几毫秒；缓存命中时直接从最近的节点返回，海外首字节通常几十毫秒。
- **D1 就近放**：创建时指定 `--location apac`（亚太），未命中缓存时查询延迟更低。
- **图片按尺寸取**：Telegram 会给每张图生成多个尺寸，转存时同时存中等尺寸（约 800px）做缩略图，时间线用缩略图，灯箱再加载原图。
- ⚠️ **中国大陆**：`*.workers.dev`（以及 `*.r2.dev`）在大陆基本无法直接访问；绑定自定义域名后可以访问，但 Cloudflare 免费版在大陆没有节点，会绕行香港 / 美西，延迟约 150~300ms+，随运营商和时段波动。真正的大陆加速需要 ICP 备案 + 国内 CDN，不在免费范围内。**所以域名迁入 Cloudflare 的优先级要提前。**

### 2.3 渲染方式：动态渲染 + 缓存，不做静态生成

页面由 Worker 在请求时查 D1、渲染 HTML，但通过缓存让访客拿到的效果和静态页一样。**不做「每发一条就重新生成整站静态文件」**，原因：

- **发布慢**：静态生成要跑一次构建 + 部署，几十秒到几分钟后才能看到新帖；Pages 免费每月 500 次构建，一天发 20 条就超了。
- **省不掉后端**：搜索、标签、日期筛选、无限滚动本来就要查接口，Worker + D1 无论如何都在。
- **页面本来就一样**：时区固定为上海后，所有访客看到的 HTML 完全相同，天然适合缓存。

缓存策略（Workers Cache，`wrangler.toml` 里 `[cache] enabled = true`）：

| 内容 | 缓存 | 失效 |
| --- | --- | --- |
| 页面 HTML、`/api/*`、`/rss.xml` | `Cache-Control: public, max-age=86400`，并带 `Cache-Tag: content` | 收到新帖 / 编辑 / `/del` 后，webhook 里调用 `ctx.cache.purge({ tags: ["content"] })` |
| 媒体 `/m/:key` | `max-age=31536000, immutable` | 永不失效（key 按文件内容唯一） |
| css / js | Workers Static Assets，文件名带 hash | 随部署更新 |

效果：平时访问全部命中缓存，不执行 Worker 代码、不查 D1；发帖后第一个访客触发一次渲染，之后又回到缓存。

> Workers Cache 是比较新的能力，M1 阶段先验证它在免费套餐 + `workers.dev` 上的表现；如果不符合预期，退回到「HTML 缓存 60 秒」的短 TTL 方案，按当前访问量不缓存也在免费额度内。

### 2.4 可移植性：核心与平台解耦

后续可能迁到自己的服务器，所以业务代码不直接依赖 Cloudflare API：

```
src/core/            只用标准 Web API（fetch / Streams / Web Crypto / Intl）+ Hono
  ports.ts           平台接口：Database（SQLite 方言）/ BlobStore / ResponseCache / BackgroundTasks
src/adapters/
  cloudflare/        D1 · R2 · Workers Cache · ctx.waitUntil
  node/              node:sqlite · 本地磁盘 · 进程内响应缓存 · 游离 Promise
```

| 接口 | Cloudflare | 自建服务器（Node） |
| --- | --- | --- |
| `Database` | D1 | `node:sqlite`（内置，无原生依赖），迁移记录表与 wrangler 的 `d1_migrations` 一致 |
| `BlobStore` | R2（`FixedLengthStream` 流式写入） | 本地磁盘（以后可加 S3 / MinIO 实现） |
| `ResponseCache` | Workers Cache 按 `Cache-Tag` 清除 | 进程内缓存，语义相同；前面有 nginx / CDN 时可按同样的响应头缓存 |
| `BackgroundTasks` | `ctx.waitUntil` | 不 await 的 Promise |

- 平台特有能力都有通用替代：链接预览不用 `HTMLRewriter`，改用 `fetch` + 正则解析 meta；图片尺寸从文件头读取，不依赖图片库。
- 两个适配器跑同一套端到端测试（Node 适配器 + 假 Telegram API），并用 `wrangler dev` 验证过 Workers 运行时。
- 数据可以直接搬：D1 导出的就是 SQLite 文件，R2 里的对象按 key 平铺，拷到 `data/media/` 即可。

---

## 3. Telegram 侧

### 3.1 配置步骤

1. `@BotFather` 创建 Bot，拿到 `BOT_TOKEN`。
2. 把 Bot 加入频道并设为 **管理员**（只有管理员才能收到 `channel_post`）。权限只开 **删除消息**（`/del` 用来清理指令和原消息），其余全关。
3. 设置 Webhook：
   ```bash
   curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
     -d url=https://<domain>/tg/webhook \
     -d secret_token=$WEBHOOK_SECRET \
     -d 'allowed_updates=["channel_post","edited_channel_post"]'
   ```
4. Worker 里配置 `CHANNEL_ID`（形如 `-100xxxxxxxxxx`），只处理来自这个频道的更新；配置 `CHANNEL_USERNAME`（公开频道的 @用户名），用于生成 `t.me/<username>/<message_id>` 回链。
5. 域名迁到 Cloudflare 后，需要用新域名重新调用一次 `setWebhook`（见 §4.5）。

### 3.2 需要处理的更新

| Update | 处理 |
| --- | --- |
| `channel_post` | 新建（或合并进相册）；若是回复某条消息的 `/del`，走删除流程 |
| `edited_channel_post` | 更新文字 / entities；若媒体被替换则重新转存 |

### 3.3 消息类型映射

| Telegram 字段 | 我们的 `kind` | 备注 |
| --- | --- | --- |
| `text` + `entities` | 纯文字 | |
| `photo[]` + `caption` | `photo` | 取数组最后一个（最大尺寸）；可同时存一个中等尺寸做缩略图 |
| `video` | `video` | 附带 `thumbnail`，一起转存做封面 |
| `animation` | `gif` | Telegram 的 GIF 实际是 mp4，前端 `<video autoplay loop muted>` |
| `document`（图片类 mime） | `photo` | 用户用「文件」发原图时 |
| `media_group_id` | 相册 | 多条消息合并为一条帖子（见 §4.2） |
| `forward_origin` | — | 转发来源，存进 `posts.forward`（见 §4.7） |
| `link_preview_options` | — | 链接预览开关 / 指定 URL / 大小图偏好（见 §4.8） |
| 其他（贴纸、投票、语音…） | 忽略 / 以占位显示 | |

---

## 4. 关键设计

### 4.1 Webhook 处理流程

```
POST /tg/webhook
 ├─ 校验 header X-Telegram-Bot-Api-Secret-Token == WEBHOOK_SECRET  否则 401
 ├─ 校验 chat.id == CHANNEL_ID                                   否则 200 忽略
 ├─ 解析消息 → 归一化为 { groupKey, messageId, text, entities, media[] }
 ├─ D1 upsert post / message（幂等：以 (chat_id, message_id) 为唯一键）
 ├─ 对每个 media：getFile → 流式 fetch → R2.put（key 用 file_unique_id，天然去重）
 ├─ 更新 media.status = ready
 └─ 返回 200
```

- **同步处理，失败返回 5xx**：Telegram 会自动重试，配合幂等 upsert 不会产生重复数据。
- **例外：单个媒体下载失败只标记 `failed`，照常返回 200**。Telegram 的更新是按顺序投递的，一条消息一直失败会堵住后面所有更新；失败的媒体在这条消息下次被编辑时会重试。
- 同一个文件（`file_unique_id`）在别的帖子里转存过就直接复用。
- **流式转存**：`fetch(fileUrl).body` 直接喂给 `R2.put`，不在内存里缓冲整个视频。
- 如果后续发现处理时间过长，可以改成「先落库返回 200，再用 Cloudflare Queues 异步转存」。

### 4.2 相册（media group）合并

Telegram 发多图时，**每张图是一条独立消息、各自一次 webhook**，它们共享 `media_group_id`，caption 通常只挂在其中一张上。

- `group_key = media_group_id ? "g:" + media_group_id : "m:" + message_id`
- `posts` 以 `(chat_id, group_key)` 唯一；每次来一张图就 `INSERT ... ON CONFLICT DO NOTHING` 再查出 post_id。
- 媒体按 `message_id` 升序展示，保证顺序与 Telegram 一致。
- 帖子文字取「有 caption 的那条」；编辑某条的 caption 时更新帖子文字。
- D1 写入是串行的，并发的几个 webhook 不会出现竞争写坏。

### 4.3 富文本渲染

- Telegram 用 `entities`（offset / length，单位是 **UTF-16 code unit**）描述格式。JS 字符串本身就是 UTF-16，直接 `slice` 即可，emoji 不会错位。
- 入库时同时存 `text`、`entities_json`，并预渲染一份 `html`（安全转义后拼标签），页面直接用 `html`，渲染器升级后可以离线重算。
- 支持：bold / italic / underline / strikethrough / code / pre / text_link / url / blockquote / spoiler / hashtag。
- `hashtag` 实体同时写入 `post_tags` 表。

### 4.4 删除（Bot API 的限制）

Bot API **不会推送「消息被删除」事件**，所以频道里删了网页不会知道。**已定方案：在频道里回复 `/del`。**

```
channel_post: text 以 bot_command "/del" 开头 且 带 reply_to_message
 ├─ messages 表按 (chat_id, reply_to_message.message_id) 找到 post
 ├─ posts.deleted = 1（软删；相册里回复任意一张都删整条帖子）
 ├─ deleteMessage(/del 这条)            —— 频道里不留指令痕迹
 └─ deleteMessage(被回复的原消息 / 整个相册) —— 尽力而为，失败就忽略
```

- 一次操作同时删掉网页和频道里的内容，不用再去频道手动删。
- `/del` 没有回复任何消息时直接忽略（同样删掉指令）。
- 软删不删 R2 文件，误删可以在数据库里改回来；以后可以加一个定时任务清理软删超过 30 天的媒体。

### 4.5 媒体访问

- Bot 的文件下载链接里带着 `BOT_TOKEN`，**绝不能直接给前端**，所以必须转存。
- Telegram 的文件链接还只保证至少 1 小时有效；公开频道网页版里的 `telesco.pe` 图片地址也会变，都不能当「源地址」用。
- **数据库只存 R2 key，不存完整 URL**；接口和页面输出时用配置项 `MEDIA_BASE` 拼出地址，切换媒体域名不需要迁移数据：

| 阶段 | `MEDIA_BASE` | 说明 |
| --- | --- | --- |
| 现在（默认） | `/m` | Worker 从 R2 读取并返回，`Cache-Control: public, max-age=31536000, immutable`，由 Workers Cache 缓存（§2.3）；支持 `Range`，视频可拖动进度条 |
| 备选 | `https://pub-xxx.r2.dev` | R2 公开地址，不占 Worker 请求；但官方限速、不建议生产使用、无 CDN 缓存 |
| 域名迁入后（最终） | `https://media.<域名>` | R2 绑定自定义域名直出，走 Cloudflare CDN 缓存，不占 Worker 请求 |

**域名计划**：现有域名不在 Cloudflare，分两步走：

1. **现在**：直接用 `thought-worker.<账号>.workers.dev`，页面、API、媒体、Webhook 全在这个地址上。
2. **把域名迁到 Cloudflare 后**（在注册商处把 NS 改成 Cloudflare 给的两个）：
   - 给 Worker 绑定自定义域名（如 `note.example.com`），用新域名重新 `setWebhook`；
   - 给 R2 绑定 `media.example.com`，把 `MEDIA_BASE` 改成它，媒体不再占 Worker 请求数；
   - 旧的 `workers.dev` 地址 301 跳到新域名。

> Workers 自定义域名要求域名的 DNS 托管在 Cloudflare；只加一条 CNAME 指过去的方式需要付费套餐，所以迁移 NS 是必要的。

### 4.6 已知限制：20MB

云端 Bot API 的 `getFile` **只能下载 ≤ 20MB 的文件**。超过的视频：

- MVP：记录元数据 + 转存封面，网页上显示封面 + 「在 Telegram 中观看」链接（频道是公开的，回链可用）。
- 进阶：自建 Local Bot API Server（需要一台 VPS，不在 Cloudflare 免费范围内），或者发视频前在手机上压缩。

### 4.7 转发消息

转发的消息正常展示，内容上方加一行「↪ 转发自 xxx」。来源从 `forward_origin` 取，存成 JSON 放在 `posts.forward`：

| `forward_origin.type` | 显示名 | 链接 |
| --- | --- | --- |
| `channel` | `chat.title` | 有 `chat.username` 时 → `t.me/<username>/<message_id>` |
| `chat` | `sender_chat.title` | 有 username 时 → `t.me/<username>` |
| `user` | `sender_user` 的名字 | 有 username 时 → `t.me/<username>` |
| `hidden_user` | `sender_user_name` | 无 |

转发的相册每条消息都带 `forward_origin`，取第一条的即可。

### 4.8 链接预览卡片

Telegram 只告诉 Bot 预览的开关和偏好（`link_preview_options`），**不给卡片内容**，所以需要 Worker 自己抓取。

- **触发条件**：纯文字帖（带图片视频的帖子不出卡片，和 Telegram 一致）、含链接、且 `link_preview_options.is_disabled` 不为 true。
- **取哪个链接**：`link_preview_options.url` 优先，否则取第一个 `url` / `text_link` entity。
- **抓取**：作为后台任务（Workers 上是 `ctx.waitUntil`）异步做，不阻塞 webhook 返回；超时 5 秒，只读 HTML 前 512KB，按 `Content-Type` / `<meta charset>` 解码，用正则解析 `og:*` / `twitter:*` / `<title>` / `description`（不用 Workers 专有的 `HTMLRewriter`，保持可移植）。
- **配图**：`og:image` 转存到 R2（上限 5MB），避免外链图片失效或防盗链。
- **样式**：宽图（宽高比 ≥ 1.5）用大图卡片，否则小缩略图卡片；尊重 `prefer_small_media` / `prefer_large_media` / `show_above_text`。
- **失败**：不显示卡片，链接照常是可点的文字；编辑消息导致链接变化时重新抓取。

### 4.9 时区：固定 Asia/Shanghai

数据库只存 UTC 时间戳；「哪一天」「今天 / 昨天」「HH:mm」、热力图、日期筛选统一按 `SITE_TZ = "Asia/Shanghai"`（`wrangler.toml` 的 vars）计算，所有访客看到的日期一致。

- **格式化**：服务端用 `Intl.DateTimeFormat("zh-CN", { timeZone: SITE_TZ })` 渲染；前端 JS（无限滚动追加的内容）用同样的参数，不用浏览器本地时区。
- **按天换算**：上海没有夏令时，固定 UTC+8，`YYYY-MM-DD` 转 UTC 区间就是 `[当天 00:00 − 8h, 次日 00:00 − 8h)`；热力图直接在 SQL 里 `date(created_at + 8*3600, 'unixepoch')` 分组。
- **「今天 / 昨天」**：跟着缓存走会过期（缓存里的「今天」过了零点就不对），所以这类相对日期交给前端 JS 按 `SITE_TZ` 计算后替换，HTML 里只输出绝对日期。

---

## 5. 数据模型

完整建表语句见 [`migrations/0001_init.sql`](../migrations/0001_init.sql)（SQLite 方言，D1 和 `node:sqlite` 通用）。

| 表 | 作用 | 要点 |
| --- | --- | --- |
| `posts` | 帖子 | `(chat_id, group_key)` 唯一；`tg_message_id` 取帖子最早一条消息，用于 t.me 回链；`text_message_id` 记录文字来自相册的哪一条；`forward` 存转发来源 JSON；软删 `deleted` |
| `messages` | TG 消息 → 帖子 | 编辑、`/del` 都按 `(chat_id, message_id)` 找回帖子 |
| `media` | 图片 / 视频 / GIF | `blob_key` 存对象存储 key（不存 URL，输出时按 `MEDIA_BASE` 拼）；`thumb_key` 图片为中等尺寸、视频为封面；`status` = ready / too_large / failed |
| `post_tags` | 标签 | 来自 `hashtag` 实体 |
| `link_previews` | 链接卡片 | 一条帖子最多一张；`layout` = large / small |
| `posts_fts` | 全文检索 | FTS5 trigram，触发器同步；少于 3 个字的关键词回退 `LIKE` |

- 对象 key：`photo|video|gif/<file_unique_id>.<ext>`、`thumb/<file_unique_id>.jpg`、`link/<url 的 sha256 前 32 位>.<ext>`。
- 存 `width/height` 是为了前端提前占位，避免图片加载时页面跳动。

---

## 6. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/tg/webhook` | Telegram 回调 |
| GET | `/api/posts?cursor=&tag=&q=&from=&to=&limit=20` | 时间线，游标 = `created_at:id`；`from`/`to` 为 `YYYY-MM-DD`（含两端，按上海时区） |
| GET | `/api/posts/:id` | 单条 |
| GET | `/api/tags` | 标签及计数 |
| GET | `/api/stats` | 条数 / 天数 / 媒体数 |
| GET | `/api/stats/heatmap?from=&to=` | 每日条数（上海时区；热力图 + 日历小圆点共用） |
| GET | `/m/:key` | 媒体（R2 代理 + 边缘缓存 + Range） |
| GET | `/?tag=&q=&from=&to=`、`/p/:id` | 服务端渲染页面（走缓存）；`/tag/:tag` 301 到 `/?tag=` |
| GET | `/fragments/timeline?…&cursor=` | 前端筛选 / 无限滚动用的 HTML 片段（JSON 包装），帖子模板只维护服务端一份 |
| GET | `/rss.xml` | RSS |

`/api/posts` 返回示例：

```json
{
  "items": [{
    "id": 128,
    "html": "今天把博客迁到 Cloudflare 了 <a href=\"/tag/折腾\">#折腾</a>",
    "created_at": 1759132800,
    "edited": false,
    "tags": ["折腾"],
    "media": [
      { "kind": "photo", "url": "/m/AQAD...jpg", "thumb": "/m/AQAD...m.jpg", "w": 1280, "h": 960 },
      { "kind": "video", "url": "/m/BAAD...mp4", "poster": "/m/AAMC...jpg", "w": 720, "h": 1280, "duration": 12 }
    ],
    "forward": { "type": "channel", "name": "某个频道", "url": "https://t.me/somechannel/88" },
    "link_preview": null,
    "tg_link": "https://t.me/xxx/345"
  }],
  "next_cursor": "1759132800:128"
}
```

---

## 7. 前端设计

UI Demo：`demo/index.html`（纯静态，直接浏览器打开）。

- **风格**：暖白纸感底色 + 单栏阅读宽度（~620px），大量留白，衬线字体只用于日期，正文用系统字体；深色模式自动切换。
- **布局**：桌面端左侧窄栏（头像、简介、热力图、标签），右侧时间线；移动端侧栏折叠到顶部。
- **时间线**：按天分组，日期作为粘性小标题；每条只显示时间（HH:mm），不加卡片边框，用细分隔线区分，读起来像日记。
- **九宫格**：1 张按原比例（限高）；2 张并排；3 张一大两小；4 张 2×2；5~9 张 3 列网格。点击进入灯箱，支持左右切换、键盘 / 滑动。
- **视频**：显示封面 + 时长角标，点击原地播放；GIF 静音自动循环。
- **日期筛选**：工具栏日历按钮弹出月历，有内容的日子标小圆点；点一下选单日，再点一下成区间；桌面端也可直接点热力图格子。筛选条件以 chip 形式显示，可单独清除，并同步到 URL（`?from=&to=`）便于分享。
- **转发**：内容上方一行浅色「↪ 转发自 xxx」，有链接时可点击。
- **链接卡片**：大图卡片（封面 1.91:1 + 站点 / 标题 / 描述）和小图卡片（右侧 88px 缩略图）两种，整张可点。
- **交互**：标签筛选、搜索、无限滚动、复制单条链接。

### 7.1 响应式与移动端

断点：`> 900px` 桌面双栏；`761–900px` 平板（侧栏收窄到 200px）；`≤ 760px` 移动端单栏。

| 模块 | 移动端处理 |
| --- | --- |
| 简介区 | 头像 + 名字 + 简介横排，统计压成一行；热力图隐藏（由日历小圆点替代） |
| 标签 | 单行横向滑动，两端渐隐提示可滑 |
| 工具栏 | 搜索 + 日历 + 主题 + 当前筛选条件整体 **吸顶**，毛玻璃背景，滚动后出现底部分隔线 |
| 日期标题 | 吸顶在工具栏下方（偏移量由 JS 按工具栏实际高度写入 `--stick`） |
| 日历 | 变为 **底部抽屉**：遮罩、44px+ 点击区域、下滑关闭、打开时锁定页面滚动 |
| 媒体 | 撑满内容宽度，单图限高 70vh；视频播放按钮加大 |
| 灯箱 | 全宽显示；左右滑切换，**下滑跟手关闭** |
| 操作栏 | 触屏设备常显（桌面端 hover 才显示），点击区域加大 |
| 其他 | 回到顶部按钮；`viewport-fit=cover` + `safe-area-inset` 适配刘海 / Home 条；搜索框字号 16px 防 iOS 聚焦放大；hover 动效只在 `(hover: hover)` 设备生效；`theme-color` 跟随深浅色 |


---

## 8. 目录结构

```
thought-worker/
├─ docs/DESIGN.md
├─ demo/index.html                 # UI 原型
├─ migrations/0001_init.sql        # D1 / node:sqlite 通用
├─ public/assets/                  # app.css / app.js / favicon（无构建步骤）
├─ scripts/set-webhook.ts          # 设置 / 查看 / 删除 webhook
├─ src/
│  ├─ core/                        # 与平台无关
│  │  ├─ ports.ts  config.ts
│  │  ├─ lib/                      # time（时区）· html · range · image-size
│  │  ├─ telegram/                 # types · client · normalize · entities · forward
│  │  ├─ services/                 # ingest（入库 / /del）· media · link-preview · link-meta · timeline（查询）
│  │  └─ http/                     # app · cache · routes/{webhook,api,media,pages} · views/*.tsx（Hono JSX）
│  └─ adapters/
│     ├─ cloudflare/               # index（Worker 入口）· d1 · r2
│     └─ node/                     # main（入口）· index · sqlite（含迁移）· fs-store · memory-cache
├─ test/                           # vitest：单元 + 端到端（假 Telegram API）
├─ wrangler.toml  Dockerfile  .env.example  .dev.vars.example
```

---

## 9. 里程碑

| 里程碑 | 状态 |
| --- | --- |
| M1 管道打通：Worker + D1 + R2 + Webhook | ✅ 已实现，`wrangler dev` 本地验证 |
| M2 消息完善：相册、视频 / GIF、封面、20MB 降级、编辑、`/del`、转发 | ✅ 已实现，端到端测试覆盖 |
| M3 前端：服务端渲染、灯箱、无限滚动、深色模式、缓存与清除 | ✅ 已实现，浏览器自动化验证 |
| M4 增强：标签、搜索、热力图、日期筛选、链接卡片、RSS、OG | ✅ 已实现 |
| M5 域名：迁入 Cloudflare、自定义域名、R2 媒体域名 | ⏳ 待域名迁移 |

Docker 镜像已在本机（OrbStack）构建并跑通入库、媒体、重启持久化。尚未在真实环境验证：真实 Bot 推送、线上 Cloudflare 部署、Workers Cache 的标签清除（本地 `wrangler dev` 不模拟）。

---

## 10. 决策记录

| 问题 | 结论 | 影响 |
| --- | --- | --- |
| 站点可见性 | 完全公开 | 不做 `#private` / 登录，`posts` 去掉 `visibility` |
| 频道类型 | 公开频道 | 可生成 `t.me` 回链；>20MB 视频跳 Telegram 观看 |
| 删除方案 | 回复 `/del` | Bot 需要「删除消息」权限，见 §4.4 |
| 域名 | 现有域名不在 Cloudflare，后续迁入 | 先用 `workers.dev`，迁入后绑定，见 §4.5 / M5 |
| 历史导入 | 不需要 | 去掉导入脚本 |
| 转发消息 | 展示并标注来源 | 见 §4.7 |
| 链接预览 | 要 | 见 §4.8 |
| 时区 | 固定 Asia/Shanghai | 所有访客日期一致，页面可整页缓存，见 §4.9 |
| 媒体地址 | 存 R2 key，按 `MEDIA_BASE` 拼 URL；现在 `/m`，域名迁入后切到 R2 自定义域名 | 见 §4.5 |
| 渲染方式 | 动态渲染 + Workers Cache，不做静态生成 | 发帖即时生效，见 §2.3 |
