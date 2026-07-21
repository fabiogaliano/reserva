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
