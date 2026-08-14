-- Plan 018 (design decision 4): pickup is no longer a fixed 'default'/'custom' pair -- a tour now
-- declares its own set of pickup option ids (TourConfig.pickupOptions, src/core/config.ts), so the
-- valid domain for `pickup_type` lives in config, not the DB, and is not enumerable in SQL (it
-- varies per tour, per deploy). The 0011 CHECK (pickup_type IN ('default','custom')) would reject
-- every non-default/custom id a tour declares, so it is REMOVED here; `pickup_type TEXT NOT NULL`
-- stays -- still required, just no longer constrained to two literal values. Domain validation
-- moves to validateTour (config load time) and mapBooking's relaxed non-empty-string predicate
-- (src/repo.ts) at read time.
--
-- Same rebuild mechanics as 0011/0013 (SQLite/D1 has no ALTER TABLE DROP CONSTRAINT): rename ->
-- create -> INSERT...SELECT with an explicit column list -> drop -> rename, then recreate every
-- index DROP TABLE bookings takes with it. side_effect_operations.booking_id still REFERENCES
-- bookings(id) (migrations 0007, 0010, restored by 0011), and D1 enforces foreign keys
-- unconditionally in this environment -- exactly as 0011's header documents, a plain DROP TABLE
-- bookings while that FK still points at it fails on the DROP itself, regardless of any
-- foreign_keys/defer_foreign_keys pragma. So even though THIS migration has no reason to change any
-- of side_effect_operations' own CHECKs, its FK still has to be removed before dropping `bookings`
-- and restored right after -- the identical create-new/copy/drop/rename dance 0011 used, repeated
-- here around the bookings rename+drop+recreate rather than around a CHECK widening.
--
-- No "DROP TABLE IF EXISTS bookings_new" preamble, for the same crash-safety reason 0011 documents:
-- a prior run that crashed AFTER "DROP TABLE bookings" but BEFORE the RENAME below leaves every
-- row's only surviving copy IN bookings_new; a defensive drop-if-exists would silently destroy it.
ALTER TABLE side_effect_operations RENAME TO side_effect_operations_fk_hold_0015;

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
  PRIMARY KEY (booking_id, kind)
  -- No FOREIGN KEY here, temporarily -- restored below, right after the bookings rebuild.
);

-- Explicit columns (never SELECT *) for the same fail-loudly reason as the bookings copy below,
-- and with 0013's abandon-at-cap CASE conversion re-applied rather than a plain copy. On a
-- correctly migrated database this CASE is a pure no-op: 0013 already converted every nonterminal
-- row at the attempt cap, and the runtime (src/confirmation.ts) abandons a row the moment it hits
-- the cap, so no such row can exist here. But a consumer migration colliding with 0013's filename
-- skips its DATA conversion while this rebuild re-establishes its SCHEMA (the 'abandoned' CHECK),
-- which satisfies the runtime fingerprint — schema checks cannot see skipped data. Without this
-- CASE those rows would stay pending/failed/in_flight forever: both claim predicates
-- (src/repo.ts) reject attempt_count >= 10, stranding them permanently.
INSERT INTO side_effect_operations
  SELECT
    booking_id,
    kind,
    CASE WHEN status IN ('pending', 'failed', 'in_flight') AND attempt_count >= 10 THEN 'abandoned' ELSE status END,
    provider_result_id,
    attempt_count,
    attempted_at,
    CASE WHEN status IN ('pending', 'failed', 'in_flight') AND attempt_count >= 10 THEN COALESCE(resolved_at, updated_at) ELSE resolved_at END,
    CASE WHEN status IN ('pending', 'failed', 'in_flight') AND attempt_count >= 10 THEN 'max attempts (10) reached during upgrade to migration 0015' ELSE error END,
    created_at,
    updated_at
  FROM side_effect_operations_fk_hold_0015;

DROP TABLE side_effect_operations_fk_hold_0015;

