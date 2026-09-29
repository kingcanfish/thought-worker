import { resolveRange } from "../../core/lib/range";
import type { BlobBody, BlobObject, BlobPutOptions, BlobStore, ByteRange } from "../../core/ports";

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

  async get(key: string, range?: ByteRange): Promise<BlobObject | null> {
    let r: { offset: number; length: number } | null = null;
    if (range) {
      // 先 head 拿到大小，把区间收敛到文件范围内，行为与其他存储一致
      const head = await this.bucket.head(key);
      if (!head) return null;
      r = resolveRange(range, head.size);
      if (!r) return null;
    }
    const obj = await this.bucket.get(key, r ? { range: r } : undefined);
    if (!obj) return null;
    return {
      body: obj.body,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      etag: obj.httpEtag,
      range: r ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
