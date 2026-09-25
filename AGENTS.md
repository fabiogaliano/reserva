# Reserva — integration contract

A booking engine for fixed-capacity time slots, built as an Astro integration — runs in your own Cloudflare account on Workers + D1, no per-booking fees.

This file ships inside the `@reservajs/astro` package. It is the contract a coding
agent needs to wire Reserva into a site without reading the library's source: what to
install, what to declare, what the deployment answers, and what every failure means.
The route table and the two vocabulary catalogs below are generated from the package's
own exported constants, so they cannot describe a version other than the installed one.

Everything Reserva treats as a closed set is exported as a **runtime value**, not just a
type: `routeManifest`, `API_ERROR_CODES` (+ `ApiErrorCode`, `isApiErrorCode`) and
`BOOKING_EVENTS` come from `@reservajs/astro/core`. Enumerate from those, never from a
hand-copied list.

## Quickstart

```bash
bun add @reservajs/astro
bun add @reservajs/stripe   # the official payment adapter; optional, see "Payments"
```

Four files, then migrations: `reserva.config.ts` (plain data, imported only by
`astro.config.ts`), `astro.config.ts` (which passes that config to `reserva({ config })`
alongside the `@astrojs/cloudflare` adapter), `src/reserva-runtime.ts` (the runtime module, the
only place provider instances and secrets exist), and `wrangler.jsonc` (the `RESERVA_DB` D1
binding). `README.md`, shipped beside this
file, carries all four verbatim under its Quickstart heading, and the repository builds a real
site out of exactly those blocks on every run of its test suite — read them there rather than
from a copy that can drift.

```bash
bunx reserva-migrate --local   # dev database
bunx reserva-migrate           # remote database
```

The runtime module is a separate file because Astro serializes integration options during the
build, and provider instances (clients, closures, secrets) cannot survive that.
`runtimeEntrypoint` defaults to `./src/reserva-runtime.ts` (resolved against the project root)
and only has to be passed for a different path; a missing file throws with the resolved path.

Build the funnel on the typed browser client rather than raw `fetch`: it is the only export that
knows the deployment's route table and the error envelope.

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

`@reservajs/astro/client` imports no Astro, Node or Cloudflare code; `@reservajs/astro/dev`
exports `devProviders()` for `astro dev`. See [`docs/api.md`](./docs/api.md).

The integration validates `config` once at `astro:config:setup` and serializes the result into
`virtual:reserva/config` as `{ config, routes: { paths, groups, dev } }`. That is the single
config source: `defineCloudflareReservaRuntime(options)` / `defineReservaRuntime(options)` take
no config argument and read it from there, and `routes.dev` is `true` only in `astro dev`
output. The runtime module itself is resolved at request time through `virtual:reserva/runtime`.

## Config schema outline

`ClientConfig` (exported from `@reservajs/astro`) is validated by Zod at build time.
Every failure names the key path and the rule that rejected it. `ClientConfig` is what you
write; `ResolvedClientConfig` (same module) is what the runtime and a provider adapter
receive once the defaults below have been applied.

