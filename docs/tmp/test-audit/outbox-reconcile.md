# Lane: outbox-reconcile — read-only ledger

Scope: tests/{confirmation-email-outbox,confirmation-mutation-outbox,confirmation-outbox-abandonment,
confirmation-outbox,confirmation-retry,booking-confirmation,reconciliation,reconciliation-helpers,
reconciliation-route-config,refund-executor,provider-failure,alerts-email-sink}.test.ts.
Owners read: src/confirmation.ts, src/reconciliation.ts, src/reconciliation-helpers.ts,
src/refund-executor.ts, src/provider-failure.ts, src/alerts/*, src/handlers/ops-reconcile.ts,
the fake repository (tests/fakes.ts) paths these tests hit, and the relevant src/repo.ts SQL.
Overlap read: tests/workers/{calendar-patch-outbox,reconciliation-claims,reconciliation-runtime,
ops-reconcile,refund-operations,repo-d1 (mutation outbox block),webhook}.test.ts,
tests/ui-page-snapshots.test.ts + snapshot, tests/handlers-status.test.ts, tests/providers-google.test.ts.
All assigned files run in the `unit` Vitest project; the overlap suites run in `workers`.

Marks: R retain, F repair, C consolidate (absorbing owner named), D delete (remaining proof named).
Describe blocks are containers and take the mark of their children unless noted.

## Ledger

### tests/confirmation-email-outbox.test.ts (split confirmation email rows; fake repo + real handlers)

| Line | Mark | Evidence |
|---|---|---|
| 32 | R | Split confirmation rows: an owner failure retries only the owner row, customer never resent (confirmation.ts runConfirmationOperation per-recipient dispatch). Catches a regression back to a combined send on retry. |
| 67 | D | Computes its own "all split rows succeeded" predicate inside a wrapped fake resolve; the retired emailSynced flag it once observed is gone (architecture invariant: no entity flag). Row order is the fake's identitySort, so it cannot fail for a production reason 32/99 don't already catch. |
| 99 | R | Send-only provider keeps one combined email_confirmation row (confirmationEmailRecipients requires both recipientsForEvent+sendToRecipient). |
| 118 | R | Legacy failed combined row retried via send(), never split, after provider becomes split-capable. Regression pin for upgrade path. (Cosmetic: `!== undefined).toBe(false)` could be `toBeUndefined()`.) |
| 155 | R | Mutation drain never claims a split confirmation row (isRowLeaseOperation boundary between the two outboxes). |
| 177 | R | A D1 write failure resolving the customer row does not block the owner row; redelivery retries only customer. |

### tests/confirmation-mutation-outbox.test.ts (mutation outbox)

| Line | Mark | Evidence |
|---|---|---|
| 43 | C | Calls only the FAKE repository (`repo.transitionToCancelled/transitionToNoShow/rescheduleWithCapacity`) — no production code runs; the fake answers the question. Owner: tests/workers/repo-d1.test.ts "mutation side-effect outbox on real D1" (already proves reschedule version `'1'` for the CAS winner and cancel batch atomicity; reconciliation-claims:114 proves a cancel's row is claimable; calendar-patch-outbox proves per-version rows). Carry: one real-D1 case that `transitionToNoShow` with `mutationSideEffects` records a pending row (no D1 proof exists today). |
| 77 | R | Request-driven drain: failed no-show email row retried on a later operator request (handler → runOwedMutationSideEffects). |
| 98 | R | Overlapping drains send once. The claim CAS itself is fake-supplied (real fencing in repo-d1:763), but the production branch "null claim ⇒ no provider call" is what this pins. Keep; do not extend. |
| 127 | R | A→B→A→B reschedules under one instant produce 3 distinct rows and 3 sends (handler seeds + drain). Real D1 versioning lives in repo-d1:814 / calendar-patch-outbox. |
| 152 | D | Fake-only replay of 43's no-show clause (`repo.transitionToNoShow` on the fake). Remaining proof: the D1 case carried by 43's consolidation. |
| 166 | R | recipientsForEvent without sendToRecipient ⇒ one combined row (mutationSideEffectSeeds). |
| 185 | R | Existing recipient row stays owed when current provider cannot send to a recipient (attemptForOperation returns null). |
| 200 | R | Regression pin: class-based provider method receiver preserved (`sendToRecipient.bind(email)`). |
| 222 | R | Mutation path: only the failed owner recipient row retried. |
| 246 | R | Durable hook delivery retried on a later request. |
| 266 | R | Provider failure log carries provider/status but never the response body (privacy). |

### tests/confirmation-outbox-abandonment.test.ts

| Line | Mark | Evidence |
|---|---|---|
| 44 | R | Permanent 401 abandons after one attempt, logs once, webhook stays 200, no reclaim on redelivery or /status, non-durable hook fired once. |
| 87 | R | Cap: failed through attempt 9, abandoned on 10 with bounded error, no 11th call. |
| 118 | R | Regression pin: interleaved tenth claim classified from the claim's authoritative attempt number, not the stale list snapshot. |
| 150 | R | No-status network error stays retryable (classifyProviderError default). |
| 171 | R | Abandoned durable confirmation hook stops handleStatus re-entering fulfillment. |

### tests/confirmation-outbox.test.ts

| Line | Mark | Evidence |
|---|---|---|
| 25 | F | Real contract: D1 write failure after calendar success ⇒ 500, redelivery re-runs createEvent, row succeeds at attempt 2. The `eventIds` set-size assertion is supplied by the test's own createEvent (id derived from booking id), so "without creating a second event" is promised but not exercised — the dedupe is owned by tests/providers-google.test.ts:190. Repair: drop the eventIds assertion / retitle. |
| 67 | R | Email attempt recorded as failed before redelivery; redelivery resumes it. |
| 98 | C | Status poll resumes a confirmed booking's owed calendar row. Near-duplicate of tests/handlers-status.test.ts:490 (failed calendar row resumed by /status, asserts succeeded). Absorb the `calendarCalls === 1` assertion there. |
| 130 | R | Expired paid hold whose capacity recheck throws ⇒ oversell marker (catch ⇒ oversold = true). |
| 155 | R | Lost pre-confirmation batch ⇒ ConfirmationInProgressError, booking stays expired (Stripe retries). |
| 171 | R | Webhook after /status confirmation backfills payment details (applyConfirmedPaymentDetails branch). |
| 215 | R | Lease-loser's late write rejected after another caller takes the expired lease. Note: renewConfirmationLease fencing has no real-D1 test (repo-d1:55 covers acquire/release only) — a gap, not a deletion. |

### tests/confirmation-retry.test.ts (admin "Try again")

| Line | Mark | Evidence |
|---|---|---|
| 27 | R | Oversell marker ⇒ not_retryable. |
| 36 | R | Abandoned calendar_create retried past cap ⇒ succeeded, calendarEventId written. |
| 52 | R | Still-failing provider ⇒ 'failed' with error recorded. |
| 65 | R | Held confirmation lease ⇒ lease_unavailable. |
| 75 | R | Already-succeeded row ⇒ nothing_to_retry. |
| 84 | R | Mutation-kind (calendar_delete) retry succeeds. |
| 99 | R | Provider no longer configured ⇒ not_retryable and claim released to 'failed'. |
| 110 | R | Abandoned durable hook row retried ⇒ succeeded. |
| 128 | R | Unregistered hook re-abandons with the remediating registration message. |

### tests/booking-confirmation.test.ts (confirmation PAGE renderer — belongs to the surfaces lane by owner)

| Line | Mark | Evidence |
|---|---|---|
| 8 | C | Every assertion (reference, "Vintage Tour" not slug, "2 people", "€100.00", meeting point) is pinned byte-for-byte by ui-page-snapshots "confirmed, full booking". Copy assertions in a behavior test. |
| 40 | R | meetingPoint: null omits the fact and the calendar location — no snapshot covers this payload. |
| 73 | R | booking: null confirmed page has no blank ticket — no snapshot covers booking: null confirmed. |
| 86 | C | Cancelled state (decisions.md #1): all assertions are copy pinned by ui-page-snapshots "cancelled", including absence of the not-found copy. |
| 105 | R | Metadata rows + XSS escaping of customer free text. |
| 145 | R | Poller hand-off contract (data-endpoint/session/attempt parsed from `attempt=4`, max, live region, no-script refresh). Snapshot only covers attempt=0. |
| 159 | R | Triage pin (50b8530): poller removed once the attempt budget is spent. |
| 166 | R | Triage pin: served script in every terminal state for the theme toggle. |
| 174 | R | ?locale negotiation and unsupported-tag injection guard. |
| 180 | R | Triage pin: neutral return-visit greeting. |
| 189 | R | Multi-day return visit names the end day (not snapshotted). |
| 197 | R | Triage pin: ICS UID = reference@host, DTSTAMP from page clock. |

### tests/reconciliation.test.ts (runReconciliation through the fake repo)

| Line | Mark | Evidence |
|---|---|---|
| 33 | D | Same assertions as tests/workers/reconciliation-runtime.test.ts:48 (summary.expiredHoldsSwept 1, row expired); the only logic is repo.sweepExpiredHolds SQL, which the fake reimplements. Also covered via ops-reconcile:118/193. |
| 43 | R | Delayed incident opens at 10 minutes, updates on a later failing pass, auto-resolves on success (reconciliation.ts sideEffectSignal + applyIncidentProjection). The backoff half is fake-derived and also proven on D1 (reconciliation-runtime:90); the incident lifecycle is not. Stale comment: `isDueForScheduledRetry` no longer exists. |
| 84 | R | No incident inside the ten-minute window. |
| 100 | R | Abandoned row ⇒ action_required incident immediately. |
| 114 | C | Duplicate of reconciliation-runtime:63 (refund resumed via claim + executor, succeeded + stripeRefundId). Carry `incidentsOpened === 0` and the single provider call into the D1 case. |
| 131 | D | Same scenario and assertions as reconciliation-runtime:129 (both added in 0dd5ab2); owner is the real CAS in resumeClaimedOperatorCancellation → D1 is the stronger layer. |
| 151 | R | Requested refund on a no_show booking: no Stripe call, action_required refund incident (no D1 counterpart). |
| 167 | R | Refund failure opens action_required incident; later success auto-resolves (refundSignal). |
| 193 | C | Oversell marker reported once. reconciliation-runtime:184 proves the persisted row; carry the "second run opens 0" assertion (listUnreportedOversellMarkers exclusion is SQL the fake reimplements). |
| 208 | R | Alert drained through sink with exactly the seven fields; not resent. |
| 231 | R | Same-pass auto-resolve suppresses the obsolete alert. |
| 255 | R | Failing sink ⇒ alertNextAttemptAt + bounded error, sweep continues. |
| 270 | F | Row-level isolation of due siblings (runScheduledSideEffectOperation, not a booking-wide drain) is real; repair the hand-built key lookups `repo.sideEffectOperations.get(\`${id}:calendar_create\`)` to `sideEffectOperation(repo, id, identity)` per the fakes.ts rule. |
| 296 | D | Same assertions as reconciliation-runtime:156 (calendarCalls 1, processed 1, incidentsOpened 10); starvation is decided by listSideEffectExecutionCandidates SQL, which the fake reimplements. |
| 314 | F | HTTP-recovery reprojection is real and has no D1 counterpart; repair the hand-built key get/set to the identity helpers. |
| 333 | R | No sink ⇒ revisions left undelivered; requireAlertSink preflight throws. |
| 347 | R | Batch loop drains a backlog across sourceLimit pages and reports `batches`. |

### tests/reconciliation-helpers.test.ts

| Line | Mark | Evidence |
|---|---|---|
| 14 | R | 5/10/20/40/60 schedule (computeNextAttemptAt: refund executor + alert drain). |
| 23 | R | Cap at 60. |
| 29 | R | Sub-1 floor. |
| 35 (describe) | D | isEligibleForAutomaticClaim has no non-test caller in src/ (grep); eligibility lives in repo SQL `next_attempt_at` predicates. Dead production code kept alive by tests. |
| 37 | D | as above |
| 40 | D | as above |
| 43 | D | as above |
| 46 | D | as above |
| 52 | R | Delay threshold boundary (-1 ms). |
| 57 | R | Exactly at threshold. |
| 62 | R | Past threshold. |
| 68 | F | Title says "both calendar families" but omits calendar_patch (added in 50b8530). Add the row. |
| 72 | R | Confirmation email identities ⇒ confirmation_email (alert `action` field). |
| 77 | R | Mutation email ⇒ customer_notification. |
| 81 | R | hook/webhook ⇒ operations_sync. |
| 85 | R | oversell ⇒ oversell. |
| 91 | F | "Never 'abandoned'" is a real rule, but iterates a hand-copied action list missing payment_verification_rejected and reconciliation_stale. Enumerate every case the switch handles. |
| 97 | C | Restates the switch's English strings (had to change in 50b8530 for a copy edit). Owners: tests/handlers-admin-incidents.test.ts:88 and tests/e2e/admin-incidents.spec.ts:67-69 render the cards. |
| 110–153 (10 its) | R | projectIncident decision table (open/update/escalate/never de-escalate/auto-resolve/skip/manual-stays-resolved/reopen). Non-obvious lifecycle; pure owner. |
| 160 | R | Alert payload is exactly the seven approved fields. |
| 174 | R | Excess props never leak into the alert (PII guard). |

### tests/reconciliation-route-config.test.ts

| Line | Mark | Evidence |
|---|---|---|
| 21 | R | Regression pin: cron-sent customer email and alert links carry the routePrefix (scheduledHandler overlays virtualConfig.routes), through the real Brevo adapter with a fake fetch. |

### tests/refund-executor.test.ts (attemptRefund claimed branch)

| Line | Mark | Evidence |
|---|---|---|
| 20 | R | Retryable failure ⇒ failed + next_attempt_at 10:05. |
| 39 | R | Cap ⇒ abandoned, no next_attempt_at. |
| 58 | R | Permanent failure abandons on attempt 1. |
| 76 | C | Claimed success ⇒ succeeded + stripeRefundId; reconciliation-runtime:63 proves the same through the real claim on D1. Low value to keep both; medium confidence. |
| 93 | R | choice none / missing payment intent never call Stripe. |
| 110 | R | Retry replays the decided partial amount, not the booking price (money). |
| 142 | R | Partial row without amount refused, provider not called. |

### tests/provider-failure.test.ts

| Line | Mark | Evidence |
|---|---|---|
| 5 | C | isRetryableStatus is only called inside provider-failure.ts (plus this test). Move the rows into a `classifyProviderError({ status })` table; unlocks un-exporting isRetryableStatus. |
| 11 | C | as above |
| 17 | C | as above (`classifyProviderError('x')`/no status already covered at 50) |
| 23 | R | ProviderFailure derives retryable from status. |
| 29 | R | Caller override of retryable. |
| 33 | R | Message bounded to 500 chars. |
| 40 | R | Reads a ProviderFailure directly. |
| 45 | R | Structural `.status` on plain objects (Google/Stripe errors). |
| 50 | R | Non-HTTP error defaults retryable. |
| 56 | R | Non-numeric status ignored. |

### tests/alerts-email-sink.test.ts

| Line | Mark | Evidence |
|---|---|---|
| 43 | R | Construction-time refusal of a provider without sendMessage. |
| 48 | F | Recipient/subject/html/text contract is real; `text toContain('3')` is near-vacuous (any "3" passes). Assert the attempt count in context or drop it. |
| 66 | R | `to` override. |
| 74 | R | Pinned email locale selects the pt-PT catalog. |
| 84 | R | Falls back to the deployment default locale. |
| 116 | R | Runtime wires the email sink by default. |
| 126 | R | Explicit alerts provider wins. |
| 138 | F | Asserts only that a sink exists and `send` resolves; never that loggerAlertSink logged the alert. loggerAlertSink (public via src/runtime.ts) has no other behavioral test. Pass a capturing logger and assert `'reserva operational alert'` with the alert payload. |

### Counts (it/test declarations, 122 total)

R 95 · F 7 · C 11 · D 9

## Layer plan

No assigned file is a wholly redundant layer. The unit suites here mostly run production
orchestration (confirmation.ts drains, reconciliation.ts projection/alerting/batching,
refund-executor branches) with the fake repository standing in for storage. The redundant
slices are narrow:

1. **Reconciliation storage-decided scenarios.** reconciliation.test.ts:33/114/131/193/296 replay,
   through the fake's reimplemented SQL, exactly what tests/workers/reconciliation-runtime.test.ts
   proves on real D1. **Keeper:** reconciliation-runtime.test.ts (expired-hold sweep, refund resume,
   cancellation-gate resume, terminal-row starvation, oversell marker, scheduled backoff).
   Carry into the keeper: `incidentsOpened === 0` + one provider call (from :114), second-run
   `incidentsOpened === 0` (from :193).
   reconciliation.test.ts stays the keeper for incident lifecycle, alert drain/obsolescence/backoff,
   missing-sink preflight, HTTP reprojection, row-level sibling isolation, the batch loop, and the
   no_show refund block.
2. **Mutation rows recorded in the winning batch.** confirmation-mutation-outbox.test.ts:43/152
   exercise only the fake. **Keeper:** tests/workers/repo-d1.test.ts "mutation side-effect outbox on
   real D1" (+ calendar-patch-outbox, reconciliation-claims:114). Carry: a transitionToNoShow
   `mutationSideEffects` row on D1 (currently unproven on D1).
3. **Claim/lease CAS.** Keeper: repo-d1 (confirmation lease acquire, mutation claim fencing),
   reconciliation-claims (refund execution, alert claims, backoff bypass). Unit drain tests keep only
   the production branching on a null claim / attempt number; do not add more fake-CAS tests.
   Gap to record (not fill in this campaign unless asked): renewConfirmationLease fencing after
   lease expiry has no D1 test (confirmation-outbox:215 proves it only against the fake).
4. **Confirmation drain orchestration** (split rows, legacy combined row, abandonment/cap,
   admin retry): keepers are the unit confirmation-*.test.ts files; only D1 end-to-end is
   workers/webhook.test.ts happy path + redelivery. No retirement.
5. **Confirmation page:** keeper for copy/markup is ui-page-snapshots; booking-confirmation keeps
   non-snapshotted payloads and triage regression pins (C for :8 and :86 only).
6. **Ops reconcile route:** workers/ops-reconcile.test.ts is sole owner (no unit layer).
7. **Alerts:** alerts-email-sink is sole owner of the sink; reconciliation.test owns the drain.

Test-only production seams:

| Seam | Non-test callers | Public? | Unlocked by |
|---|---|---|---|
| `isEligibleForAutomaticClaim` (src/reconciliation-helpers.ts:37-39 + its comment 33-36) | none | no (reconciliation-helpers is not re-exported by src/index.ts, src/core/index.ts, src/runtime.ts, src/client, src/email, src/ui/index.ts, src/dev, providers, packages/stripe) | deleting reconciliation-helpers.test.ts:35-49 |
| `export` on `isRetryableStatus` (src/provider-failure.ts:18) | same-file only | no (file header: "never re-exported") | consolidating provider-failure.test.ts:5/11/17 into classifyProviderError rows |
| `export` on `RETRY_BACKOFF_MINUTES` (reconciliation-helpers.ts:15) | same-file only; no test imports it | no | nothing (optional un-export, not test-driven) |

No tests/fakes.ts method loses its last caller from this lane's batch (sweepExpiredHolds,
transitionToNoShow, recordMutationSideEffectOperations are used by other suites).

## High-confidence batch

### 1. reconciliation-helpers.test.ts:35-49 `describe('isEligibleForAutomaticClaim')` (4 its) — D, plus seam removal
- Detects: only the helper's own `null || <=` comparison.
- Non-test callers: none (`grep -rlw isEligibleForAutomaticClaim src packages/stripe/src` ⇒ only its definition).
- Stronger remaining proof: eligibility is enforced in repo SQL; real-D1 proof in
  tests/workers/reconciliation-claims.test.ts:80 (refund next_attempt_at gate + bypass) and :114
  (mutation next_attempt_at gate + bypass); fake mirrors it for unit suites.
- History: added in e1aee9b (2026-08-14, "pure backoff/incident helpers"); never wired — the
  eligibility check landed in the claim/candidate SQL instead.
- Unlocks: delete src/reconciliation-helpers.ts:33-39 (dead export). Not public.
- Risk: none. Validation: `bun run test tests/reconciliation-helpers.test.ts`, `bun run typecheck`.
  Shipped-source change ⇒ patch changeset (not public API).

### 2. confirmation-email-outbox.test.ts:67 "counts the confirmation email as delivered only once BOTH split rows have succeeded" — D
- Detects: nothing production-owned — the predicate is computed in the test; ordering comes from the
  fake's identitySort.
- Non-test callers: n/a (no seam).
- Remaining proof: :32 and :177 (each split row created and resolved independently);
  handleStatus/confirmationFullySettled own "settled" and are exercised by
  confirmation-outbox-abandonment:171 and handlers-status.
- History: 0131425 asserted the fake's emailSynced recompute; 5bfbc49 retired the flag and rewrote
  the test to compute its own predicate.
- Unlocks: nothing in production. Risk: none. Validation: `bun run test tests/confirmation-email-outbox.test.ts`.

### 3. confirmation-mutation-outbox.test.ts:43 (C) and :152 (D) — fake-only transition tests
- Detects: behavior of tests/fakes.ts transitionToCancelled/transitionToNoShow/rescheduleWithCapacity
  only; no src/ code executes.
- Non-test callers: n/a.
- Stronger proof: tests/workers/repo-d1.test.ts:814 (reschedule version '1', loser records nothing),
  :843 (cancel batch atomic), reconciliation-claims:114 (cancel row recorded + claimable),
  calendar-patch-outbox:20 (per-version rows). Carry before deleting: one D1 case in repo-d1's
  "mutation side-effect outbox on real D1" block for transitionToNoShow with mutationSideEffects
  (winner records a pending row; a losing CAS records none) — the one clause with no real proof.
- History: both added in b081312 (BK-SIDE-001) when the outbox shipped; the D1 block came in the
  same wave but covered only reschedule/stale reclaim.
- Unlocks: none in production. Risk: low once the no-show D1 case lands.
  Validation: `bun run test tests/confirmation-mutation-outbox.test.ts`,
  `bun run test:workers tests/workers/repo-d1.test.ts`.

### 4. reconciliation.test.ts:33 (D), :131 (D), :296 (D), :114 (C), :193 (C)
- Detects: fake-reimplemented SQL outcomes (sweepExpiredHolds, listSideEffectExecutionCandidates
  ordering/limit, listUnreportedOversellMarkers exclusion) plus orchestration the D1 twins run too.
- Non-test callers: n/a.
- Stronger proof: tests/workers/reconciliation-runtime.test.ts :48, :129, :156, :63, :184 — same
  scenarios with the same assertions against real D1 and the real migrations. Carry into the D1
  twins: `refunds === 1` + `incidentsOpened === 0` (from :114); second `runReconciliation` yields
  `incidentsOpened === 0` (from :193).
- History: :33/:114/:193 date from 6bc7779 with their D1 twins; :131 and :296 were added with their
  D1 twins in 0dd5ab2 (reliability review) — the skill's "one regression at the owner boundary"
  puts them in the D1 file.
- Unlocks: none in production; fake methods still used elsewhere.
- Risk: low; the workers suite is not in `bun run test`, so CI must keep running `test:workers`.
  Validation: `bun run test tests/reconciliation.test.ts`,
  `bun run test:workers tests/workers/reconciliation-runtime.test.ts`.

Medium-confidence (not in the batch): booking-confirmation:8/:86 (C → page snapshots; surfaces
lane should decide), confirmation-outbox:98 (C → handlers-status:490), refund-executor:76 (C → D1
refund resume), reconciliation-helpers:97 (C → admin incident card tests), provider-failure:5/11/17
(C into classifyProviderError table, unlocks un-export).

## Suspected product bugs / follow-ups

1. **Split confirmation row marked delivered without sending** — src/confirmation.ts:185-190:
   for a split row (`family 'email'`, name customer/owner, event booking.confirmed) when the current
   provider lacks `sendToRecipient`, runConfirmationOperation returns null and executeOperation /
   retryConfirmationSideEffectOperation resolve the row `succeeded` though nothing was sent. The
   mutation path does the opposite (attemptForOperation returns null ⇒ row left owed, pinned by
   confirmation-mutation-outbox:185). Reachable after a provider swap between deploys. Needs an
   owner decision + a failing regression before any fix.
2. Misplaced doc comment: src/confirmation.ts:642-649 describes runOwedMutationSideEffects but sits
   above openPaymentVerificationIncident.
3. Stale comments: tests/reconciliation.test.ts:11-12 and tests/workers/reconciliation-runtime.test.ts:87-89
   cite a nonexistent `isDueForScheduledRetry`; tests/fakes.ts resolveSideEffectOperation comment
   cites the retired calendar_synced/email_synced flags.
4. Observation: owner-facing incident titles are hard-coded English in
   src/reconciliation-helpers.ts:59-70, not in a message catalog.
