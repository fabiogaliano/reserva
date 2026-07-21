# Bookkit

Bookkit is an Astro 7 integration for server-rendered tour booking on Cloudflare Workers with D1, Cache API, and Stripe-compatible payment providers.

## Install and configure

Use the package source directly or install the package from its published files. Configure the Astro Cloudflare adapter with server output, then pass the same validated client configuration to `bookkit()` and to a user-owned runtime module.

```ts
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import bookkit from 'bookkit';
import config from './bookkit.config';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [bookkit({ config, runtimeEntrypoint: './src/bookkit-runtime.ts' })],
});
```

`runtimeEntrypoint` is deliberate. Astro serializes and evaluates integration configuration during its build pipeline, while provider instances commonly contain functions, sockets, or secret-backed clients that cannot safely be serialized into a deployed Worker. Bookkit therefore validates the public config during `astro:config:setup`, but resolves a user-owned runtime module through `virtual:bookkit/runtime` for request-time provider creation.

## Runtime module

`defineCloudflareBookkitRuntime()` reads production bindings from `cloudflare:workers`, which is the supported Astro 7 and `@astrojs/cloudflare` runtime API. Direct `locals.env` is accepted only as an explicit test harness seam. The environment is kept inside the context factory and is never returned as page data.

```ts
import { defineCloudflareBookkitRuntime } from 'bookkit/runtime';
import config from './bookkit.config';
import { providers } from './providers';

export default defineCloudflareBookkitRuntime(config, {
  providers: ({ env }) => providers(env),
  secretBindings: ['TOURFLOW_SHARED_SECRET'],
});
```

The default D1 binding name is `BOOKKIT_DB`. The default Cache binding is `BOOKKIT_CACHE`, with a fallback to `caches.default` when the Worker provides it. Set `cache: null` to disable caching. Provider factories run per request, so construct Stripe, calendar, email, and ops clients there or in a user-owned module that receives the current bindings.

Do not put Stripe keys, service-account material, Access secrets, or Tourflow shared secrets in `ClientConfig`, checked-in examples, or component props. Store them in Worker secrets and expose only the names through `secretBindings`.

## Config validation

`bookkit()` runs `validateConfig()` during `astro:config:setup`. Build-time failures include malformed schedules, invalid IANA timezones, unsupported Stripe locales, `holdMinutes < 35`, and pricing gaps for any widget-generated party-size and pickup combination. The thrown Zod error includes the field paths Astro reports during configuration.

The config shape includes business details, fleet capacity, tour schedules and pricing, admin Access identifiers, booking cutoffs and horizon, supported locales, payment methods, and legal URLs. A complete example is in `examples/client-config.ts`.

## Injected routes

Every route is server-only with `prerender: false`:

- `GET /api/booking/availability?tour=&people=&from=&to=`
- `POST /api/booking/checkout`
- `POST /api/booking/webhooks/stripe`
- `GET /api/booking/status?session_id=`
- `GET /api/booking/manage?token=`
- `POST /api/booking/cancel`
- `POST /api/booking/reschedule`
- `POST /api/booking/operator/cancel`
- `POST /api/booking/operator/reschedule`
- `POST /api/booking/operator/no-show`
- `GET /api/booking/feed?since=`
- `GET|POST /booking/admin`
- `GET /booking/manage?token=`
- `GET /booking-confirmation?session_id=`

The endpoint files are intentionally thin: they import `virtual:bookkit/runtime`, create a request-scoped context, and delegate to the handler exports. JSON errors use `{ error: { code, message } }`. Admin authorization is provided by Cloudflare Access through the runtime context.

## Optional Astro Action

Import `server` from `bookkit/actions` in the application's Astro action entrypoint to expose the typed `checkout` action. The plain checkout endpoint remains required for non-Astro clients and webhooks.

```ts
// src/actions/index.ts
export { server } from 'bookkit/actions';
```

The action accepts `tourSlug`, `start`, `people`, `pickupType`, and `locale` through Astro's Zod input validation. Pickup addresses are intentionally absent because Stripe collects custom pickup details during checkout.

## Components

The package includes `BookingWidget.astro`, `ManageBooking.astro`, and `AdminDashboard.astro` reference components. They use native forms and controls without inline event handlers or inline styles, so applications can apply their own CSP and design system. Server-rendered management HTML is also available through `/booking/manage`. `BookingWidget.astro`'s `<script>` is a hoisted Astro module script rather than `is:inline`, so Astro emits it as an external hashed file — that is why the widget holds under a strict `script-src 'self'` CSP even though the source file shows a `<script>` tag.

## Local interactive demo

The fixture in `examples/smoke-site` runs the complete booking flow locally through Astro dev, Cloudflare workerd, and persistent local D1. Its payment, calendar, email, operations, analytics, refund, and Access providers are simulations, so it never contacts an external service.

