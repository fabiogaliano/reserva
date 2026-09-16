# Migrating

Two breaking cuts so far. [Migrating to 0.5.0](#migrating-to-050) is at the end of this file;
0.2.0 (the first public release) is below.

# Migrating to 0.2.0

0.1.x shipped privately as `bookkit`: one package, raw TypeScript source, Stripe bundled in,
a tour-specific domain vocabulary, and a booking widget as a public export. 0.2.0 is the first
public cut. This file maps every rename in one place.

Order of operations for an existing deployment:

1. Apply the migrations (`bunx reserva-migrate`). The published package now ships its schema as
   a single `0001_init.sql`, so it can only initialize a fresh database — it carries no upgrade
   path off the 0.1.x shape. A database still on 0.1.x has to run the incremental chain from an
   earlier 0.2.x tag first, then upgrade. Do this before deploying the new Worker.
2. Rename the Worker bindings and secrets.
3. Update the config, the integration call, and the runtime module.
4. Install `@reservajs/stripe` and replace the payment provider construction.
5. Copy the booking widget out of `examples/smoke-site` into your own site, or replace it.

## Packages and binaries

| 0.1.x | 0.2.0 |
|---|---|
| `bookkit` | `@reservajs/astro` |
| `bookkit/providers/payments-stripe` | `@reservajs/stripe` (separate package, own `stripe` dependency) |
| `bookkit/components/BookingWidget.astro` | removed — copy `examples/smoke-site/src/components/BookingWidget.astro` |
| `bookkit-migrate` (bin) | `reserva-migrate` |
| `bookkit/core`, `/email`, `/providers/calendar-google`, `/providers/email-brevo`, `/providers/email-none`, `/runtime` | same subpaths under `@reservajs/astro` |
| — | new: `@reservajs/astro/ui` (the copy seam, moved off the root barrel) |

The package now ships compiled `dist/` output. Remove any
`vite.ssr.noExternal: ['bookkit']` from your Astro config, and remove `@types/node` if you
added it only to compile the library's raw source.

## Worker bindings and secrets

| 0.1.x | 0.2.0 |
|---|---|
| `BOOKKIT_DB` | `RESERVA_DB` |
| `BOOKKIT_CACHE` | `RESERVA_CACHE` |
| `BOOKKIT_CSRF_SECRET` | `RESERVA_CSRF_SECRET` |
| `BOOKKIT_OPERATOR_SECRET` | `RESERVA_OPERATOR_SECRET` |
| `BOOKKIT_TOKEN_ENC_KEY` | `RESERVA_TOKEN_ENC_KEY` |

Cloudflare secrets are per name, not renameable in place: `wrangler secret put <NEW_NAME>` with
the same value, then `wrangler secret delete <OLD_NAME>` once the new Worker is live.
`RESERVA_TOKEN_ENC_KEY` must keep the **same key material**, or previously encrypted booking
tokens stop decrypting and their manage links stop regenerating.

Repository-internal environment variables followed the same prefix change
(`BOOKKIT_MIGRATIONS` → `RESERVA_MIGRATIONS`, `BOOKKIT_PACK_TEST_KEEP` →
`RESERVA_PACK_TEST_KEEP`, `BOOKKIT_PREVIEW_PERSIST` → `RESERVA_PREVIEW_PERSIST`,
`BOOKKIT_SCHEDULED_TEST_KEEP` → `RESERVA_SCHEDULED_TEST_KEEP`); none of them are part of a
consumer deployment.

## Module ids and routes

| 0.1.x | 0.2.0 |
|---|---|
| `virtual:bookkit/runtime` | `virtual:reserva/runtime` |
| `virtual:bookkit/config` | `virtual:reserva/config` |
| `GET /booking/assets/bookkit.css` | `GET /booking/assets/reserva.css` |
| `GET /booking/assets/bookkit.js` | `GET /booking/assets/reserva.js` |
| `POST /api/booking/webhooks/stripe` | `POST /api/booking/webhooks/payment` |

Update the payment provider's dashboard webhook endpoint to the new path. Every other route
pattern is unchanged.

## Runtime symbols

Every `Bookkit`-prefixed export became `Reserva`-prefixed, and the two factories dropped the
vendor name:

| 0.1.x | 0.2.0 |
|---|---|
| `bookkit()` (default export of the package) | `reserva()` |
| `BookkitIntegrationOptions` | `ReservaIntegrationOptions` |
| `defineBookkitRuntime` | `defineReservaRuntime` |
| `defineCloudflareBookkitRuntime` | `defineCloudflareReservaRuntime` |
| `CloudflareBookkitRuntimeOptions` | `CloudflareReservaRuntimeOptions` |
| `BookkitContext`, `BookkitContextInput` | `ReservaContext`, `ReservaContextInput` |
| `BookkitProviders` | `ReservaProviders` |
| `BookkitRuntime`, `BookkitRuntimeDefinition`, `BookkitRuntimeFactoryOptions`, `BookkitRuntimeRequest` | `ReservaRuntime`, `ReservaRuntimeDefinition`, `ReservaRuntimeFactoryOptions`, `ReservaRuntimeRequest` |
| `BookkitEnvShape`, `UntypedBookkitEnv` | `ReservaEnvShape`, `UntypedReservaEnv` |
| `BookkitCache`, `BookkitClient`, `BookkitClock`, `BookkitLogger` | no longer exported — internal context types |
| `BookkitMessageKey`, `BookkitMessages` | `ReservaMessageKey`, `ReservaMessages` |
| `BookkitResolvedRouteConfig`, `BookkitRouteEntry`, `BookkitRouteGroup`, `BookkitRouteGroupFlags`, `BookkitRouteId`, `BookkitRouteOptions` | the same names with the `Reserva` prefix |
| `createBookkitContext`, `checkBookkitMigrationsApplied`, `bookkitMigrationStatus`, `bookkitSchemaFingerprintPresent`, `bookkitSecretEnvSchema` | the same names with `reserva`/`Reserva` in place of `bookkit`/`Bookkit` |
| `defaultMessages`, `defaultLocale`, `resolveMessages`, `formatMessage` (root export) | moved to `@reservajs/astro/ui` |

`ReservaMessages` key names also changed with the domain rename (`common.tour` →
`common.service`, `setting.fleetCapacity` → `setting.capacity`, and kin). If you override copy
through `config.ui.messages`, retype the map against `ReservaMessageKey` — the compiler will
name every stale key.

## Config keys

| 0.1.x | 0.2.0 |
|---|---|
| `tours` / `TourConfig` / `tourSlug` | `services` / `ServiceConfig` / `serviceSlug` |
| `fleet.defaultCapacity` | `capacity.default` |
| `pricing[].maxPeople` | `pricing[].maxQuantity` |
| `pricing[].priceCents` | `pricing[].priceMinor` |
| `business.currency: 'eur'` (literal) | any lowercase ISO 4217 code; prices are that currency's minor unit |
| service-level `meetingPoint` / `meetingPoints` / `pickupOptions` | `location.meetingPoints` / `location.pickupOptions` — and the whole `location` module is now optional per service |
| `payments.methods` | removed — payment methods are managed in the payment provider's own dashboard |
| Stripe locale/currency validation in `validateConfig` | validated by the adapter at runtime-definition initialization |

`validateConfig` rejects the three old service-level location keys by name and points at their
new home, so a stale config fails the build rather than silently dropping pickup options.

## Wire and entity fields

The booking projection used by webhooks, `/status`, and `/manage` renamed with the domain
(`apiVersion` stays `1`; it was never published outside the two private deployments):

| 0.1.x | 0.2.0 |
|---|---|
| `tourSlug` | `serviceSlug` |
| `people` | `quantity` |
| `priceCents` | `priceMinor` (+ `currency` beside it) |
| `stripeSessionId` | `paymentSessionRef` |
| `stripePaymentIntent` | `paymentRef` |
| `tourflowSynced`, `calendarSynced`, `emailSynced` | gone — delivery state lives in `side_effect_operations` rows |
| `remindedAt`, `reviewRequestedAt` | gone (nothing ever wrote them) |

Error codes moved off the vendor name too: `stripe_session_mismatch` →
`payment_session_mismatch`, `stripe_amount_mismatch` → `payment_amount_mismatch`,
`invalid_stripe_signature` → `invalid_payment_signature`. Enumerate from `API_ERROR_CODES`
rather than hardcoding.

## Database columns

The rename migration in the earlier 0.2.x chain performs these; you do not edit them by hand:

| 0.1.x column | 0.2.0 column |
|---|---|
| `bookings.tour_slug` | `bookings.service_slug` |
| `bookings.people` | `bookings.quantity` |
| `bookings.price_cents` | `bookings.price_minor` (+ new `currency NOT NULL`) |
| `bookings.stripe_session_id` | `bookings.payment_session_ref` |
| `bookings.stripe_payment_intent` | `bookings.payment_ref` |
| `bookings.calendar_synced`, `email_synced`, `tourflow_synced` | dropped; true flags are materialized into `side_effect_operations` rows first |
| `bookings.reminded_at`, `review_requested_at` | dropped |
| `settings` key `fleet.defaultCapacity` | `capacity.default` |

## Deliberately not renamed

These keep their old names on purpose, because renaming them would change persisted state or
break already-delivered data:

- **D1 table names**: `bookings`, `settings`, `side_effect_operations`, `refund_operations`,
  `operational_incidents`, `admin_change_history`. None carry the old product name; all are
  generic and stay as they are.
- **`refund_operations.stripe_refund_id` and `refund_operations.payment_intent`.** Vendor-named
  persisted columns holding vendor-issued identifiers. Renaming them is a schema migration with
  no behavioral benefit, and this release does not touch refund history.
- **Migration filenames.** Reserva ships its schema as a single `0001_init.sql`, recorded in
  Wrangler's `d1_migrations` ledger by name. A database that applied the earlier incremental
  chain already carries that name, so it needs nothing; renaming an applied migration would
  make the ledger re-apply it.
- **`--bk-*` CSS custom properties and `.bk-*` class names.** Public theming API; renaming them
  would break every consumer's override stylesheet for no functional gain.

## External systems

Two identifiers Reserva writes into other people's systems did change. Both are safe, but know
what happens:

- **Google Calendar extended property `bookkitBookingId` → `reservaBookingId`.** Events created
  before the upgrade keep the old property. Reserva no longer matches on it, and instead dedupes
  and patches through the `calendar_event_id` stored on the booking, which every event created
  by any version has. Nothing is orphaned; only an external tool that queried the old property
  needs updating.
- **Stripe refund idempotency marker `bookkit-refund-<paymentIntent>` →
  `reserva-refund-<paymentIntent>`.** Stripe idempotency keys expire after roughly 24 hours, so
  the only affected case is a refund issued in the last day *and* retried after the upgrade:
  the retry presents a new key and Stripe answers "already refunded", which the adapter
  reconciles through `refunds.list` exactly as it does for an expired key. No double refund is
  possible.


# Migrating to 0.5.0

0.5.0 removes the second config source. The integration validates `reserva.config.ts` once and
ships the result to the runtime, so a runtime module no longer imports (or re-validates) it.

Order of operations:

1. Update `reserva.config.ts`: `occupancyFor` → `occupancy`, and `lastEnd` wherever a rule was
   subtracting `durationMin` by hand.
2. Update `astro.config.ts` and `src/reserva-runtime.ts`.
3. Re-run `wrangler types` and drop the `worker-configuration` import.

## Config keys

| 0.4.x | 0.5.0 |
| --- | --- |
| `services.<slug>.occupancyFor: (quantity) => number` | `services.<slug>.occupancy: { seatsPerUnit: number }` |
| `schedule[].lastStart` computed as `closing − durationMin` | `schedule[].lastEnd: 'HH:MM'` (the last departure is derived) |

`occupancyFor` is now a validation error (`services.<slug>.occupancyFor: replaced by
occupancy.seatsPerUnit`) rather than a silently ignored key. Units become
`ceil(quantity / seatsPerUnit)`; a function that was not of that shape has to become one, since
the resolved config must be JSON-serializable to travel through `virtual:reserva/config`.

A schedule rule declares `lastStart` **or** `lastEnd`, never both. `lastEnd` is the time the last
booking has to be finished by; the last departure is the latest start on the interval grid that
still fits `durationMin`. A rule with neither keeps the old `'18:00'` default. `ResolvedScheduleRule`
always carries the computed `lastStart`, so nothing downstream had to change.

`services.<slug>.meta` and `location.meetingPoints[].meta` are new optional passthroughs: opaque
JSON (≤ 8 KB, JSON-serializable) that the catalog echoes back and Reserva never reads.

## The integration and the runtime module

```diff
 // astro.config.ts
-integrations: [reserva({ config, runtimeEntrypoint: './src/reserva-runtime.ts' })],
+integrations: [reserva({ config })],
```

`runtimeEntrypoint` is now optional and defaults to `./src/reserva-runtime.ts`, resolved against
the Astro project root. A missing file still throws, naming the resolved path.

```diff
 // src/reserva-runtime.ts
-import config from '../reserva.config';
-import type { Env } from '../worker-configuration';
-
-export default defineCloudflareReservaRuntime<Env>(config, {
+export default defineCloudflareReservaRuntime<Env>({
   providers,
 });
```

`defineCloudflareReservaRuntime(options)` and `defineReservaRuntime(options)` drop the config
argument and read it from `virtual:reserva/config`. `ReservaRuntimeFactoryOptions.config` is gone;
`ReservaContextInput.config` is unchanged. `reserva.config.ts` is now imported only by
`astro.config.ts`.

`Env` comes from `wrangler types`, which emits a **global** `interface Env` — there is nothing to
import from `worker-configuration`.

## `virtual:reserva/config`

| 0.4.x | 0.5.0 |
| --- | --- |
| `ReservaResolvedRouteConfig` (`{ paths, groups }`) | `ReservaVirtualConfig` (`{ config, routes: { paths, groups, dev } }`) |

A component or page reading route paths changes `routeConfig.paths.checkout` to
`virtualConfig.routes.paths.checkout`. `routes.dev` is `true` only in output built by `astro dev`.

## `env.schema`

`reserva()` no longer declares provider secret names. `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `BREVO_API_KEY`, `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` and
`GOOGLE_IMPERSONATE_EMAIL` are gone from the contributed schema; `RESERVA_CSRF_SECRET` and
`RESERVA_TOKEN_ENC_KEY` join `RESERVA_OPERATOR_SECRET`. Add whichever provider names you want typed
access to in your own `env.schema`. The Worker secrets themselves are unchanged — only the
build-time declaration moved.

## Provider options

Every provider option that had more than one spelling now has exactly one. The removed names are
compile errors, not silently ignored keys.

`@reservajs/stripe` — `stripe(options)`:

| 0.4.x | 0.5.0 |
| --- | --- |
| `apiKey` | `secretKey` (now required) |
| `stripe`, `stripeClient` | `client` |
| `getSuccessUrl` | `successUrl` (string or `(booking, config) => string`) |
| `getCancelUrl` | `cancelUrl` (string or `(booking, config) => string`) |
| `getServiceName`, `serviceName`, `getProductName`, `productName`, `getLineItemName` | `lineItemName` |
| `paymentMethods` | removed — methods come from the Stripe dashboard |

`cancelUrl` now defaults to `business.url` instead of `business.url/services/<slug>`, and
`lineItemName` defaults to the service's localized `title`, so most deployments can drop the option
entirely. `charge.refunded` events no longer carry `refundRef`: Stripe stopped expanding the
charge's `refunds` list in API 2022-11-15, so the parsed event reports `refundRef: null` and the
cancel-on-full-refund path keys off the amounts.

Subscribe your webhook endpoint to `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`charge.refunded` and `charge.dispute.created`, and set the endpoint's API version explicitly.

`@reservajs/astro/providers/calendar-google`:

| 0.4.x | 0.5.0 |
| --- | --- |
| `googleSaEmail`, `saEmail` | `serviceAccountEmail` |
| `googleSaPrivateKey`, `privateKey` | `serviceAccountPrivateKey` |
| `googleImpersonateEmail`, `subject` | `impersonateEmail` |
| `fetchImpl` | `fetch` |
| `clock` | `now` |
| `apiBaseUrl`, `calendarApiUrl` | `apiBase` |
| `default`, `GoogleCalendar`, `CalendarGoogleProvider`, `createGoogleCalendarProvider` | the named `GoogleCalendarProvider` export |
| `mapGoogleCalendarEvent` | removed (internal) |

`verifyAccessJwt` options:

| 0.4.x | 0.5.0 |
| --- | --- |
| `clock` | `now` |
| `cacheTtlMs` | `jwksTtlMs` |

## Pricing helpers

`resolvedPriceTableFor` and `pricingCombinations` are now exported from `@reservajs/astro/core`,
and `priceFor` picks the tightest covering tier regardless of row order, so an unsorted rule array
prices the same as a sorted one.

## Adding a migration (contributors)

Reserva's D1 schema lives in `migrations/*.sql`, numbered `NNNN_<name>.sql` and applied in filename
order. To add one:

1. Create `migrations/NNNN_<name>.sql` with the next number. SQLite cannot widen a `CHECK`
   constraint in place, so a constraint change is written as the rebuild pattern already used by
   `0002_payment_verification_incidents.sql`: create `<name>_new`, copy the rows across, drop the
   old table, `ALTER TABLE <name>_new RENAME TO <name>`, then recreate every index the drop took
   with it.
2. Run `bun scripts/generate-schema-fingerprint.ts` (or `bun run build`, which runs it first). It
   replays every migration into `src/generated/schema-fingerprint.ts` — the gitignored module that
   supplies `RESERVA_MIGRATIONS` and the table/column/index sets the isolate-time schema check
   compares a live database against. Never edit that file by hand.
3. Apply it locally with `bunx reserva-migrate --local` from a project that owns a `wrangler.jsonc`.

Migrations are append-only: an already-published file is never edited, because `d1_migrations`
records only filenames and would report the edited migration as applied.
