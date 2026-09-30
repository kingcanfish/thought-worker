-- 收件箱：接收端把 webhook 原样写进来，构建端按 update_id 顺序处理，部署成功后删除。
-- update_id 单调递增，就是 Telegram 的投递顺序；重复投递命中主键被忽略
CREATE TABLE inbox (
  update_id    INTEGER PRIMARY KEY,
  body         TEXT    NOT NULL,             -- 原始 JSON
  received_at  INTEGER NOT NULL              -- unix 毫秒
);

-- 构建锁：只有一行，同一时间只跑一个构建
CREATE TABLE build_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  token        TEXT    NOT NULL,             -- 持有者的随机令牌
  acquired_at  INTEGER NOT NULL              -- unix 毫秒，超过 TTL 视为异常退出留下的
);

-- 站点状态：只有一行。publish_pending = 1 表示数据库里有还没发布到站点的变化（例如重试修好了媒体但部署失败），
-- 下次构建即使收件箱为空也要重新渲染；部署成功后清零
CREATE TABLE site_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  publish_pending  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO site_state (id) VALUES (1);
