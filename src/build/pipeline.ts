// 构建流程：
//   加锁 → 取回数据库 → 重试之前失败的媒体 → 处理收件箱 → 抓链接预览（每个帖子一次）
//   → 没有变化就结束 → 渲染 → 部署 → 核对数据库没被别人改过 → 回写数据库、清空已处理的收件箱 → 解锁
// 部署成功之前不回写任何东西：任何一步失败，下次构建会把同样的消息重新处理一遍（入库是幂等的）。
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SqliteDatabase, migrate } from "../adapters/node/sqlite";
import type { Config } from "../core/config";
import { renderSite } from "../core/build/site";
import type { BlobStore, Deps, ImageOptimizer, Stores } from "../core/ports";
import { listInbox, readUpdate } from "../core/services/inbox";
import { handleUpdate, telegramClient } from "../core/services/ingest";
import { refreshLinkPreview } from "../core/services/link-preview";
import { retryFailedMedia } from "../core/services/media";
import type { LinkPreviewPrefs } from "../core/telegram/normalize";

export const DB_KEY = "state/thought.db";
export const LOCK_KEY = "state/build.lock";
/** 超过这个时间的锁视为上次构建异常退出留下的，可以接管 */
const LOCK_TTL_MS = 60 * 60 * 1000;

export class BuildLockedError extends Error {
  constructor(since: number) {
    super(`另一个构建正在进行（开始于 ${new Date(since).toISOString()}）`);
  }
}

export interface BuildOptions {
  config: Config;
  stores: Stores;
  fetch?: typeof fetch;
  /** 转存图片前压缩；不传就原样存 */
  optimizeImage?: ImageOptimizer;
  /** 静态站点输出目录（整体替换） */
  outDir: string;
  publicDir: string;
  migrationsDir: string;
  /** 没有新消息也重新构建（改了模板 / 首次部署） */
  force?: boolean;
  /** 渲染完成后执行，失败则不回写 */
  deploy?: () => Promise<void>;
  now?: number;
  log?: (msg: string) => void;
}

export interface BuildResult {
  /** 站点是否重新生成 */
  changed: boolean;
  processed: number;
  retried: number;
  posts: number;
  files: number;
}

interface LockInfo {
  token: string;
  at: number;
}

async function readLock(data: BlobStore): Promise<LockInfo | null> {
  const held = await data.get(LOCK_KEY);
  if (!held) return null;
  try {
    return JSON.parse(await new Response(held.body).text()) as LockInfo;
  } catch {
    return { token: "", at: 0 };
  }
}

/**
 * 用「不存在才创建」拿锁，锁里放随机令牌。拿到后读回核对一次：
 * 不支持条件写入的 S3 兼容服务会直接覆盖，读回的令牌对不上就说明被别人抢了。
 */
async function acquireLock(data: BlobStore, log: (m: string) => void): Promise<string> {
  const token = crypto.randomUUID();
  const body = () => new TextEncoder().encode(JSON.stringify({ token, at: Date.now(), host: hostname(), pid: process.pid }));
  const opts = { contentType: "application/json" };
  let created = await data.create(LOCK_KEY, body(), opts);
  if (!created) {
    const held = await readLock(data);
    const since = held?.at ?? 0;
    if (held && Date.now() - since < LOCK_TTL_MS) throw new BuildLockedError(since);
    log("发现过期的构建锁，接管");
    await data.delete(LOCK_KEY);
    created = await data.create(LOCK_KEY, body(), opts);
    if (!created) throw new BuildLockedError(Date.now());
  }
  await assertLockHeld(data, token);
  return token;
}

