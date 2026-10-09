# Reserva — integration contract

A booking engine for fixed-capacity time slots, built as an Astro integration. It runs in your own Cloudflare account on Workers + D1, with no per-booking fees.

This file ships inside `@reservajs/astro`. It's what a coding agent needs to wire Reserva into a
site without reading the source: what to install and declare, what the deployment answers, and
what each failure means. The route table, error codes and booking events below are generated
from the package's own constants, so they always match the installed version.

Closed sets are exported as runtime values, not just types: `API_ERROR_CODES` (with
`ApiErrorCode` and `isApiErrorCode`) and `BOOKING_EVENTS` from `@reservajs/astro/core`, and the
deployment's route table as `routes.paths` in `virtual:reserva/config`. Enumerate from those,
never from a copied list.

## Quickstart

```bash
bun add @reservajs/astro
bun add @reservajs/stripe   # the official payment adapter; optional, see "Payments" in README.md
```

Four files, then migrations:

- `reserva.config.ts`: plain data, imported only by `astro.config.ts`.
- `astro.config.ts`: passes it to `reserva({ config })` next to the `@astrojs/cloudflare`
  adapter.
- `src/reserva-runtime.ts`: the runtime module, the only place provider instances and secrets
  exist.
- `wrangler.jsonc`: the `RESERVA_DB` D1 binding.

`README.md`, shipped next to this file, has all four under its Quickstart heading. The
repository builds a real site from exactly those blocks in CI, so copy them from there.

```bash
bunx reserva-migrate --local   # dev database
bunx reserva-migrate           # remote database
```

The runtime module is separate because Astro serializes integration options at build time, and
provider instances (clients, closures, secrets) can't survive that. `runtimeEntrypoint` defaults
to `./src/reserva-runtime.ts`; a missing file throws with the resolved path.

Build the booking form on the typed client rather than raw `fetch`. It knows the deployment's
routes and the error envelope:

```ts
import virtualConfig from 'virtual:reserva/config';
import { createReservaClient, isReservaApiError, firstOpenDay } from '@reservajs/astro/client';

const reserva = createReservaClient({ paths: virtualConfig.routes.paths });
try {
  const availability = await reserva.availability({ serviceSlug, quantity, from, to });
  const day = firstOpenDay(availability);
  const { checkoutUrl } = await reserva.checkout({ serviceSlug, start, quantity, locale, pickup });
  location.assign(checkoutUrl);
} catch (cause) {
  if (isReservaApiError(cause)) console.error(cause.code, cause.details?.field);
}
```

`@reservajs/astro/client` imports no Astro, Node or Cloudflare code. `@reservajs/astro/dev`
exports `devProviders()` for `astro dev`. Details: [`docs/api.md`](./docs/api.md).

The integration validates `config` once, at `astro:config:setup`, and serializes the result into
`virtual:reserva/config` as `{ config, routes: { paths, groups, dev } }`. That's the only config
source: `defineCloudflareReservaRuntime(options)` and `defineReservaRuntime(options)` take no
config argument. `routes.dev` is `true` only in `astro dev` output. The runtime module is loaded
per request through `virtual:reserva/runtime`.

## Partners and referral codes

Operators manage partners at `/booking/admin?view=partners`. Each partner has a code and a link,
`<business.url>?ref=<code>`, and may have an offer (a percentage off the service price and/or
free pickup options, formula-priced services only).

To support it in a booking form:

1. Read `ref` from the URL, lowercase it, keep it for the session.
2. `reserva.resolveReferral({ referralCode })` → `{ status: 'active', benefits }` or
   `{ status: 'unavailable' }`.
3. `reserva.quote({ serviceSlug, quantity, pickup, referralCode })` → show `priceMinor` and the
   `pricing` breakdown; keep `quoteFingerprint`.
4. `reserva.checkout({ …, referralCode, quoteFingerprint })`. A `referralCode` without
   `quoteFingerprint` is `400 validation_failed`.
5. On `409 quote_changed`, show `cause.details.quote` and ask the customer to confirm again. On
   `503 partner_storage_unavailable`, retry; never drop the code or fall back to full price.

