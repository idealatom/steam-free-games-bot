PRAGMA foreign_keys = ON;

CREATE TABLE subscribers (
  chat_id INTEGER PRIMARY KEY,
  subscribed_at INTEGER NOT NULL
);

CREATE TABLE offers (
  app_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE TABLE deliveries (
  chat_id INTEGER NOT NULL REFERENCES subscribers(chat_id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES offers(app_id) ON DELETE CASCADE,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, app_id)
);

CREATE INDEX deliveries_app_id ON deliveries(app_id);
