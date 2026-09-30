// 构建入口：npm run build:site
//   FORCE=1          没有新消息也构建
//   DEPLOY_COMMAND   渲染后执行的部署命令（如 `npx wrangler deploy`）；自建服务器直接读输出目录，不需要
//   IMAGE_OPTIMIZE=0 不压缩图片，原样转存（默认转成 WebP）
//   IMAGE_QUALITY    WebP 质量，默认 80
//   IMAGE_MAX_SIDE   图片最长边，默认 2560
//   IMAGE_MAX_BYTES  压缩后单张图片的大小上限，默认 2MB（先降质量，再缩尺寸）
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../core/config";
import { createImageOptimizer } from "./image";
import { runBuild } from "./pipeline";
import { storesFromEnv } from "./storage";

for (const f of ["site.env", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
const env = process.env;

const config = loadConfig(env);
if (!config.botToken) throw new Error("缺少 BOT_TOKEN（下载媒体、执行 /del 需要）");
if (config.channelId === null) throw new Error("缺少 CHANNEL_ID");
if (!config.siteUrl) console.warn("⚠️ 没有设置 SITE_URL：RSS 和分享卡片里的链接会是相对地址");

const deployCommand = env.DEPLOY_COMMAND;
const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) ? Number(v) : fallback);
const optimizeImage =
  env.IMAGE_OPTIMIZE === "0" || env.IMAGE_OPTIMIZE === "false"
    ? undefined
    : createImageOptimizer({
        quality: num(env.IMAGE_QUALITY, 80),
        maxSide: num(env.IMAGE_MAX_SIDE, 2560),
        maxBytes: num(env.IMAGE_MAX_BYTES, 2 * 1024 * 1024),
      });
const result = await runBuild({
  config,
  stores: storesFromEnv(env),
  optimizeImage,
  outDir: resolve(env.SITE_DIR ?? "./dist/site"),
  publicDir: resolve("public"),
  migrationsDir: resolve("migrations"),
  force: !!env.FORCE && env.FORCE !== "0" && env.FORCE !== "false",
  deploy: deployCommand
    ? () =>
        new Promise<void>((ok, fail) => {
          spawn(deployCommand, { shell: true, stdio: "inherit" }).on("exit", (code) =>
            code === 0 ? ok() : fail(new Error(`部署失败（退出码 ${code}）`)),
          );
        })
    : undefined,
});
console.log(JSON.stringify(result));
