// 平台接口：核心逻辑只依赖这些接口，Cloudflare / Node 各自提供实现（见 src/adapters）
import type { Config } from "./config";

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface RunResult {
  changes: number;
}

/** SQLite 方言的最小数据库接口（D1、node:sqlite 都能实现） */
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
  /** 已知长度时传入；部分存储（如 R2）写入流时需要 */
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

/** 对象存储（R2、本地磁盘、S3 …） */
export interface BlobStore {
  put(key: string, body: BlobBody, opts: BlobPutOptions): Promise<void>;
  get(key: string, range?: ByteRange): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
}

/** 响应缓存的失效：页面带 Cache-Tag 头，内容变化时按标签清除 */
export interface ResponseCache {
  purge(tags: string[]): Promise<void>;
}

/** 响应返回后继续执行的后台任务（Workers 的 waitUntil / Node 的游离 Promise） */
export interface BackgroundTasks {
  run(task: () => Promise<unknown>): void;
}

export interface Deps {
  config: Config;
  db: Database;
  blobs: BlobStore;
  cache: ResponseCache;
  tasks: BackgroundTasks;
  fetch: typeof fetch;
}

/** 缓存标签：所有依赖帖子内容的响应都打这个标签 */
export const CONTENT_TAG = "content";
