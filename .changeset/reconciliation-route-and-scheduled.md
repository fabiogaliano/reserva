---
"@reservajs/astro": minor
---

Reconciliation is triggerable on demand, and the cron ships inside the site Worker.

`POST /api/booking/ops/reconcile` (group `ops`) runs the same bounded sweep the cron runs,
authorized by the operator bearer secret **or** an admin identity. Its optional JSON body takes
`sourceLimit`/`alertLimit`; it returns the `ReconciliationSummary`, `503 internal_error` when no
operational alert sink is configured, and a new `409 reconciliation_in_progress` when the sweep is
already running.

Both entry points now take a deployment-wide D1 lease (new migration
`0003_reconciliation_lease.sql`, 4-minute TTL, compare-and-set), so a manual trigger and a cron tick
can never claim the same rows. An overlapping `scheduled` invocation logs a warning and exits
successfully instead of failing the cron. Both successful paths record `lastRunAt`/`lastSummary`,
which `GET /api/booking/ops/health` now reports as `reconciliation`; a deployment whose last run is
older than three ticks of the 5-minute cadence opens a `reconciliation_stale` incident on health
read. That is the first incident that belongs to the deployment rather than to a booking, so
`OperationalIncidentRecord.bookingId` is now nullable.

**Breaking for deployments running the separate cron Worker.** `@astrojs/cloudflare` honours a custom
`main`, so the second Worker (and its duplicated secrets) is gone: add a `src/worker.ts` exporting
`fetch: handle` plus `scheduled: scheduledHandler(runtime)`, and set `main` and `triggers.crons` in
your own `wrangler.jsonc`. See the rewritten step 10 in `docs/deployment.md`. The packaged
`examples/smoke-site/worker/` template is removed.
