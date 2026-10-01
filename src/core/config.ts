export interface Config {
  botToken: string;
  webhookSecret: string;
  channelId: number | null;
  /** 公开频道的用户名（不带 @），用于生成 t.me 回链 */
  channelUsername: string | null;
  siteTitle: string;
  /** 一行的简介：meta 描述、RSS 用 */
  siteDescription: string;
  /** 侧栏简介，按行拆开（SITE_DESCRIPTION 里用双引号包住、写 \n 换行） */
  siteBio: string[];
  /** 头像：图片 URL，或用作文字头像的一个字 */
  siteAvatar: string;
  /** 站点对外地址（RSS / OG 用），不填就用请求的 origin */
  siteUrl: string | null;
  siteTz: string;
  /** 媒体地址前缀：/m（经应用转发）或 https://media.example.com（对象存储直出） */
  mediaBase: string;
  /** 除本站外，还允许哪些站点（host）引用 /m 的媒体；没有 Referer 的请求总是放行 */
  mediaReferers: string[];
  maxDownloadBytes: number;
  /** 构建端转存图片时压缩成 WebP（见 src/build/image.ts） */
  image: { optimize: boolean; quality: number; maxSide: number; maxBytes: number };
  telegramApiBase: string;
  pageSize: number;
}

type Env = Record<string, unknown>;

const str = (env: Env, key: string): string | null => {
  const v = env[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

/** 只取 host：写成 https://friend.test/ 或 friend.test 都行 */
function hostOf(entry: string): string | null {
  try {
    return new URL(entry.includes("://") ? entry : `https://${entry}`).host.toLowerCase();
  } catch {
    return null;
  }
}

const int = (env: Env, key: string, fallback: number): number => {
  const v = str(env, key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function loadConfig(env: Env): Config {
  const channelId = str(env, "CHANNEL_ID");
  const bio = (str(env, "SITE_DESCRIPTION") ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    botToken: str(env, "BOT_TOKEN") ?? "",
    webhookSecret: str(env, "WEBHOOK_SECRET") ?? "",
    channelId: channelId === null ? null : Number(channelId),
    channelUsername: str(env, "CHANNEL_USERNAME")?.replace(/^@/, "") ?? null,
    siteTitle: str(env, "SITE_TITLE") ?? "碎碎念",
    siteDescription: bio.join(""),
    siteBio: bio,
    siteAvatar: str(env, "SITE_AVATAR") ?? "念",
    siteUrl: str(env, "SITE_URL")?.replace(/\/+$/, "") ?? null,
    siteTz: str(env, "SITE_TZ") ?? "Asia/Shanghai",
    mediaBase: (str(env, "MEDIA_BASE") ?? "/m").replace(/\/+$/, ""),
    mediaReferers: (str(env, "MEDIA_ALLOWED_REFERERS") ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)
      .map(hostOf)
      .filter((h): h is string => !!h),
    maxDownloadBytes: int(env, "MAX_DOWNLOAD_BYTES", 20 * 1024 * 1024),
    image: {
      optimize: !["0", "false"].includes(str(env, "IMAGE_OPTIMIZE") ?? ""),
      quality: int(env, "IMAGE_QUALITY", 80),
      maxSide: int(env, "IMAGE_MAX_SIDE", 2560),
      maxBytes: int(env, "IMAGE_MAX_BYTES", 2 * 1024 * 1024),
    },
    telegramApiBase: (str(env, "TELEGRAM_API_BASE") ?? "https://api.telegram.org").replace(/\/+$/, ""),
    pageSize: int(env, "PAGE_SIZE", 20),
  };
}