```bash
cd examples/smoke-site
bun run demo
```

Open <http://localhost:4321>. Create a booking, follow the simulated checkout confirmation, inspect `/booking/admin`, and use its manage links for operator actions. Customer and operator management URLs are also printed in the dev-server logs. See `examples/smoke-site/README.md` for the route list, feed token, and reset instructions.

## Deviations from and additions to the spec

Bookkit's build contract is the reference spec, but the implementation deliberately goes beyond it in a few places. These are intentional hardening, recorded here so they aren't mistaken for scope creep or re-litigated later.

- **Confirmation lease.** The spec's `*_synced` flags are read-then-act, so a Stripe webhook and a `/status` poll can both read `calendarSynced=false` for the same booking and both create a calendar event. `migrations/0002_confirmation_lease.sql` adds a `confirmation_lease_token`/`confirmation_lease_until` pair; `src/confirmation.ts` acquires it with a compare-and-set (5-minute TTL) before running the confirm-plus-side-effects section, making that section mutually exclusive across concurrent callers. A blocked attempt returns `503 confirmation_in_progress`: from the webhook path, Stripe treats that as a failed delivery and redelivers (desired); `/status` instead catches the error and re-reads the booking rather than failing the customer.
- **Webhook hardening guards.** The Stripe webhook handler (`src/handlers/index.ts`, around the `checkout.session.completed` branch) rejects two conditions the spec's error taxonomy doesn't name: `409 stripe_session_mismatch` when the event's session conflicts with the booking's stored session, and `409 stripe_amount_mismatch` when the captured amount doesn't equal `price_cents`. Both are non-2xx, so Stripe retries them; that's intentional — an amount mismatch should page someone via webhook-failure alerts, not silently confirm the booking.
- **Per-IP hold cap storage.** The spec defines `maxHoldsPerIp` and a `429 too_many_holds` response, but its schema never stores the requesting IP. `migrations/0003_hold_ip.sql` adds a `hold_ip` column, and `src/repo.ts`'s `insertHold` does an atomic count-and-insert against it so the cap is actually enforceable.
- **`payment.dispute_created` event.** The spec requires `charge.dispute.created` to become "log + ops event," but its own `BookingEvent` list has no member to carry it. `src/core/events.ts` adds `payment.dispute_created` to the `BookingEvent` union and explicitly excludes it from `EmailBookingEvent`, so it reaches ops and analytics sinks but can never reach the email provider.
- **Refund exactly-once.** The durable guarantee is Stripe's idempotency key (`bookkit-refund-<paymentIntent>`, set in `src/providers/stripe.ts`); the in-memory `refundedPayments` set on the request context is a same-isolate fast path, and the already-cancelled early-return in the operator-cancel handler blocks re-entry on webhook redelivery.
- **Brevo templates are inlined.** `src/providers/brevo.ts` keeps per-locale template objects, with fallback to the configured default locale, rather than the spec's `templates/{locale}/{event}.ts` file layout. Behavior is the same, only the packaging differs; add a locale by adding an entry to that file's `templates` map.

## Cloudflare setup runbook

1. Apply every SQL file in `migrations/` to the D1 database in filename order.
2. Set `BOOKKIT_DB` in the Worker bindings and optionally expose `BOOKKIT_CACHE`.
3. Add Stripe, Google Calendar, email, and Tourflow credentials as Worker secrets; keep them out of the config module.
4. Implement or import the provider adapters in the user-owned runtime module.
5. Configure Cloudflare Access for `/booking/admin` with the same team domain and audience in `config.admin`.
6. Deploy with `output: 'server'` and `@astrojs/cloudflare`; do not prerender booking routes.
7. Verify availability, checkout holds, webhook redelivery, status confirmation, customer cutoff behavior, operator actions, and feed authentication in a staging Worker.
8. Monitor D1 sync flags and Stripe webhook responses. Calendar and confirmation-email failures intentionally return non-2xx so Stripe retries delivery. Also alert on persistent `confirmation_in_progress` 503s (a stuck lease), on `stripe_amount_mismatch` 409s (never expected in normal operation), and on the "confirming expired hold after payment" warning, which marks a possible one-slot oversell that may need a phone call to the customer.

The local smoke fixture at `examples/smoke-site` imports `src/index.ts` directly and uses `@astrojs/cloudflare`; it is a build-only check and does not deploy externally.

Run `bun run check` before publishing, then run `bun run build` from `examples/smoke-site`. The standard Vitest suite covers the pure core, handlers, provider adapters, and Access verification. `bun run test:workers` applies the real D1 migrations and exercises repository leases, durable per-IP hold limits, and runtime bindings through Cloudflare's current `@cloudflare/vitest-pool-workers` workerd integration; it does not use the deprecated standalone Miniflare 2 package.
