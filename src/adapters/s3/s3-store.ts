// S3 兼容对象存储（Cloudflare R2 / AWS S3 / MinIO …）。构建端在 Workers 之外访问 R2 时用它。
import { AwsClient } from "aws4fetch";
import { decodeEntities } from "../../core/lib/html";
import { resolveRange } from "../../core/lib/range";
import { RangeNotSatisfiableError, type BlobBody, type BlobObject, type BlobPutOptions, type BlobStore, type ByteRange } from "../../core/ports";

export interface S3Options {
  /** 例：https://<account_id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
const xmlValues = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => decodeEntities(m[1]!));

export class S3BlobStore implements BlobStore {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(opts: S3Options) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: "s3",
      region: opts.region ?? "auto",
    });
    this.base = `${opts.endpoint.replace(/\/+$/, "")}/${opts.bucket}`;
  }

  async put(key: string, body: BlobBody, opts: BlobPutOptions): Promise<void> {
    // PutObject 需要 Content-Length，流先读成字节（单个文件 ≤ 下载上限 20MB）
    const bytes: Uint8Array<ArrayBuffer> =
      body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array(body);
    const res = await this.client.fetch(`${this.base}/${encodeKey(key)}`, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": opts.contentType },
    });
    if (!res.ok) throw new Error(`S3 PUT ${key}: ${res.status} ${await res.text()}`);
  }

  async create(key: string, body: Uint8Array<ArrayBuffer>, opts: BlobPutOptions): Promise<boolean> {
    // 条件写入：R2 和 AWS S3 都支持 If-None-Match: *，对象已存在时返回 412
    const res = await this.client.fetch(`${this.base}/${encodeKey(key)}`, {
      method: "PUT",
      body,
      headers: { "content-type": opts.contentType, "if-none-match": "*" },
    });
    if (res.status === 412 || res.status === 409) return false;
    if (!res.ok) throw new Error(`S3 PUT(if-none-match) ${key}: ${res.status} ${await res.text()}`);
    return true;
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const res = await this.client.fetch(`${this.base}/${encodeKey(key)}`, { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD ${key}: ${res.status}`);
    return { size: Number(res.headers.get("content-length") ?? 0), etag: res.headers.get("etag") ?? "" };
  }

  async get(key: string, range?: ByteRange): Promise<BlobObject | null> {
    const headers: Record<string, string> = {};
    if (range) {
      headers.range =
        "suffix" in range ? `bytes=-${range.suffix}` : `bytes=${range.offset}-${range.length ? range.offset + range.length - 1 : ""}`;
    }
    const res = await this.client.fetch(`${this.base}/${encodeKey(key)}`, { headers });
    if (res.status === 404) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    if (res.status === 416) {
      res.body?.cancel().catch(() => {});
      // 不是所有 S3 实现都在 416 里带 Content-Range，拿不到就 HEAD 一次（只在越界请求时发生）
      let size = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? NaN);
      if (!Number.isFinite(size)) {
        const head = await this.client.fetch(`${this.base}/${encodeKey(key)}`, { method: "HEAD" });
        size = Number(head.headers.get("content-length") ?? 0);
      }
      throw new RangeNotSatisfiableError(size);
    }
    if (!res.ok || !res.body) throw new Error(`S3 GET ${key}: ${res.status}`);

    const cr = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get("content-range") ?? "");
    const size = cr ? Number(cr[3]) : Number(res.headers.get("content-length"));
    return {
      body: res.body,
      size,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      etag: res.headers.get("etag") ?? `"${size}"`,
      range: cr ? { offset: Number(cr[1]), length: Number(cr[2]) - Number(cr[1]) + 1 } : range ? (resolveRange(range, size) ?? undefined) : undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(`${this.base}/${encodeKey(key)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key}: ${res.status}`);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const qs = new URLSearchParams({ "list-type": "2", prefix });
      if (token) qs.set("continuation-token", token);
      const res = await this.client.fetch(`${this.base}?${qs}`);
      const xml = await res.text();
      if (!res.ok) throw new Error(`S3 LIST ${prefix}: ${res.status} ${xml}`);
      keys.push(...xmlValues(xml, "Key"));
      token = xmlValues(xml, "IsTruncated")[0] === "true" ? xmlValues(xml, "NextContinuationToken")[0] : undefined;
    } while (token);
    return keys.sort();
  }
}
