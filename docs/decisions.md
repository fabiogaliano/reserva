# Decisions

Reserva was built against an external spec. These are the places where the spec had a gap or
contradicted itself, what Reserva does instead, and what the next spec revision should say.

## 1. `/status` has a `cancelled` state

The spec's `GET /api/booking/status` returned `pending | confirmed | expired | not_found`, with
nothing for a booking that was confirmed and later cancelled. Such a booking used to read as
`pending`, which matched the spec but was misleading.

Reserva returns `cancelled` for cancelled and no-show bookings (`handleStatus` in
`src/handlers/status-manage.ts`), so the confirmation page stops polling and says what happened.
`pending` still means a hold, or a completed session whose payment can't be verified yet.
Clients should treat unknown states cautiously.

**Next revision:** add `cancelled` to the enum.

## 2. Wrong-state bookings on `/cancel` and `/reschedule`

The spec only gives `past_cutoff` for these routes. A token that points at a booking that isn't
`confirmed` (a leftover hold, a no-show) used to fall through to the cutoff check, which
answered `403 past_cutoff` on cancel and `409 slot_unavailable` on reschedule. Neither was true.

Both routes now check the status first and answer `409 invalid_transition`, the same as the
operator routes.

**Next revision:** list `invalid_transition` next to `past_cutoff` for both routes.

## 3. The checkout race (resolved)

The spec's test matrix (§11) asks that two concurrent checkouts for the last slot produce at
most one hold. Its concurrency section (§6) accepted a check-then-act gap that allowed exactly
that, sizing the risk as negligible at about 50 bookings a year: at worst a one-slot oversell,
fixed with a phone call.

Checkout now checks capacity inside the same D1 `INSERT` that writes the hold
(`insertHoldWithCapacity`), so the gap is gone. `tests/handlers-checkout-race.test.ts` and
`tests/workers/capacity-allocation.test.ts` pin it: one `201`, one `409 slot_unavailable`, one
hold.

**Next revision:** keep §11 and drop the accepted gap from §6.

## 4. Admin CSRF: refusing `same-site`, and the token's key

The spec asks for two layers on admin forms, a Fetch-Metadata/Origin check and a CSRF token, and
leaves two choices open.

**`Sec-Fetch-Site: same-site` is refused**, not just `cross-site`. The Fetch Metadata spec
usually trusts `same-site`, but Cloudflare Access often scopes its cookie to the whole domain so
one login covers every app. Any subdomain, including a forgotten staging host an attacker
controls, could then post a form that the browser sends with that cookie. Only `same-origin` is
a real boundary here (`src/admin-csrf.ts`).

**The token is signed only with `RESERVA_CSRF_SECRET`.** Reserva has no session store, and no
other secret fits: borrowing the payment provider's key would tie CSRF to one adapter. An
earlier version fell back to the Access audience tag (`aud`) when the secret was unset. That was
wrong: `aud` appears in every Access JWT, so anyone who has signed in once can read it and forge
the token. Now, without `RESERVA_CSRF_SECRET`, no token is issued or checked at all, rather than
one that only looks signed. The secret is still mixed with `aud`, which keeps deployments that
share a secret apart. The origin check always runs and stops the attack in every modern browser
on its own, which is why the token layer can be optional.

**Revisit when** Cloudflare guarantees that `Sec-Fetch-*` headers pass through Access unchanged.
Until then the token stays as a backstop.
