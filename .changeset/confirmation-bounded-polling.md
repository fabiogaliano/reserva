---
"@reservajs/astro": patch
---

The confirmation page no longer polls forever, and a rejected payment says so.

- `StatusState` gains `'failed'`: a completed session whose payment is not acceptable now returns
  `{ status: 'failed', booking: null }` instead of polling on as `pending`, and opens a
  `payment_verification_rejected` operational incident on the admin dashboard (new migration
  `0002_payment_verification_incidents.sql`).
- The confirmation page refreshes at most 20 times (~60 s) via an `attempt` query parameter, then
  shows a "still waiting" page with contact details and a "Check again" link.
- New shared contact block (email, phone, WhatsApp) on the confirmation pending-timeout, failed and
  expired pages and on the manage past-cutoff and invalid-link pages.
