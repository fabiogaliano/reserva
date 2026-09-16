# Development

Running Reserva's own repository: the local interactive demo, the test suites, and what CI
enforces.

## Local development

`@reservajs/astro/dev` ships the in-memory providers a local run needs, so `astro dev` boots a
complete booking flow with no Stripe account, no calendar and no mail transport:

```ts
// src/reserva-runtime.ts
import { defineCloudflareReservaRuntime } from '@reservajs/astro/runtime';
import { devProviders } from '@reservajs/astro/dev';
import { stripePayments } from '@reservajs/stripe';

export default defineCloudflareReservaRuntime<Env>({
  // Gate on import.meta.env.DEV so the fakes are tree-shaken out of the production bundle.
  providers: import.meta.env.DEV
    ? devProviders({ pickupAddress: '1 Example Street' })
    : { payments: stripePayments({ secretKey: …, webhookSecret: … }) },
});
```

`devProviders()` returns payments (checkout redirects straight to the confirmation page and the
session always reports paid), a calendar and an email provider that logs the customer and operator
manage URLs to the console — the only way to reach a booking's manage page when no mail leaves the
machine. `devOutbox` (`{ emails, alerts }`) exposes what the fakes "sent" for assertions, and
`armNextCalendarFailure()` makes the next calendar create fail permanently so the incident path can
be exercised.

Before the first run, put the secrets in `.dev.vars`:

```ini
RESERVA_TOKEN_ENC_KEY="<32 random bytes, base64>"
RESERVA_OPERATOR_SECRET="<any string>"
RESERVA_CSRF_SECRET="<any string>"
```

then apply the migrations to the local D1 database:

```sh
bunx reserva-migrate --local
```

`/booking/admin` needs no credentials locally: output built by `astro dev` carries `dev: true`, and
the admin gate honours it when `config.admin.access` is configured (see
[`deployment.md`](./deployment.md)). Nothing about that bypass exists in an `astro build` bundle.

## Local interactive demo

[`../examples/smoke-site`](../examples/smoke-site) runs the complete booking flow locally
through Astro dev, Cloudflare workerd, and persistent local D1, with simulated
payment/calendar/email/admin-auth providers. It never contacts an external service.

```bash
cd examples/smoke-site
bun run demo
```

Open <http://localhost:4321>. Create a booking, follow the simulated checkout, inspect
`/booking/admin`. The dev-server logs print customer and operator management URLs. See
[`../examples/smoke-site/README.md`](../examples/smoke-site/README.md) for the route list and
reset instructions.

## Tests and checks

```sh
bun install
bun run verify           # typecheck + generated docs + unit/component + workers
bun run verify:packaged  # built preview, cron Worker, packed consumers, README quickstart
bun run check            # audit + both of the above
bun run test:e2e         # Playwright, against examples/smoke-site
```

`test:workers` applies the real D1 migrations through `@cloudflare/vitest-pool-workers`;
`test:pack` packs both tarballs and builds two throwaway consumers against them;
`test:quickstart` executes the README's own quickstart blocks, so a quickstart that stops
working fails the build rather than the next reader.

The contract tables in [`../README.md`](../README.md) and [`../AGENTS.md`](../AGENTS.md) are
generated from the package's exported constants: run `bun run docs:contract` after changing
routes, error codes, or booking events (`bun run docs:contract:check` runs in CI).

[`architecture.md`](./architecture.md) records the invariants a change must not break.
Security reports: see [`../SECURITY.md`](../SECURITY.md).
