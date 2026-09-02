-- Durable refund-operation record, replacing the in-memory refundedPayments Set.
-- UNIQUE(booking_id) ensures only one refund decision is ever committed per booking, so a
-- crash mid-refund can be resumed or reconciled from this row instead of per-isolate memory.
CREATE TABLE refund_operations (
  id               TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL UNIQUE,
  payment_intent   TEXT,
  choice           TEXT NOT NULL CHECK (choice IN ('full','none')),
  status           TEXT NOT NULL CHECK (status IN ('requested','succeeded','failed')),
  stripe_refund_id TEXT,
  amount_cents     INTEGER,
  requested_at     TEXT NOT NULL,
  resolved_at      TEXT,
  error            TEXT
);

CREATE INDEX idx_refund_operations_status ON refund_operations (status);
