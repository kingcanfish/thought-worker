import { Hono } from "hono";
import { addDays, dayKey, isDayKey, nowSeconds } from "../../lib/time";
import { dailyCounts, getPost, listPosts, listTags, parseFilters, siteStats, type PostView } from "../../services/timeline";
import type { AppEnv } from "../app";
import { cacheContent } from "../cache";

/** 对外 JSON 格式（snake_case，与设计文档一致） */
export const postJson = (p: PostView) => ({
  id: p.id,
  html: p.html,
  text: p.text,
  created_at: p.createdAt,
  edited_at: p.editedAt,
  tags: p.tags,
  media: p.media
    .filter((m) => m.status === "ready" || m.status === "too_large")
    .map((m) => ({ kind: m.kind, status: m.status, url: m.url, thumb: m.thumb, w: m.width, h: m.height, duration: m.duration })),
  forward: p.forward,
  link_preview: p.linkPreview && {
    url: p.linkPreview.url,
    site_name: p.linkPreview.siteName,
    title: p.linkPreview.title,
    description: p.linkPreview.description,
    image: p.linkPreview.image,
    layout: p.linkPreview.layout,
    above_text: p.linkPreview.aboveText,
  },
  tg_link: p.tgLink,
});

const MAX_RANGE_DAYS = 400;

export const apiRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    await next();
    if (c.req.method === "GET" && c.res.status === 200) cacheContent(c);
  })
  .get("/posts", async (c) => {
    const page = await listPosts(c.var.deps, parseFilters((k) => c.req.query(k)), {
      cursor: c.req.query("cursor"),
      limit: Number(c.req.query("limit")) || undefined,
    });
    return c.json({ items: page.posts.map(postJson), next_cursor: page.nextCursor });
  })
  .get("/posts/:id{[0-9]+}", async (c) => {
    const post = await getPost(c.var.deps, Number(c.req.param("id")));
    return post ? c.json(postJson(post)) : c.json({ error: "not found" }, 404);
  })
  .get("/tags", async (c) => c.json({ items: await listTags(c.var.deps) }))
  .get("/stats", async (c) => c.json(await siteStats(c.var.deps)))
  .get("/stats/heatmap", async (c) => {
    const today = dayKey(nowSeconds(), c.var.deps.config.siteTz);
    const to = isDayKey(c.req.query("to")) ? c.req.query("to")! : today;
    let from = isDayKey(c.req.query("from")) ? c.req.query("from")! : addDays(to, -139);
    if (from > to || addDays(from, MAX_RANGE_DAYS) < to) from = addDays(to, -MAX_RANGE_DAYS);
    return c.json({ from, to, today, counts: await dailyCounts(c.var.deps, from, to) });
  });
