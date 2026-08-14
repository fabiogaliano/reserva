-- Plan 020 (design decisions 5, 7, 8): schema for autonomous reconciliation — retry backoff on
-- side_effect_operations, a rebuilt refund_operations table with an execution lease/backoff/attempt
-- count so refund execution can be resumed by a scheduled reconciler (not just a live HTTP request),
-- and a new operational_incidents ledger keyed by (source_type, source_key) so a repeated scan or a
-- retried alert never duplicates a debt item's history.
--
-- Additive except for refund_operations, which SQLite/D1 cannot widen a CHECK on in place (no
-- ALTER TABLE ADD CONSTRAINT) — same rename -> create -> copy -> drop rebuild pattern as migrations
-- 0011/0012/0013/0015 (see 0011's header for why this is crash-safe without an explicit
-- transaction). Every existing refund_operations column, row, and the UNIQUE(booking_id) constraint
-- are carried across byte-for-byte; only the status domain widens and new columns are appended.

-- side_effect_operations: nullable, additive columns only — the existing CHECK/index/FK are
-- untouched. failure_started_at is the first uninterrupted-failure timestamp of the row's CURRENT
-- failure streak (cleared back to NULL by a resolved success); next_attempt_at is when a 'failed'
-- row next becomes claimable by an ordinary (non-admin-retry) claim. Both stay NULL for a row that
-- has never failed.
ALTER TABLE side_effect_operations ADD COLUMN failure_started_at TEXT;
ALTER TABLE side_effect_operations ADD COLUMN next_attempt_at TEXT;

-- Supports the scheduled reconciler's global candidate query: status narrows to
-- pending/failed/in_flight, next_attempt_at sorts claimable-now rows first, attempted_at breaks
-- ties FIFO. Does not replace idx_side_effect_operations_pending (still used by existing
-- status/updated_at-keyed reads).
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
  -- Plan 020 (design decision 7): the scheduled reconciler's execution claim, mirroring the
  -- confirmation-lease pattern (src/confirmation.ts) — a claimant holds execution_claim_token until
  -- execution_claim_until, so a stale (crashed) claim is reclaimable and a live one is not. The
  -- operator HTTP path and the scheduled reconciler both claim through this same pair before ever
  -- calling Stripe, closing the race a bare status/attempt-count check alone could not.
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

-- Plan 020 (design decision 8): one durable history row per debt item, deduplicated by
-- (source_type, source_key) so a repeated scan updates the same row instead of minting a new one.
-- No customer PII or bearer token is ever stored here — only reference/operation metadata (booking
-- id is an opaque internal id, not itself customer-identifying, and is used solely to join back to
-- the owning booking for the admin card and FK integrity).
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

-- Admin "Attention required" read model: open cards sort action-required before delayed, then
-- oldest first (design decision 14).
CREATE INDEX idx_operational_incidents_open ON operational_incidents (status, severity, first_detected_at);
-- The alert drain's candidate query: undelivered revisions (alerted_revision < alert_revision),
-- ordered by alert_next_attempt_at.
CREATE INDEX idx_operational_incidents_alert ON operational_incidents (alerted_revision, alert_next_attempt_at);
