// 读取侧：时间线、单条、标签、统计。输出与存储无关的视图模型。
import { addDays, dayKey, dayStart, isDayKey, nowSeconds, tzOffset } from "../lib/time";
import type { Deps, SqlValue } from "../ports";
import type { ForwardInfo } from "../telegram/forward";
import type { MediaKind } from "../telegram/normalize";

export interface PostFilters {
  tag: string | null;
  q: string | null;
  from: string | null;
  to: string | null;
}

export interface MediaView {
  kind: MediaKind;
  status: "ready" | "too_large" | "failed" | "pending";
  url: string | null;
  thumb: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
}

export interface LinkPreviewView {
  url: string;
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  layout: "large" | "small";
  aboveText: boolean;
}

export interface PostView {
  id: number;
  html: string;
  text: string;
  createdAt: number;
  editedAt: number | null;
  tags: string[];
  media: MediaView[];
  forward: ForwardInfo | null;
  linkPreview: LinkPreviewView | null;
  tgLink: string | null;
}

export interface Page {
  posts: PostView[];
  nextCursor: string | null;
}

const clip = (v: string | null | undefined, max: number): string | null => {
  const s = v?.trim();
  return s ? s.slice(0, max) : null;
};

export function parseFilters(get: (key: string) => string | null | undefined): PostFilters {
  let from = isDayKey(get("from")) ? get("from")! : null;
  let to = isDayKey(get("to")) ? get("to")! : null;
  if (from && !to) to = from;
  if (to && !from) from = to;
  if (from && to && from > to) [from, to] = [to, from];
  return { tag: clip(get("tag"), 64)?.replace(/^#/, "") ?? null, q: clip(get("q"), 100), from, to };
}

export const hasFilters = (f: PostFilters): boolean => !!(f.tag || f.q || f.from);

export const filterParams = (f: PostFilters): URLSearchParams => {
  const p = new URLSearchParams();
  if (f.tag) p.set("tag", f.tag);
  if (f.q) p.set("q", f.q);
  if (f.from) p.set("from", f.from);
  if (f.to && f.to !== f.from) p.set("to", f.to);
  return p;
};

const encodeCursor = (p: { createdAt: number; id: number }) => `${p.createdAt}:${p.id}`;

function decodeCursor(c: string | null | undefined): [number, number] | null {
  const m = c ? /^(\d+):(\d+)$/.exec(c) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function buildWhere(deps: Deps, f: PostFilters): { where: string[]; params: SqlValue[] } {
  const where = ["p.deleted = 0"];
  const params: SqlValue[] = [];
  const tz = deps.config.siteTz;
  if (f.tag) {
    where.push("EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ?)");
    params.push(f.tag);
  }
  if (f.from && f.to) {
    where.push("p.created_at >= ? AND p.created_at < ?");
    params.push(dayStart(f.from, tz), dayStart(addDays(f.to, 1), tz));
  }
  if (f.q) {
    // trigram 至少 3 个字符才能命中，更短的用 LIKE
    if ([...f.q].length >= 3) {
      where.push("p.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)");
      params.push(`"${f.q.replace(/"/g, '""')}"`);
    } else {
      where.push("p.text LIKE ? ESCAPE '\\'");
      params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
  }
  return { where, params };
}

interface PostRow {
  id: number;
  html: string;
  text: string;
  created_at: number;
  edited_at: number | null;
  forward: string | null;
  tg_message_id: number;
}

const POST_COLUMNS = "p.id, p.html, p.text, p.created_at, p.edited_at, p.forward, p.tg_message_id";

export async function listPosts(deps: Deps, f: PostFilters, opts: { cursor?: string | null; limit?: number } = {}): Promise<Page> {
  const limit = Math.min(Math.max(opts.limit ?? deps.config.pageSize, 1), 50);
  const { where, params } = buildWhere(deps, f);
  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    where.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
    params.push(cursor[0], cursor[0], cursor[1]);
  }
  const rows = await deps.db.all<PostRow>(
    `SELECT ${POST_COLUMNS} FROM posts p WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const more = rows.length > limit;
  const posts = await hydrate(deps, rows.slice(0, limit));
  const last = posts[posts.length - 1];
  return { posts, nextCursor: more && last ? encodeCursor(last) : null };
}

export async function countPosts(deps: Deps, f: PostFilters): Promise<number> {
  const { where, params } = buildWhere(deps, f);
  const row = await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM posts p WHERE ${where.join(" AND ")}`, params);
  return row?.n ?? 0;
}

export async function getPost(deps: Deps, id: number): Promise<PostView | null> {
  const row = await deps.db.first<PostRow>(`SELECT ${POST_COLUMNS} FROM posts p WHERE p.id = ? AND p.deleted = 0`, [id]);
  return row ? ((await hydrate(deps, [row]))[0] ?? null) : null;
}

async function hydrate(deps: Deps, rows: PostRow[]): Promise<PostView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const [media, tags, previews] = await Promise.all([
    deps.db.all<{
      post_id: number;
      kind: MediaKind;
      status: MediaView["status"];
      blob_key: string | null;
      thumb_key: string | null;
      width: number | null;
      height: number | null;
      duration: number | null;
    }>(
      `SELECT post_id, kind, status, blob_key, thumb_key, width, height, duration FROM media
       WHERE post_id IN (${marks}) ORDER BY message_id`,
      ids,
    ),
    deps.db.all<{ post_id: number; tag: string }>(`SELECT post_id, tag FROM post_tags WHERE post_id IN (${marks})`, ids),
    deps.db.all<{
      post_id: number;
      url: string;
      site_name: string | null;
      title: string | null;
      description: string | null;
      image_key: string | null;
      layout: "large" | "small";
      above_text: number;
    }>(`SELECT * FROM link_previews WHERE status = 'ready' AND post_id IN (${marks})`, ids),
  ]);

  const url = (key: string | null) => (key ? mediaUrl(deps, key) : null);
  const { channelUsername } = deps.config;
  return rows.map((r) => {
    const lp = previews.find((p) => p.post_id === r.id);
    return {
      id: r.id,
      html: r.html,
      text: r.text,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      tags: tags.filter((t) => t.post_id === r.id).map((t) => t.tag),
      media: media
        .filter((m) => m.post_id === r.id)
        .map((m) => ({
          kind: m.kind,
          status: m.status,
          url: url(m.blob_key),
          thumb: url(m.thumb_key),
          width: m.width,
          height: m.height,
          duration: m.duration,
        })),
      forward: r.forward ? (JSON.parse(r.forward) as ForwardInfo) : null,
      linkPreview: lp
        ? {
            url: lp.url,
            siteName: lp.site_name,
            title: lp.title,
            description: lp.description,
            image: url(lp.image_key),
            layout: lp.layout,
            aboveText: !!lp.above_text,
          }
        : null,
      tgLink: channelUsername ? `https://t.me/${channelUsername}/${r.tg_message_id}` : null,
    };
  });
}

export const mediaUrl = (deps: Deps, key: string): string => `${deps.config.mediaBase}/${key}`;

export async function listTags(deps: Deps, limit = 50): Promise<{ tag: string; count: number }[]> {
  return deps.db.all<{ tag: string; count: number }>(
    `SELECT t.tag, count(*) AS count FROM post_tags t JOIN posts p ON p.id = t.post_id
     WHERE p.deleted = 0 GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT ?`,
    [limit],
  );
}

/** 按站点时区统计 [from, to] 每天的条数，key 为 YYYY-MM-DD */
export async function dailyCounts(deps: Deps, from: string, to: string): Promise<Record<string, number>> {
  const tz = deps.config.siteTz;
  const rows = await deps.db.all<{ created_at: number }>(
    "SELECT created_at FROM posts WHERE deleted = 0 AND created_at >= ? AND created_at < ?",
    [dayStart(from, tz), dayStart(addDays(to, 1), tz)],
  );
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const k = dayKey(r.created_at, tz);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

export async function siteStats(deps: Deps): Promise<{ posts: number; days: number; media: number }> {
  // 天数按当前偏移近似（固定时区无夏令时时是精确的）
  const offset = tzOffset(nowSeconds(), deps.config.siteTz);
  const [p, m] = await Promise.all([
    deps.db.first<{ posts: number; days: number }>(
      "SELECT count(*) AS posts, count(DISTINCT date(created_at + ?, 'unixepoch')) AS days FROM posts WHERE deleted = 0",
      [offset],
    ),
    deps.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM media m JOIN posts p ON p.id = m.post_id
       WHERE p.deleted = 0 AND m.status IN ('ready', 'too_large')`,
    ),
  ]);
  return { posts: p?.posts ?? 0, days: p?.days ?? 0, media: m?.n ?? 0 };
}
