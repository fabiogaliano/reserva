---
"@reservajs/astro": minor
"@reservajs/stripe": minor
---

Partial refunds. `refund` on the operator cancel request accepts `partial` alongside `none` and `full`, with `refundAmountMinor` (at least 1, below the booking price) naming the amount. Migration `0004_partial_refunds.sql` widens the `refund_operations.choice` CHECK and adds `requested_amount_cents`, so a reconciler retry replays the decided amount rather than the booking price; two `partial` requests for different amounts are different decisions and the loser gets `409 refund_conflict`. Still one refund per booking, decided at cancellation.

The Stripe adapter now sends `amount` explicitly on every refund instead of relying on Stripe's refund-the-remainder default. A refund that is mid-retry across the upgrade presents the same idempotency key with different parameters and fails until the key ages out (~24h), then succeeds on a fresh attempt — visible as a refund incident, never a double refund.

Message keys `manage.refundPartial`, `manage.refundAmount`, `manage.refundAmountHint` added. Email copy `refund.timing` reworded to make no claim about how much is returned.
