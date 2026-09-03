-- Reserva's complete D1 schema. Emitted from the applied migration chain rather than rewritten by
-- hand, so a database migrated incrementally and a freshly initialized one carry byte-identical
-- sqlite_master text and cannot diverge under the runtime's schema fingerprint check.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE day_overrides (
  date     TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  reason   TEXT
);
CREATE TABLE capacity_defaults (
  from_date TEXT PRIMARY KEY,
  capacity  INTEGER NOT NULL CHECK (capacity >= 0),
  reason    TEXT
);
CREATE TABLE refund_operations (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL UNIQUE,
  payment_intent         TEXT,
  choice                 TEXT NOT NULL CHECK (choice IN ('full','none')),
  status                 TEXT NOT NULL CHECK (status IN ('requested','in_flight','succeeded','failed','abandoned')),
  stripe_refund_id       TEXT,
  amount_cents           INTEGER,
  requested_at           TEXT NOT NULL,
  resolved_at            TEXT,
  error                  TEXT,
  -- Execution claim (mirrors the confirmation-lease pattern): a claimant holds the token until
  -- execution_claim_until, so the HTTP path and the scheduled reconciler can't both call Stripe.
  execution_claim_token  TEXT,
  execution_claim_until  TEXT,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  attempted_at           TEXT,
  failure_started_at     TEXT,
  next_attempt_at        TEXT
);
CREATE INDEX idx_refund_operations_status ON refund_operations (status);
CREATE INDEX idx_refund_operations_reconciliation ON refund_operations (status, next_attempt_at, attempted_at);
CREATE TABLE bookings (
  id                             TEXT PRIMARY KEY,
  reference                      TEXT UNIQUE NOT NULL,
  service_slug                   TEXT NOT NULL,
  quantity                       INTEGER NOT NULL CHECK (quantity > 0),
  pickup_type                    TEXT,
  pickup_address                 TEXT,
  starts_at                      TEXT NOT NULL,
  ends_at                        TEXT NOT NULL CHECK (ends_at > starts_at),
  customer_name                  TEXT,
  customer_email                 TEXT,
  customer_phone                 TEXT,
  locale                         TEXT NOT NULL,
  price_minor                    INTEGER NOT NULL CHECK (price_minor >= 0),
  currency                       TEXT NOT NULL,
  status                         TEXT NOT NULL CHECK (status IN ('hold','confirmed','cancelled','expired','no_show')),
  hold_expires_at                TEXT,
  payment_session_ref            TEXT UNIQUE,
  payment_ref                    TEXT,
  calendar_event_id              TEXT,
  metadata                       TEXT,
  cancel_token                   TEXT UNIQUE NOT NULL,
  operator_token                 TEXT UNIQUE NOT NULL,
  cancelled_at                   TEXT,
  cancelled_by                   TEXT CHECK (cancelled_by IN ('customer','operator') OR cancelled_by IS NULL),
  rescheduled_from               TEXT,
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL,
  confirmation_lease_token       TEXT,
  confirmation_lease_until       TEXT,
  hold_ip                        TEXT,
  occupancy_units                INTEGER,
  occupancy_ends_at              TEXT,
  cancel_token_hash              TEXT,
  operator_token_hash            TEXT,
  cancel_token_enc               TEXT,
  operator_token_enc             TEXT,
  tokens_expire_at               TEXT,
  cancel_token_revoked_at        TEXT,
  reschedule_transition_version  INTEGER NOT NULL DEFAULT 0,
  meeting_point_id               TEXT,
  meeting_point_label            TEXT
);
CREATE TABLE side_effect_operations (
  booking_id         TEXT NOT NULL,
  family             TEXT NOT NULL CHECK (
                        family IN ('calendar_create', 'calendar_delete', 'email_confirmation', 'oversell',
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
CREATE TABLE operational_incidents (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL,
  source_type            TEXT NOT NULL CHECK (source_type IN ('side_effect','refund','oversell')),
  source_key             TEXT NOT NULL,
  action                 TEXT NOT NULL CHECK (action IN ('confirmation_email','customer_notification','calendar','operations_sync','refund','oversell')),
  status                 TEXT NOT NULL CHECK (status IN ('open','resolved')),
  severity               TEXT NOT NULL CHECK (severity IN ('delayed','action_required')),
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  first_detected_at      TEXT NOT NULL,
  last_detected_at       TEXT NOT NULL,
  source_updated_at      TEXT NOT NULL,
  alert_revision         INTEGER NOT NULL DEFAULT 1,
  alerted_revision       INTEGER NOT NULL DEFAULT 0,
  alert_attempt_count    INTEGER NOT NULL DEFAULT 0,
  alert_claim_token      TEXT,
  alert_claim_until      TEXT,
  alert_next_attempt_at  TEXT,
  alert_error            TEXT,
  resolved_at            TEXT,
  resolution_kind        TEXT CHECK (resolution_kind IN ('automatic','manual') OR resolution_kind IS NULL),
  resolved_by            TEXT,
  resolution_note        TEXT,
  UNIQUE (source_type, source_key),
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);
CREATE INDEX idx_bookings_window ON bookings (starts_at, status);
CREATE INDEX idx_bookings_status_hold ON bookings (status, hold_expires_at);
CREATE INDEX idx_bookings_confirmation_lease ON bookings (confirmation_lease_until);
CREATE INDEX idx_bookings_hold_ip ON bookings (hold_ip, status, hold_expires_at);
CREATE UNIQUE INDEX idx_bookings_cancel_token_hash ON bookings (cancel_token_hash);
CREATE UNIQUE INDEX idx_bookings_operator_token_hash ON bookings (operator_token_hash);
CREATE UNIQUE INDEX idx_bookings_payment_ref ON bookings (payment_ref) WHERE payment_ref IS NOT NULL;
CREATE UNIQUE INDEX idx_side_effect_operations_identity ON side_effect_operations (
  booking_id, family, COALESCE(name, ''), COALESCE(event, ''), COALESCE(discriminator, '')
);
CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
CREATE INDEX idx_side_effect_operations_reconciliation ON side_effect_operations (status, next_attempt_at, attempted_at);
CREATE INDEX idx_operational_incidents_open ON operational_incidents (status, severity, first_detected_at);
CREATE INDEX idx_operational_incidents_alert ON operational_incidents (alerted_revision, alert_next_attempt_at);
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
