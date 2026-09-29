# Test-audit ledger — lane: domain

Scope: 17 files, 237 declarations (it.each counted once). Baseline (docs/tmp/test-audit/baseline-unit.json):
every file in the lane passes (1211/1211 unit+component). Read-only pass; nothing edited.

Marks: R 219 · F 9 · C 6 · D 3

Production owners read: src/core/{booking,config,currency,locale,occupancy,pricing,reference,settings,slots,time,api,events}.ts,
src/booking-events.ts, src/client/availability.ts, src/http.ts (errorResponse), src/handlers/{checkout,availability,catalog}.ts,
src/reconciliation.ts. Overlaps checked: handlers-checkout-reference, handlers-customer-actions, handlers-operator,
handlers-late-webhook, confirmation-retry, confirmation-mutation-outbox, webhooks, email-render, ui-format,
packages/stripe/tests/provider.test.ts, tests/workers/{capacity-allocation,reconciliation-runtime,webhook}.

## Ledger

### core-booking.test.ts
- L16 supports hold confirmation and expiration — **F**: hold→confirmed and expired→confirmed (late webhook) are real
  status-machine contracts, but `expireBooking` has no production caller (the sweep expires in SQL). Seed
  `booking({ status: 'expired' })` instead of calling it so `expireBooking` can go.
- L23 counts a hold at its exact expiry until it is swept — **D**: asserts `isHoldActive`, which has no production caller.
  The same inclusive predicate is `bookingIsActive` in occupancy.ts, pinned by core-occupancy L189.
- L28 customer cancellation records actor — **R**: cancelledBy/cancelledAt stamping; catches a lost actor on the row.
- L35 keeps rescheduling policy-free while exposing the handler guard — **D**: `canRescheduleBooking` inside the cutoff is
  pinned at its real caller (handlers-customer-actions L466 403 past_cutoff; L476 disabled). The rescheduleBooking half
  is repeated by L41.
- L41 reschedules without creating a second booking — **R**: keeps the same id, endsAt = start + duration, rescheduledFrom.
- L49 no-show only after start — **R**: the owning status-machine boundary at ms precision (the handler tests,
  handlers-operator L910/929/938, replay it coarsely).
- L55 terminal same-state immutable; cancellation needs actor — **R**: same-state identity is load-bearing for idempotent
  re-invocation. Note: the `cancelledBy` guard can only be reached by calling `transitionBooking` directly.
- L61 rejects impossible transitions — **F**: the confirmed→expired rejection is a real contract, but the test goes through
  test-only `expireBooking`. Assert it through `transitionBooking(booking(), 'expired', …)`.

### core-reference.test.ts
- L5 formats and rolls the year — **C** → tests/handlers-checkout-reference.test.ts (001 padding, other years ignored, max+1).
  The "roll" goes through referenceYear's string-date branch, which production never uses: checkout always passes a
  numeric local year (checkout.ts:265).
- L10 retries a same-year collision — **D**: `nextReference` and `generateUniqueReference` have no production callers.
  Checkout's real collision path (maxReferenceSequence + ReferenceConflictError retry) is covered by
  handlers-checkout-reference.

### core-time.test.ts
- L7 Lisbon spring-forward conversion — **R**: hand-calculated oracle, separate from the offset-cache sweep (whose oracle is TZDate).
- L12 Lisbon fall-back conversion — **R**: same.
- L17 elapsed duration across fall-back — **R**: duration is measured in UTC, not wall time.
- L25 earlier occurrence for ambiguous fall-back — **C** → core-time-offset-cache L79, which makes the same
  `01:30 → 00:30Z` assertion and also checks the spring-forward RangeError. The extra `fallBackAmbiguityPolicy`
  assertion only restates a constant nothing reads (test-only export).
- L30 rejects rollover dates / offsetless instants — **R**: parseUtcInstant strictness, which every handler relies on.
- L35 cancellation cutoff boundary inclusive — **R**: exact-boundary regression (the handler tests only probe inside the cutoff).
- L43 addDaysToDateKey leap day — **R**.
- L49 enumerateDateKeys inclusive across month/year — **R**.
- L59 rejects malformed date keys — **R**.

