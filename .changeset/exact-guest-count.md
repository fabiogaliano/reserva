---
"@reservajs/astro": minor
"@reservajs/stripe": minor
---

Exact guest count for "up to N" services.

**Run `bunx reserva-migrate` after upgrading.** Migration `0006_guest_count.sql` adds a `guest_count` column to bookings.

- Set `collectGuestCount: true` on a service to ask the payer how many people are coming. The field is optional and never blocks payment.
- The answer is stored as `booking.guestCount`. Price and capacity still follow `quantity`.
- `@reservajs/stripe` adds it as an optional numeric field on Stripe Checkout. Change its label with `guestCountFieldLabel`.
