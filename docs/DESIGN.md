# Thought Worker · 技术方案 & PRD（v0.4，静态站点）

> 一句话：在 Telegram Channel 里发碎碎念，Bot 通过 Webhook 把消息存进收件箱，每天定时构建一次静态网站。

---

## 1. 产品需求（PRD）

### 1.1 目标用户与场景

- 只有一个作者（我），读者是任何访客：**站点完全公开**，频道里发的内容全部展示，不做隐藏 / 登录。
- 发布入口 **只有 Telegram**：手机上随手发，零额外操作。
- 网页只负责「读」：时间线浏览、按标签筛选、搜索、看图 / 看视频。

### 1.2 功能范围

| 优先级 | 功能 | 说明 |
| --- | --- | --- |
| P0 | Webhook 接收频道消息 | 文字、单图、多图相册、视频、GIF；接收端只存原始消息 |
| P0 | 媒体转存 | 从 Telegram 下载，存进 R2，网页不依赖 Telegram |
| P0 | 时间线页 | 倒序、按天分组、无限滚动 |
| P0 | 富文本还原 | 粗体 / 斜体 / 链接 / 代码 / 引用 / 剧透 等 Telegram entities |
| P0 | 编辑同步 | 频道里编辑消息，下次构建后网页更新 |
| P0 | 每日构建 | 每天定时构建一次，没有新消息不构建；可手动触发（见 §2.3） |
| P1 | 标签 | `#标签` 自动提取，侧栏标签云 + 点击筛选 |
| P1 | 搜索 | 前端在索引里做子串匹配，中文友好 |
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
- 不追求实时：发帖后最晚第二天构建时出现在网站上（需要时可以手动触发构建）。

---

## 2. 整体架构

```
 Telegram 频道 ──webhook──▶ 接收端（Worker，几十行）
                              │ 校验密钥，原样存进 R2：inbox/<update_id>.json
                              ▼
       ┌──────── R2: thought-worker-data（私有）───────┐  ┌── R2: thought-worker-media（可公开）──┐
       │ inbox/  收件箱   state/thought.db  数据库     │  │ photo/ video/ gif/ thumb/ link/        │
       │ state/build.lock  构建锁                      │  │                                        │
       └───────────────────────▲──────────────────────┘  └───────────────────▲────────────────────┘
                                             │ S3 API
 每天 04:00（GitHub Actions） ──▶ 构建端 ─────┴─────────────────────────────────────────┘
   加锁 → 取回数据库 → 重试之前失败的媒体 → 处理收件箱（入库 / 转存媒体 / /del）→ 链接预览
   → 没有变化就结束 → 渲染整站静态文件 → wrangler deploy → 核对后回写数据库、清空收件箱 → 解锁

 访客 ──▶ 静态文件（Workers Static Assets，不执行代码）；/m/* 媒体经 Worker 读 R2
```

**接收和构建分开**：

- **接收端**只做校验和存储，不解析内容、不连数据库，攻击面只有一个接口；Telegram 的推送立刻落盘，不受「未取走的更新只保留 24 小时」的限制。唯一的例外是 `/del`：立即调用 `deleteMessages` 删掉指令和被回复的消息（见 §4.4）。
- **两个桶**：媒体桶可以整体公开（绑定自定义域名直出）；收件箱、数据库、构建锁放在私有的数据桶，任何情况下都不能被外部读到。
- **构建端**每天跑一次，把积压的消息一次处理完；没有新消息就什么都不做。部署成功后才回写数据库和清空收件箱，任何一步失败，下次构建会重新处理（入库是幂等的）。
- **网站是纯静态文件**：没有服务端渲染、没有查询接口、没有缓存失效问题；筛选、搜索、分页在浏览器里基于构建生成的索引完成。