### core-time-offset-cache.test.ts
- L47 it.each zones: formats instants exactly as TZDate — **R**: perf cache must not change answers (b6914b9).
- L56 it.each zones: wall times resolve to same instant — **R**.
- L79 earlier fall-back instant; rejects skipped spring-forward — **R** (keeper for the fall-back policy).
- L84 weekday of a calendar date regardless of zone — **R**.

### core-slots.test.ts
- L6 union of matching rules, local-offset starts — **R**: union-not-first-match regression.
- L22 split day keeps both windows ascending — **R**.
- L35 overlapping rules dedupe one start — **R**.
- L47 year-end season range — **R**: generation side (validation side is core-config L426).
- L53 Lisbon DST wall times — **R**.

### core-locale.test.ts (resolveLocale; used by checkout/manage/email locale negotiation)
- L10 bare tag → regional variant — **R**.
- L15 other regional variant — **R**.
- L20 longest prefix wins — **R**.
- L26 no shared language → default — **R**.
- L31 missing/empty → default — **R**.
- L37 case/separator-insensitive, declared tag returned — **R**.
- L42 exact tag → itself — **R**.

### client-availability.test.ts (public: src/client/index.ts `export *` from availability)
- L26 openDays — **R**. L30 firstOpenDay/null — **R**. L35 isDayDisallowed incl. out-of-window — **R**.
- L44 dateKey reads UTC — **R** (TZ-drift regression). L52 horizonRange across DST — **R**.

### availability-cache-key.test.ts
- L46 extra unvalidated param shares a cache key — **R**: regression pin (the header comment names the bug).
- L59 validated param difference splits the key — **R**: the positive control for L46.

### api-contract.test.ts (tsc includes tests/, so expectTypeOf / @ts-expect-error run under `bun run typecheck`)
- L18 runtime array on public core entrypoint — **R**: API_ERROR_CODES retention bar.
- L26 no duplicates — **R**.
- L30 type derived from array; unlisted code fails to compile — **R**.
- L38 envelope code type is ApiErrorCode; isApiErrorCode — **R**.
- L47 HttpError serialization — **R**: error envelope.
- L55 foreign error with catalog code honored — **R**.
- L65 foreign non-catalog code → internal_error — **R**: closed-set guard.
- L78 wire response types pinned — **R**.

### core-currency.test.ts
- L38 ISO 4217 accept/reject — **R**: ClientConfig error message.
- L47 minorUnitFactor 0/2/3 decimals + fallback — **R**.
- L55 JPY formats as whole units — **R**: the /100 regression. ui-format.test.ts has no currency cases.
- L63 checkout sends JPY minor units to Stripe and stores currency on row — **R**: cross-boundary (core price → adapter).
- L99 Stripe adapter rejects kpw, core does not — **C** → packages/stripe/tests/provider.test.ts:713 (same `kpw` rejection
  naming business.currency, plus jpy accepted). Carry `'kpw'` into L38's accept list so the "core stays vendor-neutral"
  half survives.

### core-occupancy.test.ts
- L27 one booking, capacity 2 → available — **R**: positive control.
- L37 per-service turnaround and occupancy across services — **F**: the `occupancyFor` fn on `largeTour` is dead. It is
  the removed resolver (core-config L395) and occupancy.ts ignores it; units=2 actually comes from `seatsPerUnit: 4`.
  Drop the property and rename to "per-service turnaround and seatsPerUnit" so the fixture no longer promises a
  resolver.
- L52 at capacity; qty 8 = two units — **R**.
- L61 turnaround blocks next grid slot exactly — **R**.
- L72 override clamps / closed day with reason — **R**.
- L88 ranged capacity defaults; override trumps — **R**.
- L102 non-operating day closed — **R**.
- L115 skips nonexistent spring-forward slot — **R**.
- L129 zero/reversed/malformed intervals skipped — **R**: calendar-garbage robustness.
- L143 all-day ignored, timed counted once — **R**.
- L155 spill-in from before window — **R**.
- L165 no double count of reserva-tagged event — **R**.
- L177 orphaned tagged event counted — **R**.
- L189 hold at exact expiry counted — **R** (keeper for the inclusive hold predicate).
- L198 remainingBookings — **R**.
- L207 slots carry remaining + remainingBookings — **R**.
- L220 excludes moved booking for reschedule — **R**.

