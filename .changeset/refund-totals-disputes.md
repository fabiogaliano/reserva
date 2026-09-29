---
"@reservajs/astro": minor
"@reservajs/stripe": minor
---

Refund totals and dispute outcomes on every booking.

**Run `bunx reserva-migrate` after upgrading.** Migration `0007_refunds_disputes.sql` adds `amount_refunded_minor`, `disputed_at` and `dispute_status` to bookings, filled from the refunds and disputes already on record (an earlier dispute starts as `open`, since its outcome was never stored). Earlier releases kept a dispute only as the notification it triggered, so one that arrived while no owner email or durable hook was set up for `payment.dispute_created` left nothing to carry over.

**Add `charge.dispute.closed` to your Stripe webhook endpoint.** Without it nothing breaks, but disputes stay `open`.

- `booking.amountRefundedMinor` is the running total of refunds sent on the payment, partial or full, from Reserva or the Stripe dashboard. A partial refund made in the dashboard used to be logged and dropped; it is now recorded and still leaves the booking confirmed. A full refund cancels the booking as before. Events arriving out of order never lower the total.
- `booking.disputedAt` and `booking.disputeStatus` (`'open' | 'won' | 'lost'`, `null` when never disputed) record chargebacks and bank inquiries. Closing a dispute sends no email and leaves the booking as it is. When a payment is disputed a second time, the booking reopens as `open` with the later dispute's date and then takes its outcome.
- `PAYMENT_EVENTS` gains `dispute_closed`, and `PaymentEventParsed` gains `disputeOutcome` and `disputeCreatedAt`, the processor's own opening time, which dates the dispute whatever order its events arrive in. `DisputeStatus` and `DisputeOutcome` are exported from `@reservajs/astro/core`. A payment adapter reports `amountRefunded` as the payment's cumulative total.
- `@reservajs/stripe` maps `charge.dispute.closed`: `won` and `warning_closed` (an inquiry closed without a chargeback) are won; `lost` and `prevented` (settled by refunding the cardholder) are lost. Any other status leaves the dispute open. Both dispute events carry the Stripe dispute's `created` time.
