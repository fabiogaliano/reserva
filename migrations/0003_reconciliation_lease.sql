-- The reconciliation sweep now has two entry points (the cron `scheduled` handler and
-- POST /api/booking/ops/reconcile), so it needs a compare-and-set lease: two concurrent sweeps
-- would double-claim the same side-effect and refund rows. A single row, because the sweep is
-- deployment-wide, not per booking. last_run_at/last_summary are the same row's by-product, read
-- by ops health.
CREATE TABLE reconciliation_lease (
  id           TEXT PRIMARY KEY CHECK (id = 'singleton'),
  lease_token  TEXT,
  lease_until  TEXT,
  last_run_at  TEXT,
  last_summary TEXT
);
INSERT INTO reconciliation_lease (id) VALUES ('singleton');

-- Ops health opens a `reconciliation_stale` incident when the cron has stopped running, which is
-- the first incident that belongs to the deployment rather than to a booking. SQLite cannot widen
-- a CHECK constraint or relax NOT NULL in place, so the table is rebuilt and its rows copied over.
CREATE TABLE operational_incidents_new (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT,
  source_type            TEXT NOT NULL CHECK (source_type IN ('side_effect','refund','oversell','payment_verification','reconciliation')),
  source_key             TEXT NOT NULL,
  action                 TEXT NOT NULL CHECK (action IN ('confirmation_email','customer_notification','calendar','operations_sync','refund','oversell','payment_verification_rejected','reconciliation_stale')),
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
INSERT INTO operational_incidents_new SELECT * FROM operational_incidents;
DROP TABLE operational_incidents;
ALTER TABLE operational_incidents_new RENAME TO operational_incidents;
CREATE INDEX idx_operational_incidents_open ON operational_incidents (status, severity, first_detected_at);
CREATE INDEX idx_operational_incidents_alert ON operational_incidents (alerted_revision, alert_next_attempt_at);
