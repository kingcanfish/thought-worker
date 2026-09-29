import type { TgForwardOrigin, TgUser } from "./types";

export interface ForwardInfo {
  type: TgForwardOrigin["type"];
  name: string;
  url?: string;
}

const userName = (u: TgUser): string => [u.first_name, u.last_name].filter(Boolean).join(" ");

export function describeForward(o: TgForwardOrigin): ForwardInfo {
  switch (o.type) {
    case "channel":
      return {
        type: o.type,
        name: o.chat.title ?? o.chat.username ?? "频道",
        url: o.chat.username ? `https://t.me/${o.chat.username}/${o.message_id}` : undefined,
      };
    case "chat":
      return {
        type: o.type,
        name: o.sender_chat.title ?? o.sender_chat.username ?? "群组",
        url: o.sender_chat.username ? `https://t.me/${o.sender_chat.username}` : undefined,
      };
    case "user":
      return {
        type: o.type,
        name: userName(o.sender_user),
        url: o.sender_user.username ? `https://t.me/${o.sender_user.username}` : undefined,
      };
    case "hidden_user":
      return { type: o.type, name: o.sender_user_name };
  }
}
