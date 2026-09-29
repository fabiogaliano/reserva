# Lane admin-auth — read-only ledger

Scope: tests/handlers-admin.test.ts, tests/handlers-admin-incidents.test.ts,
tests/handlers-refunds-disputes.test.ts, tests/admin-access.test.ts, tests/admin-csrf.test.ts,
tests/access-verifier.test.ts, tests/runtime-context-admin-auth.test.ts.
Owners read: src/handlers/admin.ts, src/handlers/shared.ts, src/admin-access.ts, src/admin-csrf.ts,
src/access.ts, src/runtime-context.ts (resolveAdminAuth), src/handlers/webhook.ts (refund/dispute
branches), src/repo.ts (recordRefundedAmount / markDisputed / closeDispute / listAdminChangeHistory),
tests/fakes.ts (history + dispute fakes).
Overlap read: tests/workers/admin-auth-port, admin-history, capacity-overrides, refund-operations,
repo-d1 (money describe), ops-health; tests/http-body-limits; tests/routes-manage-group;
tests/route-customization; tests/workers/smoke-runtime; packages/stripe/tests/provider.test.ts;
tests/e2e/admin*.spec.ts. No admin page snapshot suite exists, so handlers-admin's markup
assertions are the only record of the admin page and stay.

Marks: R retain, F repair, C consolidate, D delete.

## tests/handlers-admin.test.ts (88 it, 12 describe)

