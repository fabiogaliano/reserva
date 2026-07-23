-- BK-SCHEMA-001 (handoff 12): the domain invariants the app has always assumed but the schema
-- never enforced -- people>0, price_cents>=0, ends_at>starts_at, and the three sync flags being a
-- strict 0/1 boolean -- plus the one invariant a raw DB write could violate with real business
-- consequences: two bookings sharing a stripe_payment_intent (see the partial unique index below).
-- SQLite/D1 has no ALTER TABLE ADD CONSTRAINT (no ADD CHECK, no ADD UNIQUE), so the CHECK
-- constraints require a full table rebuild: create a new table with the widened schema, copy every
-- row across (which enforces the new CHECKs against existing data for free -- a violating row
-- aborts the copy, and per wrangler 4.112.0's documented rollback behavior, the whole migration),
-- drop the old table, rename the new one into place. Ordered crash-safe: CREATE bookings_new ->
-- copy -> DROP bookings -> RENAME, so a failure between DROP and RENAME leaves every row intact in
-- bookings_new, recoverable by hand. Do NOT wrap this in an explicit BEGIN/COMMIT block -- D1
-- rejects one inside a migration file (and wrangler's own migration loader chokes on that same
-- two-word phrase, split here, appearing anywhere in the file, even inside a comment).
--
-- Pre-flight audit (for operator diagnosis before/after; NOT executed by this migration itself --
-- the INSERT...SELECT below already refuses to copy any row that violates a new CHECK):
--   SELECT stripe_payment_intent, COUNT(*) FROM bookings
--     WHERE stripe_payment_intent IS NOT NULL GROUP BY stripe_payment_intent HAVING COUNT(*) > 1;
--   SELECT id FROM bookings WHERE people <= 0;
--   SELECT id FROM bookings WHERE price_cents < 0;
--   SELECT id FROM bookings WHERE ends_at <= starts_at;
--   SELECT id FROM bookings
--     WHERE calendar_synced NOT IN (0,1) OR email_synced NOT IN (0,1) OR tourflow_synced NOT IN (0,1);

-- side_effect_operations.booking_id REFERENCES bookings(id) (migrations 0007, 0010) and D1
-- enforces foreign keys unconditionally in this environment -- neither `PRAGMA foreign_keys = OFF`
-- nor `PRAGMA defer_foreign_keys = ON` suppresses or defers the check across a DROP+RENAME of the
-- referenced table within one migration transaction here (verified empirically against the real
-- workerd/D1 engine tests/workers/schema-constraints.test.ts runs against: `foreign_keys = OFF`
-- still raises SQLITE_CONSTRAINT_FOREIGNKEY on the DROP statement itself, and `defer_foreign_keys
-- = ON` gets past the DROP but the whole transaction is still rejected at commit). So instead of
-- relying on either pragma, side_effect_operations' FK constraint is temporarily REMOVED (its own
-- create-new/copy/drop/rename, identical in every other respect) before the bookings rebuild, and
-- restored (same treatment, FK re-added) immediately after -- at every statement boundary in this
-- migration, whatever FK constraint IS currently defined is immediately satisfiable, so nothing
-- ever needs deferring. See tests/workers/schema-constraints.test.ts's lossless-fixture test for
-- the proof: it seeds a real side_effect_operations child row before running this migration and
-- asserts both that row and `PRAGMA foreign_key_check` are clean afterward.
ALTER TABLE side_effect_operations RENAME TO side_effect_operations_fk_hold_0011;

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
  PRIMARY KEY (booking_id, kind)
  -- No FOREIGN KEY here, temporarily -- restored below, right after the bookings rebuild.
);

INSERT INTO side_effect_operations SELECT * FROM side_effect_operations_fk_hold_0011;

DROP TABLE side_effect_operations_fk_hold_0011;

