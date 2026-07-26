-- Calendar deletion is recorded with the cancellation transition so a provider outage cannot leave
-- an event occupying external capacity forever after the booking itself is cancelled.
ALTER TABLE side_effect_operations RENAME TO side_effect_operations_pre_0012;

CREATE TABLE side_effect_operations (
  booking_id         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (
                        kind IN ('calendar_create', 'calendar_delete', 'email_confirmation', 'oversell')
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

INSERT INTO side_effect_operations SELECT * FROM side_effect_operations_pre_0012;

DROP TABLE side_effect_operations_pre_0012;

CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
