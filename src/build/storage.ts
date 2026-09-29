import { resolve } from "node:path";
import { FsBlobStore } from "../adapters/node/fs-store";
import { S3BlobStore } from "../adapters/s3/s3-store";
import type { Stores } from "../core/ports";

/**
 * 两个存储：media（图片视频，可公开）和 data（收件箱 + 数据库，不能公开）。
 *   STORAGE=fs（默认）：DATA_DIR/media、DATA_DIR/private
 *   STORAGE=r2：R2_BUCKET、R2_DATA_BUCKET（构建端在 GitHub Actions 上用）
 *   STORAGE=s3：S3_BUCKET、S3_DATA_BUCKET（MinIO / AWS S3 …）
 */
export function storesFromEnv(env: NodeJS.ProcessEnv): Stores {
  const kind = env.STORAGE ?? "fs";
  if (kind === "fs") {
    const dir = resolve(env.DATA_DIR ?? "./data");
    return { media: new FsBlobStore(resolve(dir, "media")), data: new FsBlobStore(resolve(dir, "private")) };
  }
  if (kind !== "r2" && kind !== "s3") throw new Error(`unknown STORAGE=${kind}`);
  const need = (k: string, fallback?: string) => {
    const v = env[k] ?? fallback;
    if (!v) throw new Error(`STORAGE=${kind} 需要环境变量 ${k}`);
    return v;
  };
  const p = kind === "r2" ? "R2" : "S3";
  const endpoint = kind === "r2" ? `https://${need("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com` : need("S3_ENDPOINT");
  const bucket = (b: string) =>
    new S3BlobStore({
      endpoint,
      bucket: b,
      accessKeyId: need(`${p}_ACCESS_KEY_ID`),
      secretAccessKey: need(`${p}_SECRET_ACCESS_KEY`),
      region: env.S3_REGION,
    });
  const media = need(`${p}_BUCKET`, kind === "r2" ? "thought-worker-media" : undefined);
  const data = need(`${p}_DATA_BUCKET`, kind === "r2" ? "thought-worker-data" : undefined);
  if (media === data) throw new Error("媒体和数据必须放在两个不同的桶里：数据桶不能公开");
  return { media: bucket(media), data: bucket(data) };
}
