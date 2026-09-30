// 在 Workers 之外（GitHub Actions 上的构建端）通过 Cloudflare API 访问 D1
import type { Database, RunResult, SqlStatement, SqlValue } from "../../core/ports";

export interface D1HttpOptions {
  accountId: string;
  databaseId: string;
  /** 需要 D1 编辑权限 */
  apiToken: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

interface QueryResult {
  results: unknown[];
  success: boolean;
  meta?: { changes?: number };
}

interface QueryResponse {
  success: boolean;
  result?: QueryResult[];
  errors?: { code?: number; message: string }[];
}

const TIMEOUT_MS = 30_000;

export class D1HttpDatabase implements Database {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: D1HttpOptions) {
    const base = (opts.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    this.url = `${base}/accounts/${opts.accountId}/d1/database/${opts.databaseId}/query`;
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** 单条语句或 batch，返回每条语句的结果。不自动重试：写入不一定幂等，失败就让这次构建失败、下次重来 */
  private async query(body: { sql: string; params: SqlValue[] } | { batch: { sql: string; params: SqlValue[] }[] }): Promise<QueryResult[]> {
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data: QueryResponse | null = null;
    try {
      data = JSON.parse(text) as QueryResponse;
    } catch {
      // 不是 JSON（例如网关错误页），下面按状态码报错
    }
    if (!res.ok || !data?.success || !data.result) {
      const reason = data?.errors?.map((e) => e.message).join("; ") || text.slice(0, 200);
      throw new Error(`D1 query failed (${res.status}): ${reason}`);
    }
    return data.result;
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const [r] = await this.query({ sql, params });
    return (r?.results ?? []) as T[];
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const [r] = await this.query({ sql, params });
    return { changes: r?.meta?.changes ?? 0 };
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    if (!statements.length) return;
    await this.query({ batch: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
  }
}
