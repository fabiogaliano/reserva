---
'@reservajs/astro': minor
---

The reconciliation sweep now stays under D1's 50 queries per Worker invocation, so it works on the Workers Free plan after an outage. Before, two bookings owing calendar and email delivery already took one sweep past the cap, and D1 refuses every query beyond it. It now starts a step only when that step's worst-case query count still fits, always keeps enough to release its lease and send one operator alert, and leaves the rest for the next tick. `ReconciliationOptions.queryBudget` (default `DEFAULT_RECONCILIATION_QUERY_BUDGET`, exported from `@reservajs/astro/runtime`) raises the limit on Workers Paid, e.g. `scheduledHandler(runtime, { requireAlertSink: true, queryBudget: 900 })`. `ReservaContext.d1QueriesIssued` reports the queries its repository has issued; it is absent when a context is built on a supplied `repo`, and the sweep then runs unbounded as before.
