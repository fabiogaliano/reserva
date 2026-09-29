# Lane: checkout-webhook — read-only ledger

Baseline (docs/tmp/test-audit/baseline-unit.json, baseline-workers.json): every assigned file passes
(unit 1211/1211, workers 201/201). No retained test fails on baseline.

Marks: R retain, F repair, C consolidate (absorbing owner named), D delete (remaining proof named).
`describe` blocks are containers and take the mark of their children; counts below are it/test
declarations (an `it.each` counts once unless rows differ).

Totals: 182 declarations — R 162, F 3, C 11, D 6.

---

## tests/handlers-catalog.test.ts (R9 D2)

- :66 R — location-ful projection (labels, hint:null, pricing incl. pickup axis, meta {}). Catches a leaked/renamed catalog field or a price table drift from quote.
- :97 R — location-less projection: `location: null`, `pickup: null`, localized metadata fields. Catches the always-present-nullable convention breaking.
- :125 D — `pickup` null/string per rule. Both halves are already inside the exact `toEqual` at :68 (four string pickups) and :99 (`pickup: null`). No distinct contract.
- :132 R — fromPriceMinor is the minimum, not first/last. Only proof for rows pricing (formula case lives in shared-hours-formula-pricing).
- :143 R — label negotiation `pt`→`pt-BR` for declared per-locale labels, plain string passes through.
- :153 R — operator-only fields and display settings (visibility/adminBadge) never published. Leak guard on a public, uncredentialed route.
- :178 R — deployment facts (locales, currency, maxHorizonDays, policy).
- :187 R — never exposes turnaround/schedule/capacity/occupancy (keys and values). Leak guard, the stated catalog contract.
- :205 R — `cache-control: public, max-age=60`.
- :210 D — "projects the merged config". The test merges the config itself and hands it in, so the fixture supplies the claim. What is left (the handler reads `context.config`) is already proven by :178. The real merge is in src/context.ts:113 through loadMergedConfig (core-settings.test.ts:125).
- :218 R — 405 method_not_allowed envelope.

## tests/handlers-quote.test.ts (R6)

- :67 R — invariant "quote and checkout price through one path": quote vs charged `priceMinor` on the persisted row across the (service, qty, pickup) matrix. Keeper for the architecture invariant.
- :85 R — flat `{priceMinor, currency}` shape; 20000 comes from the config by hand (row maxQuantity 8/custom).
- :92 R — quote returns the same pickup-axis rejections (missing, unknown, location-less). The endpoint's own contract; the checkout copy is lifecycle:604.
- :107 R — unknown service with `details.allowed`, over-max party, and zero quantity.
- :129 R — `locale` accepted and dropped, including a malformed one (payload symmetry with checkout).
- :139 R — 405.

## tests/handlers-checkout-locale.test.ts (R2 D2)

- :35 R — checkout stores the *negotiated* locale (`pt`→`pt-BR`). The one wiring proof that checkout runs resolveLocale before insert.
- :39 D — exact tag unchanged. Replays core-locale.test.ts:42. The wiring is already proven by :35.
- :44 D — `de-CH` falls back to the default. Same input as core-locale.test.ts:26. If checkout ever rejected an unsupported tag outright, :35 would fail too (`pt` is not supported verbatim).
- :48 R — `locale` is still required (400 "locale is required"). Checkout-specific.

## tests/handlers-checkout-metadata.test.ts (R11 F1)