| Line | Mark | Evidence |
|---|---|---|
| 67 describe body size | R | container |
| 68 413 over 256 KB | R | Wiring pin (audit #10): admin POST reads body via requestFormData before CSRF; helper itself owned by http-body-limits.test.ts:67, this proves the admin route uses it. |
| 84 describe access control | R | container |
| 85 absent/null/throws → 403 GET+POST | R | Keeper for fail-closed admin auth at the handler boundary (retention bar: admin auth). Absorbs admin-access.test.ts:24/29/34. |
| 108 describe listing | R | container |
| 111 active/all/past windows + sweep | F | Contract R (Active vs All window, counts, expired hold swept). Repair: line 133 depends on this being the first sweeping GET in the file — sweepExpiredHoldsThrottled keeps a module-level 60 s throttle and every test uses the same fixed clock, so reordering silently breaks it. Advance the clock or assert without relying on throttle state. |
| 153 Upcoming starts at business midnight | R | Handler-owned todayStart in business tz; catches using `now` or UTC midnight. |
| 171 paging asc/desc, clamp, prev/next | R | Handler page size/clamp/link contract; D1 ordering separately at capacity-overrides:288. |
| 209 list state carried through links, saved= dropped | R | Link-builder contract; catches one-shot notice leak. |
| 227 pt-PT filter labels vs badges, empty state | R | Admin-locale wiring of distinct filter keys. |
| 243 cancelled by status, past via window, no manage link on terminal | R | Terminal rows no manage link; search scoped to window. |
| 265 search beyond first chunk | R | Regression pin for chunked search walk. |
| 282 scan cap notice | R | Cap + truthful count copy. |
| 301 tab strip vs topbar | R | No-JS tab markup contract (enhancer keys off it). |
| 318 panel implied by URL | R | date/saved/bogus tab → correct panel. |
| 333 operator locale ≠ customer default | R | admin.locale wiring. |
| 357 manage links carry operator token, never cancel token | R | Security: token leakage. |
| 377 nohash token → no dead href | R | Regression pin (dead 403 link). |
| 395 cache-control/referrer-policy | R | Header contract (referrer same-origin needed for Origin on POST). |
| 402 CSP default/custom/off, no inline script/style | R | CSP contract. |
| 422 day cell in capacity units | R | Units vs booking count (catches raw-row count). |
| 446 day peak of concurrent units | R | Peak vs sum; cancelled excluded (fake filters, D1 filter at capacity-overrides:160). |
| 468 exact guest count label ignores widget copy | R | Admin copy independence. |
| 489 calendar independent of list filters | R | Calendar query decoupled from list. |
| 498 four months + pager | R | Recent perf change (d4cd131/bb1314a) contract. |
| 525 filters keep Upcoming with selected day | R | Tab inference regression. |
| 540 describe meeting-point | R | container |
| 547 sub-line multi vs single point | R | Rendering rule. |
| 575 search by meeting-point label | R | Search/render parity. |
| 592 describe pickup option | R | container |
| 615 declared option label | R | |
| 634 default/custom named from declared labels | R | No magic-id copy. |
| 656 raw id fallback, address withheld | R | Stale option handling; privacy of address. |
| 681 search can't match hidden meeting point | R | Haystack/renderer parity. |
| 717 describe fields/refunds/disputes | R | container |
| 743 opted-in tags, admin locale, declaration order | R | |
| 758 stale value as raw | R | |
| 765 every field listed incl. terminal rows | R | Escaping + terminal rows. |
| 784 refund/dispute badges order + facts | R | Only render proof of money badges. |
| 820 money in booking's own currency | R | Regression pin (ebccc8f). |
| 828 money badges in admin locale | R | pt-PT number/copy wiring. |
| 849 day panel badges = island | R | Server/island parity for enhancer. |
| 874 search by select label and code | R | |
| 891 describe tag overview | R | container |
| 912 options with link and counts | R | |
| 942 shared tab name, empty link column | R | |
| 950 no tab without tagged field | R | |
| 958 describe day overrides | R | container |
| 959 set: trimmed reason, 303 location | R | Form parse + redirect. |
| 972 close: dedupe/sort/one call | R | Batching contract. |
| 988 toDate range for set/clear | R | Range expansion; also covers clear → single deleteDayOverrides call. |
| 1002 toDate < date rejected | R | |
| 1010 blank capacity rejected | R | Regression pin (Number('') = 0 closed the day). |
| 1033 form required/formnovalidate | R | |
| 1043 blank reason → null | R | Distinct whitespace branch. |
| 1054 clear → deleteDayOverrides one call | C | Same call shape asserted by 988 (clear half) and 1476/1524 (`calls` = ['2026-06-20'] after clear, 303). |
| 1065 unknown action | R | |
| 1071 invalid date | R | |
| 1077 page state kept, alert rendered, crafted field not echoed | R | XSS-ish echo guard + csrf_expired copy in pt-PT. |
| 1105 describe settings | R | container |
| 1110 settings page render + overridden marker | R | |
| 1131 capacity.default save/reset/validate | R | |
| 1156 holdMinutes min/max attrs | R | |
| 1165 single-field reset + saved notice | R | |
| 1182 save stores only diffs, deletes equal | R | Resting-state contract. |
| 1209 hours tab render + save + validation | R | |
| 1261 unordered config days = no override | R | |
| 1277 pricing tab major→minor units | R | |
| 1320 section reset | R | |
| 1334 invalid value / unknown section | R | |
| 1347 reset runs merged validation | R | |
| 1366 hidden Save first submit | R | Enter-key regression. |
| 1402 holdMinutes=0 rejected | R | Regression pin (Stripe hold outlives D1 hold). |
| 1419 SettingsMergeError field attribution | R | |
| 1435 applySettingsBatch failure → internal_error + logged | R | |
| 1449 describe origin + CSRF | R | container |
| 1450 cross-origin 403, no mutation | R | Keeper for origin-guard wiring at handler. |
| 1462 same-site 403 | C | Per-feature replay of adminOriginAllowed; decision-4 pin owned by admin-csrf.test.ts:42; wiring proven by 1450 + 1573. |
| 1470 neither header 403 | C | Replay of admin-csrf.test.ts:69; wiring by 1450. |
| 1476 same-origin w/o Origin accepted | R | Positive control for the no-mutation negatives. |
| 1497 missing token → csrf_expired | R | Handler reads `csrf_token` field. |
| 1504 expired token → csrf_expired + page copy | R | Handler passes context clock. |
| 1516 foreign subject → csrf_expired | R | Handler binds access.subject. |
| 1524 rendered dashboard token accepted | R | Mint/verify round trip through handler. |
| 1538 rendered settings token accepted | R | Distinct mint path (settingsPage). |
| 1573 it.each every action cross-origin 403 | R | Guard-before-dispatch for every action. |
| 1583 no-store on success 303 | R | Only success-path no-store proof. |
| 1592 no-store on origin 403 | C | Same runAdminPost catch path as 1608 (no-store on Access 403); fold `cache-control` assertion into 1450 if wanted. |
| 1601 no-store on validation failure | D | Byte-identical request/assertions to 1065 (adminErrorOf already asserts no-store). |
| 1608 Access 403 stays plain 403 + no-store | R | |
| 1619 describe no secret | R | container |
| 1620 same-origin POST passes without token | R | Decision 4 fail-open of layer 2 at handler. |
| 1633 cross-origin still 403 without secret | R | Decision 4: layer 1 never fails open. |
| 1646 form renders empty token field | R | No-throw render. |
| 1658 describe change history | R | container |
| 1659 settings-save actor = subject | R | Handler actor threading. |
| 1680 '' subject → actor null | R | Handler normalization (repo null storage at admin-history:55). |
| 1695 close range → one history row per date | C | Per-date expansion is implemented by the fake (fakes.ts:767) and proven on D1 by capacity-overrides:126; handler's date expansion by 988/972, actor threading by 1659; `audit` is a required TS param. |
| 1713 default-set one history row | R | Only handler proof that default-set forwards capacity+reason. |
| 1725 listAdminChangeHistory most-recent-first | D | Asserts only the fake's `[...].reverse()` (fakes.ts:816). Real proof: workers/admin-history.test.ts:65. |

## tests/handlers-admin-incidents.test.ts (10 it, 1 describe)

| Line | Mark | Evidence |
|---|---|---|
| 54 describe | R | container |
| 55 no section before activity | R | |
| 74 open card title, never "abandoned" | R | Owner-facing wording contract. |
| 95 oversell no Retry + forged retry told unavailable | R | Server-side refusal (e2e covers only the missing button). |
| 122 side_effect retry dispatch → resolved | R | |
| 150 refund retry via claimRefundExecutionForRetry | R | Only handler proof of refund retry dispatch. |
| 182 resolve note 1–500, who/when, row untouched | R | "Never falsify" invariant. |
| 211 unknown/resolved incident rejected | F | Name promises incident-retry AND incident-resolve; only retry is exercised. Add a resolve row. |
| 219 hide Retry for payment_verification/reconciliation | R | |
| 242 badge counts all, list truncated | R | |
| 259 incident actions behind origin/CSRF guards | R | Incident actions absent from handlers-admin:1573 table; tab=attention on csrf_expired. |

## tests/handlers-refunds-disputes.test.ts (14 it, 2 describe)

The merge rules (MAX total, dispute date/outcome ordering) live in repo SQL (src/repo.ts:1716-1741);
the fake mirrors them (fakes.ts:525-544). Real-D1 owner: tests/workers/repo-d1.test.ts money
describe (392, 404, 415, 440). Handler-owned: which method, fromProvider flag from
disputeCreatedAt, full-refund cancel, emails/hooks/warnings.

| Line | Mark | Evidence |
|---|---|---|
| 56 describe refunds | R | container |
| 62 partial = running total, stays confirmed, no op row | R | Handler branch (no cancel, no refund op). |
| 75 never lowers total on out-of-order | C | Ordering is SQL MAX, faked at fakes.ts:527; D1 owner repo-d1:392. Handler only forwards amountRefunded. |
| 83 full total cancels, late partial ignored | R | Handler cancel threshold + no revival. |
| 98 foreign payment ignored | R | |
| 106 describe disputes | R | container |
| 114 open then outcome, owner email + hook | R | Handler dispatch + notifications. |
| 126 close before open keeps outcome, late creation still mails | R | Email-on-late-creation is handler-owned. |
| 138 inquiry closed without chargeback = won | D | Input is already `disputeOutcome: 'won'`; no inquiry is exercised (name overpromises). Same steps as 114. Mapping owner: packages/stripe/tests/provider.test.ts:756 (warning_closed → won). |
| 146 last close wins without creation time | C | Pure SQL/fake ordering; D1 owner repo-d1:415 (lines 425-427) + closeDispute unconditional status. |
| 161 dated from provider creation time | R | Handler passes disputeCreatedAt + fromProvider=true. |
| 171 reopen won on later dispute, second email | R | Second owner email per dispute is handler-owned. |
| 190 later dispute close-before-open keeps outcome | C | D1 owner repo-d1:433-436 (close then mark with provider time). |
| 202 close for unknown booking warns | R | Handler warning branch. |
| 210 close without outcome → open + warn | R | Handler branch. |
| 218 close sends no email/event/outbox | R | Side-effect-free close. |

## tests/admin-access.test.ts (6 it, 1 describe)

| Line | Mark | Evidence |
|---|---|---|
| 23 describe | C | Whole file is absorbed; header comment itself says handlers-admin covers absent/null/throws. |
| 24 absent → null | C | handlers-admin:85 (absent variant, GET+POST 403). |
| 29 resolves null → null | C | handlers-admin:85 + 1608. |
| 34 throws → null | C | handlers-admin:85 (throws variant). |
| 39 identity passthrough | C | Medium: incidents:182 asserts resolvedBy = the Access subject; handlers-admin:1659 actor = subject; 1516 token bound to subject. |
| 44 empty-subject passthrough | C | Medium: every handlers-admin POST uses subject '' with a sub-'' token. |
| 49 adminAuth gets request + context | C | Medium: workers/admin-auth-port headerTokenAdminAuth reads context.secrets — 136/150 fail if context isn't passed. |

Gap (not a deletion reason): nothing tests adminDevBypassActive's "custom adminAuth is never
bypassed" rule or the once-per-isolate warning; only workers/smoke-runtime:121 covers the positive
dev bypass. Repurposing this file for that is the natural follow-up if 39-49 are dropped.

## tests/admin-csrf.test.ts (22 it, 3 describe)

| Line | Mark | Evidence |
|---|---|---|
| 33 describe layer 1 | R | Keeper truth table for adminOriginAllowed. |
| 34 same-origin | R | |
| 38 cross-site | R | |
| 42 same-site rejected | R | Decision 4 pin. |
| 46 none rejected | R | |
| 50 Origin ignored when Sec-Fetch-Site present | R | |
| 57 Origin fallback match | R | |
| 61 Origin fallback foreign | R | |
| 65 malformed Origin | R | |
| 69 neither header | R | |
| 74 describe layer 2 | R | container |
| 75 fresh token verifies | R | |
| 81 empty subject verifies | C | Low value dup: every handlers-admin POST verifies a sub-'' token. |
| 85 expiry boundary ±1 ms | R | |
| 91 foreign subject | R | |
| 96 different secret | R | |
| 102 different aud | R | Domain separation. |
| 111 custom vs Access key | R | |
| 118 tampered payload | R | |
| 125 garbage without throwing | R | |
| 136 unforgeable from aud alone | R | Regression pin for the decision-4 revision. |
| 142 describe no secret | R | container |
| 145 mint → undefined | R | |
| 149 verify passes unconditionally | R | Decision 4 fail-open contract. |
| 156 secret-era token accepted without secret | C | Already implied by 149 (garbage + foreign subject accepted). |

## tests/access-verifier.test.ts (5 it, 1 describe)

| Line | Mark | Evidence |
|---|---|---|
| 65 describe | R | container |
| 68 RS256 + audience array | R | |
| 79 JWKS cache TTL | R | |
| 93 missing assertion → 403 error | R | |
| 100 it.each iss/aud/exp/missing exp/nbf | R | Each row's other checks pass for the fixture, so the rejection reason is the intended one. |
| 114 tampered signature | R | |

Gap: cloudflareAccessAdminAuth (public via src/runtime.ts:21) has no test at all — email-over-sub
subject choice and the identity-less assertion → null + warn guard (CSRF subject collapse) are unguarded.

## tests/runtime-context-admin-auth.test.ts (7 it, 1 describe)

| Line | Mark | Evidence |
|---|---|---|
| 37 describe | R | container |
| 38 neither path → throws naming both | R | |
| 45 both → throws "remove" | R | |
| 50 access alone accepted | R | (weak: asserts config only, not that the Access verifier is wired) |
| 55 custom alone accepted | C | Medium: workers/admin-auth-port builds the real runtime with custom adminAuth + no access (109) and drives the surface. |
| 60 both groups off → no throw | R | |
| 65 ops only → throws | R | |
| 70 admin only → throws | R | |

## Counts

it-level: 152 total — R 130, F 2, C 17, D 3. Describes: 21 (20 R, admin-access describe C).

## Layer plan

The fake-repo replay layer in this lane is narrow. Most of handlers-admin is handler/renderer-owned
(form parsing, redirects, markup, locale, link building) with no stronger boundary: there is no
admin snapshot suite and the workers suites only smoke the admin surface. The redundant layers
are:

1. **Change history via the fake** (handlers-admin 1695, 1725): the fake implements per-date rows
   and ordering. Keeper for persistence and ordering: workers/admin-history.test.ts plus
   capacity-overrides:126. Keeper for handler actor threading: handlers-admin 1659/1680/1713.
2. **Refund/dispute merge ordering via the fake** (refunds-disputes 75, 146, 190): keeper is
   workers/repo-d1 money describe. handlers-refunds-disputes keeps only handler dispatch
   (cancel threshold, fromProvider, emails, hooks, warnings).
3. **Shared-guard replays** (handlers-admin 1462, 1470; admin-access 24/29/34): keeper for the
   origin truth table is admin-csrf.test.ts layer 1. For access fail-closed at the boundary it is
   handlers-admin:85, with workers/admin-auth-port for the real runtime.

Keeper per contract:
- Admin auth fail-closed: handlers-admin:85, 1608; workers/admin-auth-port; workers/ops-health:117.
- Origin guard: admin-csrf layer 1 (truth table); handlers-admin 1450 + 1573 + incidents 259 (wiring).
- CSRF token: admin-csrf layer 2 (crypto); handlers-admin 1497/1504/1516/1524/1538 (wiring);
  workers/admin-auth-port:150 (real runtime).
- Layer-2 fail-open without secret: admin-csrf no-secret describe + handlers-admin 1619 describe.
- Access JWT: access-verifier (see seams: better retargeted at the public cloudflareAccessAdminAuth).
- One admin-auth path: runtime-context-admin-auth.
- Day overrides: handlers-admin 959-1077 (form), capacity-overrides (D1), e2e admin.spec:26.
- Incidents: handlers-admin-incidents + e2e admin-incidents.spec.

Assertions to carry: optionally add `cache-control: no-store` to handlers-admin:1450 when dropping
1592. If refunds 75/146/190 go, nothing needs carrying (repo-d1 already asserts each ordering).

### Test-only production seams (none public: not re-exported by src/index.ts, src/core/index.ts,
src/runtime.ts [exports only cloudflareAccessAdminAuth + AdminIdentity type from access.ts],
src/client, src/email, src/ui/index.ts, src/dev, providers, packages/stripe)

