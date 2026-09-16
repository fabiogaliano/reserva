---
"@reservajs/astro": patch
---

Admin dashboard usability fixes.

- Booking rows link the customer's contact details: `mailto:` for the email, `tel:` for the phone
  (digits only, keeping a written `+`), and a `wa.me` link when the stored number is E.164. The
  helpers (`emailLink`, `phoneLinks`, `telHref`, `whatsappDigits`) live in `src/ui/layout.ts`
  alongside `contactBlock`, which now shares them.
- Search also matches the customer phone (compared digit by digit, so `+351 912 345 678` and
  `912345678` find the same booking) and every `metadata` value.
- The status filter offers `expired`, so a hold nobody paid is reachable without knowing its
  reference.
- Retrying an incident reports what happened: `reprojectIncidentAfterAdminRetry` returns
  `resolved | still_open | not_retryable` and the dashboard renders `admin.incidentResolved`,
  `admin.incidentRetryFailed` or `admin.incidentRetryNotAvailable`. The message key
  `admin.incidentRetried` is removed, and a retry on a non-retryable incident now redirects with a
  notice instead of returning 400.
- Day headings name the year when it differs from the render clock's year.
- A hold row carries a badge with its expiry time.
- `@media print`: navigation, tabs, forms and the theme toggle are dropped, every disclosure prints
  open, and the list takes the full page width.
