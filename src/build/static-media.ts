// 把页面引用到的图片拷进站点输出目录的 m/ 下，和 /m/<key> 同一个地址：
// Cloudflare 上静态资源优先于 Worker，图片就不再经过 Worker、不读 R2，也不计请求数。
// 视频、GIF（mp4）仍然经 Worker：要支持 Range 拖动进度条，也可能比较大。
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BlobStore, Database } from "../core/ports";
import { mimeForKey } from "../core/services/media";

/** key 来自数据库，拼成路径前再挡一次（和 /m 路由放行的目录一致） */
const KEY_RE = /^(photo|video|gif|thumb|link)\/[\w.-]+$/;

export interface StaticMediaOptions {
  /** 本地缓存目录：key 不可变（按 file_unique_id / 链接哈希命名），缓存里有就不再从对象存储下载 */
  cacheDir?: string;
  /** 同时下载几个 */
  concurrency?: number;
}

/** 未删除帖子引用到的图片 key（和 timeline 的展示条件一致：缩略图不看 status，原图只取 ready） */
export async function publishedImageKeys(db: Database): Promise<string[]> {
  const rows = await db.all<{ k: string | null }>(
    `SELECT CASE WHEN m.status = 'ready' THEN m.blob_key END AS k FROM media m JOIN posts p ON p.id = m.post_id WHERE p.deleted = 0
     UNION SELECT m.thumb_key FROM media m JOIN posts p ON p.id = m.post_id WHERE p.deleted = 0
     UNION SELECT l.image_key FROM link_previews l JOIN posts p ON p.id = l.post_id WHERE p.deleted = 0 AND l.status = 'ready'`,
  );
  return rows
    .map((r) => r.k)
    .filter((k): k is string => !!k && KEY_RE.test(k) && !k.includes("..") && mimeForKey(k).startsWith("image/"))
    .sort();
}

/** 对象存储里没有这个文件时返回 false */
async function download(media: BlobStore, key: string, file: string): Promise<boolean> {
  const obj = await media.get(key);
  if (!obj) return false;
  await mkdir(dirname(file), { recursive: true });
  // 先写临时文件再改名：中断时缓存里不会留下半个文件
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, new Uint8Array(await new Response(obj.body).arrayBuffer()));
  await rename(tmp, file);
  return true;
}

/** 返回拷贝了几张、其中几张是新下载的；对象存储里缺的跳过（页面上那张图本来也打不开），记在 missing 里 */
export async function copyImages(
  db: Database,
  media: BlobStore,
  siteDir: string,
  opts: StaticMediaOptions = {},
): Promise<{ images: number; downloaded: number; missing: string[] }> {
  const keys = await publishedImageKeys(db);
  const missing: string[] = [];
  let downloaded = 0;
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++]!;
      const out = join(siteDir, "m", key);
      const cached = opts.cacheDir ? join(opts.cacheDir, key) : null;
      if (!cached || !existsSync(cached)) {
        if (!(await download(media, key, cached ?? out))) {
          missing.push(key);
          continue;
        }
        downloaded++;
      }
      if (cached) {
        await mkdir(dirname(out), { recursive: true });
        await copyFile(cached, out);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, keys.length) }, worker));
  return { images: keys.length - missing.length, downloaded, missing };
}
