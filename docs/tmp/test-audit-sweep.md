# Test-audit sweep — 2026-09-29 (base 9eb6759)

Per-lane ledgers (every declaration marked R/F/C/D with evidence): `docs/tmp/test-audit/{domain,checkout-webhook,admin-auth,manage-operator,outbox-reconcile,d1-repo,surfaces,distribution}.md`.

## Result

| | baseline | after |
|---|---|---|
| unit + component | 1211 tests | 1135 (3 files deleted) |
| workers (real D1) | 201 tests | 193 (same files) |
| test LOC | — | +138 −1146 |
| prod/tooling LOC | — | +5 −93 |


Applied only the high-confidence D/C batches plus F repairs of tests that could not fail. Medium-confidence items remain in the ledgers.

Deleted files: `core-reference`, `handlers-token-lifecycle`, `integration-smoke` (25 s astro build; `test:pack` owns all routes).

Production removed (none reachable from `package.json` exports): `nextReference`, `generateUniqueReference`, `formatReference`, `referenceYear`, `validCalendarDate`, `isHoldActive`, `isCancellationAllowed`, `fallBackAmbiguityPolicy`, `priceForService`, `quantityValuesForService`, `isEligibleForAutomaticClaim`; un-exported `themeCookieName`, `renderEmbedTokensCss`.

Carried into keepers before deletion: reconciliation refund single-call / no-incident and oversell second-run assertions (`workers/reconciliation-runtime`); real-D1 no-show outbox CAS case (`workers/repo-d1`); alternating-choice assertion (`workers/refund-operations`).

Mutation-verified F repairs: alerts-email-sink (logger), handlers-admin sweep (order independence), booking-events message, integration-env-schema names, admin-incidents resolve guard, admin-auth-port CSRF, availability span guard.

Pre-existing flake fixed: `workers/ops-health` "accepts no parameters" compared wall-clock `oldestPendingAgeSeconds` across two reads.

## Product bugs / gaps found (not fixed)

1. `src/runtime-context.ts:202` — `loggerAlertSink(contextInput.logger)` gets `undefined` when no logger is configured, so fallback alerts are silently dropped (rest of context defaults to `console`).
2. `src/confirmation.ts:185-190` — split confirmation email row marked `succeeded` without sending when the current email provider lacks `sendToRecipient` (mutation path leaves it owed).
3. `handleOperatorNoShow` (`src/handlers/booking-actions.ts:371-383`) maps every error, incl. DB failures after the CAS, to 409 with the raw message.
4. `listLiveBookings` (`src/repo.ts:1995`) hides a hold at its exact expiry instant while capacity still counts it (fake mirrors it).
5. Stripe adapter recomputes the charge via `priceFor` while the webhook checks stored `priceMinor` (`packages/stripe/src/provider.ts:405`); suspected drift.
6. Coverage gaps: per-IP cap in `insertHoldWithCapacity` (no real-D1 test; D1 tests use unused `insertHold`); reschedule races on `rescheduleWithCapacity` (tests use dead `transitionReschedule`); webhook `409 payment_session_mismatch`; `cloudflareAccessAdminAuth`; custom `adminAuth` never bypassed in dev; operator partial-refund major→minor conversion (`src/routes/booking/manage.ts:130`); confirmation lease fencing on real D1; webhook no_show refund exclusion.
7. `docs/decisions.md` §3 still describes the checkout race as two 201s (now one 201 + one 409).

## Next batches (medium confidence, in ledgers)

- Retarget reschedule race tests to `rescheduleWithCapacity`, then drop `transitionReschedule` (public via `ReservaContext.repo` type → changeset).
- `tests/repo.test.ts` SQL-text pins → trigger-rollback cases in `workers/admin-history`.
- Copy-literal F repairs in `ui-manage-page`, `customer-page-routes`, `booking-widget-catalog`, admin e2e specs.
- `access.ts` test-only seams (`crypto`, `fetch`/`now`/`jwksTtlMs`, `clearAccessJwksCache`) → test through `cloudflareAccessAdminAuth` with stubbed fetch.
- `webhooks.ts` `fetchImpl` / `signWebhookPayload`, Stripe `sessionStatusFromStripe`/`stripeEventToParsed`, dead `maxNetworkRetries`/`now` options, `requestJson` `limitBytes`.