| Key | Required | Shape |
|---|---|---|
| `business` | yes | `{ name, shortCode, url, timezone (IANA), currency (ISO 4217, lowercase), contact: { email, phone, phoneSecondary?, whatsapp? } }` |
| `capacity` | yes | `{ default: number }` — units available per slot |
| `admin` | no | `{ access?: { teamDomain, aud }, locale? }` — defaults to `{}`. `access` present selects Cloudflare Access; absent requires a custom `adminAuth` while the `admin`/`ops` routes are on |
| `hours` | no | `Array<ScheduleRule>` (same shape as a service `schedule` rule) — the business's opening hours, inherited by every service that declares no `schedule`; each service derives its own last departure from a shared `lastEnd` |
| `pricing` | no | `{ surcharges?: Record<pickupId, minor>, maxUnits?, surchargeScope?: 'unit' \| 'booking' }` — defaults to `{ surcharges: {}, maxUnits: 1, surchargeScope: 'unit' }`; the shared half of formula pricing, inherited field by field by every formula service that leaves it undeclared |
| `services` | yes | `Record<slug, ServiceConfig>` |
| `booking` | no | `{ minNoticeHours, maxHorizonDays, holdMinutes (≥35), cancelCutoffHours, reschedule: { enabled, cutoffHours }, limitedThreshold, calendarMaxStaleSeconds, reminderHoursBefore, maxHoldsPerIp?, tokenExpiryDays? }` — the whole key defaults, as does each of its own: `0`, `90`, `35`, `24`, `{ enabled: true }` with `cutoffHours` inheriting `cancelCutoffHours`, `2`, `900`, `24` (`reminderHoursBefore: 0` disables the reminder email) |
| `locales` | no | `{ supported: string[], default: string }` — defaults to `{ supported: ['en'], default: 'en' }` |
| `legal` | no | `{ termsUrl? }` — defaults to `{}`; `termsUrl` itself is optional |
| `webhooks` | no | `Array<{ name, url, secretBinding, events? }>` |
| `routes` | no | `{ admin?, ops?, manage? }` — all default `true` |
| `ui` | no | `{ messages?: Record<locale, Partial<messages>>, faviconUrl?, headHtml?, branding?: { logoUrl?, logoWidth?, logoHeight?, colorScheme?: 'auto' \| 'light' \| 'dark', accentColor? (hex), mastheadBackground?, fontFamily? }, confirmation?: { statusPlacement?: 'masthead' \| 'ticket' } }`. `branding` affects only the confirmation and manage pages. Page hook classes (`bk-page--*`, `data-bk-status`) and the `- ` list syntax in messages are listed in `docs/customization.md` |
| `emails` | no | `{ locale?, branding?, messages? }` |

`ServiceConfig`:

| Key | Required | Shape |
|---|---|---|
| `title` | yes | customer-facing display name; `LocalizedText` (a string or `Record<locale, string>`) |
| `durationMin` / `turnaroundMin` | yes | slot length and the gap Reserva keeps after it |
| `schedule` | no* | `Array<{ from?, to?, days: number[], firstStart?, lastStart?, lastEnd?, intervalMin }>` (`days`: 0 = Sunday; `firstStart` defaults to `'09:00'`). *Required unless a top-level `hours` block exists to inherit. Declare `lastStart` (latest departure) or `lastEnd` (time the last booking must be finished by), never both; `lastEnd` derives the last departure as the latest grid start that still fits `durationMin`. Neither ⇒ `lastStart: '18:00'`. The resolved rule always carries `lastStart` and keeps `lastEnd` for display |
| `pricing` | yes | Rows `Array<{ maxQuantity, pickup?, priceMinor }>` — the tightest row whose `maxQuantity` covers the request wins, in any row order; `pickup` names one of the service's pickup options, may be omitted when the service resolves to exactly one, and must be absent when the service declares no `location`. Or a formula `{ baseMinor, surcharges?, maxUnits?, surchargeScope? }` — `baseMinor × ceil(quantity / occupancy.seatsPerUnit)` plus the chosen pickup option's surcharge (per unit or per booking), party capped at `maxUnits × seatsPerUnit`; undeclared fields inherit top-level `pricing`, and every declared pickup option must be priced (`0` allowed). `priceFor`, `resolvedPriceTableFor`, `pricingCombinations`, `lowestPriceMinor`, `maxQuantityFor` on `@reservajs/astro/core` take either shape |
| `occupancy` | no* | `{ seatsPerUnit: number }` — a booking takes `ceil(quantity / seatsPerUnit)` capacity units. Absent ⇒ one unit per booking. *Required when `pricing` is a formula. (Replaces the removed `occupancyFor` function, which is now a validation error) |
| `meta` | no | `Record<string, unknown>` — opaque JSON reserva never reads, echoed back by the catalog. Must be JSON-serializable and under 8 KB. `MeetingPoint` takes one too |
| `location` | no | `{ meetingPoints?: Array<{ id, label, mapsUrl }>, pickupOptions?: Array<{ id, label, hint?, requiresAddress, usesMeetingPoint }> }` — declare at least one of the two. Pickup ids are opaque, so `label` is required and localized; address collection keys off `requiresAddress`, never off the id. `meetingPoints` on its own implies the single option `{ id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true }`, the one option named from a message key (`pickup.meetingPoint`). Omit `location` for a service with no pickup axis at all |
| `metadataFields` | no | `Array<{ key, label, type: 'text' \| 'number' \| 'boolean' \| 'select', options?, required?, maxLength? }>` — the entire declarable DSL; there are no conditional fields or custom validators |

