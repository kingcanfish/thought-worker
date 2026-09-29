import type { Child } from "hono/jsx";
import type { Config } from "../../config";

/** 改了 public/assets 下的文件就把它加一，让浏览器重新下载 */
export const ASSET_VERSION = "2";

export interface Meta {
  title: string;
  description?: string;
  url?: string;
  image?: string | null;
  type?: "website" | "article";
}

const THEME_INIT = `try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export function Layout(props: { config: Config; meta: Meta; origin: string; buildId?: string; children: Child }) {
  const { config, meta, origin } = props;
  return (
    <html lang="zh-CN" data-tz={config.siteTz} data-build={props.buildId}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#faf8f5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#161514" media="(prefers-color-scheme: dark)" />
        <title>{meta.title}</title>
        {meta.description && <meta name="description" content={meta.description} />}
        <meta property="og:site_name" content={config.siteTitle} />
        <meta property="og:title" content={meta.title} />
        <meta property="og:type" content={meta.type ?? "website"} />
        {meta.url && <meta property="og:url" content={meta.url} />}
        {meta.description && <meta property="og:description" content={meta.description} />}
        {meta.image && <meta property="og:image" content={meta.image} />}
        <meta name="twitter:card" content={meta.image ? "summary_large_image" : "summary"} />
        <link rel="alternate" type="application/rss+xml" title={config.siteTitle} href={`${origin}/rss.xml`} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&display=swap" rel="stylesheet" />
        <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
        <link rel="stylesheet" href={`/assets/app.css?v=${ASSET_VERSION}`} />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        {props.children}
        <script src={`/assets/app.js?v=${ASSET_VERSION}`} defer />
      </body>
    </html>
  );
}