## Round 2 — bugs fixed and next batch (landed on main)

Final `bun run verify`: unit+component 1128/1128, workers 211/211; `test:pack` OK; Playwright 63/63.

Bugs fixed (each with regression test shown failing pre-fix, and a changeset):
- c243dde alerts: fallback sink logs to console when no logger configured.
- 448bf72 operator no-show: only invalid transitions map to 409; post-commit failures → 500 without leaking.
- 3ca9182 repo: listLiveBookings counts a hold at its exact expiry instant.
- d643a96 + 5042af2 confirmation: split email row unsendable by the provider is abandoned (operator log), not marked sent — and not left owed forever (review caught the re-fire loop).
- e88c59c repo: legacy repair never adds a combined email row beside split rows (duplicate customer email).
- a7d6f46 docs/decisions §3 marked resolved.
- Stripe price drift: not a bug (single request, same config); fixture corrected (1d2e85e).

Next batch commits: 5f17437 access, e192a5f repo/D1, 51880de webhook, 09df225 ui/e2e, 07c4e0a integration/manage/outbox.

## Still open
- Stripe adapter keeps a second price computation (`priceFor`) instead of charging `booking.priceMinor` — latent, hardening only.
- 403 copy says "Cloudflare Access authorization required" even with a custom adminAuth.
- `listAdminChangeHistory` is written but never read (product decision).
- Brevo `fetchImpl` alias retired elsewhere in v2 (public → changeset).
- Held: e2e meeting-points:21 vs maze:181, component instance-ids:21, ui-booking-widget scarcity-threshold grep, handlers-manage page-renderer tests → ui-manage-page.
- A never-attempted `pending` row raises no incident (only `failed` does after 10 min).
- admin-incidents.spec failed once in a combined partial run ("No available days found"); full run green.


## Round 3 (landed on main)

- b066b5a stripe charges stored priceMinor/currency; da59097 webhook/status/confirmation page use booking.currency.
- ab3e7a1 merged origin/main (admin lazy tabs, 1a98bcd/46ac4fe/e0f79b9).
- 93b2a14 admin Recent changes section (settings, ?section=history, 20 newest) + neutral 403 "Admin authorization required"; 9725d42 aria-current fix from review.
- aa08f5f / 8096b58 held items: meeting-points flow merged into Maze with real switch-back, scarcity grep → remaining=999 behavior, test moves, incident keys via production helper, e2e strictPort (root cause of admin-incidents flake: sibling worktrees sharing port 4399), expireBooking/resolveService/routes-manifest exports removed.
- f79b34f / 627b6d2 round-3 discovery batch (docs/tmp/test-audit/round3-discovery.md).
- Pending-row incidents: intentional (ops health reports pending debt; reconciliation.ts:135-138) — left.

Final: verify 1125 unit + 210 workers, test:pack OK, e2e 62/62.

## Remaining "Maybe" (round3-discovery.md)
- Test-only repo methods insertHold / upsertDayOverride / deleteDayOverride / upsertSetting (public repo type → changeset).
- catalogPayload export used by one test; remainingCapacity only test callers.
- ~30 admin/e2e copy assertions → catalog lookups; theme-token hex values copied from a run.
- Settings enhancer tests in ui-theme are source greps (behavior now partly in admin-settings e2e).
- Brevo fetchImpl alias (public).
- e2e strictPort: parallel e2e runs from different worktrees now fail at startup instead of cross-testing.

## Round 4 (landed)
- d67a61f / 6fc554e: remainingCapacity + catalogPayload export gone; generated webhook route executed in component project (source pin removed); dropReservaSchema shared; duplicates folded; moves.
- 73f6526: copy → catalogs across unit + e2e; enhancer greps replaced by e2e behavior; theme expectations derived.
- 39a5e3c: e2e reschedule helper searches next month (month-end failure on 29 Sep).
Final: verify 1119 + 208, e2e 66/66, pack OK. Review: no findings.
