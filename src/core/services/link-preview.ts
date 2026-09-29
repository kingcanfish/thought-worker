// 链接预览卡片：抓取网页信息，配图转存到对象存储
import { imageSize } from "../lib/image-size";
import { safeUrl } from "../lib/html";
import { nowSeconds } from "../lib/time";
import { CONTENT_TAG, type Deps } from "../ports";
import { firstLink } from "../telegram/entities";
import type { LinkPreviewPrefs } from "../telegram/normalize";
import type { TgEntity } from "../telegram/types";
import { fetchLinkMeta, readLimited } from "./link-meta";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/jpeg": "jpg" };

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function storeImage(deps: Deps, url: string) {
  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok || !res.body) return null;
    const bytes = await readLimited(res.body, MAX_IMAGE_BYTES, false);
    const info = bytes && imageSize(bytes);
    if (!bytes || !info) return null;
    const key = `link/${(await sha256Hex(url)).slice(0, 32)}.${EXT[info.mime] ?? "img"}`;
    await deps.blobs.put(key, bytes, { contentType: info.mime, size: bytes.byteLength });
    return { key, ...info };
  } catch (e) {
    console.warn("link preview image failed", url, e);
    return null;
  }
}

export async function refreshLinkPreview(deps: Deps, postId: number, prefs?: LinkPreviewPrefs): Promise<void> {
  const post = await deps.db.first<{ text: string; entities: string | null; media: number }>(
    "SELECT text, entities, (SELECT count(*) FROM media WHERE post_id = posts.id) AS media FROM posts WHERE id = ? AND deleted = 0",
    [postId],
  );
  if (!post) return;
  const entities = post.entities ? (JSON.parse(post.entities) as TgEntity[]) : [];
  const preferred = prefs?.url ? safeUrl(prefs.url) : null;
  const url =
    prefs?.disabled || post.media > 0 ? null : (preferred?.startsWith("http") ? preferred : null) ?? firstLink(post.text, entities);

  const existing = await deps.db.first<{ url: string; status: string }>("SELECT url, status FROM link_previews WHERE post_id = ?", [postId]);
  if (!url) {
    if (existing) {
      await deps.db.run("DELETE FROM link_previews WHERE post_id = ?", [postId]);
      await deps.cache.purge([CONTENT_TAG]);
    }
    return;
  }
  if (existing?.url === url && existing.status === "ready") return;

  let meta = null;
  try {
    meta = await fetchLinkMeta(deps.fetch, url);
  } catch (e) {
    console.warn("link preview fetch failed", url, e);
  }
  const img = meta?.image ? await storeImage(deps, meta.image) : null;
  const w = img?.width ?? meta?.imageWidth ?? null;
  const h = img?.height ?? meta?.imageHeight ?? null;
  const wide = !!w && !!h && w / h >= 1.5 && w >= 400;
  const layout = prefs?.preferLarge ? "large" : prefs?.preferSmall ? "small" : wide ? "large" : "small";
  const ok = !!meta && (!!meta.title || !!meta.description);

  await deps.db.run(
    `INSERT INTO link_previews (post_id, url, site_name, title, description, image_key, image_w, image_h, layout, above_text, status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (post_id) DO UPDATE SET
       url = excluded.url, site_name = excluded.site_name, title = excluded.title, description = excluded.description,
       image_key = excluded.image_key, image_w = excluded.image_w, image_h = excluded.image_h, layout = excluded.layout,
       above_text = excluded.above_text, status = excluded.status, fetched_at = excluded.fetched_at`,
    [
      postId,
      url,
      meta?.siteName ?? null,
      meta?.title ?? null,
      meta?.description ?? null,
      img?.key ?? null,
      w,
      h,
      img ? layout : "small",
      prefs?.aboveText ? 1 : 0,
      ok ? "ready" : "failed",
      nowSeconds(),
    ],
  );
  if (ok) await deps.cache.purge([CONTENT_TAG]);
}