-- All 44 physical columns: the 42 from 0011's rebuild (see that migration's header for their
-- derivation) plus 0014's meeting_point_id/meeting_point_label, in that same order, with every
-- other 0011 CHECK preserved byte-for-byte and only the pickup_type CHECK removed.
CREATE TABLE bookings_new (
  id                             TEXT PRIMARY KEY,
  reference                      TEXT UNIQUE NOT NULL,
  tour_slug                      TEXT NOT NULL,
  people                         INTEGER NOT NULL CHECK (people > 0),
  pickup_type                    TEXT NOT NULL,
  pickup_address                 TEXT,
  starts_at                      TEXT NOT NULL,
  ends_at                        TEXT NOT NULL CHECK (ends_at > starts_at),
  customer_name                  TEXT,
  customer_email                 TEXT,
  customer_phone                 TEXT,
  locale                         TEXT NOT NULL,
  price_cents                    INTEGER NOT NULL CHECK (price_cents >= 0),
  status                         TEXT NOT NULL CHECK (status IN ('hold','confirmed','cancelled','expired','no_show')),
  hold_expires_at                TEXT,
  stripe_session_id              TEXT UNIQUE,
  stripe_payment_intent          TEXT,
  calendar_event_id              TEXT,
  calendar_synced                INTEGER NOT NULL DEFAULT 0 CHECK (calendar_synced IN (0,1)),
  email_synced                   INTEGER NOT NULL DEFAULT 0 CHECK (email_synced IN (0,1)),
  tourflow_synced                INTEGER NOT NULL DEFAULT 0 CHECK (tourflow_synced IN (0,1)),
  reminded_at                    TEXT,
  review_requested_at            TEXT,
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

-- Explicit named columns on both sides (never SELECT *), so a future column added to `bookings`
-- without updating this list fails loudly here rather than silently missing the copy.
INSERT INTO bookings_new (
  id, reference, tour_slug, people, pickup_type, pickup_address, starts_at, ends_at,
  customer_name, customer_email, customer_phone, locale, price_cents, status, hold_expires_at,
  stripe_session_id, stripe_payment_intent, calendar_event_id, calendar_synced, email_synced,
  tourflow_synced, reminded_at, review_requested_at, cancel_token, operator_token, cancelled_at,
  cancelled_by, rescheduled_from, created_at, updated_at, confirmation_lease_token,
  confirmation_lease_until, hold_ip, occupancy_units, occupancy_ends_at, cancel_token_hash,
  operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at,
  cancel_token_revoked_at, reschedule_transition_version, meeting_point_id, meeting_point_label
)
SELECT
  id, reference, tour_slug, people, pickup_type, pickup_address, starts_at, ends_at,
  customer_name, customer_email, customer_phone, locale, price_cents, status, hold_expires_at,
  stripe_session_id, stripe_payment_intent, calendar_event_id, calendar_synced, email_synced,
  tourflow_synced, reminded_at, review_requested_at, cancel_token, operator_token, cancelled_at,
  cancelled_by, rescheduled_from, created_at, updated_at, confirmation_lease_token,
  confirmation_lease_until, hold_ip, occupancy_units, occupancy_ends_at, cancel_token_hash,
  operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at,
  cancel_token_revoked_at, reschedule_transition_version, meeting_point_id, meeting_point_label
FROM bookings;

DROP TABLE bookings;

ALTER TABLE bookings_new RENAME TO bookings;

-- Recreate every index DROP TABLE bookings just took with it (verified against migrations 0001,
-- 0002, 0003, 0009, 0011 -- nothing lost, same set 0011 recreated since neither 0012/0013/0014
-- touched a bookings index).
CREATE INDEX idx_bookings_window ON bookings (starts_at, status);
CREATE INDEX idx_bookings_status_hold ON bookings (status, hold_expires_at);
CREATE INDEX idx_bookings_confirmation_lease ON bookings (confirmation_lease_until);
CREATE INDEX idx_bookings_hold_ip ON bookings (hold_ip, status, hold_expires_at);
CREATE UNIQUE INDEX idx_bookings_cancel_token_hash ON bookings (cancel_token_hash);
CREATE UNIQUE INDEX idx_bookings_operator_token_hash ON bookings (operator_token_hash);

-- 0011's partial unique payment-intent index, preserved byte-for-byte -- the fingerprint and
-- collision tests depend on its exact shape (see STOP conditions, docs/plans/018).
CREATE UNIQUE INDEX idx_bookings_payment_intent ON bookings (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;

-- Restore side_effect_operations' FOREIGN KEY (booking_id) REFERENCES bookings(id), temporarily
-- removed above -- `bookings` now exists again with every id preserved, so this CREATE (and the
-- copy right after it) is exactly as safe as 0011's original restoration of this same FK. Same
-- create-new/copy/drop/rename shape, same columns, same CHECKs, same PK; only the FK differs.
ALTER TABLE side_effect_operations RENAME TO side_effect_operations_fk_restore_0015;

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

INSERT INTO side_effect_operations SELECT * FROM side_effect_operations_fk_restore_0015;

DROP TABLE side_effect_operations_fk_restore_0015;

-- side_effect_operations' own index (migrations 0007, 0010), lost by the two RENAMEs above.
CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
