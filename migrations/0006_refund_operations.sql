-- BK-REFUND-001: durable refund-operation record, replacing the in-memory refundedPayments Set.
-- UNIQUE(booking_id) is the compare-and-set primitive: exactly one request can INSERT a refund
-- decision ('full'/'none') for a given booking, so a refund=full and refund=none request racing
-- on the same booking can never both call Stripe. The row survives Stripe success/failure and any
-- crash in between, so a retry (or the charge.refunded webhook for a Stripe-dashboard-initiated
-- refund) can resume/reconcile from it instead of relying on per-isolate memory.
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
