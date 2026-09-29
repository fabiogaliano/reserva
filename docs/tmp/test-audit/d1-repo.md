# Test-audit ledger — lane `d1-repo`

Scope: every `tests/workers/*.test.ts` (21 suites + `setup.ts`/`worker.ts` support), `tests/repo.test.ts`,
`tests/fakes.test.ts`, `tests/schema-fingerprint.test.ts`, `tests/runtime-migrations.test.ts`,
`tests/reserva-migrate-cli.test.ts`. Owners read: `src/repo.ts`, `migrations/0001-0007`, `src/schema-check.ts`,
`src/runtime-context.ts`/`src/runtime.ts`, `scripts/reserva-migrate.ts`, `scripts/generate*.ts`,
`src/handlers/{ops-health,ops-reconcile,admin,availability,checkout,webhook}.ts`, `tests/fakes.ts`.
Read-only pass; nothing edited, vitest not run.

Marks are per `it` / `it.each` (describes are containers and follow their children).
Totals: **223 declarations — R 185 · F 12 · C 16 · D 10**.

Context facts that drive several marks:

- `ReservaContext` (exported from `src/runtime.ts`) exposes `repo: BookingRepository`, so every repo
  method is reachable by consumers through the public context type — removing any repo method needs a
  changeset even when `src/` never calls it.
- `transitionReschedule` has had **no production caller since c0754de (2026-07-23)**; checkout/manage
  reschedule goes through `rescheduleWithCapacity` (separate SQL). `insertHold` has no `src/` caller
  either (production uses `insertHoldWithCapacity`, which carries its **own copy** of the per-IP hold cap);
  only `scripts/smoke-scheduled-test.ts` and tests call it.
- Migrations were squashed (8405ea7) into `0001_init.sql` + 0002-0007. Test comments that cite
  0008/0009/0014/0015/0018 use pre-squash numbering.
- `bun run generate:check` (CI `verify` job, added 4e2c5cb on 2026-09-17) fails whenever
  `src/generated/schema-fingerprint.ts` differs from a fresh replay of `migrations/`.
- `handleAdminPost` answers **303 for both success and a failed CSRF check** (`adminErrorRedirect`
  sets `?error=csrf_expired`), so a bare `status === 303` does not prove CSRF acceptance.

## Ledger

### tests/workers/admin-auth-port.test.ts
| line | mark | evidence |
|---|---|---|
| 109 | C | Asserts the test's own `virtualConfig` mutation (no `admin.access`). Fold into a module-level throw guard in setup; no product contract. |
| 114 | R | Custom `adminAuth` unauthenticated GET/POST → 403 and no day-override write. Auth runs before origin/CSRF (admin.ts:467), so the 403 comes from the auth port. Catches a regression where the admin surface ignores a custom port. |
| 130 | R | A wrong header token → 403. Catches a custom port that accepts any value. |
| 136 | R | Admin GET under custom auth lists the booking and regenerates the operator manage link from the encrypted token (real D1 + `RESERVA_TOKEN_ENC_KEY`). |
| 150 | F | Named "accepts a CSRF token … and mutates", but only asserts 303, which is also returned on `csrf_expired` or any action error. Repair: assert `location` has no `error` param, seed a day override, then assert it was cleared. |
| 169 | R | Operator no-show (token auth) still works with no `admin.access`; the row reaches `no_show` on D1. |

### tests/workers/admin-history.test.ts
| line | mark | evidence |
|---|---|---|
| 24 | R | Real D1: a mixed upsert/delete settings batch writes both the settings and the matching history rows. Catches history missing or diverging from the change. |
| 45 | R | `deleteSetting` writes exactly one delete history row. |
| 55 | R | A null actor round-trips as null, not `''`. |
| 65 | R | `listAdminChangeHistory` returns rows by id DESC across domains and honours the limit. Note: `listAdminChangeHistory` has no `src/` caller (see Layer plan). |

### tests/workers/availability-horizon.test.ts
| line | mark | evidence |
|---|---|---|
| 78 | R | A full 365-day horizon read in 62-day chunks against real D1 with 50 seeded rows: returns every date, slots survive deep in the horizon, soft <10 s ceiling. The only real-D1 horizon/performance guard. |
| 103 | D | Pure handler validation (62-day cap, `details.field: 'to'`); no D1 involvement. Remaining proof: `tests/handlers-lifecycle.test.ts:312` (62 days OK, 63 rejected, field `to`). |
| 110 | D | Pure handler validation (horizon message naming `config.booking.maxHorizonDays`). Remaining proof: `tests/handlers-lifecycle.test.ts:288` asserts the same message text through the same `validDateRange` branch. |

### tests/workers/calendar-patch-outbox.test.ts
| line | mark | evidence |
|---|---|---|
| 20 | R | Real D1 accepts `calendar_patch` rows (the 0005 CHECK) via production `rescheduleWithCapacity`, one row per reschedule version (`'1'`, `'2'`). |

