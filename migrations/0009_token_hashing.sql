-- BK-SEC-002 (handoff 11): manage-token hashing, expiry, and revocation. A raw D1 dump of
-- cancel_token/operator_token (migrations/0001_init.sql:25-26) previously handed out live
-- cancel/reschedule/refund credentials indefinitely, with no expiry and no way to revoke one.
-- This migration is additive + staged (see src/repo.ts for the read/write logic):
--
--   cancel_token_hash / operator_token_hash: SHA-256(presented token), base64url (see
--     src/http.ts sha256Base64Url), looked up with `WHERE ..._hash = ?`. One-way — unsalted is
--     fine here since the input is always a 256-bit crypto.getRandomValues token
--     (src/http.ts tokenBytes), not a low-entropy password.
--   cancel_token_enc / operator_token_enc: AES-GCM ciphertext of the SAME plaintext token,
--     decryptable only with the BOOKKIT_TOKEN_ENC_KEY Worker secret (never itself stored in
--     D1). This is the resolution to a design tension the pure-hash approach can't avoid on its
--     own: confirmation/cancellation/reschedule emails and the admin dashboard's operator
--     manage-link column all render a booking's manage link from a booking object loaded fresh
--     from D1 (not the original in-memory request), so *something* recoverable at read time has
--     to survive — a one-way hash cannot serve that role. Encrypting with a secret that is
--     itself never persisted in the database still satisfies "a D1 dump yields no usable
--     credentials": the dump alone (without the separately-held Worker secret) cannot recover a
--     token from either column. Null when no BOOKKIT_TOKEN_ENC_KEY is configured — that degrades
--     to "no regenerable link" for new bookings, never back to plaintext.
--   tokens_expire_at: shared expiry for both tokens (booking end + a configurable grace period —
--     see ClientConfig.booking.tokenExpiryDays, src/core/config.ts). NULL = no expiry enforced;
--     legacy rows never retroactively gain one purely from being lazily backfilled (see
--     src/repo.ts) — only bookings created after this migration get an expiry.
--   cancel_token_revoked_at: set when a booking reaches a terminal state its customer has no
--     further legitimate manage-link use for (cancelled/no_show — src/repo.ts
--     transitionToCancelled / transitionToNoShow). Deliberately scoped to the customer token
--     only, not a shared tokens_revoked_at covering the operator token too: src/handlers/
--     index.ts's reconcileCancelledRefund path lets an operator resume/verify a stuck refund
--     against an already-cancelled booking via that same operator token, so revoking it on
--     cancellation would break a supported post-cancellation flow.
--
-- cancel_token/operator_token (the original plaintext columns) are kept, not dropped or made
-- nullable: SQLite/D1 cannot relax a NOT NULL/UNIQUE constraint without a full table rebuild,
-- which would not be additive. Existing rows keep their real plaintext there until first lazily
-- backfilled by a presented-token lookup (src/repo.ts getBookingByCancelToken /
-- getBookingByOperatorToken), at which point the hash (+ encrypted blob, if a key is configured)
-- is written and this column is overwritten with a random placeholder — never literal NULL,
-- since the column forbids it, and never a value that could itself be presented as a credential:
-- the fallback query that reads this column is guarded by `..._hash IS NULL`, so once a row has
-- been hashed (immediately, for every row inserted after this migration), the plaintext column's
-- contents are never consulted again for authentication, regardless of what leaks in a dump.
-- Rows created after this migration write that same placeholder immediately (they never carry
-- real plaintext at all). A future cleanup migration can drop cancel_token/operator_token
-- entirely once live traffic confirms every reachable row has been observed to backfill.
ALTER TABLE bookings ADD COLUMN cancel_token_hash TEXT;
ALTER TABLE bookings ADD COLUMN operator_token_hash TEXT;
ALTER TABLE bookings ADD COLUMN cancel_token_enc TEXT;
ALTER TABLE bookings ADD COLUMN operator_token_enc TEXT;
ALTER TABLE bookings ADD COLUMN tokens_expire_at TEXT;
ALTER TABLE bookings ADD COLUMN cancel_token_revoked_at TEXT;

-- patch-11-r1 MEDIUM 1: without this, a booking that reached cancelled/no_show BEFORE this
-- migration ran keeps a live customer manage link forever — cancel_token_revoked_at is a new
-- column, so every pre-existing row starts out NULL (not revoked) regardless of its status, and
-- the null hash on those same rows means getBookingByCancelToken's compat fallback (src/repo.ts)
-- would keep authenticating the original plaintext cancel_token indefinitely. Terminal bookings
-- created AFTER this migration don't need this: transitionToCancelled/transitionToNoShow set
-- cancel_token_revoked_at as part of the same transition going forward. COALESCE(cancelled_at,
-- updated_at) picks the moment the row actually reached its terminal state for either status
-- (no_show has no cancelled_at). Operator tokens are untouched here too, for the same
-- reconcileCancelledRefund reason documented below.
UPDATE bookings SET cancel_token_revoked_at = COALESCE(cancelled_at, updated_at) WHERE status IN ('cancelled','no_show');

-- SQLite treats NULL as distinct from every other value (including other NULLs) in a UNIQUE
-- index, matching the existing `stripe_session_id TEXT UNIQUE` column's behavior — so pre-backfill
-- rows (cancel_token_hash IS NULL) never collide with each other or block a real hash from being
-- indexed.
CREATE UNIQUE INDEX idx_bookings_cancel_token_hash ON bookings (cancel_token_hash);
CREATE UNIQUE INDEX idx_bookings_operator_token_hash ON bookings (operator_token_hash);
