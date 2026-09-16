---
"@reservajs/astro": patch
---

Customer pages and emails: nine fixes.

- Manage and confirmation facts show the booking as `start – end`, not just the start.
- The manage page offers the same Google/ICS calendar buttons as the confirmation page for a
  confirmed booking.
- The manage error map covers every code an action can bounce back with: `refund_failed` now says
  the booking IS cancelled and the refund is being handled manually, `refund_conflict` and
  `forbidden` get their own copy, and the transient codes share "try again in a minute".
- The invalid-link page drops its token entry form (the token lives in the customer's inbox, it is
  not something to retype) and renders the shared contact block, as does the past-cutoff notice.
- `formatLocaleFor` moved to `src/core/locale.ts` and now applies to the server-rendered pages too,
  so a bare `en` reads "15 Oct" there exactly as it already did in email. The manage enhancer takes
  its calendar locale from the page instead of defaulting to `pt-PT`.
- Confirmation and reschedule mail names the service, the price paid, the reference and the free
  cancellation deadline in the card, and attaches `booking.ics` (also on the reminder).
- `RenderedEmail.attachments` is part of the renderer seam; the Brevo adapter maps it to
  `attachment: [{ name, content }]`.
- WhatsApp in email is a `wa.me` link rather than a phone number in text.
- `payment.dispute_created` now sends owner-only mail with the amount, the reference and a link to
  the admin dashboard.