### core-pricing.test.ts
- L7 resolves every quantity/pickup combination — **C** → L13, which asserts priceFor for all 1..8 × both pickups against
  hand values. Move `pricingCombinations(service).toHaveLength(16)` into L13. `priceForService` is test-only.
- L13 server prices and table parity after canonicalization — **R**: hand-calculated expected prices, and quote/checkout
  share one path. (L13/L50 overlap: see Layer plan, low confidence.)
- L50 widget table parity for unsorted raw config — **R**: regression (raw vs validated input); catalog rows type-check.
- L93 unsupported values throw PricingError — **R**.
- L114 tiers-only priced by quantity with null pickup — **R**.
- L120 single-column table keyed '' — **R**: public resolvedPriceTableFor shape.
- L127 pricingCombinations null pickup — **R**.
- L133 tiers-only validates and prices after canonicalization — **R** (keeper; absorbs core-config L44).
- L168 Maze non-additive options — **R**: regression (220 vs 210).
- L183 table key set from declared pickups — **R**.
- L195 first-occurrence key order, no default/custom pinning — **R**: public helper ordering.

### core-config.test.ts
- L8 accepts valid config unchanged — **F**: keep `validateConfig(config).toEqual(config)` (the schema neither adds nor
  strips anything). Drop the `quantityValuesForService` line (test-only export) and the `priceFor(service,5,'custom')`
  line (core-pricing L13 covers it).
- L14 idempotent when re-validated — **F (vacuous since b6914b9)**: `validateConfig` now returns its own output straight
  from the `validatedConfigs` WeakSet (config.ts:881), so this never re-parses. L922 owns the identity short-circuit.
  Repair: re-validate `structuredClone(validated)` so the resolved shape really goes back through the schema, which is
  what mergeAndValidateSettings does with its clone.
- L22 schedule 09:00–18:00 defaults — **R**. L34 days sorted/deduped (services + shared hours) — **R**.
- L44 accepts service with no location module — **C** → core-pricing L133 (same config shape, same
  `location` undefined + `priceFor(…, null) === 10000`).
- L65 location-less rule declaring pickup rejected — **R**. L81 location-ful rule omitting pickup rejected — **R**.
- L92 usesMeetingPoint without meetingPoints rejected — **R**. L112 options-only location accepted — **R**.
- L132 duplicate meeting point ids — **R**. L152 empty meeting point id — **R** (bare toThrow; fixture otherwise valid per L8).
- L169 canonicalizes out-of-order tiers — **R**. L197 duplicate breakpoint diagnostic — **R**. L212 missing pickup variant — **R**.
- L228 undeclared pickup id — **R**. L249 per-id coverage hole — **R**. L273 duplicate pickup ids — **R**. L296 malformed pickup id — **R**.
- L316 calendar grace default/min — **R**. L322 hold < 35 rejected — **R**. L329 no vendor ceiling — **R**.
- L333 unparseable locale tag — **R**. L338 operator locale independent — **R**. L349 Access team domain shape — **R**.
- L363 admin.access absent OK — **R**. L368 partial access pair rejected — **R**. L376 routes.admin/ops booleans — **R**.
- L382 equal season endpoints — **R**. L395 removed occupancyFor rejected by name with path — **R** (remediating error).
- L415 seatsPerUnit carried — **R**. L420 collectGuestCount opt-in — **R**. L426 year-end wrap accepted — **R**.
- L444 all defaults when four blocks omitted — **R** (ClientConfig defaults). L461 reschedule cutoff inherits — **R**.
- L466 explicit reschedule cutoff wins — **R**. L471 partial booking block defaults — **R**. L485 hold = 35 accepted — **R**.
- L491 supported excludes defaulted default — **R**.
- L497 meeting-point-only shorthand — **R**. L522 single option fills pricing pickup — **R**. L546 `location: {}` rejected — **R**.
- L559/L563/L567/L571 resolveMeetingPoint (id, unknown→first, none→first, no points throws) — **R** ×4 (checkout owner).
- L585/L594/L604/L611/L620/L629 meetingPointForBooking (localized, live label, removed id snapshot, id fallback,
  null id, service lost location) — **R** ×6: graceful degradation for historical rows.
