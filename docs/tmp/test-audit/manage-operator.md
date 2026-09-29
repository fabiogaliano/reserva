# Test-audit ledger — lane `manage-operator`

Read-only discovery, 2026-09-29. No source/test edits, vitest not run.

Scope: `tests/handlers-status.test.ts`, `tests/handlers-manage.test.ts`,
`tests/handlers-customer-actions.test.ts`, `tests/handlers-token-lifecycle.test.ts`,
`tests/availability-manage-token.test.ts`, `tests/routes-manage-group.test.ts`,
`tests/handlers-operator.test.ts`.

Owners read: `src/handlers/status-manage.ts`, `src/handlers/booking-actions.ts`,
`src/handlers/availability.ts` (manage-token path), `src/operator-cancellation.ts`,
`src/routes-manifest.ts`, `src/core/route-paths.ts`, `tests/fakes.ts` (token state,
refund recovery lookup, reschedule expiry).
Overlap read: `tests/workers/repo-d1.test.ts` (token hashing describe, 450-750),
`tests/workers/refund-operations.test.ts` (275-309), `tests/workers/repo-cas-transitions.test.ts`,
`tests/handlers-cas-transitions.test.ts`, `tests/handlers-lifecycle.test.ts` (327),
`tests/confirmation-mutation-outbox.test.ts` (77), `tests/core-config.test.ts`
(meetingPointForBooking 577-633, pickupPresentationFor 660-678), `tests/route-customization.test.ts`,
`tests/handlers-refunds-disputes.test.ts` (56-75), `tests/e2e/customer-manage.spec.ts`,
`tests/e2e/operator.spec.ts`, `tests/component/customer-page-routes.test.ts` (names).

Counts (113 `it` declarations; describes inherit): **R 98 · F 1 · C 6 · D 8**

---

## tests/handlers-status.test.ts (18 it — 18 R)

| Line | Mark | Evidence |
|---|---|---|
| 16 describe | — | container |
| 17 | R | Self-heal of a paid hold via `/status` (spec §6/§11): confirms, runs calendar+email once, local-offset start, **leak-guard key list** of `ConfirmationBooking`. Catches confirm-path regressions and PII leaks (customerEmail/token) into a public payload. |
| 87 | R | Confirmation builder passes `wire.meetingPointId`/`meetingPointLabel` through to `meetingPointForBooking`. Helper cases are owned by core-config:577, but only this test catches a builder that drops the stored label (removed id → shows id instead of snapshot). Wiring guard. |
| 128 describe | — | container |
| 165 | R | `usesMeetingPoint:false` option → `meetingPoint: null` present-as-null; confirmation-only gate `presentation?.usesMeetingPoint` (status-manage.ts:88). |
| 180 | R | `usesMeetingPoint:true` + address option still shows chosen point; opposite half of the gate. |
| 192 | R | Undeclared stored pickup id feeds the row-evidence fallback into the confirmation gate. Partly replays core-config:672, but it's the only proof that the confirmation gate uses the fallback. Cheap, so keep. |
| 205 | R | A concurrent confirmation lease makes `/status` return 200 pending (not 503) with no duplicate side effects. Guards the `ConfirmationInProgressError` catch. |
| 250 | R | Webhook and `/status` race across two contexts: side effects exactly once, outbox rows succeeded. Handler orchestration. The lease primitive itself is owned by repo-d1:55. |
| 316 | R | Expired Stripe session → hold expired, `{status:'expired'}`. |
| 349 | R | Completed session that fails verification → `failed`, warn log, keyed incident. Guards the dead-end/incident contract. |
| 398 | R | Unknown session → `not_found`, sensitive headers. |
| 414 | R | Open session → pending, no calendar create, hold untouched. |
| 454 | R | Detail grace window narrows the payload to the summary (leak guard). |
| 490 | R | Regression pin: grace is anchored on createdAt, so a fulfillment write bumping updatedAt doesn't renew details. Also covers the confirmed-row fulfillment repair. |
| 536 | R | Reschedule mutation rows aren't treated as confirmation debt, and owed mutation effects still drain. Isolation guard. |
| 574 | R | Missing session id → 400 `validation_failed` with sensitive headers. |
| 589 | R | decisions.md §1: cancelled and no_show → `cancelled` without calling getSession. Pinned by the decision record. |
| 634 describe | — | container |
| 661 | R | Operator-only metadata stays out of the public confirmation. Security contract. Only test here that uses the canonical `sessionId` param. |
| 665 | R | The same field shows once it is customer-visible (control for 661). |

