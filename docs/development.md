# Development

Running Reserva locally, the test suites, and adding a migration.

## Local development in your site

`@reservajs/astro/dev` has in-memory providers, so `astro dev` runs the whole booking flow with
no Stripe account, calendar or mail service:

```ts
// src/reserva-runtime.ts
import { defineCloudflareReservaRuntime } from '@reservajs/astro/runtime';
import { devProviders } from '@reservajs/astro/dev';
import { stripe } from '@reservajs/stripe';

export default defineCloudflareReservaRuntime<Env>({
  // Gated on DEV so the fakes are left out of the production bundle.
  providers: ({ env }) => import.meta.env.DEV
    ? devProviders({ pickupAddress: '1 Example Street' })
    : { payments: stripe({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET }) },
});
```

`devProviders()` gives you payments (checkout goes straight to the confirmation page, always
paid), a calendar, and an email provider that prints the customer and operator manage links to
the console, which is the only way to reach the manage page when no mail is sent. `devOutbox`
(`{ emails, alerts }`) holds what the fakes sent, for assertions. `armNextCalendarFailure()`
makes the next calendar create fail, to try the incident path.

Put the secrets in `.dev.vars`:

```ini
RESERVA_TOKEN_ENC_KEY="<32 random bytes, base64>"
RESERVA_OPERATOR_SECRET="<any string>"
RESERVA_CSRF_SECRET="<any string>"
```

Then apply the migrations to the local database:

```sh
bunx reserva-migrate --local
```

`/booking/admin` needs no sign-in locally: `astro dev` output skips Cloudflare Access (see
[Admin access](./deployment.md#admin-access)). A production build never does.

## The demo site

[`examples/smoke-site`](../examples/smoke-site) is a complete site running on workerd with a
persistent local D1 database and simulated payments, calendar, email and admin auth. It never
calls an external service.

```bash
cd examples/smoke-site
bun run demo
```

Open <http://localhost:4321>, make a booking, go through the fake checkout, and look at
`/booking/admin`. The terminal prints the manage links. See its
[README](../examples/smoke-site/README.md) for more.

## Tests and checks

```sh
bun install
bun run verify           # typecheck, generated docs, unit/component and workers tests
bun run verify:packaged  # built preview, cron Worker, packed consumers, README quickstart
bun run check            # bun audit, then both of the above
bun run test:e2e         # Playwright, against examples/smoke-site
```

- `test:workers` runs against real D1 migrations through `@cloudflare/vitest-pool-workers`.
- `test:pack` packs both packages and builds two throwaway sites against them.
- `test:quickstart` builds a site from the README's quickstart blocks, so a broken quickstart
  fails CI.
- `test:e2e` serves the smoke site on port 4399. Set `RESERVA_E2E_PORT` to run next to another
  checkout; a taken port fails the run.

The route table, error codes and booking events in the README and `AGENTS.md`, and the token
table in `customization.md`, are generated. Run `bun run docs:contract` after changing them;
CI runs `docs:contract:check`.

Every change to a published package needs a changeset: `bun run changeset`.

## Adding a migration

Migrations live in `migrations/` as `NNNN_<name>.sql` and run in filename order.

1. Create the file with the next number. SQLite can't change a `CHECK` constraint in place, so
   rebuild the table the way `0002_payment_verification_incidents.sql` does: create
   `<name>_new`, copy the rows, drop the old table, rename the new one, and recreate its
   indexes.
2. Run `bun scripts/generate-schema-fingerprint.ts` (or `bun run build`). It replays every
   migration into `src/generated/schema-fingerprint.ts`, which the runtime compares a live
   database against. Don't edit that file by hand.
3. Apply it locally with `bunx reserva-migrate --local`.

Never edit a published migration. Wrangler's ledger only records filenames, so it would treat
the edited file as already applied.

[`architecture.md`](./architecture.md) lists the rules a change must keep. Security reports go
through [`SECURITY.md`](../SECURITY.md).