### tests/workers/capacity-allocation.test.ts
| line | mark | evidence |
|---|---|---|
| 84 | R | Last-unit checkout ×2: exactly one hold is stored on D1. Keeper for checkout "at most one winner". |
| 95 | C | Mirror of 84 with the ids swapped. The inputs are symmetric and the file header says one ordering suffices. Absorbed by 84. |
| 116 | R | Reschedule ×2 into one remaining unit: the loser is not moved. |
| 128 | C | Mirror of 116 (ra/rb swapped, symmetric slots). Absorbed by 116. |
| 142 | R | Reschedule-first then checkout: the checkout loses. The two orderings run different guard SQL, so each is kept. |
| 150 | R | Checkout-first then reschedule: the reschedule loses and the row stays put. |
| 168 | R | An override landing first shrinks capacity and the reschedule is rejected (day_overrides resolved inside the SQL guard). |
| 183 | R | A reschedule landing first is not evicted retroactively; the override governs the next write. |
| 201 | R | Multi-unit party (5 → 2 units): the SQL guard rejects exactly where `maxConcurrentOccupancy` does. Expected values come from core, not from the guard. |
| 213 | R | Multi-unit fit accepted (parity). |
| 246 | R | Regression pin (patch-05-r1 Fix 1): a straddling request is accepted where a SUM guard would reject it. |
| 258 | R | Same regression through `rescheduleWithCapacity`. |
| 270 | R | Regression pin (Fix 3): a reschedule self-heals NULL `occupancy_units`. |

### tests/workers/capacity-overrides.test.ts
| line | mark | evidence |
|---|---|---|
| 57 | R | Day override upsert / ON CONFLICT / delete round trip on D1. Keeper; `repo-d1:226` duplicates it. Note: the singular `upsertDayOverride`/`deleteDayOverride` have no `src/` caller (admin uses the plural forms). |
| 69 | R | `listDayOverrides` boundary inclusivity and date order. |
| 85 | R | Capacity default upsert / ON CONFLICT / delete round trip. |
| 96 | R | `listCapacityDefaults` orders by `from_date`. |
| 110 | F | Name claims "lands every date in a single db.batch() call", but the test only asserts the end state. Rename to the effect it proves, or carry the atomicity proof here (see Layer plan). |
| 126 | R | Plural day-override writes produce one history row per date, and delete history is appended. Real-D1 keeper for plural history. |
| 143 | R | The plural upsert overwrites on conflict. |
| 149 | R | Empty date arrays are a no-op. Natural absorber for `repo.test.ts:147` (add a "history stays empty" assertion). |
| 160 | R | `listOccupancyBookings` `[from,to)` bounds, status filter and ORDER BY. Occupancy input to availability. |
| 188 | R | `listLiveBookings`: strict `hold_expires_at >` on an exactly-expired hold, exclusive upper bound, limit. |
| 210 | R | With no key, admin list plus hydrate keep `nohash:` placeholders. |
| 225 | R | The admin list defers decryption; with a key, `hydrateBookingTokens` restores the real tokens. |
| 250 | R | The admin window/status/status-set filters run in SQL; the count matches the list; an empty `statuses` gives 0. |
| 275 | R | `maxReferenceSequence` handles GLOB prefix, case and non-digit suffixes. Feeds the reference allocator. |
| 288 | R | Paging uses an id tie-break with no repeats or gaps. |

### tests/workers/email-template.test.ts
| line | mark | evidence |
|---|---|---|
| 82 | F | Its unique value is on real D1: a webhook confirmation fans out through `recipientsForEvent`/`sendToRecipient` to customer and owner. But it asserts incidental copy (`'Booking confirmed'`, `'we look forward…'`) and compares the html against `renderDefaultEmail`'s own output (expected value produced by the renderer under test). Repair: drop the copy and self-render assertions; assert both recipients were sent and both split `email` outbox rows are `succeeded`. Copy stays owned by `email-render-snapshot`. |
| 119 | D | Tests `fakeTransportRenderer`, a function defined inside the test file. No production code runs. |

### tests/workers/metadata-e2e.test.ts
| line | mark | evidence |
|---|---|---|
| 50 | R | Consumer metadata survives checkout → D1 JSON → self-healed confirmation → status + both manage roles, labelled via the real smoke config. |
| 118 | D | A required-field rejection is pure handler validation that runs before any write. Remaining proof: `tests/handlers-checkout-metadata.test.ts:66`, which is stronger (asserts code, `details.field`, "required", type). |