- :52 R — valid metadata stored verbatim on the hold.
- :60 F — the name says "no metadata at all when every declared field is optional", but the input sends `dietary_notes` (required), so the test proves less than :52 already does. Fix: declare an all-optional field set and omit `metadata`, asserting 201 + stored `null`. That pins the `raw === undefined ? {}` → `null` path (checkout.ts:145,175), which nothing else covers.
- :66 R — missing required field: key, type, `details.field`.
- :78 R — unknown key names itself and the declared keys.
- :87 R (it.each, 4 rows) — strict coercion (no "2"→2, no "true"→true, select membership, text type), plus `details.field`.
- :103 R — per-field maxLength.
- :113 R — 8 KB serialized cap independent of per-field limits.
- :121 R — non-empty metadata rejected for a service with no fields.
- :129 R — `{}` accepted for a service with no fields.
- :144 R — operator-only field accepted and stored.
- :152 R — operator-only field validated. `details.field` separates "validated as select" from "filtered out, then unknown key", since the unknown-key error has no details.
- :162 R — non-object metadata rejected.

## tests/handlers-checkout-race.test.ts (R2 C1)

- :18 R — interleaved last-unit checkouts give one 201 and one 409 (exactly one hold). The unique handler proof of the `insertHoldWithCapacity → null → sweep → retry → 409` path (checkout.ts:298-305). The atomicity itself is owned by workers/capacity-allocation.test.ts:83.
- :55 R — a sequential second checkout is rejected by the checkSlot fast path.
- :75 C → tests/workers/capacity-allocation.test.ts:198-224 (multi-unit SQL parity) + core-occupancy. Confounded: if checkSlot missed the 2-unit party, the fake's insertHoldWithCapacity guard still returns null → 409, so the test cannot fail for the handler reason.

## tests/handlers-checkout-reference.test.ts (R2 C1)

- :34 R — first reference of the year is `LVT-2026-001` (prefix = upper shortCode + local year).
- :38 R — regression pin (5aa0acc): continue after MAX, not COUNT, once rows are deleted.
- :42 C → tests/workers/capacity-overrides.test.ts:275. Other-year and non-numeric-suffix filtering is implemented by the fake's `maxReferenceSequence` (tests/fakes.ts:313), and the D1 test pins the real GLOB SQL with the same inputs (X99, 2025-900). Added in the same regression commit, so kept out of the high-confidence batch.

## tests/handlers-late-webhook.test.ts (R1)

