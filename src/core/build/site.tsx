// 静态站点渲染：数据库 → 一组文件。输出与存储无关，由 SiteWriter 决定写到哪。
import type { Child } from "hono/jsx";
import { dayKey, nowSeconds } from "../lib/time";
import type { Deps } from "../ports";
import { dailyCounts, listAllPosts, listTags, siteStats, type PostView } from "../services/timeline";
import { excerpt } from "../http/views/format";
import { HomePage, NotFoundPage, PostPage, heatmapRange } from "../http/views/pages";
import { PostItem } from "../http/views/post";
import { renderRss } from "../http/views/rss";

export interface SiteWriter {
  write(path: string, content: string): Promise<void>;
}

/** data/index.json 里每条帖子的索引，前端据此筛选 / 搜索 / 画热力图 */
export interface IndexEntry {
  id: number;
  /** unix 秒 */
  t: number;
  /** 站点时区下的日期 YYYY-MM-DD */
  d: string;
  /** 标签 */
  g: string[];
  /** 搜索用的纯文本 */
  s: string;
}

export interface SiteIndex {
  build: string;
  pageSize: number;
  posts: IndexEntry[];
}

const page = async (el: Child) => `<!doctype html>${String(await el)}`;

/** 相对地址（/m/...）补全为绝对地址，OG / RSS 需要 */
const absolute = (origin: string, url: string): string => (url.startsWith("/") ? `${origin}${url}` : url);

function firstImage(p: PostView): string | null {
  const m = p.media.find((x) => x.status === "ready" && x.kind === "photo") ?? p.media.find((x) => x.thumb);
  return m ? (m.thumb ?? m.url) : (p.linkPreview?.image ?? null);
}

const searchText = (p: PostView): string =>
  [p.text, p.forward?.name, p.linkPreview?.title, p.linkPreview?.siteName].filter(Boolean).join("\n");

export async function renderSite(deps: Deps, out: SiteWriter, opts: { buildId: string; now?: number }) {
  const { config } = deps;
  const tz = config.siteTz;
  const origin = config.siteUrl ?? "";
  const posts = await listAllPosts(deps);
  const heat = heatmapRange(dayKey(opts.now ?? nowSeconds(), tz));
  const [stats, tags, counts] = await Promise.all([siteStats(deps), listTags(deps), dailyCounts(deps, heat.from, heat.to)]);

  let files = 0;
  const write = async (path: string, content: string) => {
    await out.write(path, content);
    files++;
  };

  await write(
    "index.html",
    await page(
      <HomePage
        config={config}
        origin={origin}
        buildId={opts.buildId}
        posts={posts.slice(0, config.pageSize)}
        total={posts.length}
        stats={stats}
        tags={tags}
        heatmap={{ ...heat, counts }}
      />,
    ),
  );

  const index: IndexEntry[] = [];
  const months = new Map<string, Record<number, string>>();
  for (const p of posts) {
    const d = dayKey(p.createdAt, tz);
    index.push({ id: p.id, t: p.createdAt, d, g: p.tags, s: searchText(p) });
    const month = d.slice(0, 7);
    if (!months.has(month)) months.set(month, {});
    months.get(month)![p.id] = String(await (<PostItem post={p} config={config} />));

    const image = firstImage(p);
    await write(
      `p/${p.id}/index.html`,
      await page(
        <PostPage
          config={config}
          origin={origin}
          buildId={opts.buildId}
          post={p}
          image={image && origin ? absolute(origin, image) : null}
          description={excerpt(p.text, 120)}
        />,
      ),
    );
  }

  await write("data/index.json", JSON.stringify({ build: opts.buildId, pageSize: config.pageSize, posts: index } satisfies SiteIndex));
  for (const [month, html] of months) await write(`data/month/${month}.json`, JSON.stringify(html));
  await write("rss.xml", renderRss(config, origin, posts.slice(0, 30)));
  await write("404.html", await page(<NotFoundPage config={config} origin={origin} />));
  return { posts: posts.length, files };
}