- `ADMIN_CSRF_TOKEN_TTL_MS` (src/admin-csrf.ts:19-21): alias of the private TTL, and its comment
  says it exists for tests. Users: admin-csrf.test.ts:85-88,137 and handlers-admin.test.ts:1508.
  Unlock: tests use `60 * 60_000` from the spec'd 1 h, which pins the value better.
- `verifyAccessJwt` options `crypto` (src/access.ts:19, 100): no caller passes it, tests included.
  Dead code.
- `configOf` `{ admin: AccessAdminConfig }` union branch (src/access.ts:41, 85 signature): no
  caller passes that shape, since cloudflareAccessAdminAuth and the tests both pass the flat shape.
  Dead code.
- `AccessVerificationError.code = 'access_unauthorized'` (src/access.ts:26): read nowhere.
  `.status` is read only by access-verifier:96. Production catches the error and returns null.
- `clearAccessJwksCache` (src/access.ts:84): test-only (access-verifier beforeEach). Unlock needs
  a distinct teamDomain per fixture.
- `verifyAccessJwt` `fetch` / `now` / `jwksTtlMs` options: test-only injection, because
  cloudflareAccessAdminAuth calls with no options. Retargeting access-verifier at the public
  `cloudflareAccessAdminAuth` with `vi.stubGlobal('fetch')` + fake timers would drop the seam and
  close the identity-rule gap. This is a larger rewrite, so it is listed and not batched.
