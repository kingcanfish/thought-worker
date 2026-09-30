// 收件箱（inbox 表）：接收端把 webhook 原样写进来，构建端按 update_id 顺序取出处理，部署成功后删除。
// update_id 单调递增，就是 Telegram 的投递顺序；重复投递命中主键被忽略，天然幂等。
import type { Database, SqlStatement } from "../ports";
import type { TgUpdate } from "../telegram/types";

const MAX_UPDATE_BYTES = 1024 * 1024;
/** D1 单条语句最多 100 个绑定参数（再留一个给锁令牌） */
const DELETE_CHUNK = 90;

/** 语句只在锁仍由 token 持有时生效：检查和写入在同一条语句里，不会被接管的锁插进来 */
export const LOCK_HELD = "EXISTS (SELECT 1 FROM build_lock WHERE id = 1 AND token = ?)";

export type StoreResult = { ok: true; update: TgUpdate } | { ok: false; status: 400 | 413; reason: string };

export interface InboxItem {
  updateId: number;
  /** 无法解析时为 null（照样会被删掉，不会卡住后面的消息） */
  update: TgUpdate | null;
}

export async function storeUpdate(db: Database, raw: string): Promise<StoreResult> {
  if (raw.length > MAX_UPDATE_BYTES) return { ok: false, status: 413, reason: "update too large" };
  let update: TgUpdate;
  try {
    update = JSON.parse(raw) as TgUpdate;
  } catch {
    return { ok: false, status: 400, reason: "invalid json" };
  }
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return { ok: false, status: 400, reason: "missing update_id" };
  }
  await db.run("INSERT INTO inbox (update_id, body, received_at) VALUES (?, ?, ?) ON CONFLICT (update_id) DO NOTHING", [
    update.update_id,
    raw,
    Date.now(),
  ]);
  return { ok: true, update };
}

export async function readInbox(db: Database): Promise<InboxItem[]> {
  const rows = await db.all<{ update_id: number; body: string }>("SELECT update_id, body FROM inbox ORDER BY update_id");
  return rows.map((r) => {
    try {
      return { updateId: r.update_id, update: JSON.parse(r.body) as TgUpdate };
    } catch {
      return { updateId: r.update_id, update: null };
    }
  });
}

/** 删除这次处理过的收件箱记录（构建期间新到的留给下一次）；锁已被别人接管时什么都不删 */
export function clearInboxStatements(ids: number[], lockToken: string): SqlStatement[] {
  const stmts: SqlStatement[] = [];
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    stmts.push({
      sql: `DELETE FROM inbox WHERE update_id IN (${chunk.map(() => "?").join(",")}) AND ${LOCK_HELD}`,
      params: [...chunk, lockToken],
    });
  }
  return stmts;
}
