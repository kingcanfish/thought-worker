// MEDIA_BASE=/m 时由应用转发对象存储里的文件；换成对象存储直出域名后这个路由就用不到了
import { Hono } from "hono";
import type { ByteRange } from "../../ports";
import type { AppEnv } from "../app";
import { IMMUTABLE } from "../cache";

const KEY_RE = /^[\w-]+(\/[\w.-]+)+$/;

/** 只支持单段 Range：bytes=a-b / bytes=a- / bytes=-n */
export function parseRange(header: string | undefined): ByteRange | "invalid" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (m[1] === "") return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === "") return { offset };
  const end = Number(m[2]);
  return end < offset ? "invalid" : { offset, length: end - offset + 1 };
}

export const mediaRoutes = new Hono<AppEnv>().on(["GET", "HEAD"], "/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/m\//, ""));
  if (!KEY_RE.test(key) || key.includes("..")) return c.notFound();

  const range = parseRange(c.req.header("range"));
  if (range === "invalid") return c.body(null, 416);
  const obj = await c.var.deps.blobs.get(key, range);
  if (!obj) return c.notFound();

  const headers = new Headers({
    "Content-Type": obj.contentType,
    "Cache-Control": IMMUTABLE,
    "Accept-Ranges": "bytes",
    ETag: obj.etag,
  });
  if (c.req.header("if-none-match") === obj.etag) {
    obj.body.cancel().catch(() => {});
    return new Response(null, { status: 304, headers });
  }
  if (obj.range) {
    headers.set("Content-Range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
    headers.set("Content-Length", String(obj.range.length));
  } else {
    headers.set("Content-Length", String(obj.size));
  }
  if (c.req.method === "HEAD") {
    obj.body.cancel().catch(() => {});
    return new Response(null, { status: obj.range ? 206 : 200, headers });
  }
  return new Response(obj.body, { status: obj.range ? 206 : 200, headers });
});
