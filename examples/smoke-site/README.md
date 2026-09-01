# Reserva local demo

This fixture runs Reserva through Astro 7, Cloudflare's Vite plugin/workerd runtime, and a persistent local D1 database. Payment, calendar, email, booking-event hooks, refunds, and Cloudflare Access are simulated locally; no external service is contacted.

From this directory:

```bash
bun run demo
```

Then open <http://localhost:4321>.

The demo command applies every migration under `../../migrations` and starts `astro dev`. Local D1 state persists under `.wrangler/state`.

Useful pages and endpoints:

- `/` — booking widget and walkthrough
- `/booking-confirmation?session_id=...` — payment recovery and confirmation
- `/booking/admin` — owner dashboard; Access is bypassed only by the demo runtime
- `/booking/manage?token=...` — customer or operator controls
- `/api/booking/availability` — availability JSON

The simulated email provider prints customer and operator management URLs in the terminal. The owner dashboard also links to the operator view for every booking. `wrangler.jsonc` includes a local-only `RESERVA_TOKEN_ENC_KEY` so newly created tokens can be encrypted and regenerated for those links; production deployments must configure this as a Worker secret before accepting bookings.

To start with an empty database, stop the server and remove `.wrangler/state`, then run `bun run demo` again.

## Scheduled reconciliation

`worker/` is a second, minimal Worker whose only job is calling `runReconciliation` on a cron
schedule — the autonomous sweep that resumes stuck side-effect/refund debt, sweeps expired holds,
and opens/resolves operator incidents without needing an HTTP request to touch the affected
booking. It is a **separate Worker**, not a wrapper around this site's own entrypoint: see
`worker/scheduled.ts`'s header comment for why (short version: `@astrojs/cloudflare`'s build always
regenerates its own Wrangler config with `main` pointed at its own compiled entry, so there is no
supported way to splice a `scheduled()` handler into it without re-fighting that on every build and
risking the site's own routes/assets/bindings). It shares the same `RESERVA_DB` D1 database as this
site (same `database_name`), so both Workers see the same bookings.

D1 is the shared ledger, not the Cron Worker's complete configuration. Cloudflare bindings and
secrets are per Worker and are not inherited from the site Worker. A production copy must attach
all credentials read by the shared provider factory to this Worker too: Stripe payment/webhook
secrets; Google service-account, impersonation, and calendar-id values; Brevo; webhook signing keys;
the central
operational-alert channel; and Reserva's token-encryption secret when recovered emails need working
management links. Repeat `wrangler secret put <NAME> --config worker/wrangler.jsonc` for every
secret even if the site Worker already has a secret with the same name; put non-secret provider
URLs/ids in this Worker's `vars`. The checked-in fixture uses simulated providers and local-only
values, so its short `vars` block is not a production credential inventory.

This is installed once by whoever deploys the Worker (a technical operator), not something the
business owner configures from the admin dashboard. Its handler requires an alert sink and fails
preflight when one is missing, leaving incident alert revisions undelivered for a corrected deploy.

```bash
# Run the cron worker locally against this demo's D1 state, with wrangler's built-in scheduled-
# event test route enabled (see https://developers.cloudflare.com/workers/wrangler/commands/#dev,
# `--test-scheduled`, which exposes GET /__scheduled):
bun run cron:dev

# In another terminal, trigger one sweep the same way Cloudflare's Cron Triggers would:
bun run cron:trigger

# Deploy the cron worker for real (after `wrangler login` and creating a production D1 database,
# same as deploying this site itself):
bun run cron:deploy
```

`worker/wrangler.jsonc`'s `triggers.crons` defaults to every 5 minutes; production deployments
should tune that to their own outage-tolerance, but nothing in `src/reconciliation.ts` assumes this
exact cadence — the retry backoff schedule in `src/reconciliation-helpers.ts` is what this
cadence feeds.

Both `wrangler.jsonc` files in this fixture (the site's own and `worker/wrangler.jsonc`) enable
Workers observability with full logs — reconciliation, incident, and alert
events are only inspectable in production if their structured log fields are actually captured. A
production deployment should also set up a Cloudflare-side alert on the cron Worker's
failures/error logs (see README.md's runbook step 7a): the in-process `ReservaProviders.alerts`
sink cannot fire if the cron invocation itself never completes (D1 down, an uncaught throw before
the alert-drain step, or the trigger simply not firing).