### 2.1 选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 接收端 + 托管 | Cloudflare Workers + Static Assets | 静态文件请求免费且不计次数；只有 webhook 和媒体会执行 Worker |
| 数据 | SQLite 文件（存在私有的数据桶） | 构建时下载、构建完上传；不需要 D1，自建时就是本地文件 |
| 媒体 / 收件箱 | 两个 R2 桶 | 免费 10GB、出站流量免费；构建端通过 S3 API 访问 |
| 构建 | GitHub Actions 定时任务 | 公开仓库免费；完整 Node 环境；可手动触发 |
| 渲染 | Hono JSX（构建时渲染成 HTML） | 同一套模板，不开 JS 也能看首屏和详情页 |
| 前端交互 | 原生 JS（`public/assets/app.js`） | 无构建步骤 |

### 2.2 免费额度评估

| 资源 | 免费额度 | 预估用量（每天发 20 条、1k 次访问） |
| --- | --- | --- |
| Workers 请求 | 10 万 / 天 | 页面、数据、css/js 都是静态文件，**不计**；只有媒体（`/m`）和 webhook 计入 ≈ 1.5 万 |
| R2 存储 | 10GB | 主要瓶颈，看视频多少（见 §4.6） |
| R2 操作 | A 类 100 万 / B 类 1000 万 每月 | 每天一次构建 + 媒体读取，远低于 |
| GitHub Actions | 公开仓库不限分钟 | 每天一次，几十秒 |
| Workers Static Assets | 单个版本 20000 个文件、单文件 25MB | 每条帖子一个详情页，约 2 万条后需要调整（例如详情页分目录合并） |

⚠️ R2 需要在 Cloudflare 账户绑定支付方式才能开通（免费额度内不扣费）。

- 媒体经 Worker 转发时，一次访问约 15 个请求，每天约可承载 6000 次访问；域名迁入后媒体改由 R2 自定义域名直出，就不再占 Worker 请求。
- 超出免费额度不会扣费：当天剩余的 Worker 请求返回错误 1027，次日恢复；静态页面不受影响。

### 2.2.1 访问速度

- **静态文件**：直接由 Cloudflare 边缘节点返回，不执行代码、不查数据库。
- **按需加载**：首屏帖子直接写在 HTML 里；筛选 / 翻页用的索引（`data/index.json`）和按月分块的帖子 HTML 按需加载。
- **图片按尺寸取**：Telegram 会给每张图生成多个尺寸，转存时同时存中等尺寸（约 720px 以上的一档）做缩略图，时间线用缩略图，灯箱再加载原图。
- ⚠️ **中国大陆**：`*.workers.dev`（以及 `*.r2.dev`）在大陆基本无法直接访问；绑定自定义域名后可以访问，但 Cloudflare 免费版在大陆没有节点，延迟约 150~300ms+。真正的大陆加速需要 ICP 备案 + 国内 CDN，不在免费范围内。**所以域名迁入 Cloudflare 的优先级要提前。**

### 2.3 构建时机：每天一次，有新内容才构建

| 触发 | 行为 |
| --- | --- |
| 定时（每天 04:00 上海） | 收件箱为空、也没有待重试的媒体 → 直接结束；否则构建并部署 |
| 手动（Actions 页面 Run workflow） | 强制构建，想让刚发的帖子马上出现时用 |
| 推送代码到 `main` | 强制构建（模板 / 样式改了需要重新生成） |

- 一个月最多约 30 次定时构建；部署用 `wrangler deploy` 直接上传，不占 Pages 的构建额度。
- **同一时间只跑一个构建**，三道保护：
  1. GitHub Actions 的 `concurrency` 分组；
  2. 构建锁 `state/build.lock`：用「不存在才创建」（R2 / S3 的 `If-None-Match: *`，本地磁盘的 `O_EXCL`）拿锁，锁里放随机令牌，拿到后读回核对；超过 1 小时的锁视为异常退出留下的，可以接管；
  3. 回写前核对锁令牌仍是自己的、数据库的 ETag 与下载时一致，否则放弃回写（下次构建重新处理）。
  即使存储不支持条件写入（部分 S3 兼容服务），第 3 道也能保证不会用旧库覆盖新库。
- 为什么不是「每天拉一次 getUpdates」：Telegram 未取走的更新最多保留 24 小时，每天拉一次正好卡在边界上，定时任务一延迟就会丢消息；webhook + 收件箱没有这个问题。