Note: every other status test uses the deprecated `session_id` spelling. That's harmless, but the deprecation warning is never asserted (no gap in contract terms).

## tests/handlers-manage.test.ts (20 it — 18 R, 1 C, 1 F)

| Line | Mark | Evidence |
|---|---|---|
| 32 describe | — | container |
| 33 | R | Customer manage payload: role, capabilities, both deadlines + `deadline` alias, summary fields, sensitive headers. Primary owner of the `ManageResponse` contract. |
| 78 | R | Manage builder wiring of meetingPointId/label into `meetingPointForBooking` (only chosen-point proof on the manage surface). |
| 115 describe | — | container |
| 147 | R | The declared option's `requiresAddress`/`usesMeetingPoint` flags reach the manage payload. Wiring guard for `pickupPresentationFor`. |
| 161 | **C** | Replays `pickupPresentationFor`'s undeclared-id row-evidence fallback. Absorbed by core-config:672, which asserts both evidence cases, plus manage:147, which proves the wiring. Nothing handler-specific. |
| 181 | R (move) | `renderManagePage` formats price and refund bounds in the booking's own currency (KWD 3-dp). Real money-formatting regression. It's a pure renderer test misfiled in a handler suite, so move it to `tests/ui-manage-page.test.ts`. |
| 203 | R (move) | `renderManagePage` gates address/meeting point on the flags independently. Renderer contract; move to `tests/ui-manage-page.test.ts`. |
| 238 | R | Separate cancel/reschedule deadlines when the cutoffs differ. |
| 259 | R | Customer inside the cutoff → canCancel/canReschedule false. |
| 271 | R | Operator ignores the cutoff; canNoShow is false before start. |
| 285 | R | Operator past start → canNoShow true. |
| 295 | R | Unknown token → 403 forbidden with sensitive headers (no oracle). |
| 304 | R | Missing token → 403 (separate branch, status-manage.ts:230). |
| 311 | R | Lookup precedence: cancel_token before operator_token. Security-relevant ordering. Its comment cites a stale `handlers/index.ts:355-357`, which is a doc nit only. |
| 342 describe | — | container |
| 352 | **F** | Metadata rows for both roles. Keep the payload assertions, but `toContain('<dd>On</dd>')` is an incidental copy assertion on catalog copy (`admin.on`). Derive it from the message catalog or drop it and rely on the page snapshot suite. |
| 381 | R | Empty metadata comes back as `{}`/`[]`, never missing keys. |
| 390 | R | XSS escaping of metadata on both role renders. Security. |
| 406 describe | — | container |
| 419 | R | The customer token is refused operator-only metadata in both raw `metadata` and rows. Security. |
| 431 | R | The operator token keeps it (control). |
| 444 | R | Both roles are equal when everything is customer-visible. Partly overlaps 352's row equality, but adds raw-metadata equality. |
| 456 | R | A retired field declaration stays hidden from the customer (security regression pin). |

## tests/handlers-customer-actions.test.ts (21 it — 18 R, 3 C)

