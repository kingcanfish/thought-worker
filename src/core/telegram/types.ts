// Bot API 类型的最小子集，只列用到的字段：https://core.telegram.org/bots/api

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  user?: TgUser;
  custom_emoji_id?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
  thumbnail?: TgPhotoSize;
}

export type TgAnimation = TgVideo;

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
  thumbnail?: TgPhotoSize;
}

export type TgForwardOrigin =
  | { type: "user"; date: number; sender_user: TgUser }
  | { type: "hidden_user"; date: number; sender_user_name: string }
  | { type: "chat"; date: number; sender_chat: TgChat; author_signature?: string }
  | { type: "channel"; date: number; chat: TgChat; message_id: number; author_signature?: string };

export interface TgLinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_small_media?: boolean;
  prefer_large_media?: boolean;
  show_above_text?: boolean;
}

export interface TgMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: TgChat;
  media_group_id?: string;
  text?: string;
  entities?: TgEntity[];
  caption?: string;
  caption_entities?: TgEntity[];
  photo?: TgPhotoSize[];
  video?: TgVideo;
  animation?: TgAnimation;
  document?: TgDocument;
  forward_origin?: TgForwardOrigin;
  reply_to_message?: TgMessage;
  link_preview_options?: TgLinkPreviewOptions;
}

export interface TgUpdate {
  update_id: number;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}
