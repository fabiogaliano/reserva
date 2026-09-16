# Reserva local demo

A complete Astro 7 site wired against Reserva, running on Cloudflare's workerd with a persistent
local D1 database. Payment, calendar, email, alerts, and admin auth are simulated in
`src/runtime.ts`; nothing contacts an external service.

```bash
bun run demo        # applies the migrations, then `astro dev`
```

Open <http://localhost:4321>. Local D1 state lives under `.wrangler/state`; delete that directory
to start empty.

| Page | What it shows |
|---|---|
| `/` | booking widget and the embeddable fragments |
| `/booking-confirmation?session_id=…` | payment recovery and confirmation |
| `/booking/admin` | owner dashboard (auth bypassed by the demo runtime only) |
| `/booking/manage?token=…` | customer or operator controls |
| `/api/booking/availability` | availability JSON |

The simulated email provider prints customer and operator manage URLs to the terminal. The
operator bearer token is `local-operator-secret`.

## Scheduled reconciliation

`src/worker.ts` is this site's own Worker entry, pointed at by `main` in `wrangler.jsonc`. It
exports `fetch: handle` from `@astrojs/cloudflare/handler` alongside
`scheduled: scheduledHandler(runtime)`, so the cron runs in the same Worker as the site, with the
same bindings and secrets. `triggers.crons` runs it every 5 minutes.

`POST /api/booking/ops/reconcile` runs the same sweep on demand; both paths share one D1 lease row,
so they never sweep concurrently.

```bash
bun run cron:dev       # wrangler dev with --test-scheduled, against the demo's D1 state
bun run cron:trigger   # fire one sweep, as Cron Triggers would
bun run cron:deploy    # deploy for real
```

The default cadence is every 5 minutes. Both `wrangler.jsonc` files enable full-log observability
so reconciliation and incident events are inspectable in production; also set a Cloudflare-side
alert on this Worker's failures, since the in-process alert sink cannot fire if the invocation
itself never completes.
