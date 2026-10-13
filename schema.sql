CREATE TABLE IF NOT EXISTS campaigns (
  channel_id TEXT PRIMARY KEY,
  setting    TEXT NOT NULL,
  tone       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  lock_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  channel_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  character   TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sheet       TEXT NOT NULL DEFAULT '',
  sheet_url   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, id);

CREATE TABLE IF NOT EXISTS pending (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_channel ON pending (channel_id, id);