### 2.4 可移植性：核心与平台解耦

```
src/core/            只用标准 Web API（fetch / Streams / Web Crypto / Intl）+ Hono
  ports.ts           平台接口：Database（SQLite 方言）/ BlobStore / BackgroundTasks
  build/site.tsx     数据库 → 静态文件
src/build/           构建流程（Node）：存储选择、取回 / 回写数据库、部署
src/adapters/
  cloudflare/        接收端 Worker（R2 binding）
  node/              自建服务器（接收端 + 静态文件）· node:sqlite · 本地磁盘
  s3/                S3 兼容存储（R2 / MinIO / AWS S3）
```

| | Cloudflare | 自建服务器 |
| --- | --- | --- |
| 接收端 | Worker，两个 R2 binding（`MEDIA` / `DATA`） | Node 服务，本地磁盘 `media/` + `private/`（或 S3 两个桶） |
| 构建 | GitHub Actions，`STORAGE=r2`，`DEPLOY_COMMAND=npx wrangler deploy` | 系统 cron，`STORAGE=fs`，直接写到服务目录 |
| 托管 | Workers Static Assets | 同一个 Node 服务（或 nginx） |

- 平台特有能力都有通用替代：链接预览用 `fetch` + 正则解析 meta（不用 `HTMLRewriter`）；图片尺寸从文件头读取。
- 已验证：Node + 本地磁盘、Node + S3 兼容服务（Zenko CloudServer，校验签名）、`wrangler dev`（Workers 运行时）、Docker 镜像。
- 数据可以直接搬：数据库就是一个 SQLite 文件，对象按 key 平铺，媒体拷到 `data/media/`、收件箱和数据库拷到 `data/private/` 即可。

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
4. `site.env` 里配置 `CHANNEL_ID`（形如 `-100xxxxxxxxxx`），构建时只处理来自这个频道的更新；配置 `CHANNEL_USERNAME`（公开频道的 @用户名），用于生成 `t.me/<username>/<message_id>` 回链。
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

### 4.1 接收与构建流程

```
POST /tg/webhook（接收端）
 ├─ 校验 header X-Telegram-Bot-Api-Secret-Token == WEBHOOK_SECRET  否则 401
 ├─ 校验是合法 JSON、带 update_id、不超过 1MB                     否则 400 / 413
 └─ 原样写入 inbox/<补零的 update_id>.json，返回 200
    （update_id 单调递增，按 key 排序就是投递顺序；重复投递写同一个 key）

构建端（每天一次）
 ├─ 加锁（state/build.lock）
 ├─ 下载 state/thought.db（没有就新建）并记下 ETag，执行迁移
 ├─ 重试之前 status = failed 的媒体（最多 5 次；先于新消息，刚失败的不会在同一次构建里重复下载）
 ├─ 按顺序处理 inbox/*：校验 chat.id == CHANNEL_ID → 归一化 → 入库（幂等）
 │    ├─ 媒体：getFile → 下载 → 写入媒体桶（key 用 file_unique_id，天然去重）
 │    └─ /del：软删帖子，删除频道里的指令和整个相册
 ├─ 链接预览：这一批里有变化的纯文字帖，每个帖子按最后一次编辑抓一次（并行）
 ├─ 收件箱为空且没有重试成功 → 不渲染；若尝试过重试，仍回写数据库（记录重试次数）
 ├─ 渲染到临时目录，整体替换输出目录
 ├─ 部署（DEPLOY_COMMAND）
 ├─ 核对锁令牌和数据库 ETag
 └─ 上传数据库、删除已处理的收件箱文件、解锁
```

- **失败即重来**：部署成功前不回写任何东西；中途失败，下次构建把同一批消息重新处理一遍。
- **单个媒体下载失败**只标记 `failed`，不影响整批构建；之后每次构建自动重试（用保存的 `file_id`，它对 bot 长期有效）。
- 同一个文件（`file_unique_id`）在别的帖子里转存过就直接复用。