| Line | Mark | Evidence |
|---|---|---|
| 38 describe | — | container |
| 39 | R | Customer cancel happy path: status, cancelledBy, calendar delete once, `booking.cancelled_by_customer`. |
| 70 | R | Cancel revokes the customer token: a retry gets 403 with no second delete or email. Handler-level token lifecycle keeper. |
| 96 | R | Inside the cutoff → 403 past_cutoff, row unchanged. |
| 107 | **C** | A customer cancel's failed calendar delete is drained by a later operator cancel. The debt creation is covered by 142 (same customer-cancel failure setup). The drain via `tokenBooking` with an operator token on a cancelled booking is covered by 218 (identical second call). Absorbed by 142 + 218. |
| 142 | R | A stale calendar event keeps blocking availability until the debt drains via manage. Unique availability consequence (f559976). |
| 205 | R | decisions.md §2: a wrong-state cancel → 409 invalid_transition. |
| 217 describe | — | container |
| 218 | R | Operator cancel calendar_delete debt, and a retry drains it. Keeper for the drain-on-retry path. |
| 253 describe | — | container |
| 254 | R | Reschedule happy path: moves, preserves party/price, patches the calendar, emails. |
| 290 | R | A failed patch still reports success and is owed; a same-target resubmit drains it with no capacity write or second notice; a genuine B→C move versions again. Keeper for the reschedule outbox. |
| 345 | **C** | The operator path replays the shared `rescheduleWithToken` (the operator flag only skips the cutoff/enabled checks) with the same failed-patch → drain scenario. Absorbed by 290 plus handlers-operator:880 (operator reschedule happy path). |
| 388 | R | Regression pin: a same-start no-op succeeds even inside the cutoff. |
| 407 | R | Regression pin: the no-op must not bypass `enabled:false`. |
| 417 | R | Losing the write to a concurrent same-slot move still reports success (booking-actions.ts:118). |
| 434 | R | The handler excludes its own occupancy (`checkSlot(..., booking.id)`) at capacity 1. |
| 447 | R | Inverse control for 434: a real blocker → 409 slot_unavailable. |
| 466 | R | Reschedule inside the cutoff → 403 past_cutoff. |
| 476 | R | Reschedule disabled → 403 even outside the cutoff. |
| 487 | R | Off-grid start → 409 slot_unavailable. |
| 497 | R | A wrong-state reschedule → 409 invalid_transition (decisions §2). |
| 509 | **C** | tokens_expire_at = new endsAt + DEFAULT_TOKEN_EXPIRY_DAYS on a later move. The handler formula (booking-actions.ts:94-95) doesn't depend on direction. Absorbed by 523, which asserts the same formula and also the not-stale check. Repo persistence is owned by repo-d1:604/653. |
| 523 | R | Keeper for the handler's token-expiry formula on reschedule, including the "not frozen at checkout" check. |

## tests/handlers-token-lifecycle.test.ts (5 it — 5 D; retire file)

Every assertion is answered by the `tests/fakes.ts` token-state model (expiry, revocation, hash, compat fallback). The handler only maps `null → 403`.

| Line | Mark | Evidence |
|---|---|---|
| 28 describe | — | container |
| 29 | **D** | Expired cancel token → 403. Expiry predicate owned by repo-d1:477 (real D1, `now` past tokens_expire_at → null). Handler null→403 is covered by manage:295, and expired-token denial at the handler by operator:229. |
| 44 | **D** | Expired operator token → 403 via manage. Handler proof: operator:229 asserts `handleManage` 403 for an expired operator token. The repo predicate is owned by refund-operations:275 / repo-d1:477. |
| 56 | **D** | Customer cancel revokes the customer token but not the operator token. Handler proof: customer-actions:70 (same-token retry 403) and :107/:218 (operator token still acts on the cancelled booking). Real D1 revocation: repo-d1:477 (end) and :550. E2E: customer-manage.spec:6. |
| 83 | **D** | Legacy plaintext compat fallback, lazy upgrade, hash not usable as a token. All fake behavior. Real owners: repo-d1:517 (compat + backfill), :477 (hash-as-token denied), :686 (every dumped representation denied). |
| 108 | **D** | Unknown token → 403 `forbidden`. Exact duplicate of handlers-manage:295, which also asserts the headers. |

## tests/availability-manage-token.test.ts (3 it — 3 R)

| Line | Mark | Evidence |
|---|---|---|
| 54 describe | — | container |
| 55 | R | A manage token (customer or operator) excludes its own booking from occupancy (`manageTokenBookingId`). Sole handler owner. E2E customer-manage:93 only proves the header is sent. |
| 67 | R | A per-booking answer is `private, no-store` and never written to the shared cache. Cache-poisoning guard. |
| 78 | R | An unknown token behaves exactly like no token, including a shared cache hit (no oracle, no recompute). |

## tests/routes-manage-group.test.ts (5 it — 5 R)