-- No "DROP TABLE IF EXISTS bookings_new" preamble here, intentionally: a prior run that crashed
-- AFTER "DROP TABLE bookings" but BEFORE the RENAME below leaves every row's only surviving copy
-- IN bookings_new (that's the whole point of the crash-safe ordering above). A defensive drop-if-
-- exists here would silently destroy that surviving data on retry. Instead, a retry's CREATE TABLE
-- bookings_new fails loudly with "table already exists", forcing an operator to inspect
-- bookings_new (and manually rename it into place, or copy it back) before the migration can be
-- safely re-run. Fresh-apply and the workerd tests never have a pre-existing bookings_new, so this
-- doesn't affect either.

-- All 42 physical columns from migrations 0001 (30), 0002 (+2), 0003 (+1), 0008 (+2), 0009 (+6),
-- 0010 (+1), in that same order, with every original per-column constraint preserved verbatim and
-- only the new CHECKs added -- see docs/tmp/handoff-audit-fixes/12-schema-constraints.md and the
-- migrations themselves for the derivation.
CREATE TABLE bookings_new (
  id                             TEXT PRIMARY KEY,
  reference                      TEXT UNIQUE NOT NULL,
  tour_slug                      TEXT NOT NULL,
  people                         INTEGER NOT NULL CHECK (people > 0),
  pickup_type                    TEXT NOT NULL CHECK (pickup_type IN ('default','custom')),
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
  reschedule_transition_version  INTEGER NOT NULL DEFAULT 0
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
  cancel_token_revoked_at, reschedule_transition_version
)
SELECT
  id, reference, tour_slug, people, pickup_type, pickup_address, starts_at, ends_at,
  customer_name, customer_email, customer_phone, locale, price_cents, status, hold_expires_at,
  stripe_session_id, stripe_payment_intent, calendar_event_id, calendar_synced, email_synced,
  tourflow_synced, reminded_at, review_requested_at, cancel_token, operator_token, cancelled_at,
  cancelled_by, rescheduled_from, created_at, updated_at, confirmation_lease_token,
  confirmation_lease_until, hold_ip, occupancy_units, occupancy_ends_at, cancel_token_hash,
  operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at,
  cancel_token_revoked_at, reschedule_transition_version
FROM bookings;

DROP TABLE bookings;

ALTER TABLE bookings_new RENAME TO bookings;

-- Recreate every index DROP TABLE bookings just took with it (verified against migrations 0001,
-- 0002, 0003, 0009 -- nothing lost).
CREATE INDEX idx_bookings_window ON bookings (starts_at, status);
CREATE INDEX idx_bookings_status_hold ON bookings (status, hold_expires_at);
CREATE INDEX idx_bookings_confirmation_lease ON bookings (confirmation_lease_until);
CREATE INDEX idx_bookings_hold_ip ON bookings (hold_ip, status, hold_expires_at);
CREATE UNIQUE INDEX idx_bookings_cancel_token_hash ON bookings (cancel_token_hash);
CREATE UNIQUE INDEX idx_bookings_operator_token_hash ON bookings (operator_token_hash);

-- The highest-value item (handoff 12): "one payment must not confirm multiple bookings" as a
-- schema-level guarantee, not just an application assumption (src/repo.ts getBookingByPaymentIntent
-- usage in src/handlers/index.ts / src/confirmation.ts). Partial so pre-payment holds (NULL) never
-- collide with each other -- SQLite already treats NULL as distinct from every other value in a
-- unique index (see migrations/0009_token_hashing.sql's identical reasoning for the token hash
-- indexes), so the WHERE clause here is belt-and-suspenders documentation of that, not a
-- correctness requirement -- but it also keeps the index small (only ever-paid bookings are in it).
CREATE UNIQUE INDEX idx_bookings_payment_intent ON bookings (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;

-- Restore side_effect_operations' FOREIGN KEY (booking_id) REFERENCES bookings(id), temporarily
-- removed above -- `bookings` now exists again with every id preserved, so this CREATE (and the
-- copy right after it) is exactly as safe as 0007/0010's original definition of this table. Same
-- create-new/copy/drop/rename shape, same columns, same CHECKs, same PK; only the FK differs.
ALTER TABLE side_effect_operations RENAME TO side_effect_operations_fk_restore_0011;

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

INSERT INTO side_effect_operations SELECT * FROM side_effect_operations_fk_restore_0011;

DROP TABLE side_effect_operations_fk_restore_0011;

-- side_effect_operations' own index (migrations 0007, 0010), lost by the two RENAMEs above.
CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);

-- capacity_defaults.capacity / day_overrides.capacity (migrations 0004, 0001): the app already
-- clamps at the boundary (src/handlers/index.ts requireInteger(..., 'capacity', 0)), but a raw
-- write (a future migration, a manual fix) had no DB-level backstop. Same rebuild treatment as
-- bookings above; each table's only index is its implicit PRIMARY KEY index, which a CREATE TABLE
-- with the same PRIMARY KEY column recreates automatically -- nothing else to recreate. No
-- "DROP TABLE IF EXISTS ..._new" preamble here either, for the same reason as bookings_new above:
-- it would destroy a prior crashed run's only surviving copy of this table's data.
CREATE TABLE day_overrides_new (
  date     TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  reason   TEXT
);

INSERT INTO day_overrides_new (date, capacity, reason) SELECT date, capacity, reason FROM day_overrides;

DROP TABLE day_overrides;

ALTER TABLE day_overrides_new RENAME TO day_overrides;

CREATE TABLE capacity_defaults_new (
  from_date TEXT PRIMARY KEY,
  capacity  INTEGER NOT NULL CHECK (capacity >= 0),
  reason    TEXT
);

INSERT INTO capacity_defaults_new (from_date, capacity, reason) SELECT from_date, capacity, reason FROM capacity_defaults;

DROP TABLE capacity_defaults;

ALTER TABLE capacity_defaults_new RENAME TO capacity_defaults;
