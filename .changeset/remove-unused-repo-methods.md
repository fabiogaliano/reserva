---
'@reservajs/astro': patch
---

The booking repository on `ReservaContext.repo` no longer has `transitionReschedule` or `upsertRefundOperation`, two methods Reserva itself stopped calling; reschedules go through `rescheduleWithCapacity` and Stripe refund updates through `reconcileStripeRefundOperation`.