### 4.2 相册（media group）合并

Telegram 发多图时，**每张图是一条独立消息、各自一次 webhook**，它们共享 `media_group_id`，caption 通常只挂在其中一张上。

- `group_key = media_group_id ? "g:" + media_group_id : "m:" + message_id`
- `posts` 以 `(chat_id, group_key)` 唯一；每次来一张图就 `INSERT ... ON CONFLICT DO NOTHING` 再查出 post_id。
- 媒体按 `message_id` 升序展示，保证顺序与 Telegram 一致。
- 帖子文字取「有 caption 的那条」；编辑某条的 caption 时更新帖子文字。
- 构建时按 update_id 顺序逐条处理，相册的几条消息不会并发写入。

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
- **接收端立即删除**：bot 只能删 48 小时内的消息，等每天一次的构建可能来不及，所以接收端收到 `/del` 时马上删掉指令和被回复的那条（需要 Worker 配 `BOT_TOKEN` secret 和 `CHANNEL_ID` 变量；不配就全部留给构建）。
- 网站上的隐藏、相册里其余消息的删除仍在构建时处理；想让网站立刻更新就手动触发一次构建。

### 4.5 媒体访问

- Bot 的文件下载链接里带着 `BOT_TOKEN`，**绝不能直接给前端**，所以必须转存。
- Telegram 的文件链接还只保证至少 1 小时有效；公开频道网页版里的 `telesco.pe` 图片地址也会变，都不能当「源地址」用。
- **数据库只存 R2 key，不存完整 URL**；接口和页面输出时用配置项 `MEDIA_BASE` 拼出地址，切换媒体域名不需要迁移数据：

| 阶段 | `MEDIA_BASE` | 说明 |
| --- | --- | --- |
| 现在（默认） | `/m` | Worker 从媒体桶读取并返回，`Cache-Control: public, max-age=31536000, immutable`；支持 `Range`（超出末尾的区间截断，越界返回 416），视频可拖动进度条；只放行 `photo/ video/ gif/ thumb/ link/` |
| 备选 | `https://pub-xxx.r2.dev` | R2 公开地址，不占 Worker 请求；但官方限速、不建议生产使用、无 CDN 缓存 |
| 域名迁入后（最终） | `https://media.<域名>` | R2 绑定自定义域名直出，走 Cloudflare CDN 缓存，不占 Worker 请求 |

**域名计划**：现有域名不在 Cloudflare，分两步走：

1. **现在**：直接用 `thought-worker.<账号>.workers.dev`，页面、媒体、Webhook 全在这个地址上。
2. **把域名迁到 Cloudflare 后**（在注册商处把 NS 改成 Cloudflare 给的两个）：
   - 给 Worker 绑定自定义域名（如 `note.example.com`），用新域名重新 `setWebhook`，`site.env` 里的 `SITE_URL` 改成新域名；
   - 给**媒体桶**绑定 `media.example.com`，把 `MEDIA_BASE` 改成它，媒体不再占 Worker 请求数（数据桶永远不绑定、不公开）；
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

Telegram 只告诉 Bot 预览的开关和偏好（`link_preview_options`），**不给卡片内容**，所以构建时自己抓取。

- **触发条件**：纯文字帖（带图片视频的帖子不出卡片，和 Telegram 一致）、含链接、且 `link_preview_options.is_disabled` 不为 true。
- **取哪个链接**：`link_preview_options.url` 优先，否则取第一个 `url` / `text_link` entity。
- **抓取**：整批消息处理完之后，对有变化的纯文字帖每个抓一次（按最后一次编辑的内容，避免同一批里的旧链接覆盖新链接），各帖子之间并行；超时 5 秒，只读 HTML 前 512KB，按 `Content-Type` / `<meta charset>` 解码，用正则解析 `og:*` / `twitter:*` / `<title>` / `description`。
- **只访问公网**：网页地址和 `og:image` 地址（来自第三方网页）都要检查，拒绝 localhost、内网 / 链路本地 / 云元数据 IP、单标签主机名；重定向改为手动跟随，每一跳重新检查。自建服务器上构建时尤其重要。
- **配图**：`og:image` 转存到 R2（上限 5MB），避免外链图片失效或防盗链。
- **样式**：宽图（宽高比 ≥ 1.5）用大图卡片，否则小缩略图卡片；尊重 `prefer_small_media` / `prefer_large_media` / `show_above_text`。
- **失败**：不显示卡片，链接照常是可点的文字；编辑消息导致链接变化时重新抓取。

