---
"@reservajs/astro": minor
"@reservajs/stripe": patch
---

Confirmation and manage page fixes.

**Run `bunx reserva-migrate` after upgrading.** Migration `0005_calendar_patch_outbox.sql` adds a `calendar_patch` outbox family (ops health can now report it).

**Breaking:** `icsText` and `icsDataUrl` from `@reservajs/astro/ui` now take a second argument, `{ uid, generatedAt }`. Use `calendarUid(reference, businessUrl)` for the `uid`.

- A reschedule succeeds as soon as the booking moves. The calendar update now goes through the outbox (retried, then raised as an incident), so a calendar outage no longer turns a finished reschedule into a 500. The incident is titled "Calendar not updated".
- Rescheduling to the time the booking already has succeeds without doing anything, so a double-submitted form no longer errors.
- The reschedule calendar no longer counts the customer's own booking against capacity. Availability accepts the booking's manage token in the `x-reserva-manage-token` header (`MANAGE_TOKEN_HEADER`, or `manageToken` on the client). That answer is never cached.
- The reschedule picker no longer fails with a 400 when its range crosses a daylight-saving change.
- After cancelling, the customer sees a "Booking cancelled" page instead of "Link not valid".
- The manage page shows both the cancel and the reschedule deadline, and says when one has passed. Form errors come back as a readable message, and buttons are disabled while a form is sending.
- The confirmation page keeps waiting after a server error instead of saying the booking wasn't found. With JavaScript it checks the status in the background and announces progress to screen readers. `?locale=pt` now finds `pt-PT`.
- Calendar files use one UID per booking (`<reference>@<your host>`), so two bookings at the same time no longer clash. `DTSTAMP` is the time the file was made.
- Multi-day bookings show their end date. After the 4-hour detail window, the page no longer says a confirmation email is on its way.
- Customer pages get a "Skip to content" link, and the theme toggle works on every confirmation and manage page.
- Checkout's metadata errors include `details.field` (`metadata.<key>`) for every rule.
- The low-availability hint now reads "Room for {n} more bookings", with a new singular key `widget.limitedOne`. If you override `widget.limited`, override `widget.limitedOne` too.
- `createReservaClient({ base })` accepts a trailing slash.
- Stripe: the default success URL includes `&locale=`.

New message keys: `widget.limitedOne`, `confirmation.pollChecking`, `confirmation.pollUpdated`, `confirmation.summaryLead`, `manage.reschedulePolicy`, `manage.cancelClosed`, `manage.rescheduleClosed`, `manage.cancelDoneTitle`, `manage.cancelDoneBody`, `manage.cancelDoneRefund`, `manage.bookAgain`.
