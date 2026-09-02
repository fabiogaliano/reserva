-- Enforces domain invariants the app has always assumed but the schema never checked --
-- people>0, price_cents>=0, ends_at>starts_at, the sync flags being strict 0/1 -- plus one
-- payment never confirming multiple bookings (partial unique index below). SQLite/D1 has no
-- ALTER TABLE ADD CONSTRAINT, so this rebuilds the table: create the widened schema, copy every
-- row (a violating row aborts the copy and the whole migration), drop the old table, rename the
-- new one into place. Never wrap this in an explicit BEGIN/COMMIT -- D1 rejects one inside a
-- migration file, and wrangler's migration loader chokes on that phrase anywhere in the file,
-- even inside a comment.

-- D1 enforces foreign keys unconditionally, and neither `foreign_keys = OFF` nor
-- `defer_foreign_keys = ON` suppresses the check across a DROP+RENAME of a referenced table
-- within one migration (verified against the real workerd/D1 engine -- see
-- tests/workers/schema-constraints.test.ts). So side_effect_operations' FK is temporarily
-- removed (its own create/copy/drop/rename) before the bookings rebuild, and restored right after.
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
-- after DROP TABLE bookings but before the RENAME below leaves every row's only surviving copy
-- in bookings_new. A defensive drop-if-exists would silently destroy that data on retry --
-- instead a retry fails loudly with "table already exists" so an operator can inspect it first.

-- All 42 physical columns from migrations 0001-0010, in that same order, with every original
-- per-column constraint preserved verbatim and only the new CHECKs added.
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

-- Recreate every index DROP TABLE bookings just took with it.
CREATE INDEX idx_bookings_window ON bookings (starts_at, status);
CREATE INDEX idx_bookings_status_hold ON bookings (status, hold_expires_at);
CREATE INDEX idx_bookings_confirmation_lease ON bookings (confirmation_lease_until);
CREATE INDEX idx_bookings_hold_ip ON bookings (hold_ip, status, hold_expires_at);
CREATE UNIQUE INDEX idx_bookings_cancel_token_hash ON bookings (cancel_token_hash);
CREATE UNIQUE INDEX idx_bookings_operator_token_hash ON bookings (operator_token_hash);

-- "One payment must not confirm multiple bookings" as a schema-level guarantee, not just an
-- application assumption. Partial so pre-payment holds (NULL) never collide with each other --
-- SQLite already treats NULL as distinct from every other value in a unique index, so the WHERE
-- clause also keeps the index small (only ever-paid bookings are in it).
CREATE UNIQUE INDEX idx_bookings_payment_intent ON bookings (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;

-- Restore side_effect_operations' FOREIGN KEY (booking_id) REFERENCES bookings(id), temporarily
-- removed above -- `bookings` now exists again with every id preserved. Same
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

-- side_effect_operations' own index, lost by the two RENAMEs above.
CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);

-- capacity_defaults.capacity / day_overrides.capacity: the app already clamps at the boundary,
-- but a raw write had no DB-level backstop. Same rebuild treatment as bookings above; no
-- "DROP TABLE IF EXISTS ..._new" preamble either, for the same crash-safety reason.
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
