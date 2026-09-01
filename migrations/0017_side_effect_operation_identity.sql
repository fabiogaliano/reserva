-- Plan 021 (design decision 5): side_effect_operations trades its colon-string `kind` for a
-- structured operation identity. The old grammar forced every consumer of a row to *parse* it back
-- ("segment 1 is the event, a trailing numeric segment is a discriminator, 'customer'/'owner' can
-- never collide with one"), and those positional rules do not survive into v2's open-ended hook and
-- webhook names. The identity now lives in columns and display strings are only ever *built* from
-- them.
--
--   family             the closed operation-kind set (CHECK below)
--   name               hook/webhook subscriber name, or the email recipient role
--   event              the booking event this row delivers, for event-carrying families
--   discriminator      per-occurrence uniqueness for a repeatable event (the reschedule transition
--                      version today)
--   event_payload_json the serialized event envelope, written atomically with the booking mutation
--                      that produced it, and re-sent byte-for-byte on every retry so a stable event
--                      id can never carry changing booking data
--
-- Rebuild (rename -> create -> copy -> drop), the same pattern as 0011/0012/0013/0015/0016; see
-- 0011's header for why this is crash-safe without an explicit transaction.
--
-- Legacy kind -> identity mapping, one row per shape that ever existed:
--
--   calendar_create | calendar_delete | email_confirmation | oversell
--       -> family = the kind itself; name/event/discriminator NULL.
--   email:<event>                            -> family 'email', event, no name (unsplit send).
--   email:<event>:<recipient>                -> family 'email', name 'customer'|'owner'.
--   email:<event>:<discriminator>            -> family 'email', discriminator (reschedule version).
--   email:<event>:<recipient>:<discriminator>-> family 'email', both.
--   tourflow:<event>[:<discriminator>]       -> family 'hook', name 'ops'.
--
-- The tourflow -> hook/'ops' conversion is deliberate: the bespoke Tourflow provider is gone, and a
-- deployment that had one registers an equivalent durable hook named `ops`. These migrated rows are
-- the SOLE event-carrying rows allowed a NULL event_payload_json — their original occurrence
-- snapshot no longer exists, so they keep v1's "reconstruct from current booking state" behavior.
-- They can only ever feed that internal compatibility hook, never a public webhook. A row whose
-- name is not registered in the running config is abandoned at claim time with a remediating log,
-- so nothing here can sit pending forever.

ALTER TABLE side_effect_operations RENAME TO side_effect_operations_pre_0017;

-- Decomposition staged in its own table so the rebuild INSERT and the operational_incidents
-- source-key rewrite below both read ONE definition of the mapping instead of two copies.
CREATE TABLE side_effect_identity_0017 AS
WITH split1 AS (
  SELECT *,
    CASE WHEN instr(kind, ':') > 0 THEN substr(kind, 1, instr(kind, ':') - 1) ELSE kind END AS seg1,
    CASE WHEN instr(kind, ':') > 0 THEN substr(kind, instr(kind, ':') + 1) ELSE '' END AS tail1
  FROM side_effect_operations_pre_0017
), split2 AS (
  SELECT *,
    CASE WHEN instr(tail1, ':') > 0 THEN substr(tail1, 1, instr(tail1, ':') - 1) ELSE tail1 END AS seg2,
    CASE WHEN instr(tail1, ':') > 0 THEN substr(tail1, instr(tail1, ':') + 1) ELSE '' END AS tail2
  FROM split1
), split3 AS (
  SELECT *,
    CASE WHEN instr(tail2, ':') > 0 THEN substr(tail2, 1, instr(tail2, ':') - 1) ELSE tail2 END AS seg3,
    CASE WHEN instr(tail2, ':') > 0 THEN substr(tail2, instr(tail2, ':') + 1) ELSE '' END AS seg4
  FROM split2
)
SELECT
  kind AS legacy_kind,
  CASE seg1 WHEN 'tourflow' THEN 'hook' ELSE seg1 END AS family,
  CASE
    WHEN seg1 = 'tourflow' THEN 'ops'
    WHEN seg1 = 'email' AND seg3 IN ('customer', 'owner') THEN seg3
    ELSE NULL
  END AS name,
  CASE WHEN seg1 IN ('email', 'tourflow') THEN seg2 ELSE NULL END AS event,
  CASE
    WHEN seg1 = 'email' AND seg3 IN ('customer', 'owner') THEN nullif(seg4, '')
    WHEN seg1 IN ('email', 'tourflow') THEN nullif(seg3, '')
    ELSE NULL
  END AS discriminator
FROM split3
GROUP BY kind;

CREATE TABLE side_effect_operations (
  booking_id         TEXT NOT NULL,
  family             TEXT NOT NULL CHECK (
                        family IN ('calendar_create', 'calendar_delete', 'email_confirmation', 'oversell',
                                   'email', 'hook', 'webhook')
                      ),
  name               TEXT,
  event              TEXT,
  discriminator      TEXT,
  event_payload_json TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending','in_flight','succeeded','failed','abandoned')),
  provider_result_id TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  attempted_at       TEXT,
  resolved_at        TEXT,
  error              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  failure_started_at TEXT,
  next_attempt_at    TEXT,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

INSERT INTO side_effect_operations (
  booking_id, family, name, event, discriminator, event_payload_json,
  status, provider_result_id, attempt_count, attempted_at, resolved_at, error,
  created_at, updated_at, failure_started_at, next_attempt_at
)
SELECT
  o.booking_id, i.family, i.name, i.event, i.discriminator, NULL,
  o.status, o.provider_result_id, o.attempt_count, o.attempted_at, o.resolved_at, o.error,
  o.created_at, o.updated_at, o.failure_started_at, o.next_attempt_at
FROM side_effect_operations_pre_0017 o
JOIN side_effect_identity_0017 i ON i.legacy_kind = o.kind;


-- operational_incidents keys a side-effect incident by "<booking id>:<operation display string>".
-- The display string is now built from the identity columns, so every existing side_effect incident
-- must be re-keyed here — otherwise its debt would look unreported forever (a duplicate incident
-- opens under the new key while the old row can never auto-resolve).
UPDATE operational_incidents
SET source_key = booking_id || ':' || (
  SELECT i.family
       || COALESCE(':' || i.name, '')
       || COALESCE(':' || i.event, '')
       || COALESCE(':' || i.discriminator, '')
  FROM side_effect_identity_0017 i
  WHERE operational_incidents.source_key = operational_incidents.booking_id || ':' || i.legacy_kind
)
WHERE source_type = 'side_effect'
  AND EXISTS (
    SELECT 1 FROM side_effect_identity_0017 i
    WHERE operational_incidents.source_key = operational_incidents.booking_id || ':' || i.legacy_kind
  );

DROP TABLE side_effect_identity_0017;
DROP TABLE side_effect_operations_pre_0017;

-- After the drop, not before: ALTER TABLE RENAME carries the original's indexes over under their
-- original names, so recreating them here is the only point at which those names are free again.
--
-- The old PRIMARY KEY (booking_id, kind) becomes this: NULL is not a value SQLite's PRIMARY KEY or
-- UNIQUE treats as equal, so the coalesced expression index is what actually keeps one row per
-- identity (and what the outbox's ON CONFLICT DO NOTHING inserts rely on).
CREATE UNIQUE INDEX idx_side_effect_operations_identity ON side_effect_operations (
  booking_id, family, COALESCE(name, ''), COALESCE(event, ''), COALESCE(discriminator, '')
);

-- Recreated verbatim from 0007/0016.
CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
CREATE INDEX idx_side_effect_operations_reconciliation ON side_effect_operations (status, next_attempt_at, attempted_at);
