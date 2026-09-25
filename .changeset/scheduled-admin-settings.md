---
"@reservajs/astro": patch
---

Admin settings edits now also apply to the scheduled job. The cron ran on `reserva.config.ts` alone, so a `booking.reminderHoursBefore` changed on `/booking/admin` never affected reminders, and emails the cron sends (reminders, retried confirmation and cancellation emails) quoted the file's cancellation cutoff while the same email sent from a web request quoted the admin value. `scheduledHandler` now reads the same merged settings as every route; an invalid stored row still falls back to the file value with a `reserva.settings.invalid_override` warning.

A custom `scheduled()` that builds its own context for `runReconciliationWithLease` should wrap it in the newly exported `withStoredSettings` from `@reservajs/astro/runtime`.
