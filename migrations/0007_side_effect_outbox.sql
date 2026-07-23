CREATE TABLE side_effect_operations (
  booking_id         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('calendar_create','email_confirmation','oversell')),
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

CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