- L637/L644/L650/L654 pickupOptionFor — **R** ×4 (public via core/index.ts).
- L661/L665/L672 pickupPresentationFor — **R** ×3.
- L699 all four metadata types accepted — **R**. L709 no metadataFields stays absent — **C** → L8 (toEqual on the
  fixture already fails if the schema injects metadataFields). Low value either way, so not in the batch.
- L714 it.each bad metadata keys — **R**. L728 duplicate keys — **R**. L739 select without options — **R**. L747 duplicate option values — **R**.
- L765/L769/L773 resolveMetadataFieldLabel — **R** ×3 (public).
- L783/L787/L794/L800 metadataRowsForBooking — **R** ×4.
- L826/L833/L838/L843(it.each)/L851/L856/L866/L870/L876/L883 visibility + adminBadge + adminOptionLink +
  customerVisibleMetadata + customerMetadataFields — **R** ×10 (key paths plus remediation messages; operator-only
  values never reach the customer).
- L894 lastEnd derives lastStart — **R**. L904 lastStart+lastEnd rejected — **R**. L911 lastEnd too early — **R**.
- L922 validated config reuse (identity + lookalike still validated) — **R** (keeper for the re-validation short-circuit).

### core-settings.test.ts (all R; the pure owner of the admin settings overlay)
- L38 applies overrides without mutating base — **R**. L55 ignores unknown/malformed/invalid rows — **R**.
- L75 same instance with no overrides — **R**. L79 explicit null unsets optional — **R**.
- L85 per-kind form parsing — **R**. L95 invalid form values → SettingParseError — **R**. L105 holdMinutes form bounds — **R**.
- L120 save path accepts 35/1440 — **R**. L125 load path falls back + warns — **R**. L134 load path keeps boundary — **R**.
- L143 cross-field SettingsMergeError issue shape — **R**. L160 unattributable issue → pristine config + '*' warning — **R**.
- L175 hours definitions generated per rule — **R**. L186 stored hours applied, no mutation — **R**. L195 non-HH:MM ignored — **R**.
- L200 HH:MM form parse — **R**. L207 first > last rejected on save — **R**. L212 interval + days applied sorted — **R**.
- L219 bad day sets ignored — **R**. L226 bad intervals ignored — **R**. L233 day checkboxes parse — **R**. L243 interval parse — **R**.
- L251 load path drops only the invalid rule's rows — **R**.
- L271 pricing definitions per tier — **R**. L285 stored amount applied — **R**. L293 bad amounts ignored — **R**.
- L300 major→minor parse incl. 1.15 float — **R** (regression). L310 bad amounts rejected — **R**. L316 JPY as-is — **R**.
- L321 save keeps / load drops — **R**.
- L333 merged config reuse, warnings every time — **R** (perf cache must still warn). L345 re-merge on change — **R**.

### shared-hours-formula-pricing.test.ts
- L69 inheriting services derive lastStart from shared hours — **R**. L76 own schedule kept — **R**.
- L81 re-validates unchanged — **F (vacuous since b6914b9)**: `resolved` is in the validatedConfigs WeakSet, so
  `validateConfig(resolved)` returns it untouched. Repair with `structuredClone(resolved)` so the formula
  `inherited` / `lastEnd`+`lastStart` shape really re-parses.
- L85 no schedule + no hours → named error — **R**. L90 closing time too early names service — **R**.
- L97 materialized inherited fields + provenance — **R**. L112 base × units + surcharge, unit vs booking scope — **R**
  (hand arithmetic).
