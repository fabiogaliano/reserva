-- Adds retry backoff to side_effect_operations, rebuilds refund_operations with an execution
-- lease/backoff/attempt count so a scheduled reconciler can resume refund execution (not just a
-- live HTTP request), and adds an operational_incidents ledger keyed by (source_type, source_key)
-- so a repeated scan never duplicates a debt item's history.
--
-- refund_operations is the only non-additive part (SQLite/D1 can't widen a CHECK in place) --
-- same rename -> create -> copy -> drop rebuild pattern as 0011. Every existing column, row, and
-- the UNIQUE(booking_id) constraint carry across byte-for-byte; only the status domain widens.

-- Nullable, additive columns: failure_started_at marks the start of the row's current failure
-- streak (cleared on success); next_attempt_at is when a failed row becomes claimable again.
ALTER TABLE side_effect_operations ADD COLUMN failure_started_at TEXT;
ALTER TABLE side_effect_operations ADD COLUMN next_attempt_at TEXT;

-- Supports the scheduled reconciler's candidate query (claimable-now rows first, FIFO tiebreak);
-- does not replace idx_side_effect_operations_pending.
CREATE INDEX idx_side_effect_operations_reconciliation ON side_effect_operations (status, next_attempt_at, attempted_at);

ALTER TABLE refund_operations RENAME TO refund_operations_pre_0016;

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

INSERT INTO refund_operations (
  id, booking_id, payment_intent, choice, status, stripe_refund_id, amount_cents, requested_at, resolved_at, error,
  execution_claim_token, execution_claim_until, attempt_count, attempted_at, failure_started_at, next_attempt_at
)
SELECT
  id, booking_id, payment_intent, choice, status, stripe_refund_id, amount_cents, requested_at, resolved_at, error,
  NULL, NULL, 0, NULL, NULL, NULL
FROM refund_operations_pre_0016;

DROP TABLE refund_operations_pre_0016;

-- Recreated verbatim: DROP TABLE on the renamed original drops its indexes too.
CREATE INDEX idx_refund_operations_status ON refund_operations (status);
-- Mirrors idx_side_effect_operations_reconciliation above for the same candidate-query shape.
CREATE INDEX idx_refund_operations_reconciliation ON refund_operations (status, next_attempt_at, attempted_at);

-- One durable history row per debt item, deduplicated by (source_type, source_key). No customer
-- PII or bearer token is stored -- only reference/operation metadata.
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

-- Admin "Attention required" read model: open cards sort action-required before delayed, then oldest first.
CREATE INDEX idx_operational_incidents_open ON operational_incidents (status, severity, first_detected_at);
-- The alert drain's candidate query: undelivered revisions (alerted_revision < alert_revision),
-- ordered by alert_next_attempt_at.
CREATE INDEX idx_operational_incidents_alert ON operational_incidents (alerted_revision, alert_next_attempt_at);