Offers apply only when the runtime's `partnerOffers` option has `enabled: true` and a minimum
charge for the currency. It's server-only, never in `ClientConfig`. Until then, codes still
attribute bookings to partners but give no discount. Enable it only once the form shows live
quotes and handles `quote_changed`. See
[Partner offers](./docs/api.md#partner-offers-and-referral-codes), including the
`legacyMetadataField` bridge for sites that tracked partners in a metadata field.

## Config schema outline

`ClientConfig` (from `@reservajs/astro`) is validated with Zod at build time. Every failure names
the key path and the rule. `ClientConfig` is what you write; `ResolvedClientConfig` is what the
runtime and adapters receive, with defaults applied.

| Key | Required | Shape |
|---|---|---|
| `business` | yes | `{ name, shortCode, url, timezone (IANA), currency (ISO 4217, lowercase), contact: { email, phone, phoneSecondary?, whatsapp? } }`. `url` is also the base of partner referral links |
| `capacity` | yes | `{ default: number }`, units available per slot |
| `admin` | no | `{ access?: { teamDomain, aud }, locale? }`, default `{}`. With `access`, Cloudflare Access guards the admin; without it, the runtime needs a custom `adminAuth` while the `admin`/`ops` routes are on |
| `hours` | no | `Array<ScheduleRule>` (same shape as a service `schedule` rule): opening hours inherited by every service without a `schedule`. Each service derives its own last departure from a shared `lastEnd` |
| `pricing` | no | `{ surcharges?: Record<pickupId, minor>, maxUnits?, surchargeScope?: 'unit' \| 'booking' }`, default `{ surcharges: {}, maxUnits: 1, surchargeScope: 'unit' }`. The shared half of formula pricing; each formula service inherits any field it leaves out |
| `services` | yes | `Record<slug, ServiceConfig>` |
| `booking` | no | `{ minNoticeHours, maxHorizonDays, holdMinutes (≥35), cancelCutoffHours, reschedule: { enabled, cutoffHours }, limitedThreshold, calendarMaxStaleSeconds, reminderHoursBefore, maxHoldsPerIp, tokenExpiryDays? }`. Defaults: `0`, `90`, `35`, `24`, `{ enabled: true }` with `cutoffHours` following `cancelCutoffHours`, `2`, `900`, `24` (`0` turns the reminder email off), `5` (open unpaid holds per IP; `null` removes the cap) |
| `locales` | no | `{ supported: string[], default: string }`, default `{ supported: ['en'], default: 'en' }` |
| `legal` | no | `{ termsUrl? }`, default `{}` |
| `webhooks` | no | `Array<{ name, url, secretBinding, events? }>` |
| `routes` | no | `{ admin?, ops?, manage?, cors?: { origins: string[] } }`. The three groups default to `true`. `cors.origins` lists exact origins (`https://www.example.com`, no path or wildcard) allowed to call the customer API from a browser; without it, no route sends CORS headers |
| `ui` | no | `{ messages?: Record<locale, Partial<messages>>, faviconUrl?, headHtml?, contentSecurityPolicy?: string \| false, branding?: { logoUrl?, logoWidth?, logoHeight?, colorScheme?: 'auto' \| 'light' \| 'dark', accentColor? (hex), mastheadBackground?, fontFamily? }, confirmation?: { statusPlacement?: 'masthead' \| 'ticket' } }`. `branding` affects only the confirmation and manage pages. Page hooks (`bk-page--*`, `data-bk-status`) and the `- ` list syntax in messages are in `docs/customization.md` |
| `emails` | no | `{ locale?, branding?, messages? }` |

`ServiceConfig`:

| Key | Required | Shape |
|---|---|---|
| `title` | yes | display name, `LocalizedText` (a string or `Record<locale, string>`) |
| `durationMin` / `turnaroundMin` | yes | slot length, and the gap kept after it |
| `schedule` | no* | `Array<{ from?, to?, days: number[], firstStart?, lastStart?, lastEnd?, intervalMin }>` (`days`: 0 = Sunday; `firstStart` defaults to `'09:00'`). *Required unless top-level `hours` exists. Declare `lastStart` (last departure) or `lastEnd` (when the last booking must finish), never both; `lastEnd` gives the latest grid start that still fits `durationMin`. Neither means `lastStart: '18:00'` |
| `pricing` | yes | Rows `Array<{ maxQuantity, pickup?, priceMinor }>`: the smallest `maxQuantity` that covers the party wins, in any order. `pickup` names one of the service's pickup options, can be left out when there's exactly one, and must be absent without `location`. Or a formula `{ baseMinor, surcharges?, maxUnits?, surchargeScope? }`: `baseMinor × ceil(quantity / occupancy.seatsPerUnit)` plus the pickup surcharge (per unit or per booking), party capped at `maxUnits × seatsPerUnit`. Fields left out come from top-level `pricing`; every pickup option needs a surcharge (`0` allowed). Partner offers need a formula. `priceFor`, `resolvedPriceTableFor`, `pricingCombinations`, `lowestPriceMinor` and `maxQuantityFor` from `@reservajs/astro/core` handle both shapes |
| `occupancy` | no* | `{ seatsPerUnit: number }`, what one unit of `capacity` holds; a booking takes `ceil(quantity / seatsPerUnit)` units. `1` counts people; a value at least the largest party makes every booking one unit. *Required for parties larger than one and for formula pricing |
| `collectGuestCount` | no | `boolean`. For services sold as "up to N": the payment page asks for the exact headcount (optional), stored as `booking.guestCount` (`null` when not asked or left blank). Price and capacity still follow `quantity` |
| `meta` | no | `Record<string, unknown>`, JSON returned by the catalog and never read by Reserva. Under 8 KB. Meeting points take one too |
| `location` | no | `{ meetingPoints?: Array<{ id, label, mapsUrl }>, pickupOptions?: Array<{ id, label, hint?, requiresAddress, usesMeetingPoint }> }`, at least one of the two. Pickup ids are opaque: `label` is required, and address collection follows `requiresAddress`, never the id. `meetingPoints` alone implies the option `{ id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true }`, labelled by the `pickup.meetingPoint` message. Leave `location` out for a service with no pickup |
| `metadataFields` | no | `Array<{ key, label, type: 'text' \| 'number' \| 'boolean' \| 'select', options?, required?, maxLength?, visibility?: 'customer' \| 'operator', adminBadge?, adminOptionLink? }>`. No conditional fields or custom validators. `visibility: 'operator'` keeps a field out of the catalog, confirmation, customer manage view and customer emails, but the browser still sends it, so treat it as a claim. `adminBadge: true` (`select` only) tags the booking with the option label in the admin. `adminOptionLink` (needs `adminBadge`) is a URL with `{value}`, shown per option in the admin |

Every label in config (`title`, meeting-point `label`, pickup `label`/`hint`, metadata field and
option labels) is `LocalizedText`: a string or a `Record<locale, string>`, resolved from the
requested locale to its base language to the default locale, like `ui.messages`.

## Routes

Every route is server-rendered (`prerender: false`). `reserva({ routePrefix })` puts a prefix in
front of all of them. `config.routes` can turn off the `admin`, `ops` and `manage` groups; the
`customer` and `webhook` groups always stay. With `config.routes.cors`, the customer API routes
(`availability`, `checkout`, `quote`, `resolveReferral`, `catalog`, `status`, `manageApi`,
`cancel`, `reschedule`) answer `OPTIONS` preflights from the listed origins. No other route does.

<!-- generated:routes -->
| Route id | Path | Group |
|---|---|---|
| `availability` | `/api/booking/availability` | customer |
| `checkout` | `/api/booking/checkout` | customer |
| `quote` | `/api/booking/quote` | customer |
| `resolveReferral` | `/api/booking/referral` | customer |
| `catalog` | `/api/booking/catalog` | customer |
| `webhooksPayment` | `/api/booking/webhooks/payment` | webhook |
| `status` | `/api/booking/status` | customer |
| `manageApi` | `/api/booking/manage` | customer |
| `cancel` | `/api/booking/cancel` | customer |
| `reschedule` | `/api/booking/reschedule` | customer |
| `operatorCancel` | `/api/booking/operator/cancel` | ops |
| `operatorReschedule` | `/api/booking/operator/reschedule` | ops |
| `operatorNoShow` | `/api/booking/operator/no-show` | ops |
| `opsHealth` | `/api/booking/ops/health` | ops |
| `reconcile` | `/api/booking/ops/reconcile` | ops |
| `assetsCss` | `/booking/assets/reserva.css` | customer |
| `assetsJs` | `/booking/assets/reserva.js` | customer |
| `adminPage` | `/booking/admin` | admin |
| `managePage` | `/booking/manage` | manage |
| `confirmationPage` | `/booking-confirmation` | customer |
<!-- /generated:routes -->

Request and response types are exported from `@reservajs/astro/core`: `AvailabilityResponse`,
`QuoteRequest`/`QuoteResponse`, `ResolveReferralRequest`/`ReferralResolution`,
`CheckoutRequest`/`CheckoutResponse`, `CatalogResponse`, `StatusResponse`, `ManageResponse`,
`ManageActionResponses`, `OpsHealthResponse`, `ApiErrorEnvelope`. Lists are always present
(empty when there's nothing) and optional modules are always present (`null` when off), so
nothing needs a key-presence check.

The booking flow: `catalog` (what) → `availability` (when) → `quote` (how much) → `checkout`
(hold + payment session). The payment provider redirects to
`/booking-confirmation?sessionId=…`, which polls `status` until the webhook confirms. `status` is
`pending | confirmed | failed | cancelled | expired | not_found`. `failed` means the session
completed but the payment wasn't acceptable (a delayed method, or a wrong amount or currency): no
booking was made, it's final for the customer, and it opens an incident for the operator. The
page polls up to 20 times (about 60 s), then shows a "still waiting" page with contact details.

For a reschedule picker, pass the booking's manage token to `availability` in the
`x-reserva-manage-token` header (`MANAGE_TOKEN_HEADER`; `manageToken` on the client). The
booking's current slot then doesn't block the move. That answer is never cached, and an unknown
or revoked token gets the same answer as none.

Request fields are `serviceSlug`, `pickup`, `start` and `sessionId` everywhere; the webhook
booking calls the pickup `pickupType`. `CheckoutResponse` has `paymentDeadline`;
`ManageResponse` has `cancelDeadline` and `rescheduleDeadline`. Four hours after creation, `status` answers `confirmed` with a
`ConfirmationSummary` (`reference`, `serviceTitle`, `start`, `end`, `locale`) instead of the full
booking.

## Introspection

Two endpoints let a deployment describe itself:

- `GET /api/booking/catalog?locale=`, public. Per service: title in the locale, duration,
  location options, metadata fields, `pricing` (rows `{ maxQuantity, pickup, priceMinor }[]`
  with `pickup` null without a pickup axis, or a formula
  `{ baseMinor, surcharges, maxUnits, surchargeScope, seatsPerUnit }`), `maxQuantity`,
  `fromPriceMinor` and `meta`. Top level: `locales`, `currency`, `maxHorizonDays` and `policy`
  (`cancelCutoffHours`, `reschedule.{enabled,cutoffHours}`). Never exposes schedules,
  turnaround or capacity. Build the booking UI from this; don't hardcode config or prices.
- `GET /api/booking/ops/health`, admin only. `schema` (migrations applied, fingerprint match),
  `outbox` (pending and abandoned counts per family, oldest pending age), `incidents` (open
  count), `security` (whether `RESERVA_CSRF_SECRET` and `RESERVA_TOKEN_ENC_KEY` are set, and
  which `adminAuth` is in use), `reconciliation` (`lastRunAt`, `lastSummary`). No parameters.
  Its one write: it opens a `reconciliation_stale` incident when the sweep hasn't run for three
  cadences and resolves it once it has, so polling never alerts twice.

## Error codes

Every failure, at any status, is `{ error: { code, message, details? } }` with `code` one of:

<!-- generated:error-codes -->
`validation_failed`, `method_not_allowed`, `payload_too_large`, `forbidden`, `not_found`, `past_cutoff`, `invalid_transition`, `slot_unavailable`, `too_many_holds`, `quote_changed`, `partner_storage_unavailable`, `partner_conflict`, `payment_session_mismatch`, `payment_amount_mismatch`, `invalid_payment_signature`, `duplicate_payment_ref`, `confirmation_in_progress`, `reconciliation_in_progress`, `refund_conflict`, `refund_payment_ref_missing`, `refund_failed`, `calendar_unavailable`, `internal_error`
<!-- /generated:error-codes -->

`validation_failed` messages always name the field and the rule. `details` (`ApiErrorDetails`)
can carry `field`, `allowed` (accepted values, for closed sets) and `quote` (the new quote, on
`quote_changed`). Switch on `code`, never on `message` or the status alone.

## Booking events

Sent to in-process hooks and to signed webhooks, both from the same durable outbox:

<!-- generated:booking-events -->
`booking.confirmed`, `booking.cancelled_by_customer`, `booking.cancelled_by_operator`, `booking.rescheduled`, `booking.no_show`, `booking.reminder`, `payment.dispute_created`
<!-- /generated:booking-events -->

An unknown name in a subscriber's `events` filter fails the build with the valid list. A
subscriber can also name `settings.changed`, which fires once per admin save (best effort, not
durable) so a static site can rebuild.

Hooks are registered on the runtime. Webhooks are declared in config, since the URL is ordinary
config and only the signing key is secret:

```ts
defineCloudflareReservaRuntime<Env>({
  providers,
  hooks: [
    { name: 'analytics', handler: async (event, booking) => track(event, booking?.reference) },
    { name: 'ops', durable: true, events: ['booking.confirmed'], handler: pushToOps },
  ],
});

// reserva.config.ts
webhooks: [{ name: 'partner', url: 'https://partner.example/reserva', secretBinding: 'PARTNER_WEBHOOK_SECRET', events: ['booking.confirmed'] }]
```

A plain hook is fire-and-forget: one warning log on failure, no retry. A `durable` hook and every
webhook get an outbox row, with retries and eventual abandonment.

### Webhook envelope

```json
{
  "apiVersion": 1,
  "id": "<bookingId>/<family>:<name>:<event>[:<discriminator>]",
  "event": "booking.confirmed",
  "occurredAt": "2026-06-14T08:00:00.000Z",
  "data": { "booking": { "id": "…", "reference": "…", "status": "confirmed", "startsAt": "…", "updatedAt": "…" } }
}
```

The envelope is written in the same transaction as the change that caused it, and every retry
sends the same bytes. It records the event, not the booking's current state. Order isn't
guaranteed: deduplicate on `id`, and compare `occurredAt` or `booking.updatedAt` before
overwriting newer local data.

### Verifying a delivery

Requests are signed per [Standard Webhooks](https://www.standardwebhooks.com/) (`webhook-id`,
`webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>` over
`<id>.<timestamp>.<body>`), so any compliant verifier works:

```ts
import { Webhook } from 'standardwebhooks';

export async function POST({ request }: { request: Request }) {
  const body = await request.text();
  const wh = new Webhook(process.env.PARTNER_WEBHOOK_SECRET!); // 'whsec_<base64>'
  let envelope: unknown;
  try {
    envelope = wh.verify(body, Object.fromEntries(request.headers));
  } catch {
    return new Response('bad signature', { status: 400 });
  }
  // ... dedupe on envelope.id, then handle envelope.event
  return new Response(null, { status: 204 });
}
```

Generate a key with `openssl rand -base64 32` and store it as `whsec_<that value>` in the Worker
secret named by `secretBinding`. `webhook-timestamp` is new on each attempt (300-second
tolerance). A non-2xx response or a network error counts as a failed attempt and is retried, then
abandoned into an incident.

## Migrations

Reserva owns its D1 schema. `reserva-migrate` wraps `wrangler d1 migrations apply` and points it
at the packaged `migrations/`:

```bash
bunx reserva-migrate --local            # local dev database
bunx reserva-migrate                    # remote
bunx reserva-migrate <db-name-or-binding> --env staging
```

It reads `wrangler.jsonc`/`.json`/`.toml` and picks a D1 entry: the `RESERVA_DB` binding, your
only `d1_databases` entry, or the one you name. It refuses to run if that entry's
`migrations_dir` points elsewhere, since that's your own migration pipeline and Wrangler keeps
one ledger per database. Give Reserva its own D1 database.

On each isolate's first request, the runtime checks the ledger and a schema fingerprint, and
throws naming any missing migration instead of failing later with a raw SQL error.

## Failure → remedy

| What you see | Cause | Fix |
|---|---|---|
| `Astro.locals.runtime.env has been removed in Astro v6` | reading bindings through `locals.runtime.env` | Reserva reads them from `cloudflare:workers`; don't touch `locals.runtime` |
| Build fails in `astro:config:setup` with a Zod path | the config was rejected | fix the named key; the message has the rule |
| `holdMinutes` rejected | below 35 | payment sessions need the headroom; raise it |
| Startup throw: "migration … not applied" | the database is behind the package | `bunx reserva-migrate` (`--local` in dev) |
| Startup throw: ledger says applied but fingerprint mismatch | a migration filename collision in a shared database | give Reserva its own D1 database |
| Startup throw about `adminAuth` | neither or both of `config.admin.access` and a custom `adminAuth`, with `admin`/`ops` routes on | configure exactly one |
| `403` from `/booking/admin` or an operator route | `adminAuth` returned `null` or threw | deliberate; check the Access application or your callback |
| Admin POST gets 403, GET works | the origin check refused a cross-origin form | send the form from the same origin |
| Admin form says "This page expired" | its CSRF token expired or belongs to another user | reload and submit again; nothing changed |
| `400 invalid_payment_signature` on the payment webhook | the signing secret doesn't match the endpoint | a live endpoint's secret never verifies a test-mode event, and vice versa |
| `409 payment_amount_mismatch` | amount paid ≠ the booking's stored price | never expected; alert on it, don't retry in a loop |
| `503 confirmation_in_progress` | another caller holds the confirmation lease | retry; the payment webhook's retry is the intended path |
| `429 too_many_holds` | `booking.maxHoldsPerIp` reached (5 by default) | expected under abuse; raise it where many customers share an IP (a hotel desk), or `null` to remove it |
| `409 quote_changed` on checkout | the price or offer changed since the quote | show `details.quote`, let the customer confirm, retry with its fingerprint |
| `400 validation_failed` on `quoteFingerprint` | checkout sent `referralCode` without a fingerprint | call `quote` with the code first and send its `quoteFingerprint` |
| `503 partner_storage_unavailable` | the partner registry couldn't be read | retry; keep the referral code |
| `400 validation_failed` on `referralCode` | the code isn't lowercase `a-z0-9_-` | lowercase it before sending |
| Partner discount never applies | `partnerOffers` not enabled, no minimum for the currency, or the service uses row pricing | enable it in the runtime; offers need formula pricing |
| Log: `reserva reconciliation query budget reached` | the sweep's backlog needs more D1 queries than one invocation allows (50 on Free) | expected after an outage; later ticks drain the rest. On Paid, pass `queryBudget` to `scheduledHandler` |
| `400 validation_failed: pickup …` | the service has no `location`, or the id isn't declared | omit `pickup` for a location-less service; otherwise use a declared id |
| `<ManageBooking />` throws about a missing endpoint | its route group is off in `config.routes` | pass `endpoint`, or turn the group back on |
| Browser console: "blocked by CORS policy" calling the API from another site | the page's origin isn't in `config.routes.cors.origins`, or differs by scheme, port or `www` | add the exact origin the console shows; a path, trailing slash or wildcard fails the build |
| Can't resolve `virtual:reserva/runtime` | `reserva()` missing from `integrations`, or types not synced | add the integration; run `astro sync` |

## Provider ports

Every integration point is an interface in `@reservajs/astro/core`, passed to the runtime in
`providers`.

| Port | Required | Optional |
|---|---|---|
| `PaymentProvider` | `createCheckout`, `parseWebhook`, `getSession`, `refund` | `cancelPayment`, `validateConfig` |
| `CalendarProvider` | `listEvents`, `createEvent`, `patchEvent`, `deleteEvent` | `cacheKey` |
| `EmailProvider` | `send` | `recipientsForEvent`, `sendToRecipient`, `sendMessage` |
| `OperationalAlertSink` | `send(alert, config)` | none |

`EmailProvider.sendMessage({ to, subject, html, text })` sends a message with no booking behind
it. Without `providers.alerts`, an email provider that implements it also receives operational
alerts (logged once), sent to the `business.contact.email` currently saved in the admin. An
explicit `providers.alerts` always wins. Writing an adapter: [`docs/providers.md`](./docs/providers.md).

## Boundaries

- Reserva mounts its routes with `injectRoute()`. Astro 7 treats `src/fetch.ts` as a custom fetch
  entrypoint; don't use that filename for anything else.
- No customer booking form ships in the package. Build it on the public API;
  `examples/smoke-site` in the repository is a complete reference.
- Secrets never go in `ClientConfig`. Only binding names do, through `secretBindings` and
  `webhooks[].secretBinding`.
- IP rate limiting for the public endpoints belongs at the Cloudflare edge (WAF), not in Reserva.
