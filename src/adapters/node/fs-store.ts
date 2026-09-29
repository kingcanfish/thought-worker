import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { resolveRange } from "../../core/lib/range";
import type { BlobBody, BlobObject, BlobPutOptions, BlobStore, ByteRange } from "../../core/ports";

interface Meta {
  contentType: string;
}

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

  async get(key: string, range?: ByteRange): Promise<BlobObject | null> {
    const p = this.path(key);
    const st = await stat(p).catch(() => null);
    if (!st?.isFile()) return null;
    const meta = JSON.parse(await readFile(`${p}.meta.json`, "utf8").catch(() => "{}")) as Partial<Meta>;
    const r = range ? resolveRange(range, st.size) : null;
    if (range && !r) return null;
    const stream = createReadStream(p, r ? { start: r.offset, end: r.offset + r.length - 1 } : {});
    return {
      body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      size: st.size,
      contentType: meta.contentType ?? "application/octet-stream",
      etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      range: r ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const p = this.path(key);
    await rm(p, { force: true });
    await rm(`${p}.meta.json`, { force: true });
  }
}