### tests/workers/migrations-fingerprint.test.ts — all R (retention bar: schema fingerprint)
| line | mark | evidence |
|---|---|---|
| 44 | R | `checkReservaMigrationsApplied` passes on a real, fully migrated schema. Keeper (absorbs `runtime-migrations:67`). |
| 50 | R | A forged ledger over a bare schema → collision error, not "missing". Keeper (absorbs `runtime-migrations:102`). |
| 72 | R | it.each over 10 bookings columns: each dropped column is caught. |
| 84 | R | it.each over 10 pre-v2 columns: each one still present is caught. |
| 94 | R | `idx_bookings_payment_ref` missing is caught. |
| 103 | R | side_effect_operations indexes (3 rows). |
| 116 | R | side_effect_operations columns (2 rows). |
| 125 | R | refund_operations indexes (2 rows). |
| 137 | R | refund_operations columns (4 rows). |
| 149 | R | operational_incidents table missing. |
| 159 | R | operational_incidents columns. |
| 166 | R | operational_incidents indexes. |
| 181 | R | reconciliation_lease table missing. |
| 188 | R | reconciliation_lease columns. |

### tests/workers/ops-health.test.ts — all R (no unit-level handler suite exists)
| line | mark | evidence |
|---|---|---|
| 117 | R | 403 without admin auth, and the body leaks nothing about the outbox. |
| 127 | R | SQL GROUP BY outbox debt (pending vs abandoned vs succeeded), oldest pending age, incidents, `no-store`, security posture, schema ok. |
| 158 | R | A drained deployment returns empty collections plus the `reconciliation_stale` self-incident. |
| 169 | R | Query params are ignored and no booking data leaks. |
| 184 | R | 405 on POST. |

### tests/workers/ops-reconcile.test.ts — all R
| line | mark | evidence |
|---|---|---|
| 108 | R | Unauthorized → 403 with no sweep and the lease untouched. |
| 118 | R | An operator bearer runs the sweep; summary returned; `no-store`. |
| 131 | R | An admin identity is accepted too. |
| 141 | R | The lease is released on success, and ops health reports `lastRunAt`/summary. |
| 156 | R | A held lease → 409 `reconciliation_in_progress`, with no half-done work. Real CAS lease. |
| 172 | R | No alert sink → 503. |
| 184 | R | 405 on GET. |
| 193 | R | The cron `scheduledHandler` sweeps. |
| 202 | R | The cron skips with a warning, without throwing, when the route holds the lease. |

### tests/workers/reconciliation-claims.test.ts
| line | mark | evidence |
|---|---|---|
| 48 | R | 5 concurrent `claimRefundExecution` → exactly one winner. |
| 63 | R | A stale `in_flight` row is reclaimable only after the lease window. |
| 80 | R | The `next_attempt_at` gate holds; the retry bypass ignores it. |
| 95 | R | `abandoned` is claimable only through the retry bypass. |
| 114 | R | Mutation side-effect backoff gate and bypass. |
| 142 | R | Concurrent incident alert claims → one winner. |
| 157 | R | A stale alert token cannot resolve. |
| 178 | F | Reopen/resolve lifecycle is fine, but the comment says the reopen upsert uses "escalate=true" while the call passes `escalate: false`, and the describe claims "a later reopen increments alert_revision" without asserting it. Repair: fix the comment and assert that `alertRevision` increments on reopen (repo.ts:2336). |
| 221 | R | `listOpenIncidents` severity/age order; counts match the lists. |

### tests/workers/reconciliation-runtime.test.ts — all R (real-D1 keeper over tests/reconciliation.test.ts's fake)
| line | mark | evidence |
|---|---|---|
| 48 | R | Sweeps an expired hold. |
| 63 | R | Resumes a stuck cancelled-booking refund through the real claim. |
| 90 | R | Scan-time backoff against a stored attempt_count/attempted_at (10 → 20 min windows). |
| 129 | R | A requested refund whose cancel CAS was interrupted: Stripe only runs after a durable cancel. |
| 156 | R | Terminal rows beyond `sourceLimit` do not starve actionable debt (fairness). |
| 184 | R | An oversell marker becomes a persisted incident. |

### tests/workers/refund-operations.test.ts
| line | mark | evidence |
|---|---|---|
| 48 | C | Two concurrent claims → one winner. Duplicates 67 (five concurrent claims, full/none alternating). Absorbed by 67 after carrying over the `stored.choice` agreement assertion. |
| 67 | R | Five concurrent claims → one winner, and the stored id matches the winner. Keeper for the claim CAS. |
| 89 | R | A sequential second claim is a no-op and never overwrites. |
| 104 | F | The `resolveRefundOperation` half is R. The second half exercises `upsertRefundOperation`, which has **no production caller** (the webhook uses `upsertRefundOperationAndTransitionToCancelled` → `stripeRefundReconciliationStmt`). Retarget to `reconcileStripeRefundOperation`, or drop it with the seam. |
| 126 | R | `deleteRefundOperation` cannot destroy a succeeded row. |
| 143 | R | `deleteRefundOperation` removes a requested row. |
| 155 | D | "upsertRefundOperation never regresses" guards only the test-only `upsertRefundOperation`. Production non-regression is owned by 195 (`reconcileStripeRefundOperation`). Pair the deletion with the seam removal (changeset). |
| 175 | R | Authoritative Stripe data corrects a none/succeeded audit row. The comment above it (about resolveRefundOperation) belongs to 309. |
| 195 | R | Reconcile does not regress against stale requested/failed data, and repeating it is idempotent. |
| 242 | R | Refund + cancel in one batch; on CAS loss the refund is kept. |
| 275 | R | An expired operator token is allowed only for requested/failed refund recovery, including the legacy lookup path. |
| 309 | R | `resolveRefundOperation` never downgrades a succeeded row. |
| 328 | R | A partial claim stores its decided amount through resolution. |
| 349 | R | The CHECK rejects a partial row with no amount and a full row with an amount (328 provides the positive control). |

