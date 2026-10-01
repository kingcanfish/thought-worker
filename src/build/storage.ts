import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { D1HttpDatabase } from "../adapters/d1/http";
import { FsBlobStore } from "../adapters/node/fs-store";
import { SqliteDatabase, migrate } from "../adapters/node/sqlite";
import { S3BlobStore } from "../adapters/s3/s3-store";
import type { BlobStore, Database } from "../core/ports";

type Env = NodeJS.ProcessEnv;

/** 空字符串当作没设置（CI 里引用了未定义的变量会得到 ""） */
function opt(env: Env, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

function need(env: Env, key: string, why: string): string {
  const v = opt(env, key);
  if (!v) throw new Error(`${why} 需要环境变量 ${key}`);
  return v;
}

const dataDir = (env: Env) => resolve(opt(env, "DATA_DIR") ?? "./data");

/**
 * 媒体存储（图片视频）：
 *   STORAGE=fs（默认）：DATA_DIR/media
 *   STORAGE=r2：R2_BUCKET（构建端在 GitHub Actions 上用 S3 API 访问）
 *   STORAGE=s3：S3_BUCKET（MinIO / AWS S3 / Backblaze B2 …）
 */
export function mediaFromEnv(env: Env): BlobStore {
  const kind = opt(env, "STORAGE") ?? "fs";
  if (kind === "fs") return new FsBlobStore(resolve(dataDir(env), "media"));
  if (kind !== "r2" && kind !== "s3") throw new Error(`unknown STORAGE=${kind}`);
  const why = `STORAGE=${kind}`;
  const p = kind === "r2" ? "R2" : "S3";
  return new S3BlobStore({
    endpoint: kind === "r2" ? `https://${need(env, "R2_ACCOUNT_ID", why)}.r2.cloudflarestorage.com` : need(env, "S3_ENDPOINT", why),
    bucket: opt(env, `${p}_BUCKET`) ?? (kind === "r2" ? "thought-worker-media" : need(env, "S3_BUCKET", why)),
    accessKeyId: need(env, `${p}_ACCESS_KEY_ID`, why),
    secretAccessKey: need(env, `${p}_SECRET_ACCESS_KEY`, why),
    region: opt(env, "S3_REGION"),
  });
}

export interface OpenedDatabase {
  db: Database;
  close(): void;
}

/**
 * 数据库（帖子 + 收件箱 + 构建锁）：
 *   DB=sqlite（默认）：DATA_DIR/thought.db，打开时执行迁移；接收端和构建端共用这一个文件
 *   DB=d1：通过 Cloudflare API 访问 D1，迁移由 `wrangler d1 migrations apply` 执行
 */
export function databaseFromEnv(env: Env, migrationsDir: string): OpenedDatabase {
  const kind = opt(env, "DB") ?? "sqlite";
  if (kind === "d1") {
    const why = "DB=d1";
    const db = new D1HttpDatabase({
      accountId: opt(env, "D1_ACCOUNT_ID") ?? need(env, "CLOUDFLARE_ACCOUNT_ID", why),
      databaseId: need(env, "D1_DATABASE_ID", why),
      apiToken: opt(env, "D1_API_TOKEN") ?? need(env, "CLOUDFLARE_API_TOKEN", why),
    });
    return { db, close: () => {} };
  }
  if (kind !== "sqlite") throw new Error(`unknown DB=${kind}`);
  const path = opt(env, "DB_PATH") ?? resolve(dataDir(env), "thought.db");
  // SQLite 不会自己建上级目录：新机器上第一次运行时 DATA_DIR 还不存在
  mkdirSync(dirname(path), { recursive: true });
  const db = new SqliteDatabase(path);
  migrate(db, migrationsDir);
  return { db, close: () => db.close() };
}