- `BookingRepository.listAdminChangeHistory` (src/repo.ts:553, 2137): no production caller. But
  `ReservaContext.repo: BookingRepository` is on the public `ReservaContext` type (src/runtime.ts),
  so removing it is a public-type change that needs a changeset. Not unlocked by this lane.

## High-confidence batch

1. **handlers-admin.test.ts:1601** "sets Cache-Control: no-store on an admin POST that fails validation" — D
   - Detects: validation-error POST missing no-store or not redirecting. Same request and
     assertions as 1065, because `adminErrorOf` asserts 303 + no-store + no saved=.
   - Non-test callers: runAdminPost/adminErrorRedirect (handleAdminPost) stay.
   - Remaining proof: handlers-admin:1065, plus every `adminErrorOf` call (1002, 1010, 1077, 1131 …).
   - History: added with runAdminPost no-store fix, then rewritten to adminErrorOf when errors
     became redirects, which made it identical to 1065.
   - Unlocks: nothing in production.
   - Risk: none. `bun run test tests/handlers-admin.test.ts`.
2. **handlers-admin.test.ts:1725** "listAdminChangeHistory (via the repo) returns rows most-recent-first" — D
   - Detects: only a change to the fake's `.reverse()` (fakes.ts:816). The handler never reads history.
   - Non-test callers of listAdminChangeHistory: none (see seams).
   - Remaining proof: workers/admin-history.test.ts:65 (ORDER BY id DESC, limit, on real D1).
   - History: e8f4f15 "fake parity" when history landed.
   - Unlocks: nothing now. It narrows fake-parity users of listAdminChangeHistory.
   - Risk: none. `bun run test tests/handlers-admin.test.ts`; `bun run test:workers tests/workers/admin-history.test.ts`.
