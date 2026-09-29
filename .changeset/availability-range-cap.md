---
'@reservajs/astro': minor
---

Availability requests are now capped at 62 days each (`MAX_AVAILABILITY_RANGE_DAYS`, exported from the client). A longer range returns 400 `validation_failed` with `details: { field: 'to' }`. Before this, the only bound was `config.booking.maxHorizonDays`, so a 500-day horizon meant one request spent seconds of CPU and a Cloudflare Worker hit its CPU limit. `createReservaClient().availability()` splits longer ranges into consecutive requests and merges the days, so client users need no changes; a raw HTTP consumer that requested more than 62 days at once must now split the range.

The manage page's reschedule calendar now fetches one calendar month at a time: the month shown plus the next, then further months as you page, cached so paging back doesn't refetch. Before, it fetched the whole booking horizon on load.
