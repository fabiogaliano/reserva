-- BK-SIDE-001 (handoff 13): mutation-path side effects (per-recipient email, Tourflow push) reuse
-- this outbox table (migrations/0007, task 04) instead of a second mechanism. Their `kind` values
-- are dynamic -- 'email:<event>:<recipient>' / 'email:<event>:<recipient>:<discriminator>' (a
-- provider with per-recipient support) / 'email:<event>' / 'email:<event>:<discriminator>' (a
-- provider without it) / 'tourflow:<event>' / 'tourflow:<event>:<discriminator>' (see
-- src/confirmation.ts mutationSideEffectKinds / attemptForKind) -- so the CHECK constraint on
-- `kind` widens from a fixed enum to "one of the confirmation-path literals, or an
-- 'email:'/'tourflow:' prefixed string". SQLite has no ALTER TABLE for CHECK constraints, so the
-- table is recreated: rename, create with the widened CHECK, copy every existing row, drop the
-- renamed original. The confirmation-path literals ('calendar_create','email_confirmation',
-- 'oversell') and their semantics (src/repo.ts confirmWithSideEffectOperations etc.) are unchanged.
-- Task 12's planned bookings-table REBUILD MUST preserve reschedule_transition_version. It is
-- the durable per-booking counter that makes repeat reschedule outbox kinds collision-safe.
ALTER TABLE bookings ADD COLUMN reschedule_transition_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE side_effect_operations RENAME TO side_effect_operations_pre_0010;

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

INSERT INTO side_effect_operations SELECT * FROM side_effect_operations_pre_0010;

DROP TABLE side_effect_operations_pre_0010;

CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
