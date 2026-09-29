import type { Config } from "../../config";
import { timeOfDay } from "../../lib/time";
import type { LinkPreviewView, MediaView, PostView } from "../../services/timeline";
import { WEEKDAY_CN, formatDuration, groupByDay } from "./format";
import { Icon } from "./icons";

export function DaySections(props: { posts: PostView[]; config: Config }) {
  return (
    <>
      {groupByDay(props.posts, props.config.siteTz).map((g) => {
        const [, m, d] = g.key.split("-").map(Number);
        const weekday = new Date(`${g.key}T00:00:00Z`).getUTCDay();
        return (
          <section class="day" data-day={g.key}>
            <div class="day-head">
              <span class="day-num">{d}</span>
              <span class="day-meta">
                {m} 月 · {WEEKDAY_CN[weekday]}
                <em data-rel-day={g.key} />
              </span>
            </div>
            {g.posts.map((p) => (
              <PostItem post={p} config={props.config} />
            ))}
          </section>
        );
      })}
    </>
  );
}

export function PostItem(props: { post: PostView; config: Config }) {
  const { post: p, config } = props;
  const lp = p.linkPreview;
  return (
    <article class="post" id={`p${p.id}`} data-id={p.id}>
      <div class="post-time">
        <a href={`/p/${p.id}`}>{timeOfDay(p.createdAt, config.siteTz)}</a>
        {p.editedAt && <span class="edited">· 已编辑</span>}
      </div>
      {p.forward && (
        <div class="fwd">
          <Icon name="forward" size={13} />
          转发自{" "}
          {p.forward.url ? (
            <a href={p.forward.url} target="_blank" rel="noopener">
              {p.forward.name}
            </a>
          ) : (
            p.forward.name
          )}
        </div>
      )}
      {lp?.aboveText && <LinkCard lp={lp} />}
      {p.html && <div class="content" dangerouslySetInnerHTML={{ __html: p.html }} />}
      <MediaGrid media={p.media} postId={p.id} tgLink={p.tgLink} />
      {lp && !lp.aboveText && <LinkCard lp={lp} />}
      <div class="post-actions">
        <button type="button" data-copy={`/p/${p.id}`}>
          <Icon name="link" size={13} />
          复制链接
        </button>
        {p.tgLink && (
          <a href={p.tgLink} target="_blank" rel="noopener" title="在 Telegram 中查看">
            <Icon name="telegram" size={13} />
            Telegram
          </a>
        )}
      </div>
    </article>
  );
}

const MAX_CELLS = 9;

function MediaGrid(props: { media: MediaView[]; postId: number; tgLink: string | null }) {
  const list = props.media.filter((m) => m.status === "ready" || m.status === "too_large");
  if (!list.length) return null;
  const n = list.length;
  const cls = n === 1 ? "g1" : n === 2 ? "g2" : n === 3 ? "g3" : n === 4 ? "g4" : "gn";
  return (
    <div class={`grid ${cls}`}>
      {list.slice(0, MAX_CELLS).map((m, i) => {
        const style = n === 1 && m.width && m.height ? `aspect-ratio:${m.width}/${m.height}` : undefined;
        const more = i === MAX_CELLS - 1 && n > MAX_CELLS ? <div class="more-badge">+{n - MAX_CELLS}</div> : null;
        const dims = { width: m.width ?? undefined, height: m.height ?? undefined };

        if (m.status === "too_large") {
          return (
            <div class="m static" style={style}>
              {m.thumb && <img loading="lazy" decoding="async" src={m.thumb} alt="" {...dims} />}
              {props.tgLink && (
                <div class="too-large">
                  <a href={props.tgLink} target="_blank" rel="noopener">
                    视频较大 · 在 Telegram 中观看 ↗
                  </a>
                </div>
              )}
              {m.duration != null && <span class="duration">{formatDuration(m.duration)}</span>}
            </div>
          );
        }
        if (m.kind === "gif") {
          return (
            <div class="m static" style={style}>
              <video src={m.url!} poster={m.thumb ?? undefined} autoplay loop muted playsinline preload="metadata" />
              <span class="gif-badge">GIF</span>
            </div>
          );
        }
        if (m.kind === "video") {
          return (
            <div class="m video" style={style} data-video={m.url!}>
              {m.thumb ? (
                <img loading="lazy" decoding="async" src={m.thumb} alt="" {...dims} />
              ) : (
                <video src={`${m.url!}#t=0.1`} preload="metadata" muted playsinline />
              )}
              <div class="play">
                <span>
                  <Icon name="play" size={18} />
                </span>
              </div>
              {m.duration != null && <span class="duration">{formatDuration(m.duration)}</span>}
            </div>
          );
        }
        return (
          <a class="m" style={style} href={m.url!} data-full={m.url!} target="_blank" rel="noopener">
            <img loading="lazy" decoding="async" src={m.thumb ?? m.url!} alt="" {...dims} />
            {more}
          </a>
        );
      })}
    </div>
  );
}

function LinkCard(props: { lp: LinkPreviewView }) {
  const { lp } = props;
  const body = (
    <div class="link-body">
      {lp.siteName && <div class="link-site">{lp.siteName}</div>}
      {lp.title && <div class="link-title">{lp.title}</div>}
      {lp.description && <div class="link-desc">{lp.description}</div>}
    </div>
  );
  if (lp.image && lp.layout === "large") {
    return (
      <a class="link-card" href={lp.url} target="_blank" rel="noopener">
        <img class="cover" loading="lazy" src={lp.image} alt="" />
        {body}
      </a>
    );
  }
  return (
    <a class={`link-card${lp.image ? " small" : ""}`} href={lp.url} target="_blank" rel="noopener">
      {body}
      {lp.image && <img class="thumb" loading="lazy" src={lp.image} alt="" />}
    </a>
  );
}
