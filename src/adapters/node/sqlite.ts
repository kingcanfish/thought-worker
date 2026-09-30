import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Database, RunResult, SqlStatement, SqlValue } from "../../core/ports";

/** Node 内置 SQLite（node:sqlite）实现的 Database */
export class SqliteDatabase implements Database {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (this.raw.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const r = this.raw.prepare(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(r.changes) };
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    // node:sqlite 是同步 API，事务期间不会有其他请求插进来
    this.raw.exec("BEGIN");
    try {
      for (const s of statements) this.raw.prepare(s.sql).run(...((s.params ?? []) as SQLInputValue[]));
      this.raw.exec("COMMIT");
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  close() {
    this.raw.close();
  }
}

/**
 * 按文件名顺序执行 migrations/*.sql。记录表与 wrangler 的 d1_migrations 结构一致，
 * 从 D1 导出的数据库文件可以直接接着用。
 */
export function migrate(db: SqliteDatabase, dir: string): string[] {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const pending: string[] = [];
  for (const name of files) {
    // 接收端和构建端可能同时打开数据库：IMMEDIATE 先拿写锁，再在事务里判断是否已执行，不会重复执行
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      if (!db.raw.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(name)) {
        db.raw.exec(readFileSync(join(dir, name), "utf8"));
        db.raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
        pending.push(name);
      }
      db.raw.exec("COMMIT");
    } catch (e) {
      db.raw.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(e as Error).message}`);
    }
  }
  return pending;
}
