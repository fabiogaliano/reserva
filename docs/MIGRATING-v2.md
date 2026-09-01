# Migrating to 0.2.0

0.1.x shipped privately as `bookkit`: one package, raw TypeScript source, Stripe bundled in,
a tour-specific domain vocabulary, and a booking widget as a public export. 0.2.0 is the first
public cut. This file maps every rename in one place.

Order of operations for an existing deployment:

1. Apply the migrations (`bunx reserva-migrate`) — `0018_v2_domain_rename.sql` rebuilds
   `bookings`. Do this before deploying the new Worker.
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
| `bookkit/core`, `/email`, `/providers`, `/providers/calendar-google`, `/providers/email-brevo`, `/providers/email-none`, `/runtime` | same subpaths under `@reservajs/astro` |
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
| `defaultMessages`, `defaultLocale`, `resolveMessages`, `formatMessage`, `SLOT_STATUS_MESSAGE_KEYS` (root export) | moved to `@reservajs/astro/ui` |

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
| `payments.methods` | the payment adapter's `paymentMethods` option (`stripe({ paymentMethods: [...] })`) |
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

`migrations/0018_v2_domain_rename.sql` performs these; you do not edit them by hand:

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
- **Migration filenames.** `0001_init.sql` … `0019_admin_change_history.sql` are recorded in
  Wrangler's `d1_migrations` ledger by name. Renaming an applied migration would make the
  ledger re-apply it. Comments inside already-applied files (for example `0009`'s mention of the
  old token-encryption secret name) are historical text and stay as written.
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