Every human-readable label in config — `title`, meeting-point `label`, pickup `label`/`hint`,
metadata field and option labels — is `LocalizedText`: a plain string or a `Record<locale, string>`
resolved with the same candidate-locale → base-language → default-locale chain as `ui.messages`.

## Routes

Every route is server-only (`prerender: false`). `reserva({ routePrefix })` prepends a
prefix to all of them; `config.routes` disables the `admin`, `ops`, and `manage` groups.
The `customer` and `webhook` groups are load-bearing and cannot be disabled.

<!-- generated:routes -->
| Route id | Path | Group |
|---|---|---|
| `availability` | `/api/booking/availability` | customer |
| `checkout` | `/api/booking/checkout` | customer |
| `quote` | `/api/booking/quote` | customer |
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

Request/response types for every one of these are exported from `@reservajs/astro/core`:
`AvailabilityResponse`, `QuoteRequest`/`QuoteResponse`, `CheckoutRequest`/`CheckoutResponse`,
`CatalogResponse`, `StatusResponse`, `ManageResponse`, `ManageActionResponses`,
`OpsHealthResponse`, `ApiErrorEnvelope`. Collections are always present and empty rather
than absent; optional modules are always present and `null`. Nothing needs a key-presence
check.

The booking flow: `catalog` (what can be booked) → `availability` (when) → `quote` (how
much) → `checkout` (hold + payment session) → the payment provider redirects to
`/booking-confirmation?sessionId=…`, which polls `status` until the webhook confirms.
`StatusState` is `pending | confirmed | failed | cancelled | expired | not_found`. `failed`
means the payment session completed but its payment was not acceptable (a delayed payment
method, or a mismatched amount/currency): no booking was made, it is terminal for the
customer, and it opens an operational incident for the operator. The confirmation page polls
at most 20 times (~60 s) before showing a "still waiting" page with contact details.

Endpoint field names are `serviceSlug`, `pickup`, `start` and `sessionId` everywhere. The old
spellings (`?service=`, `?session_id=`, `pickupType` in the checkout body, `newStart` in the
reschedule body) still read for one minor and log `deprecated field` once per isolate; they are
already absent from the exported request types. The webhook envelope's booking keeps `pickupType`.
`CheckoutResponse` carries `paymentDeadline`; `ManageResponse` carries `cancelDeadline` and
`rescheduleDeadline` (`deadline` is a deprecated alias of the first). Four hours after creation,
`status` answers `confirmed` with a `ConfirmationSummary` (`reference`, `serviceTitle`, `start`,
`end`, `locale`) instead of the full booking.

## Introspection

Two endpoints let a deployment describe itself without source access:

- `GET /api/booking/catalog?locale=` — public. Services with locale-resolved titles,
  duration, declared location options, declared metadata fields, the service's `pricing`
  (rows `{ maxQuantity, pickup, priceMinor }[]`, `pickup` null without a pickup axis, or a
  formula `{ baseMinor, surcharges, maxUnits, surchargeScope, seatsPerUnit }`), its
  `maxQuantity` and `fromPriceMinor`, plus `locales`, `currency`, `maxHorizonDays` and `policy`
  (`cancelCutoffHours`, `reschedule.{enabled,cutoffHours}`). Never exposes schedules, turnaround,
  or capacity. Build a
  booking UI from this; do not hardcode config or prices in the consumer.