### tests/workers/refunds-disputes-migration.test.ts — all R (migration backfill, retention bar)
| line | mark | evidence |
|---|---|---|
| 80 | R | it.each: only succeeded refund amounts carry over (5 rows). |
| 90 | R | A dispute is dated by its earliest outbox row. |
| 99 | R | Non-disputed rows get no dispute. |
| 105 | R | The backfill leaves status and updatedAt untouched. |

### tests/workers/repo-cas-transitions.test.ts
| line | mark | evidence |
|---|---|---|
| 47 | R | Cancel wins and the stale no-show loses; the row keeps `cancelledBy`. Line 70's compound boolean is vacuous given line 68; it can be dropped. |
| 73 | R | No-show wins and the stale cancel loses; no cancel fields leak. |
| 97 | F | Cancel vs **`transitionReschedule`**, which production has not called since c0754de. Retarget the loser to `rescheduleWithCapacity`, the real reschedule CAS. |
| 130 | F | Same problem: the `expectedStartsAt` stale-cancel guard is proven against a reschedule the dead method wrote. Retarget the winner to `rescheduleWithCapacity`. |
| 164 | C | At the repo level this is identical to 47 (`transitionToCancelled` accepting `confirmed`, then `transitionToNoShow` loses). Absorbed by 47. |
| 193 | F | At the repo level this duplicates 73. The regression it names (webhook refund scope excluding `no_show`, webhook.ts:161) is supplied by the test's own `expectedStatusIn`, so it cannot catch a handler change. Move it to the webhook handler boundary: charge.refunded on a `no_show` booking stays `no_show`. |
| 217 | R | An operator cancel of a hold beats a late payment confirm; no `paymentRef` is written. |

### tests/workers/repo-d1.test.ts
| line | mark | evidence |
|---|---|---|
| 25 | R | Hold CRUD, session lookup, and the strict `sweepExpiredHolds` boundary (equal is not swept, +1 ms is). |
| 55 | F | Lease serialization and the `expireHold` CAS are R. The per-IP hold-limit half runs through **`insertHold`**, not production `insertHoldWithCapacity`, whose separate WHERE clause plus post-failure reclassification (repo.ts:1466-1477) has no real-D1 test. Retarget the hold-limit assertion to `insertHoldWithCapacity` (retention bar: hold limits). |
| 110 | R | A failing outbox insert rolls back the confirmation (trigger technique). |
| 148 | R | A failing hook-row insert rolls back the confirmation. |
| 190 | R | A failing split owner email-row insert rolls back the confirmation. |
| 226 | D | Byte-for-byte subset of `capacity-overrides.test.ts:57` (upsert → get → delete → null). |
| 239 | R | Meeting point columns round-trip through `insertHoldWithCapacity`. |
| 255 | R | Omitted meeting point → NULL columns. |
| 272 | C | "Pre-0014" NULL row: `insertHold` already writes NULL (the comment admits it), so this repeats 255's NULL read. Absorbed by 255. |
| 294 | R | A non-enum `pickup_type` survives write and read (no CHECK; the domain lives in config). Keeper that absorbs `schema-constraints:98`. |
| 310 | R | A stored empty `pickup_type` → `InvalidBookingRowError` at read time. |
| 325 | R | A NULL `pickup_type` hydrates as null. |
| 337 | R | `guest_count` is set at confirm, a late detail cannot overwrite it, and the CHECK rejects 0. |
| 364 | R | `countMetadataValues` upcoming/past semantics. It sits in the wrong describe (refund/dispute); move it. |
| 389 | R | Money column defaults are 0/null. |
| 393 | R | The refunded total is monotonic MAX regardless of order; the CHECK rejects negatives. |
| 405 | R | A dispute opens once; close sets the outcome. |
| 416 | R | Reopen/move requires the provider timestamp. |
| 439 | R | Close-before-open ordering; the dispute_status CHECK holds. |
| 456 | R | No plaintext is stored even without a key, and hash lookup still works. |
| 477 | R | With a key: no hash-as-credential, expiry, cancel-only revocation. |
| 517 | R | Legacy plaintext compat fallback plus lazy hash/enc backfill. |
| 550 | F | Titled "re-running migration 0009's retroactive UPDATE", but after the squash no shipped migration contains that statement. The remaining contract is that a legacy plaintext row with `cancel_token_revoked_at` set denies the customer token and keeps the operator token. Retitle it and set the column directly. |
| 604 | R | Production `rescheduleWithCapacity` moves `tokens_expire_at` later and earlier, and COALESCE keeps it when omitted. |
| 653 | D | Same contract through dead `transitionReschedule`. The production path is covered by 604. Delete together with the seam. |
| 686 | R | Dumped hash/placeholder/ciphertext never authenticates, for either token family or lookup. |
| 717 | R | A tampered or foreign-key ciphertext fails closed to the placeholder. |
| 763 | R | A stale resolver token is fenced after a reclaim. |
| 790 | R | The mutation drain reclaims a stale `in_flight` row. |
| 814 | F | "Only the winning CAS records outbox rows" is proven on dead `transitionReschedule`. Retarget to `rescheduleWithCapacity` (loser leaves no `booking.rescheduled` row). |
| 843 | R | A failing outbox insert rolls back the cancellation. |