- L123 over-units / unknown / null pickup refused — **R**. L131 tables, combinations, lowest price, breakpoint coexistence — **R**.
- L142 every pickup must be priced, block named — **R**. L150 formula needs seatsPerUnit — **R**.
- L156 written amounts beat claimed inheritance — **R**.
- L170 catalog projection publishes formula without provenance — **R** (catalog contract; the only formula catalog test).
- L193 hours section: shared block + overrides — **R**. L204 shared closing-time edit propagates — **R**.
- L212 pricing section keys — **R**. L229 shared surcharge edit reaches inheriting services only — **R**.
- L237 per-service edits scoped — **R**. L244 stale stored row dropped with warning — **R**.
- L252 renders shared blocks first, overrides folded — **F**: the only render test of formula/shared-hours settings, but
  it asserts copy (`'All services'`, `'Custom pick-up and drop-off surcharge'`, the full
  `<summary>Service-specific overrides (1)</summary>` string). Keep the structural checks (`name="…"` inputs,
  `value="19:00"`, `details.bk-overrides` present, the firstStart ordering, no old-city schedule input) and drop the
  prose.

### booking-events.test.ts
- L109 non-durable hook gets only subscribed events — **R**.
- L138 failing non-durable hook swallowed, logged once, no outbox row — **R**.
- L166 unknown hook event rejected listing the vocabulary — **F**: the regex is a hand-copied WEBHOOK_EVENTS list (junk:
  copied inventory), so adding an event breaks an unrelated test. Build the expected message from
  `WEBHOOK_EVENTS.join(', ')`, or assert the `booking.canceled` prefix plus one enumerated member.
- L173 invalid/duplicate hook name — **R**. L187 settings.changed subscribable — **R**. L191 unknown webhook event — **R**.
- L195 duplicate webhook names — **R**.
- L203 durable row atomic with confirmation; /status drains; retry resends exact bytes — **R** (envelope-bytes invariant).
- L242 raw metadata record / `{}` in envelope — **R** (wire empty-value rule).
- L289 later event distinct id, old row keeps original snapshot — **R** (historical-truth invariant).
- L327 two reschedules at one instant → distinct envelope ids — **R**: webhook envelope id. confirmation-mutation-outbox
  L127 covers email row keys, not envelope ids.
- L355 durable hook gets occurrence snapshot — **R**.
- L399 unregistered durable hook abandoned with remediation — **R**: owed-effects path. confirmation-retry L128 is the
  admin retry path, a different entry.

### reconciliation-settings.test.ts
- L38 cron honours reminderHoursBefore=0 override — **R** (cron reads merged D1 settings).
- L50 cron arms with 48h override — **R**.
- L63 cron-retried confirmation carries overridden cancelCutoffHours — **F**: the `config.booking.cancelCutoffHours === 72`
  assertion is the contract. The `renderDefaultEmail(...)` + `'Free cancellation until 17 August'` half calls the
  renderer directly (not via the cron), i.e. a renderer contract asserting copy. Move that to email-render.test.ts,
  which today only checks the phrase exists (L215) and never checks a non-default cutoff date.
- L85 invalid override degrades + warns — **R**.

## Layer plan

The domain lane is mostly pure units at the owning boundary. There is no fake-repository layer to retire here: the
repo-backed suites in the lane (availability-cache-key, booking-events, reconciliation-settings, core-currency L63)
test handler/cron/events behaviour, not CAS or capacity SQL. Redundancy is between pairs of assertions, not whole
files.

Redundant pairs, with the keeper named:
| Contract | Keeper | Redundant copy |
|---|---|---|
| validateConfig re-validation short-circuit | core-config L922 | core-config L14, shared-hours L81 (both vacuous now → repair as clone re-parse) |
| location-less service validates + prices | core-pricing L133 | core-config L44 |
| fall-back ambiguity = earlier | core-time-offset-cache L79 | core-time L25 |
| hold counted at exact expiry | core-occupancy L189 (live predicate) | core-booking L23 (dead `isHoldActive`) |
| reschedule cutoff / disabled | handlers-customer-actions L466/L476 | core-booking L35 |
| Stripe currency limit | packages/stripe/tests/provider.test.ts:713 | core-currency L99 |
| reference numbering | handlers-checkout-reference.test.ts | core-reference.test.ts (whole file) |
| breakpoint price per quantity | core-pricing L13 | core-pricing L7 |
| (low confidence) raw vs canonical parity | core-pricing L50 | core-pricing L13 could fold its hand values into L50's loop; left R |

