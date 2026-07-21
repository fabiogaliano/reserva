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

The package includes `BookingWidget.astro`, `ManageBooking.astro`, and `AdminDashboard.astro` reference components. They use native forms and controls without inline event handlers or inline styles, so applications can apply their own CSP and design system. Server-rendered management HTML is also available through `/booking/manage`.

## Cloudflare setup runbook

1. Apply every SQL file in `migrations/` to the D1 database in filename order.
2. Set `BOOKKIT_DB` in the Worker bindings and optionally expose `BOOKKIT_CACHE`.
3. Add Stripe, Google Calendar, email, and Tourflow credentials as Worker secrets; keep them out of the config module.
4. Implement or import the provider adapters in the user-owned runtime module.
5. Configure Cloudflare Access for `/booking/admin` with the same team domain and audience in `config.admin`.
6. Deploy with `output: 'server'` and `@astrojs/cloudflare`; do not prerender booking routes.
7. Verify availability, checkout holds, webhook redelivery, status confirmation, customer cutoff behavior, operator actions, and feed authentication in a staging Worker.
8. Monitor D1 sync flags and Stripe webhook responses. Calendar and confirmation-email failures intentionally return non-2xx so Stripe retries delivery.

The local smoke fixture at `examples/smoke-site` imports `src/index.ts` directly and uses `@astrojs/cloudflare`; it is a build-only check and does not deploy externally.

Run `bun run check` before publishing, then run `bun run build` from `examples/smoke-site`. The standard Vitest suite covers the pure core, handlers, provider adapters, and Access verification. `bun run test:workers` applies the real D1 migrations and exercises repository leases, durable per-IP hold limits, and runtime bindings through Cloudflare's current `@cloudflare/vitest-pool-workers` workerd integration; it does not use the deprecated standalone Miniflare 2 package.