### tests/workers/runtime-workerd.test.ts
| line | mark | evidence |
|---|---|---|
| 13 | D | `createContext({request})` with no locals resolves `RESERVA_DB` from `cloudflare:workers`. `tests/workers/worker.ts:79` calls exactly that path for every `webhook.test.ts` case, which would fail with "RESERVA_DB is not configured" if it broke. |

### tests/workers/schema-constraints.test.ts
| line | mark | evidence |
|---|---|---|
| 42 | R | quantity=0 CHECK. |
| 48 | R | quantity=-1 CHECK (could share an it.each with 42). |
| 54 | R | price_minor CHECK. |
| 60 | R | ends_at = starts_at CHECK. |
| 67 | R | ends_at < starts_at CHECK. |
| 74 | R | Partial unique `payment_ref`. |
| 83 | R | NULL `payment_ref` allowed more than once. |
| 90 | R | Positive control for the bare `rejects.toThrow()` matrix. Optional hardening: match `/CHECK|UNIQUE/`. |
| 98 | C | Raw insert of a non-enum `pickup_type` succeeds. Subsumed by `repo-d1:294`, which inserts the same value through the repo, so it would fail on the same CHECK regression and also proves the read path. |
| 107 | R | capacity_defaults negative CHECK. |
| 113 | R | day_overrides negative CHECK. |
| 119 | R | capacity 0 allowed. |
| 139 | R | A duplicate PI on confirm → 409 `DuplicatePaymentRefError`; the batch rolls back. |
| 161 | R | `applyConfirmedPaymentDetails` duplicate PI → 409. |
| 178 | R | The generic `updateBooking` duplicate guard (3 `src/` callers). |
| 190 | R | Regression pin: an empty-string PI collision gives 409, not 500. |

### tests/workers/smoke-runtime.test.ts
| line | mark | evidence |
|---|---|---|
| 52 | R | The real smoke runtime: strict verification, real tokens (not `nohash:`) in the emitted manage URLs, operator manage, dev admin bypass listing. Overlaps metadata-e2e's flow but asserts disjoint facts. |

### tests/workers/webhook.test.ts — all R (assembled money path)
| line | mark | evidence |
|---|---|---|
| 107 | R | Signed checkout.session.completed → confirmed, with calendar/email/hook rows `succeeded`. |
| 137 | R | Tampered and unsigned requests → 400; nothing written. |
| 165 | R | Redelivery is idempotent; attemptCount stays 1. |
| 195 | R | A stale completion for a cancelled booking stays cancelled; only the session ref is backfilled. |

### tests/repo.test.ts (fake D1; exact SQL strings)
Each test proves "the change plus its history row ride one `db.batch()`". Real D1 cannot see that on the
success path, so these are the only atomicity proof. They pin exact SQL text, so any whitespace edit breaks
them. Mark C: the absorbing owner is `tests/workers/admin-history.test.ts`, extended with a
`CREATE TRIGGER … RAISE(ABORT)` on `admin_change_history` insert per write family, then asserting the
settings/capacity/override row was **not** written (the pattern already used at `repo-d1:110`). Delete
these only after that lands.
| line | mark | evidence |
|---|---|---|
| 29 | C | `applySettingsBatch` batch shape → admin-history trigger rollback case. |
| 51 | C | Empty ops → no batch. Absorbed by an admin-history "no history rows" assertion. |
| 62 | C | `deleteSetting` → admin-history trigger case. |
| 75 | C | `upsertCapacityDefault` (history value JSON is already asserted in real D1 at capacity-overrides:126 for overrides; add it for defaults). |
| 92 | C | `deleteCapacityDefault` → trigger case. |
| 107 | C | `upsertDayOverrides` → trigger case; per-date history is already real at capacity-overrides:126. |
| 132 | C | `deleteDayOverrides` → trigger case. |
| 147 | C | Empty dates → capacity-overrides:149 plus a history-length-0 assertion. |