### 4.9 时区：固定 Asia/Shanghai

数据库只存 UTC 时间戳；「哪一天」「今天 / 昨天」「HH:mm」、热力图、日期筛选统一按 `SITE_TZ = "Asia/Shanghai"`（`site.env`）计算，所有访客看到的日期一致。

- **格式化**：构建时用 `Intl.DateTimeFormat` 加 `timeZone: SITE_TZ` 渲染时间，索引里每条帖子带上按站点时区算好的日期（`d`），前端筛选直接比较字符串。
- **「今天 / 昨天」、热力图**：静态页面构建后可能几天都不更新，这类跟「现在」有关的内容由前端按 `SITE_TZ` 实时计算，HTML 里只输出绝对日期。

---

## 5. 数据模型

数据库是一个 SQLite 文件，存放在私有数据桶的 `state/thought.db`，构建时取回、构建完回写。完整建表语句见 [`migrations/0001_init.sql`](../migrations/0001_init.sql)。

| 表 | 作用 | 要点 |
| --- | --- | --- |
| `posts` | 帖子 | `(chat_id, group_key)` 唯一；`tg_message_id` 取帖子最早一条消息，用于 t.me 回链；`text_message_id` 记录文字来自相册的哪一条；`forward` 存转发来源 JSON；软删 `deleted` |
| `messages` | TG 消息 → 帖子 | 编辑、`/del` 都按 `(chat_id, message_id)` 找回帖子 |
| `media` | 图片 / 视频 / GIF | `blob_key` 存对象存储 key（不存 URL，输出时按 `MEDIA_BASE` 拼）；`thumb_key` 图片为中等尺寸、视频为封面；`status` = ready / too_large / failed；保存 `file_id` 和 `attempts` 用于重试 |
| `post_tags` | 标签 | 来自 `hashtag` 实体 |
| `link_previews` | 链接卡片 | 一条帖子最多一张；`layout` = large / small |
| `posts_fts` | 全文检索 | FTS5 trigram，触发器同步（目前搜索在前端做，保留备用） |

- 数据桶：`inbox/<update_id>.json`（收件箱）、`state/thought.db`（数据库）、`state/build.lock`（构建锁）。
- 媒体桶：`photo|video|gif/<file_unique_id>.<ext>`、`thumb/<file_unique_id>.jpg`、`link/<url 的 sha256 前 32 位>.<ext>`。
- 只接受浏览器能直接显示、不会执行脚本的格式：图片 jpeg / png / webp / gif，视频 mp4 / webm / mov；SVG、HEIC、TIFF 等文件不当作媒体。
- 存 `width/height` 是为了前端提前占位，避免图片加载时页面跳动。

---

## 6. 接口与输出

