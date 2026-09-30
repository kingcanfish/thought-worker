import { resolveRange } from "../../core/lib/range";
import { RangeNotSatisfiableError, type BlobBody, type BlobObject, type BlobPutOptions, type BlobStore, type ByteRange } from "../../core/ports";

export class R2Adapter implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: BlobBody, opts: BlobPutOptions): Promise<void> {
    const httpMetadata = { contentType: opts.contentType };
    if (!(body instanceof ReadableStream)) {
      await this.bucket.put(key, body, { httpMetadata });
      return;
    }
    if (opts.size) {
      // R2 写入流时必须知道长度：用 FixedLengthStream 包一层，全程流式，不占内存
      const fixed = new FixedLengthStream(opts.size);
      const piping = body.pipeTo(fixed.writable);
      await Promise.all([this.bucket.put(key, fixed.readable, { httpMetadata }), piping]);
      return;
    }
    await this.bucket.put(key, await new Response(body).arrayBuffer(), { httpMetadata });
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const h = await this.bucket.head(key);
    return h ? { size: h.size, etag: h.httpEtag } : null;
  }

  async get(key: string, range?: ByteRange): Promise<BlobObject | null> {
    let obj: R2ObjectBody | null;
    try {
      obj = await this.bucket.get(key, range ? { range } : undefined);
    } catch (e) {
      if (!range) throw e;
      // R2 对超出文件末尾的区间会报错：按文件大小截断后重试（HTTP 语义是截断，不是失败）
      const head = await this.bucket.head(key);
      if (!head) return null;
      const clamped = resolveRange(range, head.size);
      if (!clamped) throw new RangeNotSatisfiableError(head.size);
      obj = await this.bucket.get(key, { range: clamped });
    }
    if (!obj) return null;
    const r = range ? resolveRange(range, obj.size) : null;
    if (range && !r) throw new RangeNotSatisfiableError(obj.size);
    return {
      body: obj.body,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      etag: obj.httpEtag,
      range: r ?? undefined,
    };
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys.sort();
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
