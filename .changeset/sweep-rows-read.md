---
'@reservajs/astro': minor
---

The reconciliation sweep no longer reads the whole booking history every five minutes. D1 counts the rows a query scans, and on the Workers Free plan stops all queries for the rest of the UTC day after 5 million. Three of the sweep's checks (reminders coming due, unreported oversells, incidents to re-check) scanned every booking or every outbox row, so the idle sweep alone used up the Free allowance at about 1,600 bookings, or about 160 once 20 incidents had been resolved by hand. On a history of 2,000 bookings an idle sweep now reads about 160 rows instead of about 212,000. The delivery-debt count in `/api/booking/ops/health` also stopped reading every outbox row on each poll.

**Run `bunx reserva-migrate` after upgrading.** Migration `0008_oversell_marker_index.sql` adds an index covering oversell markers only, so ordinary bookings never write to it. Until it is applied, the runtime refuses to start and names the missing migration.
