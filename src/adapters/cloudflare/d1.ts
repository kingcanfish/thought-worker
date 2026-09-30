import type { Database, RunResult, SqlStatement, SqlValue } from "../../core/ports";

/** Worker 里通过 D1 binding 访问数据库（接收端写收件箱用） */
export class D1Adapter implements Database {
  constructor(private readonly d1: D1Database) {}

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return (await this.d1.prepare(sql).bind(...params).all<T>()).results;
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.d1.prepare(sql).bind(...params).first<T>()) ?? null;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const r = await this.d1.prepare(sql).bind(...params).run();
    return { changes: r.meta.changes };
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    // D1 的 batch 在一个事务里执行，任何一条失败整批回滚
    await this.d1.batch(statements.map((s) => this.d1.prepare(s.sql).bind(...(s.params ?? []))));
  }
}