3. **handlers-admin.test.ts:1695** "a day-range close action records one day_override/upsert history row per date" — C
   - Detects: the fake's per-date loop (fakes.ts:767-772). Handler range expansion and actor threading are proven elsewhere.
   - Remaining proof: capacity-overrides:126 (D1 per-date rows, atomic); handlers-admin:988 (range → dates), 972 (close + reason), 1659 (actor = subject); `audit` is a required TS param.
   - History: e8f4f15.
   - Risk: low. `bun run test tests/handlers-admin.test.ts`; `bun run test:workers tests/workers/capacity-overrides.test.ts`.
4. **handlers-admin.test.ts:1054** "action=clear calls deleteDayOverrides with the full date array in one call" — C
   - Remaining proof: 988 (clear → one deleteDayOverrides call with the full array), 1476/1524 (single-date clear), e2e admin.spec:26.
   - Risk: none. `bun run test tests/handlers-admin.test.ts`.
5. **handlers-admin.test.ts:1462, 1470** same-site / no-header 403 — C
   - Detects: adminOriginAllowed returning true for same-site or header-less requests. The handler only calls the boolean.
   - Remaining proof: admin-csrf.test.ts:42 (decision-4 pin), :69; handler wiring by 1450 (+no mutation) and the 1573 it.each.
   - History: 46db3ae security fix added both layers' tests at both levels.
   - Risk: low. Retention-bar area (CSRF), but the unit pins the exact behavior. `bun run test tests/admin-csrf.test.ts tests/handlers-admin.test.ts`.
