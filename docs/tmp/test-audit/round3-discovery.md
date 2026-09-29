# Test-audit round 3 — read-only discovery (HEAD e88c59c)

Scope: current `tests/`, `packages/stripe/tests` (worktrees skipped). Inputs: SKILL.md, architecture.md,
test-audit-sweep.md (round 1 + 2 + held list), all eight lane ledgers re-checked against HEAD.
Nothing edited, no vitest/playwright run.

Ledger re-check result: of ~105 C/D rows across the eight ledgers, ~95 are already handled at HEAD
(deleted, consolidated, or repaired in 9271e38 / ee5b12c / e192a5f / 51880de / 09df225 / 07c4e0a).
Held items (meeting-points:21 vs maze:181, component instance-ids:21, widget scarcity grep,
handlers-manage page renderers) are not re-proposed.

Junk-pattern hunts:
- (a) source greps: only `ui-booking-widget` (held/Maybe), `integration-entry:15` (R, deliberate pin,
  no executing owner), `providers-tree-shake` (R, structural guard), `ui-theme-tokens` CSS reads (R).
- (b) prose: see Batch 7-9 and Maybe.
- (c) priceFor in tests: clean (only `core-config:169`, which tests canonicalization with a hand value).
- (d) hand-copied lists: clean for routes/codes/events. `RESERVA_TABLES` is copied between two worker
  files (setup duplication only → Maybe).
- (e)/(f): no new high-confidence cases beyond the ledgers; `handlers-checkout-race:18` re-checked, R
  (unique handler proof of the null→sweep→retry→409 path).
- (g) wrong-guard negatives: block scan of every 4xx-without-code test found none that can be satisfied
  by a different guard (operator auth has one guard; the admin cross-origin cases carry a valid token).
- (h) test-only / dead production: see Batch 10-11 and Maybe.

---

## Batch (high confidence)

### 1. `tests/booking-confirmation.test.ts:8` "renders a confirmed booking from the minimized status payload" — D
- Detects: copy/format change on the confirmed page (reference, title not slug, "2 people", €100.00, meeting point).
- Seam callers: none (`renderConfirmationPage` is production-called by the confirmation route).
- Stronger proof: `tests/ui-page-snapshots.test.ts:33` "confirmed, full booking" — same `fullBooking`
  input field-for-field; snapshot contains every asserted string byte-for-byte.
- History: outbox ledger marked C in round 1; never applied, not held.
- Unlocks: nothing in production; −1 prose test.
- Risk nil. `bun run test tests/booking-confirmation.test.ts` then `bun run test tests/ui-page-snapshots.test.ts`.

### 2. `tests/booking-confirmation.test.ts:86` "renders a cancelled booking as cancelled with a start-over action" — D
- Detects: cancelled copy, "Start a new booking" link, absence of not-found copy.
- Stronger proof: `ui-page-snapshots.test.ts:40` "cancelled" (same input; pins h1, lead, href, and as a
  whole document excludes the not-found copy). Also `component/customer-page-routes:103` via the real route.
- History / unlocks / risk / validation: as item 1.

### 3. `tests/core-config.test.ts:686` "accepts a service with no metadataFields at all (unchanged, absent)" — D
- Detects: `validateConfig` inventing `metadataFields`.
- Stronger proof: `core-config.test.ts:8` `expect(validateConfig(config)).toEqual(config)` — the fixture
  declares no `metadataFields`, so an injected `[]` fails :8.
- History: 2103659 (metadata feature); domain ledger C.
- Unlocks: nothing. Risk nil. `bun run test tests/core-config.test.ts`.

### 4. `tests/workers/runtime-workerd.test.ts:13` "loads D1 from cloudflare:workers without legacy Astro locals" — C
- Detects: `createContext({request})` failing to resolve `RESERVA_DB` from `cloudflare:workers`.
- Stronger proof: `runtime-workerd.test.ts:23` (added 07c4e0a) makes the identical no-locals call and would
  throw "RESERVA_DB is not configured" (`runtime-context.ts:250`) first; `tests/workers/worker.ts` uses the
  same path for every `webhook.test.ts` case.
- Edit shape: fold the `context.db === env.RESERVA_DB` identity assertion into :23, delete :13.
- Unlocks: nothing. Risk low. `bun run test:workers tests/workers/runtime-workerd.test.ts`.