| Line | Mark | Evidence |
|---|---|---|
| 59 describe | — | container |
| 60 | R | `routes.manage:false` drops only `/booking/manage` from the built route table, so the capability gate is exercised for real. Only owner of the manage flag (route-customization covers ops/admin). |
| 71 | R | The default stays on for the route, email links and admin links. |
| 77 | R | Emails omit manage links when disabled. |
| 84 | R | The admin dashboard omits dead manage links when disabled. |
| 91 | R | `requireEnabledRoutePath` names the manage flag (what `ManageBooking.astro` evaluates). Mild overlap with route-customization:96 (admin group). Keep. |

## tests/handlers-operator.test.ts (41 it — 36 R, 2 C, 3 D)

| Line | Mark | Evidence |
|---|---|---|
| 37 describe | — | container |
| 38 | R | Wrong operator token → 403. |
| 45 | R | No token and no bearer → 403. |
| 51 | R | A customer token used as an operator token → 403 (disjoint columns). Security. |
| 58 | R | Bearer + bookingId accepted with the correct secret. |
| 65 | R | Bearer with the wrong secret → 403. Owner. handlers-lifecycle:327 (other lane) duplicates it via no-show and should be C into this test. |
| 72 | R | Bearer with an unknown bookingId → 404 not_found. |
| 80 describe | — | container |
| 81 | R | refund=full calls refund() once; a retry is idempotent. Refund exactly-once keeper. |
| 107 | R | Goodwill refund after a customer cancel is executed and recorded; a retry is idempotent. |
| 145 | R | Goodwill without a PI → 409 refund_payment_ref_missing, no op row. |
| 179 | R | Full without a PI is rejected before claim/cancel; `none` still cancels. |
| 209 | R | Regression pin: a legacy full op without a PI is marked failed, not succeeded. |
| 229 each | R | Expired operator token: the recovery bypass works only on cancel, and only for requested/failed ops. Manage/reschedule/no-show stay 403, cancel recovers and refunds. Keeper for the handler `refundRecovery` scoping. The predicate itself is owned by refund-operations:275. |
| 279 | **D** | Expired token + succeeded op → 403. Pure fake predicate replay of `getBookingByOperatorTokenForRefundRecovery`. Real D1 owner: refund-operations:275 (`resolves.toBeNull()` after succeeded). Handler null→403 is covered by 38. |
| 304 | **D** | Expired token with no op → 403. Same as 279. refund-operations:275 asserts the recovery lookup is null before any claim. |
| 325 | **C** | Manage/reschedule/no-show stay 403 for an expired token with a requested op. The `'requested'` row of 229 makes these same three calls with the same assertions before recovering, so 229 fully subsumes it. |
| 353 | R | refund=none with a PI never calls refund(). |
| 371 | R | Missing refund field → 400 validation_failed. |
| 381 | R | Operator cancel of a non-confirmed booking → 409 invalid_transition. |
| 391 | R | A throwing refund() is non-2xx, but the cancel stays durable and the op is marked failed. |
| 413 | R | (F7) full vs none race: one winner, loser gets refund_conflict, replays behave. Regression pin. |
| 462 | R | Crash between claim/CAS and Stripe recovers on retry and records the refund id. |
| 487 | R | (F8) Stripe succeeds but the D1 resolve fails: the op stays `requested`, and the retry reuses the idempotency key. Regression pin. |
| 532 | R | The booking price is forwarded as expectedAmountCents. |
| 550 | **C** | (F9) "fresh repo instance" is meaningless with the fake: it's a pre-seeded requested op on a confirmed booking, which hits the same branch as 584 (booking-actions.ts:340 → `completeClaimedOperatorCancellation`). Its follow-up retry is idempotency, already covered by 81. The misleading refundRef `re_should_not_happen` is asserted *to happen* (refunds=1). Absorbed by 584 + 81. |
| 584 | R | Resume a requested claim after a crash before CAS; a conflicting choice is still rejected. Keeper for the resume branch. |
| 622 | R | (finding #3) A lost CAS to a reschedule deletes the requested op, never calls Stripe, and a later cancel works. |
| 658 | R | A lost operator CAS to a customer cancel resumes the claimed refund. |
| 687 | R | A charge.refunded webhook that wins the CAS keeps its succeeded op. Stripe is never called. |
| 717 | R | An authoritative webhook corrects a none/succeeded row, and a follow-up full is idempotent. Handler-level (the repo half is refund-operations:175). |
| 762 | R (move) | The partial-refund webhook doesn't rewrite an existing op row or cancel. This is webhook behavior, so move it next to handlers-refunds-disputes:62, which covers only the no-existing-row case. |
| 798 | R | A same-choice loser re-reads after the winner resolves, ending in one consistent succeeded row. |
| 858 | **D** | "cross-context retry … instead of refundedPayments". The in-memory `refundedPayments` Set was deleted in 93bb918 (BK-REFUND-001), and contexts hold no refund state (`src/context.ts` keeps only `confirmationLocks`). What's left (second full request, refunds stays 1) is identical to 81's retry. |
| 879 describe | — | container |
| 880 | R | Cutoff asymmetry: customer 403, operator 200 (moves, preserves party/price, patches). Operator reschedule keeper. |
| 909 describe | — | container |
| 910 | R | No-show before start → 409 invalid_transition. |
| 920 | R | No-show on a hold → 409. Could merge with 929 into one `it.each` (same catch path), but that's low value. |
| 929 | R | No-show on a cancelled booking → 409. |
| 938 | R | No-show happy path, `booking.no_show` dispatched, a repeat is idempotent. |
| 965 describe | — | container |
| 983 | R | Partial refund refunds only the decided amount and records it. |
| 1002 | R | A different partial amount is a different decision → refund_conflict. |
| 1024 | R | The same partial decision repeated is idempotent. |
| 1036 each | R | Validation table for partial amounts (none/0/full/over/fraction/amount-with-full) → 400 with nothing claimed. All rows share one mark. |

---

## Layer plan

**Redundant layer: `tests/handlers-token-lifecycle.test.ts` (retire whole file).** It replays the manage-token hashing/expiry/revocation/compat model through the `tests/fakes.ts` token state, around the stronger real-D1 suite.
- Keeper (repo predicate, hashing, compat, dump non-usability, revocation, migration 0009 backfill): `tests/workers/repo-d1.test.ts` › `token hashing, expiry, and revocation` (450-750).
- Keeper (expired-token refund recovery predicate): `tests/workers/refund-operations.test.ts:275`.
- Keeper (handler mapping and route scoping): handlers-manage:295/304 (403 envelope), handlers-customer-actions:70 (revocation on cancel), handlers-operator:229 (recovery bypass scoped to cancel).
- E2E: customer-manage.spec:6 (revoked link indistinguishable from unknown).
- Assertions to carry: none. Every assertion already has a stronger owner.
- Fake support unlocked: **none**. Seeded fake rows start with `cancelTokenHash: null`, so every handler test authenticates through the fake's compat path, and `tokensExpireAt` is still used by operator:229.

**Operator refund recovery negative controls (operator:279, :304):** the same pattern, with a fake predicate replay. Keeper: refund-operations:275.

**Duplicate invocations inside the keeper suites:**
- operator:325 → operator:229 (the requested row is a superset).
- operator:550 → operator:584 (+81).
- operator:858 → operator:81 (its premise, `refundedPayments`, is gone).
- customer-actions:345 → customer-actions:290 + operator:880 (shared `rescheduleWithToken`).
- customer-actions:107 → customer-actions:142 + :218.
- customer-actions:509 → customer-actions:523.

**Shared-helper replay:** handlers-manage:161 → core-config:672 (`pickupPresentationFor`); manage:147 keeps the wiring proof.

**Misfiled (R, move only):**
- handlers-manage:181, :203 → `tests/ui-manage-page.test.ts` (pure `renderManagePage` tests).
- handlers-operator:762 → `tests/handlers-refunds-disputes.test.ts` (webhook partial-refund guard).

**Keeper per contract (this lane):**
- `/status` confirmation, leak guard, grace window, decisions §1 → handlers-status.
- `ManageResponse` capability, deadlines, metadata visibility → handlers-manage.
- Customer cancel/reschedule transitions, cutoffs, decisions §2, reschedule outbox, token-expiry formula → handlers-customer-actions.
- Operator auth, refund-decision orchestration (claim/CAS/resume/conflict/partial) → handlers-operator. The repo halves live in workers/refund-operations and workers/repo-cas-transitions.
- Manage-token availability exclusion and cache isolation → availability-manage-token.
- `routes.manage` capability gate → routes-manage-group.

**Cross-lane note:** handlers-lifecycle:327 ("rejects operator actions without constant-time shared-secret auth") asserts only a 403 for a wrong bearer on no-show. Its name promises constant-time behavior the test doesn't check, and it duplicates handlers-operator:65 → C into operator:65.

**Test-only production seams:** none in this lane. I checked every export of the owners against `src/`:
- `tokenBooking` has a production caller (booking-actions).
- `operatorBearerAuthorized` has production callers (booking-actions, ops-reconcile).
- `resumeClaimedOperatorCancellation` has production callers (booking-actions, reconciliation).
- `requireEnabledRoutePath` is used by `ManageBooking.astro`.
- `resolveRouteConfig`, `routePath`, `resolvedRoutePaths` are used by integration/context/client.
- `assertSupportedPartySize` and `calendarEventsForWindow` are used by checkout.
- `ClaimedOperatorCancellationResult` is an exported type with no outside user. It's neither test-driven nor worth touching.

---

## High-confidence batch

### 1. Delete `tests/handlers-token-lifecycle.test.ts` (whole file, 5 tests)
- **Name/location:** handlers-token-lifecycle.test.ts:29, :44, :56, :83, :108.
- **What it can detect:** `handleManage`/`handleCustomerCancel` mapping a null token lookup to 403. Everything else (expiry, revocation, hash, compat upgrade) is computed by the fake repository.
- **Non-test callers of the covered seam:** `getBookingByCancelToken`/`getBookingByOperatorToken` in `src/repo.ts`, called from status-manage.ts:211-234 and availability.ts:293. These are real, but their behavior is proven on D1.
- **Stronger remaining proof:**
  - repo-d1:456/477/517/550/686/717 (real D1 hashing, expiry, revocation, compat, dump denial).
  - refund-operations:275 (expired operator token).
  - handlers-manage:295/304 (403 envelope).
  - handlers-customer-actions:70 (revoke on cancel at the handler).
  - handlers-operator:229 (`handleManage` 403 on an expired operator token).
  - e2e customer-manage.spec:6.
- **History:** added in 0c36c5c (BK-SEC-002) alongside the real-D1 suite. The fake-level replay was scaffolding for the feature commit.
- **Deletion unlocked:** 115 test LOC. No production or fake code.
- **Risk:** low. Validate with `bun run test tests/handlers-manage.test.ts tests/handlers-customer-actions.test.ts tests/handlers-operator.test.ts` and `bun run test:workers tests/workers/repo-d1.test.ts tests/workers/refund-operations.test.ts`.

### 2. Delete handlers-operator.test.ts:858 ("cross-context retry … instead of refundedPayments")
- **What it can detect:** a second full request calling refund() again. That's identical to operator:81's retry.
- **Non-test callers:** no `refundedPayments` symbol exists anywhere in `src/` (removed in 93bb918), and `createReservaContext` holds no refund state (only `confirmationLocks`).
- **Stronger proof:** operator:81 (retry idempotent), plus :462/:487/:550/:584 for durable-row resume, plus workers/refund-operations:48/67/89.
- **History:** written in 93bb918 to prove the durable row replaced the in-memory Set. The Set is gone, so the contrast no longer exists.
- **Unlocked:** about 19 test LOC.
- **Risk:** very low. Validate with `bun run test tests/handlers-operator.test.ts`.

### 3. Consolidate handlers-operator.test.ts:325 into :229
- **What it can detect:** manage/reschedule/no-show must reject an expired operator token while a requested refund op exists.
- **Stronger proof:** the `'requested'` row of the `it.each` at :229 makes the same three calls with the same 403 assertions (lines 261-268), and then also proves cancel recovers.
- **Non-test callers:** `tokenBooking(…, refundRecovery)` in booking-actions.ts:153/307. Only cancel passes `true`.
- **History:** f559976 added both "expired-token denial scoped to the recovery route" tests. The `it.each` later grew the same scope checks.
- **Unlocked:** about 27 test LOC. Nothing needs carrying over.
- **Risk:** very low. Validate with `bun run test tests/handlers-operator.test.ts`.

### 4. Delete handlers-operator.test.ts:279 and :304 (expired token + succeeded op / no op → 403)
- **What they can detect:** only the fake `getBookingByOperatorTokenForRefundRecovery` predicate (fakes.ts:298). The handler just maps null to 403.
- **Stronger proof:** refund-operations:275 on real D1 asserts null before any claim, non-null for requested/failed, and null after succeeded, including the legacy-row variant. Handler null→403 is proven by operator:38, and handler scoping by :229.
- **History:** f559976, written as negative controls for the recovery bypass.
- **Unlocked:** about 42 test LOC.
- **Risk:** low. Validate with `bun run test tests/handlers-operator.test.ts` and `bun run test:workers tests/workers/refund-operations.test.ts`.

### 5. Consolidate handlers-customer-actions.test.ts:345 into :290 (+ handlers-operator:880)
- **What it can detect:** an operator reschedule with a failed calendar patch reports 200, owes the outbox row, and a retry drains it with no second capacity write.
- **Non-test callers:** `rescheduleWithToken` (booking-actions.ts:72) is shared. `operator=true` only skips the `enabled`/cutoff checks (lines 76, 82), which the patch/outbox path never reads.
- **Stronger proof:** customer-actions:290 runs the identical outbox scenario through the same function. operator:880 proves the operator reschedule path end to end, including the calendar patch. workers/calendar-patch-outbox:20 covers the real D1 row.
- **History:** added pre-50b8530, then re-asserted in 50b8530 when the patch moved to the outbox. It mirrors the customer test.
- **Unlocked:** about 42 test LOC.
- **Risk:** low. Validate with `bun run test tests/handlers-customer-actions.test.ts tests/handlers-operator.test.ts`.

### 6. Consolidate handlers-operator.test.ts:550 (F9) into :584 (+81)
- **What it can detect:** the resume of a requested same-choice claim on a still-confirmed booking (booking-actions.ts:340).
- **Stronger proof:** :584 reaches the same branch from a real simulated crash, and also proves a conflicting choice is refused. :81 proves the follow-up retry is idempotent.
- **Why it's weak:** "fresh repo instance" is meaningless with the fake, and the misleading `re_should_not_happen` refundRef is asserted as happening.
- **History:** 93bb918 (BK-REFUND-001). It predates :584.
- **Unlocked:** about 33 test LOC.
- **Risk:** low. Validate with `bun run test tests/handlers-operator.test.ts`.

### Medium-confidence (C, lower priority; include only after a second look)
- **customer-actions:107 → :142 + :218.** Debt creation on customer cancel is covered by 142. The operator-token drain on a cancelled booking is covered by 218. Both reach `tokenBooking` → `runOwedMutationSideEffects` identically.
- **customer-actions:509 → :523.** The token-expiry formula doesn't depend on direction, and 523 is the stronger case.
- **handlers-manage:161 → core-config:672.** It replays the `pickupPresentationFor` fallback. Manage wiring stays proven by :147.
- **handlers-manage:352 (F).** Drop or derive the literal `'<dd>On</dd>'` catalog copy.

---

## Suspected product bugs / follow-ups

1. **`handleOperatorNoShow` catch-all (booking-actions.ts:371-383).** The `try` wraps `transitionToNoShow` *and* `dispatchMutation` (→ `runOwedMutationSideEffects`, which does repo writes). Any infrastructure error comes back as `409 invalid_transition`, with the raw `error.message` placed in the public envelope. That includes a D1 failure in the drain *after* the no_show CAS has already committed. The operator is told the transition is invalid even though it succeeded, and internal error text leaks into the envelope. Cancel and reschedule let such errors surface as 5xx. Not reproduced.
2. **Stale source references in test comments.** handlers-manage.test.ts:313 cites `handlers/index.ts:355-357`, and handlers-token-lifecycle.test.ts:76 cites `src/handlers/index.ts`. The code now lives in `status-manage.ts`/`booking-actions.ts`. Doc nit only.
3. **`handleCustomerCancel`'s `status === 'cancelled' → ok` early return (booking-actions.ts:30) is effectively unreachable.** Every cancel revokes the customer token, so `tokenBooking` throws 403 first. It's only reachable for a pre-0009 cancelled row whose revocation backfill didn't run. Not a bug, but it's dead-ish code worth noting for a later simplification.