Keeper suite per contract: status machine → core-booking (pure) + tests/workers/repo-cas-transitions (CAS);
occupancy math → core-occupancy + tests/workers/capacity-allocation (atomic SQL); time → core-time (hand oracle) +
core-time-offset-cache (equivalence); config schema → core-config; shared hours / formula pricing →
shared-hours-formula-pricing; pricing → core-pricing; settings overlay → core-settings; error envelope → api-contract;
booking events → booking-events + webhooks.test.ts (signing) + confirmation-* (outbox); availability cache →
availability-cache-key; client helpers → client-availability.

Retired files: tests/core-reference.test.ts (whole file).

Assertions to carry into keepers: `pricingCombinations(service).toHaveLength(16)` → core-pricing L13; `'kpw'` accepted by
core → core-currency L38; the cutoff-date render (`72h → 17 August`) → email-render.test.ts.

### Test-only production seams unlocked
All verified with grep over src/, packages/stripe/src, examples, scripts. None is exported from src/core/index.ts,
src/index.ts, src/client/index.ts, src/runtime.ts, src/email/, src/ui/index.ts or src/dev/, and none is re-exported
through any package.json `exports` entry.
- src/core/reference.ts: `nextReference`, `generateUniqueReference` (no callers outside tests, present since the initial
  commit). `formatReference` export is internal only. `referenceYear`'s string/Date/timezone branches are dead:
  checkout.ts:280 always passes a numeric year. Could collapse to `generateReference(shortCode, year, sequence)`.
- src/core/booking.ts: `isHoldActive` (a duplicate of occupancy.ts `bookingIsActive`), `expireBooking` (the sweep expires
  in SQL), `isCancellationAllowed` (no callers at all, not even tests). `canTransition` / `transitionBooking` exports
  only feed tests; they are used internally.
- src/core/time.ts: `fallBackAmbiguityPolicy` const + `FallBackAmbiguityPolicy` type (only core-time L26 reads them).
- src/core/pricing.ts: `priceForService` (added e17ec80; test-only).
- src/core/config.ts: `quantityValuesForService` (added e17ec80; test-only).
- src/core/occupancy.ts: the `resolveService` option alias in OccupancyIntervalOptions has no caller anywhere (production
  uses `services` or `serviceResolver`). `remainingCapacity` export is internal via `slotRemaining`; tests use it.
  Keep it, low value.

## High-confidence batch

1. **tests/core-reference.test.ts L5 + L10 (whole file)**: C + D.
   - Detects: formatReference padding and year roll through the string branch (L5); nextReference /
     generateUniqueReference collision skipping (L10).
   - Non-test callers: `generateReference` ← src/handlers/checkout.ts:280 (numeric year only). No callers for
     nextReference, generateUniqueReference, or referenceYear's string/Date branches.
   - Stronger proof: tests/handlers-checkout-reference.test.ts (001 start, max+1 after deletions, other years and
     non-numeric suffixes ignored) through real checkout.
   - History: 92129c7 initial commit; the collision helpers were superseded by maxReferenceSequence + ON CONFLICT retry.
   - Unlocks: delete nextReference, generateUniqueReference, the referenceYear string/Date/timezone paths, and the
     formatReference export.
   - Risk: low. `bun run test tests/handlers-checkout-reference.test.ts`, `bun run typecheck`.
2. **tests/core-booking.test.ts:23 "counts a hold at its exact expiry until it is swept"**: D.
   - Detects: `isHoldActive` boundary only.
   - Non-test callers: none.
   - Stronger proof: core-occupancy.test.ts:189 on the live `bookingIsActive` predicate. The SQL counterparts
     (`hold_expires_at >= ?`) live in tests/workers/capacity-allocation.
   - History: initial commit.
   - Unlocks: delete `isHoldActive`, plus the unreferenced `isCancellationAllowed`.
   - Risk: low. `bun run test tests/core-occupancy.test.ts`, `bun run test tests/core-booking.test.ts`.