### 5. `tests/schema-fingerprint.test.ts:18` "matches a fresh replay of the migration chain, so a stale generated file fails the build" — D
- Detects: stale `src/generated/schema-fingerprint.ts`.
- Stronger proof: `bun run generate:check` (`scripts/generate.ts --check`, byte-exact `render() === file`),
  first step of `bun run verify` in CI (`.github/workflows/ci.yml:35`). SKILL.md Validation §2 names
  generate:check as the owner of generated files.
- History: test 3e25b99 (09-16) predates the check 4e2c5cb (09-17). d1-repo ledger batch item, never applied.
- Keep :24 ("picks up a column added by a later migration") — it tests the generator logic itself.
- Unlocks: nothing. Risk low (fingerprint is on the retention bar; the owner remains CI).
  `bun run generate:check` + `bun run test tests/schema-fingerprint.test.ts`.

### 6. `packages/stripe/tests/provider.test.ts:326` "reconciles an already-refunded error via refunds.list instead of surfacing a false failure" — D
- Detects: a thrown `refunds.create` error reconciled via `refunds.list`.
- Stronger proof: `:343` — same branch, same assertions, with an opaque message; the catch never reads the
  message (`isDefinitiveStripeError` checks type only), so :343 is the strictly stronger input and the actual
  regression pin (93bb918, BK-REFUND-001).
- Unlocks: nothing. Risk nil. `bun run test packages/stripe/tests/provider.test.ts`.

### 7. `tests/ui-layout.test.ts:27` "emits neither when unset" — F (name overpromises)
- Detects only: no favicon link when unset. The "consumer head HTML" half is unasserted.
- Repair: also assert nothing follows the library stylesheet (no second `rel="stylesheet"`), or rename.
- Risk nil. `bun run test tests/ui-layout.test.ts`.

### 8. Vacuous prose negatives → catalog lookups — F
- `tests/email-render.test.ts:191-192` ("says free cancellation is not available…"): negative
  `'Free cancellation until'` goes vacuous on a copy edit. Use `englishEmailCopy['cancellation.free']`
  prefix and `formatMessage(englishEmailCopy['cancellation.closed'], { cancelCutoffHours: '24' })`
  (`src/email/copy.ts:41-42`).
- `tests/providers-email.test.ts:176,179` ("omits the manage-link paragraph…"): `'Manage my booking'` /
  `'Open booking actions'` negatives → `englishEmailCopy['confirmed.customer.button']` / `['owner.button']`
  (copy.ts:52,55). Keep the `nohash:` / `href=""` negatives.
- Owner of the copy itself: `email-render-snapshot`. Risk nil.
  `bun run test tests/email-render.test.ts`, `bun run test tests/providers-email.test.ts`.

### 9. e2e incidental copy — F (same shape as 09df225)
- `tests/e2e/operator.spec.ts:26,54` `getByText('This booking has been cancelled.')` →
  `page.locator('body[data-bk-status="cancelled"]')` (`src/ui/layout.ts:142`; precedent
  `ui-manage-page.test.ts:123`). The API status check after it stays.
- `tests/e2e/widget-party-size.spec.ts:11,29` option labels `'1 person'…'6 people'` → option `value`s
  `['1'..'6']` / `['1','2']` (the contract is sizes 1..maxQuantity; labels are catalog copy).
- Risk low. `bun run test:e2e tests/e2e/operator.spec.ts`, `bun run test:e2e tests/e2e/widget-party-size.spec.ts`.

### 10. `expireBooking` (`src/core/booking.ts:165`) — test-only production code
- Non-test callers: none (grep src/, packages/, examples/, scripts/). Expiry happens in SQL
  (`repo.sweepExpiredHolds`). Not public (`src/core/index.ts` exports only `toWireBooking` + types from booking).
- Tests: `core-booking.test.ts:14` (seed `booking({ status: 'expired' })` for the expired→confirmed leg;
  keep hold→expired via `transitionBooking(hold, 'expired', …)`) and `:48` (use
  `transitionBooking(booking(), 'expired', …)` to assert `BookingTransitionError`).
- History: domain ledger flagged it (medium only because it touched two assertions).
- Unlocks: −4 prod LOC. Empty changeset. Risk nil.
  `bun run test tests/core-booking.test.ts` + `bun run typecheck`.