async function assertLockHeld(data: BlobStore, token: string): Promise<void> {
  const held = await readLock(data);
  if (held?.token !== token) throw new BuildLockedError(held?.at ?? Date.now());
}

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { data, media } = opts.stores;
  const token = await acquireLock(data, log);
  let ownsLock = true;
  const work = await mkdtemp(join(tmpdir(), "thought-build-"));
  const dbPath = join(work, "thought.db");
  try {
    const keys = await listInbox(data);
    log(`收件箱：${keys.length} 条`);

    const saved = await data.get(DB_KEY);
    const baseEtag = saved?.etag ?? null;
    if (saved) await writeFile(dbPath, new Uint8Array(await new Response(saved.body).arrayBuffer()));

    const db = new SqliteDatabase(dbPath);
    let result: BuildResult;
    let dbChanged: boolean;
    try {
      const applied = migrate(db, opts.migrationsDir);
      if (applied.length) log(`执行迁移：${applied.join(", ")}`);
      const deps: Deps = { config: opts.config, db, blobs: media, fetch: opts.fetch ?? fetch, optimizeImage: opts.optimizeImage };

      // 先重试之前失败的媒体，再处理新消息：这次刚失败的不会在同一次构建里被重复下载
      const retry = await retryFailedMedia(deps, telegramClient(deps));
      if (retry.attempted) log(`重试失败的媒体：${retry.fixed} / ${retry.attempted} 成功`);

      // 同一个帖子在这一批里可能有原消息和多次编辑，链接预览只按最后一次抓
      const previews = new Map<number, LinkPreviewPrefs | undefined>();
      for (const key of keys) {
        const update = await readUpdate(data, key);
        if (!update) {
          log(`跳过无法解析的 ${key}`);
          continue;
        }
        const r = await handleUpdate(deps, update);
        log(`${key} → ${r.action}${r.action === "ignored" ? `（${r.reason}）` : ""}`);
        if (r.action === "saved" && r.textOnly) previews.set(r.postId, r.prefs);
      }
      await Promise.all(
        [...previews].map(([postId, prefs]) =>
          refreshLinkPreview(deps, postId, prefs).catch((e) => log(`链接预览失败（帖子 ${postId}）：${(e as Error).message}`)),
        ),
      );

      const siteChanged = keys.length > 0 || retry.fixed > 0;
      // 重试即使全部失败，重试次数也变了，要回写，否则永远到不了上限
      dbChanged = siteChanged || retry.attempted > 0;
      if (!siteChanged && !opts.force) {
        log("没有新内容，跳过构建");
        result = { changed: false, processed: 0, retried: 0, posts: 0, files: 0 };
      } else {
        const site = await render(deps, opts);
        log(`渲染完成：${site.posts} 条帖子，${site.files} 个文件`);
        result = { changed: true, processed: keys.length, retried: retry.fixed, ...site };
      }
    } finally {
      db.close(); // 关闭时 WAL 会合并回主文件
    }

    if (result.changed && opts.deploy) {
      log("部署中…");
      await opts.deploy();
    }
    if (dbChanged) {
      // 回写前再核对两道：锁还是自己的、数据库没被别人改过，任何一项不满足都放弃回写
      try {
        await assertLockHeld(data, token);
      } catch (e) {
        ownsLock = false;
        throw e;
      }
      const current = (await data.head(DB_KEY))?.etag ?? null;
      if (current !== baseEtag) throw new Error("数据库在构建期间被其他进程修改，放弃回写（下次构建会重新处理）");
      const bytes = new Uint8Array(await readFile(dbPath));
      await data.put(DB_KEY, bytes, { contentType: "application/vnd.sqlite3", size: bytes.byteLength });
      for (const key of keys) await data.delete(key);
      log(keys.length ? "数据库已回写，收件箱已清理" : "数据库已回写");
    }
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
    // 只释放自己的锁；被别人接管的锁不能删
    if (ownsLock && (await readLock(data).catch(() => null))?.token === token) {
      await data.delete(LOCK_KEY).catch((e) => log(`释放构建锁失败：${(e as Error).message}`));
    }
  }
}

/** 先渲染到临时目录再整体替换，自建服务器上不会出现构建到一半的站点 */
async function render(deps: Deps, opts: BuildOptions) {
  const staging = `${opts.outDir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await cp(opts.publicDir, staging, { recursive: true });
  const site = await renderSite(
    deps,
    {
      async write(path, content) {
        const file = join(staging, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      },
    },
    { buildId: Date.now().toString(36), now: opts.now },
  );
  await rm(`${opts.outDir}.old`, { recursive: true, force: true });
  await rename(opts.outDir, `${opts.outDir}.old`).catch(() => {});
  await rename(staging, opts.outDir);
  await rm(`${opts.outDir}.old`, { recursive: true, force: true });
  return site;
}