动态接口只有两个（接收端）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/tg/webhook` | Telegram 回调，存进收件箱 |
| GET | `/m/<photo|video|gif|thumb|link>/<key>` | 媒体（`MEDIA_BASE=/m` 时），支持 `Range` / `416` / `ETag` |

其余都是构建生成的静态文件：

| 路径 | 内容 |
| --- | --- |
| `/index.html` | 首页：侧栏 + 首屏 `PAGE_SIZE` 条帖子（不开 JS 也能看） |
| `/p/<id>/` | 单条详情页，带 OG 信息，便于分享 |
| `/data/index.json` | 所有帖子的索引：`{ id, t（时间戳）, d（日期）, g（标签）, s（纯文本） }`，前端筛选 / 搜索 / 热力图 / 日历用 |
| `/data/month/YYYY-MM.json` | 该月每条帖子渲染好的 HTML（`{ id: html }`），无限滚动按需加载 |
| `/rss.xml`、`/404.html`、`/assets/*` | RSS、404 页、样式脚本 |

- 筛选条件在 URL 上（`/?tag=&q=&from=&to=`），前端读取后过滤索引，分享链接打开就是同样的结果。
- 帖子 HTML 只在服务端模板里维护一份，前端只负责按天分组插入。

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
- **交互**：标签筛选、搜索、无限滚动、复制单条链接。筛选 / 搜索都在浏览器里完成；每次追加后会检查底部是否仍在预加载范围内并继续加载；切换筛选时丢弃旧请求的结果。

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
├─ migrations/0001_init.sql
├─ public/                         # 原样复制进站点：assets/（app.css · app.js · favicon）、_headers
├─ scripts/set-webhook.ts          # 设置 / 查看 / 删除 webhook
├─ site.env                        # 站点配置（非密钥，提交到仓库）
├─ src/
│  ├─ core/                        # 与平台无关
│  │  ├─ ports.ts  config.ts
│  │  ├─ lib/                      # time（时区）· html · range · image-size · url-guard（内网地址检查）
│  │  ├─ telegram/                 # types · client · normalize · entities · forward
│  │  ├─ services/                 # inbox · ingest（入库 / /del）· media（含重试）· link-preview · link-meta · timeline
│  │  ├─ build/site.tsx            # 数据库 → 静态文件
│  │  └─ http/                     # 接收端 app · routes/{webhook,media} · views/*.tsx（Hono JSX 模板）
│  ├─ build/                       # 构建入口（Node）：main · pipeline · storage
│  └─ adapters/
│     ├─ cloudflare/               # Worker 入口 · r2
│     ├─ node/                     # 自建服务器入口 · sqlite（含迁移）· fs-store
│     └─ s3/                       # S3 兼容存储
├─ test/                           # vitest：单元 + 端到端（假 Telegram API）
├─ .github/workflows/build.yml     # 每日构建
├─ wrangler.toml  Dockerfile  .env.example  .dev.vars.example
```

---

## 9. 里程碑

| 里程碑 | 状态 |
| --- | --- |
| M1 接收端：webhook → 收件箱 | ✅ 已实现，`wrangler dev` 验证 |
| M2 构建：入库、相册、视频 / GIF、20MB 降级、编辑、`/del`、转发、媒体重试 | ✅ 已实现，端到端测试覆盖 |
| M3 静态站点：首页、详情页、索引 / 分块、灯箱、无限滚动、深色模式 | ✅ 已实现，浏览器自动化验证 |
| M4 增强：标签、搜索、热力图、日期筛选、链接卡片、RSS、OG | ✅ 已实现 |
| M5 每日构建：GitHub Actions | ✅ 已编写，待配置 Secrets 后在线上验证 |
| M6 域名：迁入 Cloudflare、自定义域名、R2 媒体域名 | ⏳ 待域名迁移 |

已验证：Node + 本地磁盘、Node + S3 兼容服务、`wrangler dev`、Docker 镜像。尚未在真实环境验证：真实 Bot 推送、线上 Cloudflare 部署、GitHub Actions 定时任务。

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
| 渲染方式 | ~~动态渲染 + Workers Cache~~ → **静态站点，每天构建一次** | 去掉服务端渲染、查询接口和缓存失效问题，见 §2 |
| 接收方式 | webhook 只存原始消息，构建时处理 | 不受 getUpdates 24 小时保留期限制，见 §2.3 |
| 数据存储 | SQLite 文件和媒体都放 R2，分两个桶 | 公开仓库只有代码；`/del` 删掉的内容不会留在 git 历史里；媒体桶可公开，数据桶永远私有 |
| `/del` 时机 | 接收端立即删频道消息，构建时隐藏帖子 | 赶在 bot 的 48 小时删除期限内 |
| Worker 语言 | 继续用 TypeScript | 和构建端共用收件箱格式、配置、媒体路由；wrangler 原生编译 TS |
