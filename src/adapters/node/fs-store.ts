import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { resolveRange } from "../../core/lib/range";
import { RangeNotSatisfiableError, type BlobBody, type BlobObject, type BlobPutOptions, type BlobStore, type ByteRange } from "../../core/ports";

interface Meta {
  contentType: string;
}

// 大小 + 修改时间（mtimeMs 带小数，精度到亚毫秒）
const etagOf = (st: { size: number; mtimeMs: number }) => `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;

/** 本地磁盘实现的 BlobStore：文件按 key 存放，旁边一个 .meta.json 记录类型 */
export class FsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`invalid key: ${key}`);
    return p;
  }

  async put(key: string, body: BlobBody, opts: BlobPutOptions): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    try {
      if (body instanceof ReadableStream) {
        await pipeline(Readable.fromWeb(body as NodeWebStream<Uint8Array>), createWriteStream(tmp));
      } else {
        await writeFile(tmp, body instanceof ArrayBuffer ? new Uint8Array(body) : body);
      }
      await writeFile(`${p}.meta.json`, JSON.stringify({ contentType: opts.contentType } satisfies Meta));
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const st = await stat(this.path(key)).catch(() => null);
    return st?.isFile() ? { size: st.size, etag: etagOf(st) } : null;
  }

  async get(key: string, range?: ByteRange): Promise<BlobObject | null> {
    const p = this.path(key);
    const st = await stat(p).catch(() => null);
    if (!st?.isFile()) return null;
    const meta = JSON.parse(await readFile(`${p}.meta.json`, "utf8").catch(() => "{}")) as Partial<Meta>;
    const r = range ? resolveRange(range, st.size) : null;
    if (range && !r) throw new RangeNotSatisfiableError(st.size);
    const stream = createReadStream(p, r ? { start: r.offset, end: r.offset + r.length - 1 } : {});
    return {
      body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      size: st.size,
      contentType: meta.contentType ?? "application/octet-stream",
      etag: etagOf(st),
      range: r ?? undefined,
    };
  }

  async list(prefix: string): Promise<string[]> {
    const dir = resolve(this.root, prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : ".");
    if (!dir.startsWith(this.root)) return [];
    const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isFile() && !e.name.endsWith(".meta.json") && !e.name.endsWith(".tmp"))
      .map((e) => relative(this.root, resolve(e.parentPath, e.name)).split(sep).join("/"))
      .filter((k) => k.startsWith(prefix))
      .sort();
  }

  async delete(key: string): Promise<void> {
    const p = this.path(key);
    await rm(p, { force: true });
    await rm(`${p}.meta.json`, { force: true });
  }
}
