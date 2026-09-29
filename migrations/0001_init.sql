-- 帖子：一条帖子对应一条 TG 消息，或一个相册（多条消息）
CREATE TABLE posts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          INTEGER NOT NULL,
  group_key        TEXT    NOT NULL,            -- g:<media_group_id> | m:<message_id>
  tg_message_id    INTEGER NOT NULL,            -- 帖子里最早的一条消息，用于 t.me 回链
  text_message_id  INTEGER,                     -- 文字来自哪条消息（相册里带 caption 的那条）
  text             TEXT    NOT NULL DEFAULT '',
  entities         TEXT,                        -- JSON
  html             TEXT    NOT NULL DEFAULT '',
  forward          TEXT,                        -- JSON：{ type, name, url? }
  created_at       INTEGER NOT NULL,            -- unix 秒
  edited_at        INTEGER,
  deleted          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chat_id, group_key)
);
CREATE INDEX idx_posts_timeline ON posts (deleted, created_at DESC, id DESC);

-- TG 消息 → 帖子，编辑 / 删除时按 message_id 找回帖子
CREATE TABLE messages (
  chat_id     INTEGER NOT NULL,
  message_id  INTEGER NOT NULL,
  post_id     INTEGER NOT NULL REFERENCES posts (id),
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX idx_messages_post ON messages (post_id);

CREATE TABLE media (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         INTEGER NOT NULL REFERENCES posts (id),
  message_id      INTEGER NOT NULL,             -- 排序用
  kind            TEXT    NOT NULL,             -- photo | video | gif
  file_unique_id  TEXT    NOT NULL,
  blob_key        TEXT,                         -- NULL：未转存（过大 / 失败）
  thumb_key       TEXT,                         -- 图片：中等尺寸；视频 / GIF：封面
  mime            TEXT,
  width           INTEGER,
  height          INTEGER,
  duration        INTEGER,
  size            INTEGER,
  status          TEXT    NOT NULL DEFAULT 'pending',  -- pending | ready | too_large | failed
  UNIQUE (post_id, message_id)
);

CREATE TABLE post_tags (
  post_id  INTEGER NOT NULL REFERENCES posts (id),
  tag      TEXT    NOT NULL,
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX idx_post_tags_tag ON post_tags (tag);

-- 链接预览，一条帖子最多一张卡片
CREATE TABLE link_previews (
  post_id      INTEGER PRIMARY KEY REFERENCES posts (id),
  url          TEXT    NOT NULL,
  site_name    TEXT,
  title        TEXT,
  description  TEXT,
  image_key    TEXT,
  image_w      INTEGER,
  image_h      INTEGER,
  layout       TEXT    NOT NULL DEFAULT 'small',     -- large | small
  above_text   INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'pending',   -- pending | ready | failed
  fetched_at   INTEGER
);

-- 全文检索：trigram 分词，中文 3 个字以上可命中，更短的关键词回退 LIKE
CREATE VIRTUAL TABLE posts_fts USING fts5 (text, content = 'posts', content_rowid = 'id', tokenize = 'trigram');

CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER posts_fts_update AFTER UPDATE OF text ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO posts_fts (rowid, text) VALUES (new.id, new.text);
END;