### tests/fakes.test.ts (test-support fidelity; R-support)
These test the fake, not production. Each mirrors a real-D1 owner (`repo-d1:456-545`, `capacity-overrides:210/225`,
`schema-constraints:139-198`) and keeps unit suites honest: for example, `handlers-webhook-redelivery:126`'s
409 comes from the fake's duplicate guard. Keep them while the unit layer relies on these fake behaviours,
and retire each one with its last unit consumer.
| line | mark | evidence |
|---|---|---|
| 25 | R | Legacy seeded tokens hydrate without a key (fixture design that the handler suites rely on). |
| 52 | R | Lazy backfill keeps legacy tokens presentable. |
| 73 | R | New rows are `nohash:` without a key (mirrors repo-d1:456). |
| 87 | R | With a key, hydrated reads are real and raw reads are placeholders (mirrors capacity-overrides:225). |
| 111 | R | Duplicate PI guard across fake write paths (mirrors schema-constraints). |
| 146 | R | Partial-write no-op and refund upsert non-overwrite parity. Its `upsertRefundOperation` half goes with that seam. |
| 170 | R | Lease refused for an unknown id. |

### tests/schema-fingerprint.test.ts
| line | mark | evidence |
|---|---|---|
| 11 | R | `RESERVA_MIGRATIONS` equals the on-disk `*.sql` in **numeric** order. The generator sorts lexically (generate-schema-fingerprint.ts:147), so this is independent of `generate:check`. |
| 18 | D | "Fresh replay equals the generated module" is exactly what `bun run generate:check` enforces in CI `verify` (`render() === file`). The test (2026-09-16) predates the check (4e2c5cb, 2026-09-17). |
| 24 | R | The generator picks up an `ALTER TABLE ADD COLUMN` from a later migration (generator behaviour; generate:check is self-consistent and cannot catch this). |

### tests/runtime-migrations.test.ts
| line | mark | evidence |
|---|---|---|
| 67 | C | "Passes when everything is applied" against a fake whose answers are derived from the fingerprint itself. Absorbed by real-D1 `migrations-fingerprint:44`. |
| 71 | R | Extra consumer migrations are tolerated (only here). |
| 76 | F | The configured `migrationsTable` contract is real, but the test asserts the exact query sequence (call-shape). Repair: assert behaviour, i.e. it passes against a DB whose ledger lives only in `reserva_migrations`. A real-D1 version is possible in migrations-fingerprint. |
| 90 | R | A configured table with a missing ledger → "is missing", and the fingerprint is not queried (short-circuit). |
| 102 | D | The same assertions as real-D1 `migrations-fingerprint:50` (`/dedicated D1 database/`, not `/is missing/`), plus a copy-prefix match. The fake answers the question. |
| 110 | R | An unsafe `migrationsTable` identifier is rejected (SQL injection guard). |
| 117 | R | The missing-migration message names the file and the wrangler/reserva-migrate commands (remediating error). |
| 124 | R | A missing ledger table lists every migration. |
| 130 | R | A transient select error propagates and is not recast as missing. |
| 140 | R | Regression: a transient failure does not poison the memoized check. |

### tests/reserva-migrate-cli.test.ts — all R (public `reserva-migrate` bin; arg parsing, config derivation, cleanup, real wrangler)
Lines 85, 98, 110, 117, 128, 141, 148, 161, 174, 188, 205, 212, 226, 237, 252, 265, 272, 283, 290, 302, 325, 356,
369, 388, 403, 413, 467, 485: each pins one CLI behaviour (binding selection, env selection, JSONC/TOML
parsing, option forwarding, `--` passthrough, derived-config shape, no files left beside the consumer config,
cleanup on success and failure, and two real-wrangler runs as the only end-to-end proof that an absolute
`migrations_dir` works). No duplicates found.

## Layer plan

| Contract | Keeper | Redundant layer / action |
|---|---|---|
| Checkout / reschedule capacity guard | `workers/capacity-allocation` | Collapse the mirror orderings (95, 128). The unit fake race (`handlers-checkout-race`) is a different contract (§6 TOCTOU), not this lane's. |
| Per-IP hold cap | **Gap**: should be `workers/repo-d1` on `insertHoldWithCapacity` | `repo-d1:55` proves only the `insertHold` copy; the unit 429 (`handlers-lifecycle:135`) runs on the fake. |
| Status CAS transitions | `workers/repo-cas-transitions` | 164 folds into 47. Retarget 97/130 to `rescheduleWithCapacity`. Move 193's claim to the webhook handler. |
| Reschedule outbox / tokens_expire_at | `repo-d1:604`, `calendar-patch-outbox` | Delete `repo-d1:653`; retarget `repo-d1:814`. |
| Admin change + history atomicity | `workers/admin-history` (after adding trigger-rollback cases) | Retire `tests/repo.test.ts` (8 exact-SQL fake-D1 tests) once they land. |
| Day override / capacity default persistence | `workers/capacity-overrides` | Delete `repo-d1:226`. |
| Schema constraints | `workers/schema-constraints` + repo-level CHECK asserts in repo-d1/refund-operations | `schema-constraints:98` folds into `repo-d1:294`. |
| Migration ledger + fingerprint | `workers/migrations-fingerprint` (real D1) + `generate:check` (freshness) + `schema-fingerprint:11,24` | `runtime-migrations:67,102` (fake derived from the fingerprint) and `schema-fingerprint:18` (duplicates generate:check). The unit layer keeps what only it reaches: messages, memoization, identifier guard, consumer extras. |
| Refund claim / reconcile | `workers/refund-operations`, `workers/reconciliation-claims` | 48 folds into 67. 155 and 104's upsert half go with the `upsertRefundOperation` seam. |
| Reconciliation pipeline | `workers/reconciliation-runtime` + `ops-reconcile` | The fake-backed `tests/reconciliation.test.ts` belongs to another lane; keep its logic-only cases. |
| Availability validation | `tests/handlers-lifecycle.test.ts:288,312` | `availability-horizon:103,110` duplicate them; keep 78 (real-D1 horizon/performance). |
| Metadata validation | `tests/handlers-checkout-metadata.test.ts:66` | `metadata-e2e:118` duplicates it. |
| Runtime env binding under workerd | `webhook.test.ts` via `worker.ts` | `runtime-workerd.test.ts` (whole file). |
| Fake repository fidelity | `tests/fakes.test.ts` (support) | Keep while the unit suites depend on these fake behaviours. |