### 11. Dead production exports with zero callers (not even tests)
All non-public (not reachable from any `package.json` `exports` entry; grep of src/, packages/, examples/,
scripts/, docs, AGENTS.md finds only the definition):
- `isCurrencyCode` — `src/core/currency.ts:19` (since e17ec80)
- `isBookingEvent` — `src/core/events.ts:198` (eb9bea7; `isWebhookEvent` next to it is used)
- `generateSlotStarts` — `src/core/slots.ts:63` (initial commit)
- `addMinutesIso`, `formatLocalDate`, `formatLocalTime` — `src/core/time.ts:190,198,202` (initial commit)
- `slotRemaining` — `src/core/occupancy.ts:326` (initial commit; only a comment at :380 names it)
- Unlocks: ~25 prod LOC. Risk nil. `bun run typecheck` + `bun run test tests/core-occupancy.test.ts`.
- Follow-on (Maybe): with `slotRemaining` gone, `remainingCapacity` (`occupancy.ts:307`) is called only by
  `core-occupancy.test.ts:58,78,174`.

---

## Maybe (medium confidence)

- `tests/schema-fingerprint.test.ts:11` "lists migrations/*.sql on disk exactly" — also covered by
  generate:check (the rendered module embeds the list); decide together with Batch 5.
- `packages/stripe/tests/provider.test.ts:413` (empty-list rethrow) — fold into a table with :357/:370/:383/:399.
- `tests/handlers-checkout-reference.test.ts:42` "ignores other years and non-numeric suffixes" — the fake's
  `maxReferenceSequence` does the filtering; real GLOB is pinned on D1 at `workers/capacity-overrides:270-281`;
  but it is a regression pin (5aa0acc).
- `tests/workers/schema-constraints.test.ts:98` non-enum pickup_type — repo-d1:354 overlaps, but repo-d1
  defers the SQL-layer proof to it.
- `tests/workers/repo-d1.test.ts:332` pre-0014 NULL row through mapBooking — near-duplicate of :315.
- `tests/workers/admin-auth-port.test.ts:109` asserts the test's own config → make it a setup guard.
- `tests/booking-confirmation.test.ts:73` status-only confirmed page — likely covered by snapshot
  "confirmed, summary" (`ui-page-snapshots:34`); unverified.
- Test-only exports/methods: `catalogPayload` (`src/handlers/catalog.ts:93`; only
  `shared-hours-formula-pricing.test.ts:172` → drive `handleCatalog`); repo `insertHold` (only
  `scripts/smoke-scheduled-test.ts:69` + 38 test sites), `upsertDayOverride`, `deleteDayOverride`, `upsertSetting`
  (tests/fakes + worker setup only) — all on the public `ReservaContext.repo` type → changeset.
- Copy → catalog F-repairs (no snapshot owns admin copy, so repair, don't delete):
  `handlers-admin.test.ts:262,283,302,393,1089,1121`; `handlers-admin-incidents.test.ts:88,250-251,271`;
  `booking-confirmation.test.ts:81,185`; `reconciliation-settings.test.ts:81` (prefix only);
  e2e `customer-manage:24,30`, `errors:6,20`, `confirmation-poll:34-36` (use `data-bk-status`),
  `location-less:31,50` (vacuous label negatives), `widget-checkout:35-188` (read from widget messages).
- `ui-booking-widget.test.ts` loading-affordance regex (→ component render) and syncMeetingPoints wiring
  (e2e proves listener/hide/disable; only init ordering is unique).
- `ui-theme-tokens.test.ts:133,138` and `ui-theme.test.ts:36` — hex values copied from a run/tokens file;
  derive from `darkAccentPalette(...)` / `darkTokenValues`.
- `RESERVA_TABLES` duplicated in `workers/migrations-fingerprint.test.ts:24` and
  `workers/refunds-disputes-migration.test.ts:18` → move to `tests/workers/setup.ts`.
- Moves only: `handlers-lifecycle.test.ts:276` → availability-hardening; `payment-port.test.ts:143` → handlers-status.

## Keep (re-checked false positives)

- `handlers-customer-actions.test.ts:106` — only test of the no-refund-row + `none` branch (`booking-actions.ts:243-244`).
- `handlers-lifecycle.test.ts:288,303` — their claimed owners (`workers/availability-horizon:103/110`) were deleted; now sole owners.
- `integration-entry.test.ts:15` webhook-route source pin — no suite executes the generated route.
- `handlers-checkout-race.test.ts:18,55`; `client.test.ts` literal URLs (public client contract);
  `handlers-status.test.ts:177` status-payload key list (wire shape); branding contrast helpers (non-obvious logic).

## Counts

- Batch: 11 items → 6 deletions (5 tests + 1 merge), 3 F-repair groups (7 files), 1 test-only prod function,
  7 zero-caller prod exports.
- Maybe: ~17 entries (~35 assertion sites). Keep: 7 re-checked.
