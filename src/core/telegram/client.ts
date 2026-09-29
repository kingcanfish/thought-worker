import type { TgFile } from "./types";

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
  ) {
    super(`${method}: ${code} ${description}`);
  }
}

/**
 * Bot API 客户端。apiBase 可以换成自建的 Local Bot API Server，
 * 这样就能下载超过 20MB 的文件。
 */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly apiBase: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok: true; result: T }
      | { ok: false; error_code: number; description: string }
      | null;
    if (!data) throw new TelegramError(method, res.status, "invalid response");
    if (!data.ok) throw new TelegramError(method, data.error_code, data.description);
    return data.result;
  }

  getFile(fileId: string): Promise<TgFile> {
    return this.call<TgFile>("getFile", { file_id: fileId });
  }

  /** 下载 getFile 返回的 file_path；链接里带 token，绝不能暴露给前端 */
  async download(filePath: string): Promise<Response> {
    const res = await this.fetchFn(`${this.apiBase}/file/bot${this.token}/${filePath}`);
    if (!res.ok || !res.body) throw new TelegramError("download", res.status, res.statusText);
    return res;
  }

  deleteMessages(chatId: number, messageIds: number[]): Promise<boolean> {
    return this.call<boolean>("deleteMessages", { chat_id: chatId, message_ids: messageIds });
  }
}