`tests/workers/` has no two suites duplicating the same CAS/capacity contract wholesale. The real overlaps
are single tests (repo-d1:226 against capacity-overrides:57; mirror orderings within capacity-allocation;
cas:164 against cas:47). The larger problem is the **opposite of duplication**: the real-D1 tests for three
contracts exercise repo methods that production no longer calls.

### Test-only production seams (grep over `src/` excluding `src/repo.ts`, plus examples/scripts)
All are `BookingRepository` methods and therefore reachable through the public `ReservaContext.repo`
(`src/runtime.ts` re-exports `ReservaContext`). None is in a package entry's value exports, but removing
any of them changes a public type, so each needs a changeset and an API call.
- `transitionReschedule` (repo.ts:486/1857, plus the fake): no caller since c0754de. Unlocks deleting
  `repo-d1:653` once cas:97/130 and repo-d1:814 are retargeted. **Best candidate.**
- `upsertRefundOperation` plus `refundOperationUpsertStmt` (repo.ts:584/1182/2187, plus the fake): no caller;
  production uses `stripeRefundReconciliationStmt`. Unlocks `refund-operations:155`, the upsert half of 104,
  and part of `fakes.test:146`.
- `insertHold`: no `src/` caller, but `scripts/smoke-scheduled-test.ts` and nearly every workers suite use it
  as a seed helper. Not a deletion candidate; the fix is to test the production twin.
- `upsertDayOverride`/`deleteDayOverride` (singular) and `upsertSetting`: no `src/` caller; used as test setup.
  Low value to remove.
- `listAdminChangeHistory`: the only reader of `admin_change_history`, with no `src/` caller (history is
  written and never read by the product). This is a product decision, not a seam cleanup.

## High-confidence batch

Each entry lists: name/location · failure it detects · non-test callers of the covered code · stronger remaining proof · history · deletion unlocked · risk and validation.

1. **`availability-horizon.test.ts:103` "rejects one request spanning more than the per-request cap"** (D) ·
   detects a missing or changed 62-day cap in `validDateRange` · caller `handleAvailability` (route
   `availability`) · `handlers-lifecycle.test.ts:312` asserts 62 OK / 63 rejected with `details.field: 'to'` ·
   added with the horizon suite, whose real purpose is the full-horizon read (78) · no source unlocked ·
   low risk; `bun run test:workers tests/workers/availability-horizon.test.ts` and
   `bun run test tests/handlers-lifecycle.test.ts`.
2. **`availability-horizon.test.ts:110` "still rejects a request past the horizon"** (D) · detects the horizon
   message or its bound changing · same caller · `handlers-lifecycle.test.ts:288` asserts the exact message
   through the same branch (180-day fixture) · same history · none unlocked · low risk; same commands.
3. **`email-template.test.ts:119` "overrides booking.no_show instead of delegating"** (D) · detects only a
   change to the test file's own `fakeTransportRenderer`; no production code is exercised · non-test callers:
   none · no proof needed (no contract) · consumer-renderer demo · none unlocked · no risk;
   `bun run test:workers tests/workers/email-template.test.ts`.
4. **`metadata-e2e.test.ts:118` "rejects a checkout missing the required dietary_notes field"** (D) · detects
   required-metadata validation regressing · caller `handleCheckout` · `handlers-checkout-metadata.test.ts:66`
   (asserts code, field, "required", type) · the file's point is the survives-D1 test (50) · none unlocked ·
   low risk; `bun run test:workers tests/workers/metadata-e2e.test.ts` and
   `bun run test tests/handlers-checkout-metadata.test.ts`.
5. **`repo-d1.test.ts:226` "persists capacity overrides"** (D) · detects day-override upsert/delete breaking on
   D1 · the covered singular methods have no `src/` caller · `capacity-overrides.test.ts:57` does the same
   round trip plus ON CONFLICT · early repo smoke test predating capacity-overrides · none unlocked · no risk;
   `bun run test:workers tests/workers/repo-d1.test.ts` and `… capacity-overrides.test.ts`.