6. **handlers-admin.test.ts:1592** no-store on cross-origin 403 — C
   - Same runAdminPost catch path as 1608, which asserts no-store on a thrown 403. Optionally add the header assertion to 1450.
   - Risk: low. `bun run test tests/handlers-admin.test.ts`.
7. **admin-access.test.ts:24, 29, 34** absent / null / throws → null — C
   - Detects: accessAllowed failing open. Non-test callers: handleAdminGet/Post, handleOpsHealth, ops-reconcile.
   - Remaining proof: handlers-admin:85 (all three variants, GET + POST → 403), 1608; workers/ops-health:117; workers/admin-auth-port:114. The file's own header says handlers-admin covers these.
   - History: d146656 adminAuth port migration.
   - Unlocks: nothing (accessAllowed has production callers).
   - Risk: low. `bun run test tests/admin-access.test.ts tests/handlers-admin.test.ts`.
8. **handlers-refunds-disputes.test.ts:138** "counts an inquiry closed without a chargeback as won" — D
   - Detects: nothing beyond 114. The input is already a parsed `disputeOutcome: 'won'`, so no inquiry is exercised and the name overpromises.
   - Remaining proof: packages/stripe/tests/provider.test.ts:756 (`warning_closed` → won, the actual mapping); handlers-refunds-disputes:114 (open → won close).
   - History: a897ddc.
   - Risk: none. `bun run test tests/handlers-refunds-disputes.test.ts`; stripe: `bun run test packages/stripe/tests/provider.test.ts`.

Medium (ledger C, not batched): refunds 75/146/190; admin-access 39/44/49; admin-csrf 81/156;
runtime-context-admin-auth 55.

## Suspected product issues

- No bug confirmed.
- Coverage gap with real risk: `cloudflareAccessAdminAuth` (src/access.ts:113) is untested — the
  identity-less assertion → null guard prevents every admin sharing one CSRF subject.
- Coverage gap: the custom-adminAuth-never-bypassed half of `adminDevBypassActive` is untested.
- Nit: the 403 message "Cloudflare Access authorization required" (src/handlers/admin.ts:250, 468)
  is also served on custom-adminAuth deployments.
- Test fragility (not product): handlers-admin:133 depends on the module-level sweep throttle (see F).
