-- An operator cancelling a booking can now refund part of what was paid, not only all or nothing.
-- SQLite cannot widen a CHECK constraint in place, so the table is rebuilt and its rows copied over.
--
-- requested_amount_cents is the amount the operator DECIDED to refund; amount_cents keeps its
-- existing meaning, the amount the provider reported it actually moved. They are separate columns
-- because a retry from the reconciler has to replay the decision — resolving the amount from the
-- booking's price instead would silently turn a partial refund into a full one.
CREATE TABLE refund_operations_new (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL UNIQUE,
  payment_intent         TEXT,
  choice                 TEXT NOT NULL CHECK (choice IN ('full','none','partial')),
  status                 TEXT NOT NULL CHECK (status IN ('requested','in_flight','succeeded','failed','abandoned')),
  stripe_refund_id       TEXT,
  amount_cents           INTEGER,
  requested_amount_cents INTEGER CHECK (requested_amount_cents IS NULL OR requested_amount_cents > 0),
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
  next_attempt_at        TEXT,
  -- A 'partial' row without its decided amount has nothing to replay, and a non-'partial' row
  -- carrying one would contradict the booking price the executor uses. Enforced here so the
  -- executor can treat the pairing as an invariant rather than a per-call-site check.
  CHECK ((choice = 'partial') = (requested_amount_cents IS NOT NULL))
);
INSERT INTO refund_operations_new (
  id, booking_id, payment_intent, choice, status, stripe_refund_id, amount_cents,
  requested_amount_cents, requested_at, resolved_at, error,
  execution_claim_token, execution_claim_until, attempt_count, attempted_at,
  failure_started_at, next_attempt_at
)
SELECT
  id, booking_id, payment_intent, choice, status, stripe_refund_id, amount_cents,
  NULL, requested_at, resolved_at, error,
  execution_claim_token, execution_claim_until, attempt_count, attempted_at,
  failure_started_at, next_attempt_at
FROM refund_operations;
DROP TABLE refund_operations;
ALTER TABLE refund_operations_new RENAME TO refund_operations;
CREATE INDEX idx_refund_operations_status ON refund_operations (status);
CREATE INDEX idx_refund_operations_reconciliation ON refund_operations (status, next_attempt_at, attempted_at);
