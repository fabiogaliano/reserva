-- side_effect_operations trades its colon-string `kind` for structured identity columns
-- (family/name/event/discriminator/event_payload_json): the old grammar's positional parsing
-- rules don't survive v2's open-ended hook/webhook names. Legacy kind values are mapped to
-- identities by the CASE logic below; tourflow:* becomes family 'hook' name 'ops' (the bespoke
-- provider is gone) and is the only case allowed a NULL event_payload_json, since its original
-- event snapshot no longer exists. Same rebuild pattern as 0011 (rename/create/copy/drop).

ALTER TABLE side_effect_operations RENAME TO side_effect_operations_pre_0017;

-- Staged in its own table so the rebuild INSERT and the operational_incidents source-key rewrite
-- below both read one definition of the mapping instead of two copies.
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


-- Existing incidents are keyed by the old colon-string kind; re-key them to the new identity
-- string here, or their debt would look unreported forever under the new key.
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

-- Recreated after the drop, once the old names are free again. The old PRIMARY KEY (booking_id,
-- kind) becomes this expression index: NULL isn't treated as equal by UNIQUE, so COALESCE keeps
-- one row per identity (relied on by the outbox's ON CONFLICT DO NOTHING inserts).
CREATE UNIQUE INDEX idx_side_effect_operations_identity ON side_effect_operations (
  booking_id, family, COALESCE(name, ''), COALESCE(event, ''), COALESCE(discriminator, '')
);

-- Recreated verbatim from 0007/0016.
CREATE INDEX idx_side_effect_operations_pending ON side_effect_operations (status, updated_at);
CREATE INDEX idx_side_effect_operations_reconciliation ON side_effect_operations (status, next_attempt_at, attempted_at);
