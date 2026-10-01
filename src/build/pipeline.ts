// 构建流程：
//   加锁 → 重试之前失败的媒体 → 处理收件箱 → 抓链接预览（每个帖子一次）
//   → 没有变化就结束 → 渲染 → 核对锁 → 部署 → 删掉已处理的收件箱、清掉待发布标记（都以锁仍是自己的为条件）→ 解锁
// 入库直接写数据库，但收件箱要等部署成功才删：任何一步失败，下次构建会把同样的消息重新处理一遍（入库是幂等的）。
// 不在收件箱里的变化（重试修好的媒体）记在 site_state.publish_pending，部署失败也不会丢。
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../core/config";
import { renderSite } from "../core/build/site";
import type { BlobStore, Database, Deps, ImageOptimizer } from "../core/ports";
import { LOCK_HELD, clearInboxStatements, readInbox } from "../core/services/inbox";
import { handleUpdate, telegramClient } from "../core/services/ingest";
import { refreshLinkPreview } from "../core/services/link-preview";
import { retryFailedMedia } from "../core/services/media";
import type { LinkPreviewPrefs } from "../core/telegram/normalize";
import { copyImages, type StaticMediaOptions } from "./static-media";

/** 超过这个时间的锁视为上次构建异常退出留下的，可以接管 */
const LOCK_TTL_MS = 60 * 60 * 1000;

export class BuildLockedError extends Error {
  constructor(since: number) {
    super(`另一个构建正在进行（开始于 ${new Date(since).toISOString()}）`);
  }
}

export interface BuildOptions {
  config: Config;
  /** 数据库（D1 或本地 SQLite），迁移需要事先执行 */
  db: Database;
  /** 媒体存储 */
  media: BlobStore;
  fetch?: typeof fetch;
  /** 转存图片前压缩；不传就原样存 */
  optimizeImage?: ImageOptimizer;
  /** 静态站点输出目录（整体替换） */
  outDir: string;
  publicDir: string;
  /** 把图片拷进输出目录的 m/ 下（Cloudflare 上由静态资源直接提供，不经 Worker）；不传就都经 /m 路由 */
  staticMedia?: StaticMediaOptions;
  /** 没有新消息也重新构建（改了模板 / 首次部署） */
  force?: boolean;
  /** 渲染完成后执行，失败则不清理收件箱 */
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
  /** 拷进输出目录的图片数 */
  images: number;
}

/**
 * 锁表只有一行：没有就插入，有但已过期就接管，一条语句完成，不会两个构建同时拿到。
 * RETURNING 只在真正写入时返回行，所以返回了令牌就是拿到了锁。
 */
async function acquireLock(db: Database): Promise<string> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const got = await db.first<{ token: string }>(
    `INSERT INTO build_lock (id, token, acquired_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET token = excluded.token, acquired_at = excluded.acquired_at
     WHERE build_lock.acquired_at < ?
     RETURNING token`,
    [token, now, now - LOCK_TTL_MS],
  );
  if (got?.token === token) return token;
  const held = await db.first<{ acquired_at: number }>("SELECT acquired_at FROM build_lock WHERE id = 1");
  throw new BuildLockedError(held?.acquired_at ?? now);
}

/** 锁被别人接管过（例如这次构建超过了 TTL）就停下：那边会处理同一批消息 */
async function assertLockHeld(db: Database, token: string): Promise<void> {
  if (!(await db.first("SELECT 1 AS ok FROM build_lock WHERE id = 1 AND token = ?", [token]))) throw new BuildLockedError(Date.now());
}

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { db } = opts;
  const token = await acquireLock(db);
  try {
    const inbox = await readInbox(db);
    log(`收件箱：${inbox.length} 条`);
    const deps: Deps = { config: opts.config, db, blobs: opts.media, fetch: opts.fetch ?? fetch, optimizeImage: opts.optimizeImage };

    // 先重试之前失败的媒体，再处理新消息：这次刚失败的不会在同一次构建里被重复下载
    const retry = await retryFailedMedia(deps, telegramClient(deps));
    if (retry.attempted) log(`重试失败的媒体：${retry.fixed} / ${retry.attempted} 成功`);
    // 重试结果已经写进数据库、但还没发布：先记下来，这次部署失败的话下次构建照样会重新渲染
    if (retry.fixed) await db.run(`UPDATE site_state SET publish_pending = 1 WHERE id = 1 AND ${LOCK_HELD}`, [token]);

    // 同一个帖子在这一批里可能有原消息和多次编辑，链接预览只按最后一次抓
    const previews = new Map<number, LinkPreviewPrefs | undefined>();
    for (const { updateId, update } of inbox) {
      if (!update) {
        log(`跳过无法解析的 update ${updateId}`);
        continue;
      }
      const r = await handleUpdate(deps, update);
      log(`${updateId} → ${r.action}${r.action === "ignored" ? `（${r.reason}）` : ""}`);
      if (r.action === "saved" && r.textOnly) previews.set(r.postId, r.prefs);
    }
    await Promise.all(
      [...previews].map(([postId, prefs]) =>
        refreshLinkPreview(deps, postId, prefs).catch((e) => log(`链接预览失败（帖子 ${postId}）：${(e as Error).message}`)),
      ),
    );

    const pending = (await db.first<{ p: number }>("SELECT publish_pending AS p FROM site_state WHERE id = 1"))?.p === 1;
    const siteChanged = inbox.length > 0 || pending;
    if (!siteChanged && !opts.force) {
      log("没有新内容，跳过构建");
      return { changed: false, processed: 0, retried: 0, posts: 0, files: 0, images: 0 };
    }
    const site = await render(deps, opts);
    log(`渲染完成：${site.posts} 条帖子，${site.files} 个文件${opts.staticMedia ? `，${site.images} 张图片` : ""}`);

    // 部署前再核对一次：锁被接管了就不要用这份（可能更旧的）渲染结果覆盖对方的部署
    await assertLockHeld(db, token);
    if (opts.deploy) {
      log("部署中…");
      await opts.deploy();
    }
    await assertLockHeld(db, token);
    // 以锁仍是自己的为条件，和检查在同一条语句里：即使恰好在这之间被接管，也不会删掉对方正在处理的记录
    await db.batch([
      ...clearInboxStatements(inbox.map((i) => i.updateId), token),
      { sql: `UPDATE site_state SET publish_pending = 0 WHERE id = 1 AND ${LOCK_HELD}`, params: [token] },
    ]);
    if (inbox.length) log("收件箱已清理");
    return { changed: true, processed: inbox.length, retried: retry.fixed, ...site };
  } finally {
    // 只释放自己的锁；被别人接管的锁不能删
    await db.run("DELETE FROM build_lock WHERE id = 1 AND token = ?", [token]).catch((e) => log(`释放构建锁失败：${(e as Error).message}`));
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
  let images = 0;
  if (opts.staticMedia) {
    const r = await copyImages(deps.db, deps.blobs, staging, opts.staticMedia);
    if (r.missing.length) (opts.log ?? console.warn)(`媒体存储里缺少 ${r.missing.length} 张图片：${r.missing.slice(0, 5).join(", ")}`);
    images = r.images;
  }
  await rm(`${opts.outDir}.old`, { recursive: true, force: true });
  await rename(opts.outDir, `${opts.outDir}.old`).catch(() => {});
  await rename(staging, opts.outDir);
  await rm(`${opts.outDir}.old`, { recursive: true, force: true });
  return { ...site, images };
}
