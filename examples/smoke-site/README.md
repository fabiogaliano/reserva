# Reserva local demo

A complete Astro 7 site running Reserva on Cloudflare's workerd, with a persistent local D1
database. Payments, calendar, email, alerts and admin sign-in are simulated in `src/runtime.ts`,
so nothing calls an external service.

```bash
bun run demo        # applies the migrations, then runs `astro dev`
```

Open <http://localhost:4321>. Local data lives in `.wrangler/state`; delete it to start over.

| Page | What it shows |
|---|---|
| `/` | the booking widget and the `<ManageBooking />` form |
| `/booking-confirmation?sessionId=…` | payment and confirmation |
| `/booking/admin` | the owner dashboard (sign-in skipped by the demo runtime) |
| `/booking/manage?token=…` | customer or operator controls |
| `/api/booking/availability` | availability JSON |

The fake email provider prints customer and operator manage links in the terminal. The operator
bearer token is `local-operator-secret`.

## Scheduled reconciliation

`src/worker.ts` is the site's Worker entry (`main` in `wrangler.jsonc`). It exports
`fetch: handle` from `@astrojs/cloudflare/handler` and `scheduled: scheduledHandler(runtime)`, so
the cron runs in the same Worker as the site, with the same bindings and secrets, every five
minutes.

`POST /api/booking/ops/reconcile` runs the same sweep on demand. Both share one lease, so they
never run at the same time.

```bash
bun run cron:dev       # wrangler dev on the demo's D1; trigger with GET /cdn-cgi/handler/scheduled
bun run cron:trigger   # run one sweep, as the cron would
bun run cron:deploy    # deploy for real
```

Both `wrangler.jsonc` files turn on full-log observability. In production, also add a
Cloudflare alert on this Worker's failures: if the invocation never finishes, Reserva can't send
an alert itself.
