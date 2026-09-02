-- Durable, actor-attributed record of every admin-surface write. History INSERTs ride the same
-- db.batch() as the change they record (src/repo.ts), never a second write that could be lost if
-- only half a save succeeded. INTEGER PRIMARY KEY (rowid) makes ORDER BY id DESC "most recent first".
CREATE TABLE admin_change_history (
  id          INTEGER PRIMARY KEY,
  domain      TEXT NOT NULL CHECK (domain IN ('setting', 'day_override', 'capacity_default')),
  item_key    TEXT NOT NULL,   -- setting key, override date, or capacity-default from_date
  action      TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  value       TEXT,            -- serialized new value; NULL for delete
  actor       TEXT,            -- admin identity subject; NULL when the auth port exposes none
  changed_at  TEXT NOT NULL
);

CREATE INDEX idx_admin_change_history_domain_key ON admin_change_history (domain, item_key);
