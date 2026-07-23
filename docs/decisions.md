# Spec-level decisions

Bookkit's implementation is checked against a build contract spec external to this
repo. These entries record places where a spec review found the spec itself has a gap
or internal inconsistency that the implementation cannot resolve alone. Each states the
current behavior and a recommendation for the next spec revision, so it doesn't get
re-litigated.

## 1. `/status` has no `cancelled` state

**Context.** The spec's `GET /api/booking/status` response enum is
`pending | confirmed | expired | not_found`. There is no value for a booking that was
confirmed and then cancelled.

**Current behavior.** If a booking is confirmed and then cancelled before the customer's
confirmation-page poll reaches `handleStatus` (`src/handlers/index.ts`), the handler
falls through its status checks (only `confirmed` and `expired` are special-cased) to
the default `return json({ status: 'pending' })`. This is spec-compliant but misleading:
the customer's confirmation page reports "pending" for a booking that will never
confirm.

**Decision / recommendation.** Add `cancelled` to the `/status` response enum in the
next spec revision and have the handler return it for cancelled bookings. This is
additive for clients — anything already treating unknown values conservatively is
unaffected — and lets the confirmation page render an honest message instead of a
stuck "pending" state. Until the spec is revised, the current "pending" behavior stands
and is pinned by a test (work package 02, task 3).

**Revisit when.** The spec gets a next revision, or if support tickets show customers
are confused by a confirmation page stuck on "pending" for a booking that was actually
cancelled.

## 2. Customer-route wrong-state error code

**Context.** The spec names only `past_cutoff` as the error code for `/cancel` and
`/reschedule`. It has no code for the case where the booking token resolves to a row
that is neither `confirmed` nor already `cancelled` (e.g. a stray `hold` or `no_show`
row) — a state the cutoff check was never meant to describe.

**Current / prior behavior.** Before this refinement, a wrong-state booking on either
customer route fell through to the cutoff check, which returns false purely because of
the status, producing a misleading `403 past_cutoff` on `/cancel` and a misleading
`409 slot_unavailable` on `/reschedule`.

**Decision / recommendation.** Both customer routes now check status first and return
`409 invalid_transition` when the booking isn't `confirmed`, before applying the cutoff
check — matching the pattern the operator routes (`handleOperatorCancel`,
`handleOperatorNoShow`) already use. This is recorded as the adopted refinement: an
additive contract clarification, not a spec violation, that the next spec revision
should adopt by documenting `409 invalid_transition` alongside `past_cutoff` for these
two routes.

**Revisit when.** The spec is next revised — add `invalid_transition` to the documented
error codes for `/cancel` and `/reschedule`.

## 3. §11 checkout-race bullet contradicts §6's accepted TOCTOU

**Context.** The spec's §11 test matrix asks for "checkout race (two concurrent
checkouts for last slot → at most one hold, oversell path handled)". But §6
("Concurrency at checkout (accepted, not eliminated)") explicitly accepts the
check-then-act TOCTOU window: occupancy is recomputed in JS between the D1 read and
the hold insert, so two checkouts interleaving inside that window can both hold the
last slot. §6 sizes the risk (negligible at ~50 bookings/year, worst case a one-slot
oversell resolved by a phone call) and declines to eliminate it. The two sections
cannot both be satisfied.

**Current behavior.** The implementation follows §6, and
`tests/handlers-checkout-race.test.ts` pins it: two interleaved checkouts for the last
slot both receive `201` and both holds exist (the documented oversell window), while a
sequential second checkout is correctly rejected with `409 slot_unavailable`. Neither
the test nor the spec file is changed here — §6 is treated as normative because it is
the section that reasons about the trade-off, while the §11 bullet reads as a summary
that drifted from it.

**Decision / recommendation.** The next spec revision should reword the §11 bullet to
match §6 — e.g. "checkout race: two interleaved checkouts for the last slot may both
hold (the accepted §6 oversell, pinned by test); a sequential second checkout is
rejected `409 slot_unavailable`" — so the test matrix stops implying an atomicity
guarantee §6 explicitly declines to provide.

