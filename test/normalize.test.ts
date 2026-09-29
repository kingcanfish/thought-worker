import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../src/core/telegram/normalize";
import type { TgMessage } from "../src/core/telegram/types";

const chat = { id: -100123, type: "channel", title: "c" };
const base = { message_id: 10, date: 1759132800, chat };

describe("normalizeMessage", () => {
  it("picks the largest photo and a ~720px thumbnail", () => {
    const n = normalizeMessage({
      ...base,
      caption: "hi",
      photo: [
        { file_id: "s", file_unique_id: "us", width: 90, height: 60 },
        { file_id: "m", file_unique_id: "um", width: 800, height: 533 },
        { file_id: "l", file_unique_id: "ul", width: 1280, height: 853 },
      ],
    });
    expect(n.text).toBe("hi");
    expect(n.groupKey).toBe("m:10");
    expect(n.media[0]).toMatchObject({ kind: "photo", fileId: "l", width: 1280, thumb: { fileId: "m" } });
  });

  it("groups album messages by media_group_id", () => {
    const n = normalizeMessage({ ...base, media_group_id: "g1", photo: [{ file_id: "a", file_unique_id: "ua", width: 10, height: 10 }] });
    expect(n.groupKey).toBe("g:g1");
    expect(n.isAlbum).toBe(true);
    expect(n.media[0]?.thumb).toBeUndefined();
  });

  it("treats animation as gif even though document is also set", () => {
    const anim = { file_id: "g", file_unique_id: "ug", width: 320, height: 240, duration: 3, mime_type: "video/mp4" };
    const n = normalizeMessage({ ...base, animation: anim, document: { file_id: "g", file_unique_id: "ug", mime_type: "video/mp4" } });
    expect(n.media).toHaveLength(1);
    expect(n.media[0]?.kind).toBe("gif");
  });

  it("detects /del replies", () => {
    const n = normalizeMessage({
      ...base,
      text: "/del@mybot",
      entities: [{ type: "bot_command", offset: 0, length: 10 }],
      reply_to_message: { ...base, message_id: 7 } as TgMessage,
    });
    expect(n.command).toBe("del");
    expect(n.replyToMessageId).toBe(7);
  });

  it("does not treat other commands as /del", () => {
    const n = normalizeMessage({ ...base, text: "/delete", entities: [{ type: "bot_command", offset: 0, length: 7 }] });
    expect(n.command).toBeUndefined();
  });

  it("describes forward origin with a t.me link for public channels", () => {
    const n = normalizeMessage({
      ...base,
      text: "x",
      forward_origin: { type: "channel", date: 1, chat: { id: 1, type: "channel", title: "每日一图", username: "daily" }, message_id: 88 },
    });
    expect(n.forward).toEqual({ type: "channel", name: "每日一图", url: "https://t.me/daily/88" });
  });

  it("keeps link preview preferences", () => {
    const n = normalizeMessage({ ...base, text: "x", link_preview_options: { is_disabled: true } });
    expect(n.linkPreview?.disabled).toBe(true);
  });
});