6. **`runtime-workerd.test.ts:13` (whole file)** (D) · detects `createContext` failing to load `RESERVA_DB` from
   `cloudflare:workers` when no locals are passed · callers: every Cloudflare runtime request (runtime-context.ts:245) ·
   `webhook.test.ts` (4 cases) dispatches through `worker.ts:79`, which calls `runtime.createContext({ request })`
   without locals · from the initial commit (92129c7), when this was the only workerd test · none unlocked ·
   medium-low risk: if worker.ts ever starts passing locals, the coverage silently moves. Add a one-line
   comment in worker.ts when deleting. `bun run test:workers tests/workers/webhook.test.ts`.
7. **`schema-fingerprint.test.ts:18` "matches a fresh replay of the migration chain"** (D) · detects a stale
   `src/generated/schema-fingerprint.ts` · caller `scripts/generate.ts` · `bun run generate:check`
   (in `verify`, CI) does the identical `render() === file` comparison · test 3e25b99 (09-16) predates the check
   4e2c5cb (09-17) · none unlocked · low risk, though the fingerprint is retention-bar, so confirm reviewers accept
   generate:check as the owner; `bun run generate:check` and `bun run test tests/schema-fingerprint.test.ts`.
8. **`runtime-migrations.test.ts:102` "distinct collision error …"** (D) and **`:67` "passes silently …"** (C) ·
   detect the collision/pass verdicts of `checkReservaMigrationsApplied` · caller `runtime-context.ts` (memoized
   per isolate) · real-D1 `migrations-fingerprint.test.ts:50` / `:44`, same assertions against real sqlite_master ·
   the unit fake predates the real-D1 suite; its answers are generated from the fingerprint, so it cannot
   disagree · none unlocked (the `fingerprintResults` helper stays for 140) · low risk;
   `bun run test tests/runtime-migrations.test.ts` and `bun run test:workers tests/workers/migrations-fingerprint.test.ts`.
9. **`capacity-allocation.test.ts:95` and `:128`** (C into 84 / 116) · detect "at most one winner" with the ids
   swapped · caller `insertHoldWithCapacity`/`rescheduleWithCapacity` in checkout/manage · 84/116 run the same
   symmetric inputs; the file header states one ordering suffices because D1 is serial · none unlocked · low risk
   (capacity is retention-bar; keep one ordering each) · `bun run test:workers tests/workers/capacity-allocation.test.ts`.
10. **`repo-cas-transitions.test.ts:164`** (C into 47) · detects a stale no-show overwriting a cancelled row ·
    caller `transitionToNoShow` (operator no-show) · 47 runs the identical repo sequence (only the winner's
    expectedStatusIn list differs, and it is test-supplied) · none unlocked · low risk;
    `bun run test:workers tests/workers/repo-cas-transitions.test.ts`.
11. **`refund-operations.test.ts:48`** (C into 67, carrying the `stored.choice` assertion) · detects a double refund
    claim · caller `claimRefundOperation` (customer/operator cancel, reconciler) · 67: five concurrent claims with
    alternating choices · none unlocked · low risk; `bun run test:workers tests/workers/refund-operations.test.ts`.

Not batched (need a replacement first, or a changeset): all 8 of `tests/repo.test.ts` (wait for the
admin-history trigger cases), `repo-d1:653` and `refund-operations:155` (pair them with the seam removals),
`repo-d1:272`, `schema-constraints:98`, `admin-auth-port:109`.

## Suspected product issues and coverage gaps (none confirmed as a live bug)

1. **Production per-IP hold cap is untested on real D1.** `insertHoldWithCapacity`'s own hold-cap clause and its
   post-failure `HoldLimitExceededError` reclassification (repo.ts:1466-1477) have no workers test. `repo-d1:55`
   tests the `insertHold` copy. Retention-bar contract.
2. **Production reschedule CAS races are proven on a dead method.** Cancel-vs-reschedule (cas:97/130) and
   loser-writes-no-outbox (repo-d1:814) use `transitionReschedule`, which is not called since c0754de.
   `rescheduleWithCapacity`'s status/starts_at CAS loss against a cancel has no real-D1 test.
3. **`admin-auth-port:150` is vacuous for CSRF.** 303 is also the `csrf_expired` / error redirect.
4. **Webhook refund scope** (`webhook.ts:161`, excluding `no_show`) is not pinned at the handler boundary.
   `cas:193` restates it with a test-supplied list.
5. **Stale post-squash references.** Test comments cite migrations 0008/0009/0014/0015/0018, and `repo-d1:550`
   replays a "0009" UPDATE that no shipped migration contains. `reconciliation-claims:178` has a comment that
   contradicts its call (`escalate`).
6. **`admin_change_history` is write-only in the product.** `listAdminChangeHistory` has no `src/` caller.
