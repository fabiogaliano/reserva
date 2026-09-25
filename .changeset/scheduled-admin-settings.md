---
"@reservajs/astro": patch
---

Admin settings edits now also apply to the scheduled job. The cron ran on `reserva.config.ts` alone, so a `booking.reminderHoursBefore` changed on `/booking/admin` never affected reminders, and emails the cron sends (reminders, retried confirmation and cancellation emails) quoted the file's cancellation cutoff while the same email sent from a web request quoted the admin value. `scheduledHandler` now reads the same merged settings as every route; an invalid stored row still falls back to the file value with a `reserva.settings.invalid_override` warning.

Links in cron-sent emails now honour `routePrefix`. With `reserva({ routePrefix })`, the manage link in a retried customer or owner email and the admin link in an operational alert pointed at the unprefixed path; they now use the same paths as the routes.

A custom `scheduled()` that builds its own context for `runReconciliationWithLease` should wrap it in the newly exported `withStoredSettings` from `@reservajs/astro/runtime` and set `routeConfig` from `virtual:reserva/config`; `docs/deployment.md` shows the snippet.

The Guests value in booking emails is now the copy key `value.guests` (default `'{quantity}'`, so output is unchanged). A per-vehicle site can set it through `config.emails.messages`, e.g. `en: { 'value.guests': 'Up to {quantity} guests' }`; it applies to the customer and owner cards, including the reminder.
