---
"@reservajs/astro": minor
---

Add the reminder email. `config.booking.reminderHoursBefore` (integer ≥ 1, default 24, `0`
disables) is editable in the admin settings "policy" section, `BOOKING_EVENTS` gains
`booking.reminder`, and a bounded sweep in `runReconciliation` arms one reminder per confirmed
booking whose start falls inside the window and that was created before it. The reminder rides the
normal outbox path (retries, abandonment, incidents), discriminated by `starts_at` so a reschedule
re-arms it. The email goes to the customer only, with new `reminder.customer.*` copy in English and
Portuguese: a card with date, time, guests, meeting point or pickup, and the manage button.
