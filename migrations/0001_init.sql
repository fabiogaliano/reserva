CREATE TABLE bookings (
  id                    TEXT PRIMARY KEY,
  reference             TEXT UNIQUE NOT NULL,
  tour_slug             TEXT NOT NULL,
  people                INTEGER NOT NULL,
  pickup_type           TEXT NOT NULL CHECK (pickup_type IN ('default','custom')),
  pickup_address        TEXT,
  starts_at             TEXT NOT NULL,
  ends_at               TEXT NOT NULL,
  customer_name         TEXT,
  customer_email        TEXT,
  customer_phone        TEXT,
  locale                TEXT NOT NULL,
  price_cents           INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('hold','confirmed','cancelled','expired','no_show')),
  hold_expires_at       TEXT,
  stripe_session_id     TEXT UNIQUE,
  stripe_payment_intent TEXT,
  calendar_event_id     TEXT,
  calendar_synced       INTEGER NOT NULL DEFAULT 0,
  email_synced          INTEGER NOT NULL DEFAULT 0,
  tourflow_synced       INTEGER NOT NULL DEFAULT 0,
  reminded_at           TEXT,
  review_requested_at   TEXT,
  cancel_token          TEXT UNIQUE NOT NULL,
  operator_token        TEXT UNIQUE NOT NULL,
  cancelled_at          TEXT,
  cancelled_by          TEXT CHECK (cancelled_by IN ('customer','operator') OR cancelled_by IS NULL),
  rescheduled_from      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_bookings_window ON bookings (starts_at, status);
CREATE INDEX idx_bookings_status_hold ON bookings (status, hold_expires_at);

CREATE TABLE day_overrides (
  date     TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL,
  reason   TEXT
);
