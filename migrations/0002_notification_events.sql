PRAGMA foreign_keys = ON;

CREATE TABLE notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offers_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER
);

CREATE TABLE notification_deliveries (
  event_id INTEGER NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES subscribers(chat_id) ON DELETE CASCADE,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, chat_id)
);

CREATE INDEX notification_events_dispatch
  ON notification_events(created_at, dispatched_at);

CREATE INDEX notification_deliveries_chat_id
  ON notification_deliveries(chat_id);
