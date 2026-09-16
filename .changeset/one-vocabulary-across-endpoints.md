---
"@reservajs/astro": minor
"@reservajs/stripe": minor
---

One vocabulary across the endpoints: `serviceSlug`, `pickup`, `start` and `sessionId`.

Availability reads `?serviceSlug=`, status reads `?sessionId=`, the checkout body reads `pickup`
and the reschedule body reads `start`. The previous spellings (`?service=`, `?session_id=`,
`pickupType`, `newStart`) still read for one minor and log `deprecated field` once per isolate per
field; they are removed from the exported request types now. `ManageBooking.pickup` replaces
`ManageBooking.pickupType`, `CheckoutRequest.pickup` replaces `CheckoutRequest.pickupType`, and
`RescheduleRequest`/`CancelRequest` are exported for the first time. The Stripe adapter's default
success URL emits `sessionId={CHECKOUT_SESSION_ID}`. The webhook envelope's booking keeps
`pickupType`, which stays frozen for this release line.
