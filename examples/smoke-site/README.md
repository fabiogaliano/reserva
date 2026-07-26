# Bookkit local demo

This fixture runs Bookkit through Astro 7, Cloudflare's Vite plugin/workerd runtime, and a persistent local D1 database. Payment, calendar, email, operations, analytics, refunds, and Cloudflare Access are simulated locally; no external service is contacted.

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
- `/api/booking/feed?since=...` — incremental feed; use `Authorization: Bearer local-tourflow-secret`

The simulated email provider prints customer and operator management URLs in the terminal. The owner dashboard also links to the operator view for every booking. `wrangler.jsonc` includes a local-only `BOOKKIT_TOKEN_ENC_KEY` so newly created tokens can be encrypted and regenerated for those links; production deployments must configure this as a Worker secret before accepting bookings.

To start with an empty database, stop the server and remove `.wrangler/state`, then run `bun run demo` again.