3. **tests/core-booking.test.ts:35 "keeps rescheduling policy-free while exposing the handler guard"**: D.
   - Detects: canRescheduleBooking false inside cutoff; rescheduleBooking ignores policy.
   - Non-test callers: canRescheduleBooking ← booking-actions.ts, status-manage.ts.
   - Stronger proof: handlers-customer-actions.test.ts:466 (403 past_cutoff) and :476 (disabled), core-booking:41.
   - History: initial commit.
   - Unlocks: nothing.
   - Risk: low. `bun run test tests/handlers-customer-actions.test.ts`.
4. **tests/core-time.test.ts:25 "chooses the earlier occurrence for an ambiguous fall-back wall time"**: C →
   core-time-offset-cache.test.ts:79 (identical assertion plus the spring-forward RangeError).
   - Non-test callers of `fallBackAmbiguityPolicy`: none.
   - History: initial commit; the offset-cache test was added in b6914b9.
   - Unlocks: delete the `fallBackAmbiguityPolicy` const and type.
   - Risk: low. `bun run test tests/core-time.test.ts`, `bun run test tests/core-time-offset-cache.test.ts`.
5. **tests/core-pricing.test.ts:7 "resolves every supported quantity and pickup combination"**: C → core-pricing:13.
   Move the `pricingCombinations` length-16 assertion over.
   - Non-test callers of `priceForService`: none.
   - History: e17ec80.
   - Unlocks: delete `priceForService`.
   - Risk: low. `bun run test tests/core-pricing.test.ts`.
6. **tests/core-config.test.ts:44 "accepts a service with no location module at all"**: C → core-pricing.test.ts:133
   (same shape and assertions).
   - Unlocks: nothing.
   - Risk: nil. `bun run test tests/core-pricing.test.ts tests/core-config.test.ts`.
7. **tests/core-config.test.ts:8, partial F**: drop the `quantityValuesForService` and `priceFor` lines.
   - Non-test callers of `quantityValuesForService`: none. History: e17ec80.
   - Unlocks: delete `quantityValuesForService`.
   - Risk: low. `bun run test tests/core-config.test.ts`.
8. **tests/core-currency.test.ts:99 "rejects a currency the Stripe adapter cannot present"**: C →
   packages/stripe/tests/provider.test.ts:713. Also add `'kpw'` to the accept loop at core-currency:39.
   - Non-test callers: stripe `validateConfig` ← runtime definition.
   - History: 5bfbc49 (v2 currency plumbing).
   - Unlocks: nothing.
   - Risk: nil. `bun run test packages/stripe/tests/provider.test.ts tests/core-currency.test.ts`.

High-confidence F repairs (not deletions):
- core-config:14 and shared-hours:81 have been vacuous since b6914b9's WeakSet short-circuit. Re-validate a structuredClone.
- booking-events:166 uses a hand-copied event vocabulary. Derive it from WEBHOOK_EVENTS.
- core-occupancy:37 has a stale `occupancyFor` fixture and name.
- core-booking:16 and :61 need rewriting if `expireBooking` is deleted (medium: it adds `expireBooking` to the
  seam deletions).

## Suspected product bugs / oddities
- src/repo.ts:1995 `listLiveBookings` filters holds with `hold_expires_at > ?` (strict). Every capacity path counts a hold
  as live through its exact expiry: occupancy.ts:128 `<=`, and repo.ts:1379/1416/1424/1903 `>=`. At that one instant
  the admin day view hides a hold that still blocks capacity. Cosmetic and low severity; the fake at
  tests/fakes.ts:707 copies the strict `>`, so fake-backed admin tests cannot catch it.
- Since b6914b9, nothing re-parses a resolved config through the schema directly. mergeAndValidateSettings still does so
  indirectly with its clone (covered by the shared-hours L204/L229 merges), so risk is low, but the idempotence tests
  no longer test what their names claim (see the F repairs above).
