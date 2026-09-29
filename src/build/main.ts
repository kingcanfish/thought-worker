// 构建入口：npm run build:site
//   FORCE=1          没有新消息也构建
//   DEPLOY_COMMAND   渲染后执行的部署命令（如 `npx wrangler deploy`）；自建服务器直接读输出目录，不需要
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../core/config";
import { runBuild } from "./pipeline";
import { storesFromEnv } from "./storage";

for (const f of ["site.env", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
const env = process.env;

const config = loadConfig(env);
if (!config.botToken) throw new Error("缺少 BOT_TOKEN（下载媒体、执行 /del 需要）");
if (config.channelId === null) throw new Error("缺少 CHANNEL_ID");
if (!config.siteUrl) console.warn("⚠️ 没有设置 SITE_URL：RSS 和分享卡片里的链接会是相对地址");

const deployCommand = env.DEPLOY_COMMAND;
const result = await runBuild({
  config,
  stores: storesFromEnv(env),
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
