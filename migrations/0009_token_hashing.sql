-- Adds hashed/encrypted manage-token columns, expiry, and revocation (additive, staged --
-- see src/repo.ts). The original plaintext columns are kept, since SQLite/D1 can't relax
-- NOT NULL/UNIQUE without a full rebuild, and are lazily replaced with a random placeholder
-- on first hashed lookup so a D1 dump never yields a usable credential from a touched row.
ALTER TABLE bookings ADD COLUMN cancel_token_hash TEXT;
ALTER TABLE bookings ADD COLUMN operator_token_hash TEXT;
ALTER TABLE bookings ADD COLUMN cancel_token_enc TEXT;
ALTER TABLE bookings ADD COLUMN operator_token_enc TEXT;
ALTER TABLE bookings ADD COLUMN tokens_expire_at TEXT;
ALTER TABLE bookings ADD COLUMN cancel_token_revoked_at TEXT;

-- Backfills cancel_token_revoked_at for bookings already terminal before this migration, since
-- the new column defaults to NULL regardless of status. Terminal bookings created afterward get
-- it set by the cancel/no-show transition itself.
UPDATE bookings SET cancel_token_revoked_at = COALESCE(cancelled_at, updated_at) WHERE status IN ('cancelled','no_show');

-- NULL is distinct from every other value in a UNIQUE index, so pre-backfill rows
-- (cancel_token_hash IS NULL) never collide with each other.
CREATE UNIQUE INDEX idx_bookings_cancel_token_hash ON bookings (cancel_token_hash);
CREATE UNIQUE INDEX idx_bookings_operator_token_hash ON bookings (operator_token_hash);
