-- Adds a terminal 'abandoned' status so a permanently-failed or capped-retry row (>= 10 attempts)
-- stops being polled forever. Any pre-existing nonterminal row already at or over that cap,
-- including stale in_flight ones, is converted to 'abandoned' by this migration.
ALTER TABLE side_effect_operations RENAME TO side_effect_operations_pre_0013;

CREATE TABLE side_effect_operations (
  booking_id         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (
                        kind IN ('calendar_create', 'calendar_delete', 'email_confirmation', 'oversell')
                        OR kind LIKE 'email:%'
                        OR kind LIKE 'tourflow:%'
                      ),
  status             TEXT NOT NULL CHECK (status IN ('pending','in_flight','succeeded','failed','abandoned')),
  provider_result_id TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  attempted_at       TEXT,
  resolved_at        TEXT,
  error              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (booking_id, kind),
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

INSERT INTO side_effect_operations
  SELECT
    booking_id,
    kind,
    CASE WHEN status IN ('pending', 'failed', 'in_flight') AND attempt_count >= 10 THEN 'abandoned' ELSE status END,
    provider_result_id,
    attempt_count,
    attempted_at,
    CASE WHEN status IN ('pending', 'failed', 'in_flight') AND attempt_count >= 10 THEN COALESCE(resolved_at, updated_at) ELSE resolved_at END,
    CASE WHEN status IN ('pending', 'failed', 'in_flight') AND attempt_count >= 10 THEN 'max attempts (10) reached during upgrade to migration 0013' ELSE error END,
    created_at,
    updated_at
  FROM side_effect_operations_pre_0013;

DROP TABLE side_effect_operations_pre_0013;

CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
