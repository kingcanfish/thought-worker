import type { Database, RunResult, SqlStatement, SqlValue } from "../../core/ports";

export class D1Adapter implements Database {
  constructor(private readonly d1: D1Database) {}

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const r = await this.d1.prepare(sql).bind(...params).all<T>();
    return r.results;
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.d1.prepare(sql).bind(...params).first<T>()) ?? null;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const r = await this.d1.prepare(sql).bind(...params).run();
    return { changes: r.meta.changes };
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    if (!statements.length) return;
    // D1 的 batch 本身就是一个事务
    await this.d1.batch(statements.map((s) => this.d1.prepare(s.sql).bind(...(s.params ?? []))));
  }
}