- :9 R — payment on an already-expired hold still confirms (spec §6). Covers customer details, the `oversell` outbox row `capacity_exceeded`, and the operator warning. Keeper for the late-confirm path (absorbs lifecycle:395's positive half).

## tests/handlers-webhook-async-payment.test.ts (R4)

- :43 R — async_payment_succeeded refunds in full; booking stays expired.
- :59 R — a failed refund leaves the durable row for the retry loop, with no incident.
- :75 R — redelivery does not refund twice.
- :86 R — an amount mismatch never refunds and is still acked.

## tests/handlers-webhook-redelivery.test.ts (R6)

- :13 R — calendar fails first: email still sent, non-2xx; redelivery retries only calendar (spec §11).
- :79 R — DuplicatePaymentRefError reaches the envelope as 409 `duplicate_payment_ref` through the confirmation path (nothing in confirmation.ts swallows it). The D1 constraint is owned by workers/schema-constraints.test.ts:153; the envelope pass-through by api-contract.test.ts:55. This test keeps only the "not swallowed by confirmBookingFromPayment" link; low value, kept.
- :130 R — redelivery on a terminal booking drains an owed cancellation email.
- :180 R — charge.refunded: failed calendar_delete becomes debt, and redelivery drains it.
- :236 R — email fails first: calendar not re-run; a failing non-durable hook never causes non-2xx.
- :326 R — double charge.refunded on an already-cancelled booking only records the refunded total (no second transition, no new debt).

## tests/handlers-lifecycle.test.ts (R20 F1 C5 D2)

- :13 R — checkout persists sessionRef; two concurrent webhooks confirm once (calendar/email ×1). The concurrent case; sequential redelivery on real D1 is workers/webhook.test.ts:165.
- :67 R — the event's guestCount reaches the row (D1 round-trip in repo-d1:337; this is the handler wiring).
- :86 R — an active confirmation lease gives 503 `confirmation_in_progress`, and the retry settles both rows.
- :117 R — HoldLimitExceededError → 429 `too_many_holds`. The only handler mapping proof. NOTE: the limit itself comes from the fake, and the D1 cap test (repo-d1:55-94) exercises `insertHold`, not `insertHoldWithCapacity`, the path checkout uses (see Gaps).
- :138 R — checkSlot lookback uses the longest service window.
- :207 R — unpaid completed session: expire, cancel the payment, ack, one incident keyed `:payment_not_paid`.
- :223 R — a throwing cancelPayment still acks.
- :233 R — dispute hook drained through waitUntil without blocking the response.
- :276 R — an impossible date (02-30) gives 400. Move to availability-hardening.test.ts (misplaced).
- :288 F — the multi-century range message is also asserted at workers/availability-horizon.test.ts:110. `occupancyReads === 0` cannot fail: the horizon check throws before any repo read whether or not enumeration runs first. Only the test timeout guards "fail fast". Fix: drop the vacuous assertion and its comment, or C into availability-horizon:110.
- :312 C → tests/workers/availability-horizon.test.ts:78 (62-day chunks accepted) and :103 (63 days rejected, `details.field: 'to'`).
- :327 D — "rejects operator actions without constant-time shared-secret auth". Wrong bearer → 403 via handleOperatorNoShow. Every operator handler resolves through the shared `operatorBooking`/`operatorBearerAuthorized` (booking-actions.ts:140-146), and handlers-operator.test.ts:65 pins the wrong-secret 403. The title promises constant-time, which is not asserted.
- :377 R — reference collision regenerates up to the cap.
- :387 R — gives up after 5 collisions (500, no infinite loop).
- :395 C → handlers-late-webhook.test.ts:9. The positive half (warning on the expired-hold path) duplicates late-webhook:83 byte for byte. Carry the negative half ("no oversell warning on the normal hold path") into late-webhook, then delete.
- :473 R — a 2-point default pickup requires meetingPointId.
- :480 R — an unknown meetingPointId gives 400 with `details.allowed`, for default and custom.
- :500 R — a single-point service stores the only point when the field is omitted.
- :508 C → :638. The same branch (points.length>1, `usesMeetingPoint:false`, first point stored); only the option id differs (`custom` vs `custom_pickup`).
- :516 R — the chosen second point's id and label are stored.
- :575 R — a declared non-enum pickup id is priced from its own row (19000 from the config).
- :583 R — an undeclared pickup lists all 4 declared ids (non-enum regression).
- :592 C → handlers-quote.test.ts:67 (the matrix books `custom` through checkout with a 201) + :575. The acceptance and pricing of a two-option id is already exercised.
- :604 R — exact invalid message plus `details`, and "pickup is required", under the `pickupType` fallback.
- :622 D — "declared service distinguishes missing from undeclared": the same `requireString` branch and message as :604's missing half. resolvePickupAxis reaches `requireString(value)` before reading the option list, so the maze config changes nothing.
- :631 R — `usesMeetingPoint:true` + requiresAddress (custom_dropoff) still requires meetingPointId.
- :638 R — `usesMeetingPoint:false` (custom_pickup) does not require it and stores the first point.
- :646 C → :480. A supplied meetingPointId is validated in the `raw !== undefined` branch (checkout.ts:66-74) before any `usesMeetingPoint` read, so the option shape is irrelevant. :480 already covers default and custom.

## tests/handlers-cas-transitions.test.ts (R8)

The repo CAS is owned by tests/workers/repo-cas-transitions.test.ts. These pin the handler reaction to a lost CAS (409 code, no side effects, no row corruption), which that suite cannot reach.
- :48 R customer cancel vs no-show → 409, no calendar delete.
- :76 R operator cancel vs no-show.
- :103 R no-show vs cancel.
- :123 R customer reschedule vs cancel.
- :145 R operator reschedule vs cancel.
- :169 R reschedule vs reschedule → 409 `slot_unavailable` (different code).
- :197 R charge.refunded loses to a customer cancel and drains only the winner's outbox, then retries email once.
- :292 R confirmation loses to an operator cancel → 503, no resurrection, no side effects.

## tests/payment-verification.test.ts (R1)

- :43 R (it.each, 9 rows) — verifyPayment, webhook, and status make the same decision. `allowed` is hand-coded per row. Keeper for the payment-verification contract. Rows do not cover `session_mismatch`/`session_ref_missing` (see Gaps).

## tests/payment-port.test.ts (R5 F1)

- :41 R — vendor-neutral adapter drives checkout + webhook confirmation (public PaymentProvider port).
- :72 R — an event outside PAYMENT_EVENTS → 200, booking untouched.
- :110 R — validateConfig throws at Cloudflare runtime definition.
- :116 R — control: a supported config does not throw.
- :122 R — env-factory runtime validates once at the first context.
- :144 F — the title says "/status and manage report the same …", but only handleStatus is called. Contract kept (a settled confirmation re-runs no provider; handlers-status has no zero-call assertion). Rename and move into handlers-status.test.ts.

## tests/webhooks.test.ts (R6)

Independent Standard Webhooks library as oracle — the strongest form.
- :40 R verifiable request (headers, UA, body bytes).
- :62 R tampered body rejected (negative control).
- :72 R fresh timestamp per attempt.
- :91 R `whsec_` and bare base64 sign identically.
- :102 R malformed secret is permanent, with no fetch.
- :111 R non-2xx classified by status with a bounded body.

## tests/availability-hardening.test.ts (R7)

- :34 R single-flight calendar read shared across services and party sizes.
- :70 R stale occupancy within the grace window, `no-store`, and busy slot hidden.
- :114 R cold cache → 503 `calendar_unavailable`.
- :135 R beyond the stale bound → fresh read → 503.
- :168 R checkout fails closed before insert when the calendar is unverifiable.
- :191 R over-max party gives 400 before any calendar read.
- :215 R regression: pricing over declared non-enum pickup ids.

## tests/http-body-limits.test.ts (R8 C2)

- :33 R, :40 R, :46 R, :51 R — the JSON reader: under-limit, declared overshoot without reading, streamed overshoot, malformed JSON.
- :58 R, :67 R — the form reader's own wiring and default limit.
- :73 C → :46. The streamed overshoot lives in the shared `readBoundedBytes`, and the per-reader wiring is already proven by :67.
- :80 R, :85 R — the text reader: byte-for-byte result and declared overshoot (public `requestText`).
- :91 C → :46. Same reason as :73.

## packages/stripe/tests/api.test.ts (R17)

Parity against stripe-node as oracle.
- :68 R form encoding.
- :75 R byte parity of checkout create.
- :94 R pins API_VERSION to the SDK.
- :98 R GET query and path escaping.
- :114 R caller key / generated key / no key on GET.
- :125 R retry keeps key and body.
- :136 R retry classes.
- :144 R retry cap → StripeConnectionError.
- :152 R stripe-should-retry both ways.
- :179 R (it.each) error class parity.
- :199 R non-JSON → API error.
- :205 R provider definitive vs ambiguous refund.
- :229 R, :235 R, :245 R, :252 R, :259 R signature verification (stripe-node-signed headers, tamper/secret/scheme, tolerance, rolled secrets, provider 400).

## packages/stripe/tests/provider.test.ts (R47 C2)

- :93 R contract checkout session. NOTE the fixture booking has priceMinor 10000, yet `unit_amount` is 12000 (see Suspected issues).
- :118 R, :133 R (1440 bound), :144 R, :158 R, :174 R, :183 R, :192 R, :202 R, :209 R, :223 R, :239 R, :255 R — checkout param shape and conditionals.
- :262 R, :285 R, :296 R, :307 R — refund create path, amount/status guards.
- :315 C → :332. The code gates reconciliation on error type only, never the message (provider.ts:553), so :332's opaque message is the stronger input for the same branch. Originates in fix 93bb918 (BK-REFUND-001), so kept out of the batch.
- :332 R, :346 R, :359 R, :372 R, :388 R — reconciliation match predicates (marker, amount, sum, status).
- :402 C → table with :346/:359/:372/:388. An empty list is the weakest of the "no match → rethrow original, list called" cases.
- :416 R, :432 R, :448 R, :465 R, :481 R — list failure, charge_already_refunded both ways, definitive errors skip reconciliation.
- :497 R, :504 R, :527 R — webhook: missing signature, raw passthrough + tolerance 300, 413 before verification.
- :551 R, :561 R, :607 R, :639 R, :670 R — checkout idempotency and handleCheckout reaction (retry replays, recovery keeps the hold, definitive/idempotency_error expire the hold). :639 and :670 could share a table; not required.
- :703 R, :708 R, :713 R — validateConfig limits.
- :721 R, :729 R, :740 R, :753 R (each), :764 R (each), :773 R, :779 R, :792 R, :807 R — mapping helpers.

---

## Layer plan

| Contract | Keeper | Redundant layer / action |
|---|---|---|
| Atomic last-unit capacity | workers/capacity-allocation.test.ts | Handler keeps race:18 (null→409 mapping) and race:55 (fast path). Retire race:75 (fake-guard confounded). |
| Reference numbering | workers/capacity-overrides.test.ts:275 (SQL) + checkout-reference:34/:38 (handler prefix, +1, regression) | reference:42 replays the fake's filter → C. |
| Per-IP hold cap | lifecycle:117 (429 mapping) | **No D1 proof for insertHoldWithCapacity's cap** (gap, not a deletion). |
| Status CAS | workers/repo-cas-transitions (repo) + handlers-cas-transitions (handler reaction) | No redundancy: the layers assert different things. |
| Webhook confirm idempotency | workers/webhook.test.ts:165 (sequential, real D1 + real Stripe HMAC) | Unit redelivery suite owns partial-failure per-sink retry (unique); lifecycle:13 owns the concurrent case. Keep both. |
| Stripe signature | api.test.ts (stripe-node parity) + workers/webhook.test.ts:137 (assembled) | provider:497 (missing header) is distinct. Keep. |
| Payment verification | payment-verification.test.ts it.each | Add session_mismatch rows (gap). |
| Quote = charge invariant | handlers-quote:67 | lifecycle:592 C into it. |
| Locale negotiation | core-locale.test.ts | checkout-locale:39/:44 D; keep :35 wiring + :48 required. |
| Pickup / meeting point | lifecycle `checkout meetingPointId` + `checkout pickupType` blocks | Collapse :508→:638, :622→:604, :646→:480. |
| Availability range bounds | workers/availability-horizon.test.ts | lifecycle:312 C; :288 F; move :276 to availability-hardening. |
| Body limits | http-body-limits (shared reader once, per-reader wiring once) | :73, :91 C. |
| Outbound webhook signing | webhooks.test.ts | — |
| Operator auth | handlers-operator.test.ts:37-78 | lifecycle:327 D. |

Misplaced (move, stay R): lifecycle:276 → availability-hardening.test.ts; payment-port:144 → handlers-status.test.ts (with rename).

### Test-only / dead production seams (all verified not public: src/index.ts, src/core/index.ts, src/runtime.ts, src/client/, src/email/, src/ui/index.ts, src/dev/, provider entries, packages/stripe/src/index.ts)

1. `src/webhooks.ts` `WebhookDelivery.fetchImpl` + `delivery.fetchImpl ??` (line 80, 88). No src caller passes it (booking-events.ts:155, settings-events.ts:59); only webhooks.test.ts uses it. Removal needs webhooks.test to `vi.stubGlobal('fetch', …)`: a rewrite, not a deletion. Medium.
2. `src/webhooks.ts` `export` on `signWebhookPayload`: nothing outside the file imports it. Drop the keyword.
3. `packages/stripe/src/api.ts` `StripeFetchClientOptions.maxNetworkRetries` and `.now`: zero callers in src **and** tests (provider builds `createStripeFetchClient(options.secretKey)` with no options). Dead; remove, and constructEventAsync uses `Date.now()`. `fetch`/`sleep` are test-only but are the natural seam for api.test's parity suite: keep.
4. `packages/stripe/src/provider.ts` `export` of `sessionStatusFromStripe` / `stripeEventToParsed`: only provider.test imports them (the internal callers are in the same file). They could be driven through `provider.getSession` / `parseWebhook` with the `client` stub (public `StripeOptions.client`). Low priority.
5. `src/http.ts` `limitBytes` parameter on `requestJson` / `requestFormData`: never passed by any caller (src or tests). Dead parameter.
6. `src/handlers/catalog.ts` `export catalogPayload`: the only external importer is tests/shared-hours-formula-pricing.test.ts (another lane).
7. (repo lane, found here) `BookingRepository.insertHold` (src/repo.ts:359/1363) has **zero src callers**: checkout uses insertHoldWithCapacity, and 38 test call sites keep it alive.

---

## High-confidence batch

1. **tests/handlers-lifecycle.test.ts:327** "rejects operator actions without constant-time shared-secret auth" — **D**
   - Detects: wrong bearer → 403 on handleOperatorNoShow.
   - Non-test callers: `operatorBearerAuthorized`/`operatorBooking` (booking-actions.ts:140-146), shared by cancel/reschedule/no-show handlers.
   - Stronger proof: handlers-operator.test.ts:65 (wrong secret → 403) and :38/:45/:51. The no-show route's 403 is also exercised at handlers-operator.test.ts:325.
   - History: carried in from the pre-v2 lifecycle suite (earliest surviving commit eb9bea7), before handlers-operator had an auth block. The title's "constant-time" was never asserted.
   - Unlocks: nothing in production.
   - Risk: none. `bun run test tests/handlers-lifecycle.test.ts` and `bun run test tests/handlers-operator.test.ts`.
2. **tests/handlers-catalog.test.ts:125** "publishes pickup as null on a location-less service rule and as a string on a location-ful one" — **D**
   - Detects: `pickup` null vs string per rule.
   - Non-test callers: `catalogPricing` via handleCatalog.
   - Stronger proof: the exact `toEqual` at :68 (four string pickups) and :99 (`pickup: null`).
   - History: added with catalog pricing (b3bb45d) alongside the full-shape asserts.
   - Unlocks: none.
   - Risk: none. `bun run test tests/handlers-catalog.test.ts`.
3. **tests/handlers-catalog.test.ts:210** "projects the merged config…" — **D**
   - Detects: only that the handler reads `context.config`. The test performs the "merge" itself.
   - Non-test callers: handleCatalog.
   - Stronger proof: :178 already reads maxHorizonDays/policy from `context.config`. The merge is owned by loadMergedConfig (src/context.ts:113; core-settings.test.ts:125).
   - History: aea29f9 introduced it as a stand-in for createRouteContext.
   - Unlocks: none.
   - Risk: low. `bun run test tests/handlers-catalog.test.ts`.
4. **tests/handlers-checkout-locale.test.ts:39 and :44** — **D** (per-feature replay of resolveLocale)
   - Detects: exact tag kept; `de-CH` falls back to `en`.
   - Non-test callers: checkout.ts:259 `resolveLocale`.
   - Stronger proof: core-locale.test.ts:42 and :26 (identical `de-CH` input). Checkout wiring is proven by :35 (`pt` → `pt-BR` stored), which would also fail on a strict supported-only check.
   - History: c166699, written together with the core negotiation.
   - Unlocks: none.
   - Risk: low. `bun run test tests/handlers-checkout-locale.test.ts` and `bun run test tests/core-locale.test.ts`.
5. **tests/handlers-lifecycle.test.ts:622** "a declared service distinguishes a missing pickup from an undeclared one" — **D**
   - Detects: missing pickup → "pickup is required".
   - Non-test callers: resolvePickupAxis (checkout.ts:24-33).
   - Stronger proof: :604's missing half. The branch is `requireString(value)` and runs identically whatever the option list.
   - History: 5bfbc49, the v2 test rename sweep.
   - Unlocks: none.
   - Risk: none. `bun run test tests/handlers-lifecycle.test.ts`.
6. **tests/handlers-lifecycle.test.ts:646** "still validates a supplied meetingPointId against the declared set for both option shapes" — **C → :480**
   - Detects: bogus meetingPointId → 400 for custom_dropoff/custom_pickup.
   - Non-test callers: resolveCheckoutMeetingPoint.
   - Stronger proof: :480 (default + custom, with `details.allowed`). The `raw !== undefined` branch (checkout.ts:66-74) runs before `usesMeetingPoint` is read.
   - History: 5946ae5, when behavior was re-keyed onto option flags; the re-keying never touched this branch.
   - Unlocks: none.
   - Risk: none. `bun run test tests/handlers-lifecycle.test.ts`.
7. **tests/handlers-lifecycle.test.ts:508** "does not require meetingPointId for a custom pickup, and stores the resolved first point" — **C → :638**
   - Detects: `usesMeetingPoint:false` on a 2-point service stores the first point.
   - Non-test callers: resolveCheckoutMeetingPoint:76-80.
   - Stronger proof: :638 (same branch, same assertions, maze `custom_pickup`).
   - History: d7a5f04 (enum era); :638 was added at the flag re-key and supersedes it.
   - Unlocks: none.
   - Risk: none. `bun run test tests/handlers-lifecycle.test.ts`.

Not batched, but ready once someone confirms (C with a named owner): lifecycle:312, lifecycle:395 (carry the negative half first), lifecycle:592, race:75, reference:42 (regression commit), http-body-limits:73/:91, provider:315 (regression commit), provider:402.

---

## Suspected product issues and gaps

1. **Doc drift, docs/decisions.md §3.** It says tests/handlers-checkout-race.test.ts pins "two interleaved checkouts both receive 201 and both holds exist". The code (insertHoldWithCapacity, atomic) and the test (:18) now pin one 201 and one 409 with exactly one hold. §3's "current behavior" and "revisit" text is stale.
2. **Second pricing call site in the Stripe adapter.** packages/stripe/src/provider.ts:405 charges `priceFor(service, booking.quantity, booking.pickupType)` recomputed from config instead of `booking.priceMinor`, but the webhook verifies `amount_total === booking.priceMinor` (payment-verification.ts:42). They agree today only because createCheckout runs in the same request with the same merged config. provider.test.ts:93 books a fixture with priceMinor 10000 and silently asserts `unit_amount: 12000`. This conflicts with the "prices only in the pricing module / one path" invariant. Suspected risk, not a reproduced bug.
3. **Gap:** the per-IP hold cap inside `insertHoldWithCapacity` (src/repo.ts:1405-1452), the path checkout uses, has no D1 test. repo-d1:55-94 tests `insertHold`, which has no production caller, and lifecycle:117 passes through the fake's implementation.
4. **Gap:** webhook `409 payment_session_mismatch` (verifyPayment `session_ref_missing` / `session_mismatch`, webhook.ts:117-118) has no test anywhere.
5. **Vacuous assertion:** lifecycle:288 `occupancyReads === 0` cannot fail (see ledger).
6. **Misleading titles:** metadata:60, payment-port:144, lifecycle:327 (see ledger).