- `GET /api/booking/ops/health` — admin-authenticated. `schema` (migrations applied +
  fingerprint match), `outbox` (pending/abandoned counts by family, oldest pending age),
  `incidents` (open count), `security` (`csrfTokenLayer`/`tokenEncryption` on or off from the
  secrets that are set, and the resolved `adminAuth` path), `reconciliation` (`lastRunAt`,
  `lastSummary`). Takes no parameters. Its one write is the `reconciliation_stale` incident: the
  read opens it when the sweep has not run for three cadences and resolves it once it has, an
  idempotent upsert keyed on the sweep, so polling never re-alerts.

## Error codes

Every failure at every status is `{ error: { code, message, details? } }`, where `code` is one of:

<!-- generated:error-codes -->
`validation_failed`, `method_not_allowed`, `payload_too_large`, `forbidden`, `not_found`, `past_cutoff`, `invalid_transition`, `slot_unavailable`, `too_many_holds`, `payment_session_mismatch`, `payment_amount_mismatch`, `invalid_payment_signature`, `duplicate_payment_ref`, `confirmation_in_progress`, `reconciliation_in_progress`, `refund_conflict`, `refund_payment_ref_missing`, `refund_failed`, `calendar_unavailable`, `internal_error`
<!-- /generated:error-codes -->

`validation_failed` messages always name the offending field and the rule that rejected
it. The optional `details` (`ApiErrorDetails`) carries `{ field?, allowed? }` — the rejected
field's name and, for a closed set, the accepted values. Switch on `code`, never on `message`
or on the status alone.

## Booking events

Emitted to in-process hooks and to signed outbound webhooks, both from the same durable
outbox:

<!-- generated:booking-events -->
`booking.confirmed`, `booking.cancelled_by_customer`, `booking.cancelled_by_operator`, `booking.rescheduled`, `booking.no_show`, `booking.reminder`, `payment.dispute_created`
<!-- /generated:booking-events -->

An unknown name in a subscriber's `events` filter fails the build with the valid list.

In-process hooks are registered on the runtime; webhooks are declared in config because a
URL is ordinary configuration and only the signing key is secret:

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

A non-`durable` hook is fire-and-forget (one warning log, never retried). A `durable` hook
and every webhook get an outbox row with retries and abandonment.

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

The envelope is serialized in the same atomic write as the mutation that produced it, and
every retry sends those exact bytes. It is the historical record of an occurrence, not a
view of current state. Delivery order is not guaranteed: deduplicate on `id`, and compare
`occurredAt`/`booking.updatedAt` before overwriting newer local state.

### Verifying a delivery