**Revisit when.** The spec is next revised, or if the accepted oversell occurs in
practice often enough to justify §6's optional recount-and-delete insurance, which
would make "at most one hold" the intended behavior after all.

## 4. Admin CSRF guard: rejecting `Sec-Fetch-Site: same-site`, and the token's key material

**Context.** BK-SEC-001 (audit finding, `docs/tmp/handoff-audit-fixes/09-admin-csrf.md`):
`handleAdminPost` previously gated only on Cloudflare Access (WHO), with no defense
against a cross-origin request riding an operator's live Access session. The spec calls
for two independent layers — Fetch-Metadata/Origin enforcement and a per-session CSRF
token — but leaves two judgment calls to the implementation.

**Decision 1 — `Sec-Fetch-Site: same-site` is rejected, not just `cross-site`.** The
Fetch Metadata spec treats `same-site` as a normally-trusted value (it covers
subdomains and sibling domains sharing a registrable domain). `src/admin-csrf.ts`
rejects it anyway: Cloudflare Access's own session cookie is commonly scoped to the
whole apex domain (by design, so a single login covers every Access-protected
application under it), so any same-site subdomain — including one an attacker
controls, e.g. a forgotten preview/staging host — can host a hostile auto-submitting
form and have the browser attach that cookie. "Same site" is therefore not this admin
surface's real trust boundary; only `same-origin` is.

**Decision 2 — the CSRF token's HMAC key material (revised).** Bookkit has no session
store to mint a per-session secret from (see "Why not Astro sessions?" below), and no
existing secret in `ClientConfig`/`SecretLookup` is purpose-fit for CSRF signing
(reaching into a specific `PaymentProvider` implementation for Stripe's secret/webhook
key would couple this to one provider and never surfaces on `BookkitContext` anyway;
reusing the optional Tourflow shared secret would mix unrelated trust domains for no
real gain). The first version of this decision keyed the token from
`config.admin.accessAud` alone whenever the optional `BOOKKIT_CSRF_SECRET` Worker
secret was unset, reasoning that accessAud is "never observable outside an
already-Access-authenticated session." **That reasoning was wrong and a subsequent
review of this handoff caught it (BK-SEC-001, P1 finding 1):** accessAud is the Access
application's Audience tag, which appears in the `aud` claim of every Access-issued
JWT — an attacker only needs to have completed an Access login once (or seen the value
in checked-in config) to read it, so a key derived from it alone is not secret and
the "signed" token was forgeable by anyone who could reach the admin route with a
valid Access session, i.e. it added no protection beyond layer 1 whenever
`BOOKKIT_CSRF_SECRET` wasn't set.

**Corrected decision.** `src/admin-csrf.ts`'s `csrfSecret` now returns a key only when
`BOOKKIT_CSRF_SECRET` is actually configured (still mixed with `config.admin.accessAud`
for cheap extra domain separation between deployments sharing one secret — that mixing
was never the problem, using accessAud *alone* as a fallback was). When the secret is
unset, `mintAdminCsrfToken`/`verifyAdminCsrfToken` take layer 2 offline entirely —
no token is minted, and verification is a no-op — rather than emit a token that only
looks signed. **`BOOKKIT_CSRF_SECRET` must be set (`wrangler secret put
BOOKKIT_CSRF_SECRET`, added to `secretBindings`) for layer 2 to actually run.** This
fail-open is acceptable, and does not reopen BK-SEC-001, only because layer 1
(Fetch-Metadata/Origin) is unconditional and independently stops the attack in every
modern browser with or without a configured secret — layer 1 itself never fails open.

**Revisit when.** Cloudflare documents a guarantee (or a way to opt into one) that
`Sec-Fetch-*` headers survive Access's proxy unmodified end to end — until then, layer 2
(the token) stays as the fallback for that unverified assumption.
