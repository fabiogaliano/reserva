-- reschedule_transition_version is a durable per-booking counter that makes repeat reschedule
-- outbox kinds collision-safe; any future bookings-table rebuild must preserve it.
ALTER TABLE bookings ADD COLUMN reschedule_transition_version INTEGER NOT NULL DEFAULT 0;

-- Mutation-path side effects (per-recipient email, Tourflow push) reuse this outbox table, so
-- the CHECK on `kind` widens to accept 'email:'/'tourflow:' prefixed values. SQLite has no
-- ALTER TABLE for CHECK constraints, so the table is rebuilt: rename, recreate, copy, drop.
ALTER TABLE side_effect_operations RENAME TO side_effect_operations_pre_0010;

CREATE TABLE side_effect_operations (
  booking_id         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (
                        kind IN ('calendar_create', 'email_confirmation', 'oversell')
                        OR kind LIKE 'email:%'
                        OR kind LIKE 'tourflow:%'
                      ),
  status             TEXT NOT NULL CHECK (status IN ('pending','in_flight','succeeded','failed')),
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

INSERT INTO side_effect_operations SELECT * FROM side_effect_operations_pre_0010;

DROP TABLE side_effect_operations_pre_0010;

CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
