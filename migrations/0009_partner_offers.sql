CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 64 AND code GLOB '[a-z0-9]*' AND code NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Codes remain reserved even if a partner is archived. Historical links must not be reassigned.
CREATE TRIGGER partners_immutable_code BEFORE UPDATE OF code ON partners
WHEN NEW.code != OLD.code
BEGIN
  SELECT RAISE(ABORT, 'Partner referral codes are immutable');
END;
CREATE TRIGGER partners_no_delete BEFORE DELETE ON partners
BEGIN
  SELECT RAISE(ABORT, 'Archive partners instead of deleting them');
END;

CREATE TABLE partner_offers (
  partner_id TEXT PRIMARY KEY REFERENCES partners(id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  basis_points INTEGER NOT NULL CHECK (typeof(basis_points) = 'integer' AND basis_points BETWEEN 0 AND 10000),
  waived_pickup_ids TEXT NOT NULL CHECK (json_valid(waived_pickup_ids) AND json_type(waived_pickup_ids) = 'array'),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE bookings ADD COLUMN partner_id TEXT REFERENCES partners(id);
ALTER TABLE bookings ADD COLUMN partner_attribution_snapshot TEXT CHECK (partner_attribution_snapshot IS NULL OR json_valid(partner_attribution_snapshot));
ALTER TABLE bookings ADD COLUMN partner_pricing_snapshot TEXT CHECK (partner_pricing_snapshot IS NULL OR json_valid(partner_pricing_snapshot));
CREATE INDEX idx_bookings_partner ON bookings(partner_id);

-- Once captured, checkout history cannot be relabeled/repriced by a later settings or offer edit.
-- Legacy NULL snapshots remain eligible for an explicit attribution-only historical backfill.
CREATE TRIGGER bookings_immutable_partner_checkout BEFORE UPDATE OF
  partner_id, partner_attribution_snapshot, partner_pricing_snapshot, price_minor, currency ON bookings
WHEN (OLD.partner_attribution_snapshot IS NOT NULL OR OLD.partner_pricing_snapshot IS NOT NULL)
  AND (NEW.partner_id IS NOT OLD.partner_id
    OR NEW.partner_attribution_snapshot IS NOT OLD.partner_attribution_snapshot
    OR NEW.partner_pricing_snapshot IS NOT OLD.partner_pricing_snapshot
    OR NEW.price_minor IS NOT OLD.price_minor OR NEW.currency IS NOT OLD.currency)
BEGIN
  SELECT RAISE(ABORT, 'Partner checkout snapshots and booked amounts are immutable');
END;

-- Preserve the existing audit history while extending its closed domain set.
ALTER TABLE admin_change_history RENAME TO admin_change_history_old;
CREATE TABLE admin_change_history (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL CHECK (domain IN ('setting', 'day_override', 'capacity_default', 'partner')),
  item_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  value TEXT,
  actor TEXT,
  changed_at TEXT NOT NULL
);
INSERT INTO admin_change_history SELECT * FROM admin_change_history_old;
DROP TABLE admin_change_history_old;
CREATE INDEX idx_admin_change_history_domain_key ON admin_change_history(domain, item_key);
