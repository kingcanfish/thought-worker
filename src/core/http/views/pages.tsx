import type { Config } from "../../config";
import { addDays, weekdayOf } from "../../lib/time";
import type { PostView } from "../../services/timeline";
import { Icon } from "./icons";
import { Layout, type Meta } from "./layout";
import { DaySections } from "./post";

/** 热力图显示的周数 */
export const HEATMAP_WEEKS = 20;

export interface HomeData {
  config: Config;
  origin: string;
  buildId: string;
  /** 首屏直接渲染的帖子（不开 JS 也能看）；其余由前端从 /data 加载 */
  posts: PostView[];
  total: number;
  stats: { posts: number; days: number; media: number };
  tags: { tag: string; count: number }[];
  heatmap: { from: string; to: string; counts: Record<string, number> };
}

const fmtMD = (key: string) => {
  const [, m, d] = key.split("-").map(Number);
  return `${m}月${d}日`;
};

export function heatmapRange(today: string): { from: string; to: string } {
  return { from: addDays(today, -((HEATMAP_WEEKS - 1) * 7 + weekdayOf(today))), to: today };
}

function Avatar(props: { config: Config }) {
  const a = props.config.siteAvatar;
  return /^(https?:)?\/\//.test(a) || a.startsWith("/") ? (
    <img class="avatar" src={a} alt="" />
  ) : (
    <div class="avatar">{[...a][0]}</div>
  );
}

function Sidebar(props: HomeData) {
  const { config, stats, tags, heatmap } = props;
  const cells: string[] = [];
  for (let d = heatmap.from; d <= heatmap.to; d = addDays(d, 1)) cells.push(d);
  return (
    <aside>
      <Avatar config={config} />
      <h1 class="name">
        <a href="/">{config.siteTitle}</a>
      </h1>
      {config.siteDescription && <p class="bio">{config.siteDescription}</p>}
      <div class="stats">
        <div class="stat">
          <b>{stats.posts}</b>
          <span>条</span>
        </div>
        <div class="stat">
          <b>{stats.days}</b>
          <span>天</span>
        </div>
        <div class="stat">
          <b>{stats.media}</b>
          <span>图 / 视频</span>
        </div>
      </div>
      <div class="heatmap-wrap">
        <p class="section-title">最近 {HEATMAP_WEEKS} 周</p>
        <div class="heatmap" id="heatmap">
          {cells.map((d) => {
            const c = heatmap.counts[d] ?? 0;
            return <i data-l={Math.min(c, 4)} data-day={d} title={`${fmtMD(d)} · ${c ? `${c} 条` : "没有碎碎念"}`} />;
          })}
        </div>
        <div class="heatmap-legend">
          <span>点格子按天筛选</span>
          <span>
            少<i data-l="0" />
            <i data-l="1" />
            <i data-l="2" />
            <i data-l="3" />
            <i data-l="4" />多
          </span>
        </div>
      </div>
      {tags.length > 0 && (
        <div class="tags-wrap">
          <p class="section-title">标签</p>
          <div class="tags" id="tags">
            {tags.map((t) => (
              <a class="tag-chip" href={`/?tag=${encodeURIComponent(t.tag)}`} data-tag={t.tag}>
                #{t.tag}
                <small>{t.count}</small>
              </a>
            ))}
          </div>
        </div>
      )}
      <div class="side-foot">
        {config.channelUsername && (
          <a href={`https://t.me/${config.channelUsername}`} target="_blank" rel="noopener">
            Telegram
          </a>
        )}
        <a href="/rss.xml">RSS</a>
      </div>
    </aside>
  );
}

export function TimelineBody(props: { config: Config; posts: PostView[] }) {
  if (props.posts.length) return <DaySections posts={props.posts} config={props.config} />;
  return <div class="empty">还没有碎碎念，去频道里发一条吧。</div>;
}

