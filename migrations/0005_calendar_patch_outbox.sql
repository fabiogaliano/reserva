-- A reschedule now owes its calendar update to the outbox, like a cancellation already owes its
-- calendar deletion: the booking has moved once the row commits, so a calendar outage must become
-- a retried (and eventually alerted) debt instead of failing the customer's request. SQLite cannot
-- widen a CHECK constraint in place, so the table is rebuilt and its rows copied over.
CREATE TABLE side_effect_operations_new (
  booking_id         TEXT NOT NULL,
  family             TEXT NOT NULL CHECK (
                        family IN ('calendar_create', 'calendar_delete', 'calendar_patch', 'email_confirmation', 'oversell',
                                   'email', 'hook', 'webhook')
                      ),
  name               TEXT,
  event              TEXT,
  discriminator      TEXT,
  event_payload_json TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending','in_flight','succeeded','failed','abandoned')),
  provider_result_id TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  attempted_at       TEXT,
  resolved_at        TEXT,
  error              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  failure_started_at TEXT,
  next_attempt_at    TEXT,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);
INSERT INTO side_effect_operations_new (
  booking_id, family, name, event, discriminator, event_payload_json, status, provider_result_id,
  attempt_count, attempted_at, resolved_at, error, created_at, updated_at, failure_started_at, next_attempt_at
)
SELECT
  booking_id, family, name, event, discriminator, event_payload_json, status, provider_result_id,
  attempt_count, attempted_at, resolved_at, error, created_at, updated_at, failure_started_at, next_attempt_at
FROM side_effect_operations;
DROP TABLE side_effect_operations;
ALTER TABLE side_effect_operations_new RENAME TO side_effect_operations;
CREATE UNIQUE INDEX idx_side_effect_operations_identity ON side_effect_operations (
  booking_id, family, COALESCE(name, ''), COALESCE(event, ''), COALESCE(discriminator, '')
);
CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
CREATE INDEX idx_side_effect_operations_reconciliation ON side_effect_operations (status, next_attempt_at, attempted_at);
