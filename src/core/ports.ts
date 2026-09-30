// 平台接口：核心逻辑只依赖这些接口，各平台提供实现（见 src/adapters）
import type { Config } from "./config";

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface RunResult {
  changes: number;
}

/** SQLite 方言的最小数据库接口 */
export interface Database {
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null>;
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  /** 在一个事务里依次执行 */
  batch(statements: SqlStatement[]): Promise<void>;
}

export type BlobBody = ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer;

export interface BlobPutOptions {
  contentType: string;
  /** 已知长度时传入；部分存储（如 R2 binding）写入流时需要 */
  size?: number;
}

/** offset + length，或只取末尾 suffix 个字节 */
export type ByteRange = { offset: number; length?: number } | { suffix: number };

export interface BlobObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
  etag: string;
  /** 请求了 range 时，实际返回的区间 */
  range?: { offset: number; length: number };
}

/** 请求的区间超出了文件范围（HTTP 416） */
export class RangeNotSatisfiableError extends Error {
  constructor(readonly size: number) {
    super("range not satisfiable");
  }
}

/** 对象存储（R2、S3、本地磁盘 …） */
export interface BlobStore {
  put(key: string, body: BlobBody, opts: BlobPutOptions): Promise<void>;
  /** 仅当 key 不存在时写入，返回是否写入成功（用于构建锁） */
  create(key: string, body: Uint8Array<ArrayBuffer>, opts: BlobPutOptions): Promise<boolean>;
  /** 只取元信息，不存在返回 null */
  head(key: string): Promise<{ size: number; etag: string } | null>;
  /** 不存在返回 null；区间无法满足抛 RangeNotSatisfiableError */
  get(key: string, range?: ByteRange): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
  /** 按 key 字典序列出某个前缀下的全部 key */
  list(prefix: string): Promise<string[]>;
}

/**
 * 两个存储分开：media 只放图片视频（可以整体公开，例如绑定 R2 自定义域名直出）；
 * data 放收件箱和数据库文件，永远不能公开。
 */
export interface Stores {
  media: BlobStore;
  data: BlobStore;
}

/**
 * 图片压缩（构建端可选）：返回压缩后的内容；不支持的格式、或压缩后没有变小时返回 null，保留原图。
 */
export type ImageOptimizer = (bytes: Uint8Array, mime: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;

/** 构建端依赖 */
export interface Deps {
  config: Config;
  db: Database;
  /** 媒体存储 */
  blobs: BlobStore;
  fetch: typeof fetch;
  optimizeImage?: ImageOptimizer;
}

/** 边缘缓存（如 Workers Cache API）：命中就不再读媒体存储 */
export interface MediaCache {
  /** 用原始请求匹配（带上 Range / If-None-Match，由缓存自己处理） */
  match(key: string, req: Request): Promise<Response | undefined>;
  /** 后台写入，不阻塞响应 */
  put(key: string, res: Response): void;
}

/** 接收端依赖 */
export interface ReceiverDeps {
  config: Config;
  stores: Stores;
  fetch: typeof fetch;
  mediaCache?: MediaCache;
}