function Toolbar() {
  return (
    <div class="toolbar">
      <form class="search" action="/" method="get" role="search">
        <Icon name="search" size={16} />
        <input id="q" name="q" type="search" placeholder="搜索碎碎念…" autocomplete="off" />
      </form>
      <div class="cal-wrap">
        <button type="button" class="icon-btn" id="cal-btn" title="按日期筛选" aria-label="按日期筛选" aria-expanded="false">
          <Icon name="calendar" />
        </button>
        <div class="sheet-mask" id="mask" />
        <div class="cal" id="cal" hidden>
          <div class="cal-head">
            <button type="button" data-cal="-1" aria-label="上个月">
              <Icon name="left" size={14} />
            </button>
            <span id="cal-title" />
            <button type="button" data-cal="1" aria-label="下个月">
              <Icon name="right" size={14} />
            </button>
          </div>
          <div class="cal-week">
            {["日", "一", "二", "三", "四", "五", "六"].map((d) => (
              <span>{d}</span>
            ))}
          </div>
          <div class="cal-days" id="cal-days" />
          <div class="cal-presets">
            <button type="button" data-preset="0">今天</button>
            <button type="button" data-preset="6">近 7 天</button>
            <button type="button" data-preset="29">近 30 天</button>
            <button type="button" data-preset="clear">清除</button>
          </div>
          <p class="cal-hint" id="cal-hint">点一下选单日，再点一下选成区间</p>
        </div>
      </div>
      <ThemeButton />
    </div>
  );
}

const ThemeButton = () => (
  <button type="button" class="icon-btn" id="theme" title="切换主题" aria-label="切换主题">
    <Icon name="moon" />
  </button>
);

function Overlays() {
  return (
    <>
      <div class="lb" id="lb" role="dialog" aria-modal="true">
        <button type="button" class="lb-btn lb-close" data-act="close" aria-label="关闭">
          <Icon name="close" size={18} />
        </button>
        <button type="button" class="lb-btn lb-prev" data-act="prev" aria-label="上一张">
          <Icon name="left" size={18} />
        </button>
        <img id="lb-img" alt="" />
        <button type="button" class="lb-btn lb-next" data-act="next" aria-label="下一张">
          <Icon name="right" size={18} />
        </button>
        <div class="lb-count" id="lb-count" />
      </div>
      <div class="toast" id="toast" />
      <button type="button" class="to-top" id="to-top" aria-label="回到顶部">
        <Icon name="up" size={18} />
      </button>
    </>
  );
}

export function HomePage(props: HomeData) {
  const { config, origin, posts } = props;
  const meta: Meta = { title: config.siteTitle, description: config.siteDescription, url: `${origin}/` };
  const more = props.total > posts.length;
  return (
    <Layout config={config} meta={meta} origin={origin} buildId={props.buildId}>
      <div class="shell">
        <Sidebar {...props} />
        <main>
          <div class="topbar" id="topbar">
            <Toolbar />
            <div class="filter-bar" id="filter" />
          </div>
          <div id="timeline">
            <TimelineBody config={config} posts={posts} />
          </div>
          <div class="end" id="end">
            {more ? "加载中…" : posts.length ? "— 到底啦 —" : ""}
          </div>
        </main>
      </div>
      <Overlays />
    </Layout>
  );
}

export function PostPage(props: { config: Config; origin: string; buildId: string; post: PostView; image: string | null; description: string }) {
  const { config, origin, post } = props;
  const meta: Meta = {
    title: `${props.description ? `${props.description.slice(0, 30)} · ` : ""}${config.siteTitle}`,
    description: props.description || config.siteDescription,
    url: `${origin}/p/${post.id}`,
    image: props.image,
    type: "article",
  };
  return (
    <Layout config={config} meta={meta} origin={origin} buildId={props.buildId}>
      <div class="single">
        <header class="single-head">
          <a href="/" class="back">
            <Icon name="back" size={16} />
            {config.siteTitle}
          </a>
          <ThemeButton />
        </header>
        <div id="timeline">
          <DaySections posts={[post]} config={config} />
        </div>
      </div>
      <Overlays />
    </Layout>
  );
}

export function NotFoundPage(props: { config: Config; origin: string }) {
  return (
    <Layout config={props.config} meta={{ title: `找不到 · ${props.config.siteTitle}` }} origin={props.origin}>
      <div class="single">
        <header class="single-head">
          <a href="/" class="back">
            <Icon name="back" size={16} />
            {props.config.siteTitle}
          </a>
        </header>
        <div class="empty">这条碎碎念不见了，可能已经被删掉。</div>
      </div>
    </Layout>
  );
}