Requests are signed per the [Standard Webhooks](https://www.standardwebhooks.com/)
specification (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`
over `<id>.<timestamp>.<body>`), so any spec-compliant verifier works unchanged:

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

Generate a signing key with `openssl rand -base64 32` and store it as `whsec_<that value>`
in the Worker secret named by `secretBinding`. `webhook-timestamp` is fresh per attempt
(300-second tolerance); a non-2xx or a network failure is a failed attempt and is retried,
then abandoned into an operational incident.

## Migrations

Reserva owns its D1 schema. `reserva-migrate` wraps `wrangler d1 migrations apply` and
points it at the packaged `migrations/` directory:

```bash
bunx reserva-migrate --local            # local dev database
bunx reserva-migrate                    # remote
bunx reserva-migrate <db-name-or-binding> --env staging
```

It reads your `wrangler.jsonc`/`.json`/`.toml`, selects a D1 entry (the `RESERVA_DB`
binding, your only `d1_databases` entry, or the one you name), and refuses to run if that
entry already points `migrations_dir` somewhere other than Reserva's — that is your own
migration pipeline, and Wrangler has one shared ledger. Give Reserva its own D1 database.

At the first request in each isolate the runtime verifies the ledger *and* a schema
fingerprint, and throws naming the unapplied migration instead of failing later with a raw
SQL error.

## Failure → remedy

| What you see | Cause | Fix |
|---|---|---|
| `Astro.locals.runtime.env has been removed in Astro v6` | reading bindings through `locals.runtime.env` | Reserva reads them from `cloudflare:workers`; don't touch `locals.runtime` |
| Build fails in `astro:config:setup` with a Zod path | `validateConfig` rejected the config | fix the named key; the message carries the violated rule |
| `holdMinutes` rejected | value below 35 | payment sessions need the headroom; raise it |
| Startup throw: "migration … not applied" | D1 schema is behind the package | `bunx reserva-migrate` (`--local` in dev) |
| Startup throw: ledger says applied but fingerprint mismatch | migration filename collision in a shared database | give Reserva a dedicated D1 database |
| Startup throw about `adminAuth` | neither or both of `config.admin.access` and a custom `adminAuth` configured while `admin`/`ops` routes are on | configure exactly one |
| `403` from `/booking/admin` or any operator route | `adminAuth` returned `null` or threw | fail-closed by design; check the Access application (or your callback) |
| Admin POST rejected, GET fine | same-origin CSRF layer | send the form from the same origin; set `RESERVA_CSRF_SECRET` for the token layer |
| `400 invalid_payment_signature` on the payment webhook | signing secret does not match the endpoint sending events | a live endpoint's secret never verifies a test-mode event, and vice versa |
| `409 payment_amount_mismatch` | captured amount ≠ the booking's stored price | never expected; alert on it, do not retry-loop it |
| `503 confirmation_in_progress` | another caller holds the confirmation lease | retry; the payment webhook's retry is the intended path |
| `429 too_many_holds` | `booking.maxHoldsPerIp` reached | expected under abuse; raise the cap or leave it |
| `400 validation_failed: pickup …` | service has no `location`, or the id is not declared | omit `pickup` for a location-less service; otherwise use a declared id |
| `<ManageBooking />` throws about a missing endpoint | its route group is disabled in `config.routes` | pass an explicit `endpoint`, or re-enable the group |
| Consumer build cannot resolve `virtual:reserva/runtime` | `reserva()` missing from `integrations`, or types not synced | add the integration; run `astro sync` |

## Provider ports

Every integration point is an interface in `@reservajs/astro/core`; the runtime receives
implementations through `providers`.

| Port | Required members | Optional members |
|---|---|---|
| `PaymentProvider` | `createCheckout`, `parseWebhook`, `getSession`, `refund` | `cancelPayment`, `validateConfig` |
| `CalendarProvider` | `listEvents`, `createEvent`, `patchEvent`, `deleteEvent` | `cacheKey` |
| `EmailProvider` | `send` | `recipientsForEvent`, `sendToRecipient`, `sendMessage` |
| `OperationalAlertSink` | `send` | — |

`EmailProvider.sendMessage({ to, subject, html, text })` sends a plain message with no booking
behind it. When `providers.alerts` is absent and the email provider implements it, the runtime
wires `emailAlertSink(providers.email, { to: business.contact.email })` automatically and logs it
once. An explicit `providers.alerts` always wins.

## Boundaries

- Reserva mounts routes with `injectRoute()`. Astro 7's `fetchFile` option means a
  project-level `src/fetch.ts` becomes a custom fetch entrypoint — do not use that filename
  for unrelated code.
- There is no customer-facing booking funnel UI in the package. Build it on the public
  API; `examples/smoke-site` in the repository is a complete reference consumer.
- Secrets never belong in `ClientConfig`. Only names travel, through `secretBindings`.
- IP rate limiting for the public endpoints belongs at the Cloudflare edge (WAF), not in
  this library.
