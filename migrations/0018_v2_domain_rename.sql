-- Plan 022 (design decision 1): the single v2 rebuild of `bookings`. Reserva stops being a tour
-- product: the domain vocabulary becomes services/quantity/capacity, the vendor's name leaves the
-- core columns, the dead and duplicated columns go, and price gains its own currency.
--
--   tour_slug             -> service_slug
--   people                -> quantity
--   price_cents           -> price_minor      (+ new NOT NULL `currency` beside it)
--   stripe_session_id     -> payment_session_ref
--   stripe_payment_intent -> payment_ref      (its partial unique index follows the name)
--
-- Dropped: reminded_at / review_requested_at (dead -- nothing has ever written them),
-- tourflow_synced (its provider left with plan 021), and calendar_synced / email_synced (delivery
-- state is a side_effect_operations row's status; an entity flag may not duplicate it).
-- Added: currency TEXT NOT NULL, metadata TEXT (nullable JSON; plan 024 declares and validates it).
-- Changed: pickup_type becomes NULLABLE -- plan 023 makes the location module optional, and a
-- service with no location options must store NULL rather than a sentinel id like 'none'. Every
-- existing value is copied across unchanged.
--
-- Currency backfill: 'eur' for every existing row. Both deployments that can possibly run this
-- migration (v1-consumer and consumer-a) are euro businesses, and the column being replaced
-- (price_cents) was only ever written against ClientConfig.business.currency, which the pre-v2
-- schema validated as the literal 'eur' -- so 'eur' is not a guess, it is the only value those
-- rows could have carried.
--
-- Sync-flag materialization (below, before the rebuild): a booking confirmed before migration 0010
-- has no outbox row at all, and its calendar_synced/email_synced flags are the ONLY record that its
-- calendar event and confirmation email were already delivered. Dropping the flags without
-- converting them would let the legacy-repair path (repo.ensureConfirmationSideEffectOperations)
-- mint fresh pending rows and re-send a message the customer already received. So the "already
-- delivered" flags become the succeeded outbox rows they should always have been; a false flag
-- records nothing and is simply dropped, exactly as the repair path already treats it.
--
-- Rebuild shape: rename -> create -> copy -> drop, the same pattern as 0011/0013/0015/0016/0017
-- (see 0011's header for why this is crash-safe, and why an explicit transaction block must never
-- appear in a migration file -- wrangler's loader rejects that two-word phrase anywhere in the
-- file, even inside a comment). The order differs from 0015's in one way: `bookings` is renamed
-- away FIRST, so SQLite re-points side_effect_operations' and operational_incidents' foreign keys
-- at the renamed original, and each child then needs ONE rebuild (pointing its FK back at the new
-- `bookings`) instead of a remove-then-restore pair. At every statement boundary the FK that is
-- actually defined is satisfiable, so nothing needs deferring -- D1 enforces foreign keys
-- unconditionally here (0011's header documents the empirical proof).

-- Materialized while the flags still exist. Guarded by NOT EXISTS so a booking that already has the
-- row (every confirmation since migration 0010) is untouched. bookings.updated_at is the closest
-- timestamp to when the flag was actually set.
INSERT INTO side_effect_operations (
  booking_id, family, name, event, discriminator, event_payload_json,
  status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
)
SELECT b.id, 'calendar_create', NULL, NULL, NULL, NULL,
       'succeeded', b.calendar_event_id, 0, NULL, b.updated_at, NULL, b.updated_at, b.updated_at
FROM bookings b
WHERE b.calendar_synced = 1
  AND NOT EXISTS (
    SELECT 1 FROM side_effect_operations o
    WHERE o.booking_id = b.id AND o.family = 'calendar_create'
  );

INSERT INTO side_effect_operations (
  booking_id, family, name, event, discriminator, event_payload_json,
  status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
)
SELECT b.id, 'email_confirmation', NULL, NULL, NULL, NULL,
       'succeeded', NULL, 0, NULL, b.updated_at, NULL, b.updated_at, b.updated_at
FROM bookings b
WHERE b.email_synced = 1
  AND NOT EXISTS (
    SELECT 1 FROM side_effect_operations o
    WHERE o.booking_id = b.id
      AND (o.family = 'email_confirmation' OR (o.family = 'email' AND o.event = 'booking.confirmed'))
  );

ALTER TABLE bookings RENAME TO bookings_pre_0018;

-- 41 physical columns: 0015's 44 minus the five dropped ones, plus currency and metadata. Every
-- other CHECK is 0011's, re-expressed against the new names; the pickup_type CHECK stays removed
-- (0015) and pickup_type is no longer NOT NULL.
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

-- Explicit named columns on both sides (never SELECT *), so a future column added without updating
-- this list fails loudly here rather than silently missing the copy.
INSERT INTO bookings (
  id, reference, service_slug, quantity, pickup_type, pickup_address, starts_at, ends_at,
  customer_name, customer_email, customer_phone, locale, price_minor, currency, status,
  hold_expires_at, payment_session_ref, payment_ref, calendar_event_id, metadata,
  cancel_token, operator_token, cancelled_at, cancelled_by, rescheduled_from, created_at, updated_at,
  confirmation_lease_token, confirmation_lease_until, hold_ip, occupancy_units, occupancy_ends_at,
  cancel_token_hash, operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at,
  cancel_token_revoked_at, reschedule_transition_version, meeting_point_id, meeting_point_label
)
SELECT
  id, reference, tour_slug, people, pickup_type, pickup_address, starts_at, ends_at,
  customer_name, customer_email, customer_phone, locale, price_cents, 'eur', status,
  hold_expires_at, stripe_session_id, stripe_payment_intent, calendar_event_id, NULL,
  cancel_token, operator_token, cancelled_at, cancelled_by, rescheduled_from, created_at, updated_at,
  confirmation_lease_token, confirmation_lease_until, hold_ip, occupancy_units, occupancy_ends_at,
  cancel_token_hash, operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at,
  cancel_token_revoked_at, reschedule_transition_version, meeting_point_id, meeting_point_label
FROM bookings_pre_0018;

-- Both children's FOREIGN KEY (booking_id) now points at bookings_pre_0018 (SQLite rewrites FK
-- clauses on RENAME), so each is rebuilt once to point back at the new `bookings`. Schema, CHECKs
-- and columns are otherwise byte-identical to 0017's and 0016's definitions.
ALTER TABLE side_effect_operations RENAME TO side_effect_operations_pre_0018;

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

INSERT INTO side_effect_operations (
  booking_id, family, name, event, discriminator, event_payload_json,
  status, provider_result_id, attempt_count, attempted_at, resolved_at, error,
  created_at, updated_at, failure_started_at, next_attempt_at
)
SELECT
  booking_id, family, name, event, discriminator, event_payload_json,
  status, provider_result_id, attempt_count, attempted_at, resolved_at, error,
  created_at, updated_at, failure_started_at, next_attempt_at
FROM side_effect_operations_pre_0018;

DROP TABLE side_effect_operations_pre_0018;

ALTER TABLE operational_incidents RENAME TO operational_incidents_pre_0018;

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

INSERT INTO operational_incidents (
  id, booking_id, source_type, source_key, action, status, severity, attempt_count,
  first_detected_at, last_detected_at, source_updated_at, alert_revision, alerted_revision,
  alert_attempt_count, alert_claim_token, alert_claim_until, alert_next_attempt_at, alert_error,
  resolved_at, resolution_kind, resolved_by, resolution_note
)
SELECT
  id, booking_id, source_type, source_key, action, status, severity, attempt_count,
  first_detected_at, last_detected_at, source_updated_at, alert_revision, alerted_revision,
  alert_attempt_count, alert_claim_token, alert_claim_until, alert_next_attempt_at, alert_error,
  resolved_at, resolution_kind, resolved_by, resolution_note
FROM operational_incidents_pre_0018;

DROP TABLE operational_incidents_pre_0018;

DROP TABLE bookings_pre_0018;

-- After the drops, not before: ALTER TABLE RENAME carries each original's indexes over under their
-- original names, so this is the first point at which those names are free again. Recreated verbatim
-- from 0001/0002/0003/0009/0015 (bookings), 0017 (side_effect_operations) and 0016
-- (operational_incidents), except that the partial payment index follows its column's new name.
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

-- The admin settings page persists overrides by key string (src/core/settings.ts), so a rename that
-- doesn't follow through here would silently revert an operator's saved capacity to the file
-- default the moment this migration lands.
UPDATE settings SET key = 'capacity.default' WHERE key = 'fleet.defaultCapacity';

-- Plan 022 (design decision 7): payment methods stop being an admin-editable runtime setting and
-- become code-level options of the payment adapter (@reservajs/stripe's `paymentMethods`). The
-- definition leaves src/core/settings.ts with the settings page's whole `payments` section, so a
-- surviving row here would be an override nothing can read, edit, or clear.
DELETE FROM settings WHERE key = 'payments.methods';
