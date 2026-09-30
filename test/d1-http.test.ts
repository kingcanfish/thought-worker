// 构建端访问 D1 的 HTTP 适配器：请求格式和错误处理（真实 D1 在部署时验证）
import { describe, expect, it } from "vitest";
import { D1HttpDatabase } from "../src/adapters/d1/http";

function fakeApi(respond: (body: Record<string, unknown>) => Response) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fn: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body });
    return respond(body);
  };
  const db = new D1HttpDatabase({ accountId: "acc", databaseId: "dbid", apiToken: "tok", fetch: fn });
  return { db, calls };
}

const ok = (result: unknown[]) => Response.json({ success: true, errors: [], result });

describe("D1HttpDatabase", () => {
  it("sends single statements with params and reads rows and changes", async () => {
    const { db, calls } = fakeApi((b) =>
      String(b.sql).startsWith("SELECT") ? ok([{ success: true, results: [{ id: 1 }, { id: 2 }], meta: {} }]) : ok([{ success: true, results: [], meta: { changes: 3 } }]),
    );
    expect(await db.all("SELECT id FROM posts WHERE deleted = ?", [0])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await db.first("SELECT id FROM posts")).toEqual({ id: 1 });
    expect(await db.run("UPDATE posts SET deleted = 1")).toEqual({ changes: 3 });
    expect(calls[0]).toEqual({
      url: "https://api.cloudflare.com/client/v4/accounts/acc/d1/database/dbid/query",
      auth: "Bearer tok",
      body: { sql: "SELECT id FROM posts WHERE deleted = ?", params: [0] },
    });
    expect(calls[2]!.body).toEqual({ sql: "UPDATE posts SET deleted = 1", params: [] });
  });

  it("sends batches in one request and skips empty ones", async () => {
    const { db, calls } = fakeApi(() => ok([]));
    await db.batch([]);
    expect(calls).toHaveLength(0);
    await db.batch([{ sql: "DELETE FROM inbox WHERE update_id = ?", params: [1] }, { sql: "DELETE FROM build_lock" }]);
    expect(calls[0]!.body).toEqual({
      batch: [
        { sql: "DELETE FROM inbox WHERE update_id = ?", params: [1] },
        { sql: "DELETE FROM build_lock", params: [] },
      ],
    });
  });

  it("surfaces API errors and non-JSON responses", async () => {
    const api = fakeApi(() => Response.json({ success: false, errors: [{ code: 7500, message: "no such table: inbox" }] }, { status: 400 }));
    await expect(api.db.all("SELECT * FROM inbox")).rejects.toThrow("D1 query failed (400): no such table: inbox");
    const gw = fakeApi(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(gw.db.run("SELECT 1")).rejects.toThrow("D1 query failed (502): <html>bad gateway</html>");
  });
});
