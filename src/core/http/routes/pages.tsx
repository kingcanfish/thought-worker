import { Hono, type Context } from "hono";
import { dayKey, nowSeconds } from "../../lib/time";
import {
  countPosts,
  dailyCounts,
  getPost,
  hasFilters,
  listPosts,
  listTags,
  parseFilters,
  siteStats,
  type PostView,
} from "../../services/timeline";
import type { AppEnv } from "../app";
import { cacheContent } from "../cache";
import { excerpt } from "../views/format";
import { FilterBar, HomePage, NotFoundPage, PostPage, TimelineBody, heatmapRange } from "../views/pages";
import { DaySections } from "../views/post";
import { renderRss } from "../views/rss";

const originOf = (c: Context<AppEnv>): string => c.var.deps.config.siteUrl ?? new URL(c.req.url).origin;

/** 相对地址（/m/...）补全为绝对地址，OG / RSS 需要 */
export const absolute = (origin: string, url: string): string => (url.startsWith("/") ? `${origin}${url}` : url);

const firstImage = (p: PostView): string | null => {
  const m = p.media.find((x) => x.status === "ready" && x.kind === "photo") ?? p.media.find((x) => x.thumb);
  return m ? (m.thumb ?? m.url) : (p.linkPreview?.image ?? null);
};

export const notFoundPage = (c: Context<AppEnv>) =>
  c.html(<NotFoundPage config={c.var.deps.config} origin={originOf(c)} />, 404);

// 注意：挂在根路径下，不能用 .use 中间件（会匹配到 /m 等所有路由），缓存头在各处理函数里设置
export const pageRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const deps = c.var.deps;
    const filters = parseFilters((k) => c.req.query(k));
    const heat = heatmapRange(dayKey(nowSeconds(), deps.config.siteTz));
    const [page, count, stats, tags, counts] = await Promise.all([
      listPosts(deps, filters),
      hasFilters(filters) ? countPosts(deps, filters) : Promise.resolve(null),
      siteStats(deps),
      listTags(deps),
      dailyCounts(deps, heat.from, heat.to),
    ]);
    cacheContent(c);
    return c.html(
      <HomePage
        config={deps.config}
        origin={originOf(c)}
        filters={filters}
        posts={page.posts}
        nextCursor={page.nextCursor}
        count={count}
        stats={stats}
        tags={tags}
        heatmap={{ ...heat, counts }}
      />,
    );
  })
  .get("/tag/:tag", (c) => c.redirect(`/?tag=${encodeURIComponent(c.req.param("tag"))}`, 301))
  .get("/p/:id{[0-9]+}", async (c) => {
    const deps = c.var.deps;
    const post = await getPost(deps, Number(c.req.param("id")));
    const origin = originOf(c);
    if (!post) return notFoundPage(c);
    const image = firstImage(post);
    cacheContent(c);
    return c.html(
      <PostPage
        config={deps.config}
        origin={origin}
        post={post}
        image={image && absolute(origin, image)}
        description={excerpt(post.text, 120)}
      />,
    );
  })
  // 前端无限滚动 / 切换筛选时拉取的 HTML 片段，模板只维护服务端这一份
  .get("/fragments/timeline", async (c) => {
    const deps = c.var.deps;
    const filters = parseFilters((k) => c.req.query(k));
    const cursor = c.req.query("cursor");
    const [page, count] = await Promise.all([
      listPosts(deps, filters, { cursor }),
      !cursor && hasFilters(filters) ? countPosts(deps, filters) : Promise.resolve(null),
    ]);
    const html = cursor
      ? String(await (<DaySections posts={page.posts} config={deps.config} />))
      : String(await (<TimelineBody config={deps.config} filters={filters} posts={page.posts} />));
    const filter = cursor ? null : String(await (<FilterBar filters={filters} count={count} />));
    cacheContent(c);
    return c.json({ html, filter, next: page.nextCursor, empty: page.posts.length === 0 });
  })
  .get("/rss.xml", async (c) => {
    const deps = c.var.deps;
    const page = await listPosts(deps, parseFilters(() => null), { limit: 30 });
    cacheContent(c);
    c.header("Content-Type", "application/rss+xml; charset=utf-8");
    return c.body(renderRss(deps.config, originOf(c), page.posts));
  });
