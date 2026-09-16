# The booking API

The injected endpoints in detail — the ones whose contract is not obvious from their name —
plus the wire types, the error envelope, and the deliberate behavior behind a few status codes.

The canonical route table is generated from the package's route manifest and lives in
[`../README.md`](../README.md#injected-routes); [`../AGENTS.md`](../AGENTS.md) carries the same
table inside the published tarball.

## Endpoint notes

- `GET /api/booking/availability?serviceSlug=&quantity=&from=&to=` — bookable slots per day. Each
  slot is `{ start, date, time, remaining }`: `start` is the ISO instant with its offset, `date`
  (`YYYY-MM-DD`) and `time` (`HH:MM`) are the same instant in the business timezone, already
  projected so a consumer never re-derives it. `remaining: number | null` is published only at or
  below `config.booking.limitedThreshold` and `null` above it (exact capacity is
  deployment-private). `quantity` is optional and defaults to 1. The range may span up to
  `maxHorizonDays`; a consumer never chunks requests.
- `POST /api/booking/quote` — `{ serviceSlug, quantity, pickup? }` →
  `{ priceMinor, currency }`. The same validation and pricing path checkout charges on: a
  consumer that shows a price never computes one. A `locale` key is accepted and ignored (a price
  never varies by locale), so one payload builder can serve quote and checkout.
- `GET /api/booking/catalog?locale=` — everything needed to build a booking flow before a date
  is chosen: per service `slug`, locale-resolved `title`, `durationMin`, `location` (or
  `null`), `metadataFields` (`[]` for none), `pricing` (the configured rules, each
  `{ maxQuantity, pickup, priceMinor }`, `pickup` null where the service has no pickup axis)
  and `fromPriceMinor` (the lowest of them, for a "from" price); top-level
  `locales`, `currency`, `maxHorizonDays`. Every service and every meeting point also carries
  `meta`: the opaque JSON object its config declared, echoed back verbatim (`{}` when none) so a
  site can fetch prices and its own content in one call. Never exposes schedules, turnaround,
  capacity, or occupancy — a charged price still comes from `/api/booking/quote`.
  `Cache-Control: public, max-age=60`.
- `POST /api/booking/checkout` —
  `{ serviceSlug, start, quantity, pickup?, locale, meetingPointId?, metadata? }` →
  `{ checkoutUrl, bookingId, reference, paymentDeadline }`.
  `meetingPointId` is required when the service declares more than one meeting point and the
  selected pickup option uses one; a single-point service resolves to its first declared
  point. `paymentDeadline` (UTC ISO) is when the payment page closes; the hold may outlive it by
  a few minutes.
- `GET /api/booking/status?sessionId=` — the confirmation page's poll target. `status` is
  `pending | confirmed | failed | cancelled | expired | not_found`. `failed` means the payment
  session completed but its payment was not acceptable — a delayed payment method, or an amount
  or currency that does not match the booking. No booking was made, the hold is released, the
  payment is cancelled where the adapter can, and an operational incident is opened. It is
  terminal: polling again cannot change it. For four hours after the booking was created a
  `confirmed` answer carries the full `ConfirmationBooking`; after that it carries the
  `ConfirmationSummary` `{ reference, serviceTitle, start, end, locale }` instead, and the
  confirmation page says the details were emailed.
- `GET /api/booking/manage?token=` — `cancelDeadline` and `rescheduleDeadline` are the two
  cutoffs, as UTC instants; they are independent policies. `deadline` remains as an alias of
  `cancelDeadline` for one minor and is then removed.
- `GET /api/booking/ops/health` — read-only deployment health behind admin auth: `schema`
  (migrations and fingerprint), `outbox` (pending/abandoned counts by family, oldest pending
  age), `incidents` (open count).
- `GET /booking/assets/reserva.css` and `/booking/assets/reserva.js` — static first-party
  assets for the server-rendered pages; see
  [`customization.md`](./customization.md#components-and-theming).

## Wire types and error codes

Every request and response shape is exported as a type from `@reservajs/astro/core`
(`AvailabilityResponse`, `QuoteRequest`/`QuoteResponse`, `CheckoutRequest`/`CheckoutResponse`,
`CatalogResponse`, `StatusResponse`, `ConfirmationSummary`, `ManageResponse`,
`CancelRequest`/`RescheduleRequest`, `ManageActionResponses`,
`OpsHealthResponse`, `ApiErrorEnvelope`, `ApiErrorDetails`); the handlers are typed against the same
declarations. Collections are always present and empty (`[]`, `{}`) and optional modules are
always present and `null`, so nothing branches on key presence.

Every failure is `{ error: { code, message, details? } }`. The `code` is one of a closed set
exported as `API_ERROR_CODES` (with the `ApiErrorCode` union and `isApiErrorCode` guard), listed
in the [README](../README.md#injected-routes). `validation_failed` messages name the offending
field and the rule that rejected it. `details` (type `ApiErrorDetails`) is optional and carries
`{ field?: string; allowed?: string[] }`: the rejected input's name and, when the input is a
closed set (service slugs, pickup ids, meeting point ids, `select` metadata options), the values
it accepts.

### Building a price table

Pricing rows are breakpoints (`{ maxQuantity, pickup?, priceMinor }`): the tightest row whose
`maxQuantity` covers the request wins. `@reservajs/astro/core` exports the three helpers that
apply that rule, so a funnel never re-derives it from the rows itself. All three are order-safe —
they accept the catalog's rules or a raw config module, sorted or not.

```ts
import { priceFor, resolvedPriceTableFor, pricingCombinations } from '@reservajs/astro/core';

priceFor(service, 3, 'custom_pickup');    // one charged amount, in minor units
resolvedPriceTableFor(service);           // { [pickup or '']: number[] } indexed by quantity
pricingCombinations(service);             // [{ quantity, pickup, priceMinor }, …] — one row per cell
```

`resolvedPriceTableFor` is what a build-time price grid reads (`table[pickup][quantity]`);
`pricingCombinations` is the same data flattened, for rendering a list. `service` is anything with
a `pricing` array, so `catalog.services[i]` works directly.

Locale-bearing endpoints negotiate the requested tag against `config.locales.supported` by
longest prefix match; an unsupported tag falls back to `locales.default`. Every human-readable
label in config (`services.<slug>.title`, meeting-point and pickup labels and hints, metadata
labels) is a plain string or a `Record<locale, string>` resolved with the same chain, so a
response's `title`, `serviceTitle` and pickup labels come back in the request's — or the
booking's — locale.

### One vocabulary, and the deprecated spellings

The field names are `serviceSlug`, `pickup`, `start` and `sessionId` on every endpoint that takes
them. The older spellings still read for one minor and log `deprecated field` once per isolate:
`?service=` on availability, `?session_id=` on status, `pickupType` in the checkout body, and
`newStart` in the reschedule body. They are already gone from the exported request types. The
webhook envelope's booking keeps `pickupType`, which is frozen for this release line.

## The typed browser client

`@reservajs/astro/client` is the browser-safe entry: it imports nothing but the wire types, the
error catalog and the route pattern table, so it carries no Astro, Node or Cloudflare code into a
bundle.

```ts
import virtualConfig from 'virtual:reserva/config';
import { createReservaClient, isReservaApiError } from '@reservajs/astro/client';

const reserva = createReservaClient({ paths: virtualConfig.routes.paths });

const catalog = await reserva.catalog({ locale: 'pt-PT' });
const days = await reserva.availability({ serviceSlug: 'old-town', quantity: 2, from, to });
const { checkoutUrl } = await reserva.checkout({ serviceSlug, start, quantity, locale, pickup });
```

- `paths` (the deployment's resolved table, which already honours `routePrefix`) and `base` (a
  plain prefix or origin the default patterns hang off) are mutually exclusive; with neither, the
  client uses the default patterns on the current origin.
- `fetch` swaps the transport (tests, a server-side call); `bearer` is the operator secret the
  `operator.*`, `opsHealth` and `opsReconcile` methods send.
- Methods: `catalog`, `availability`, `quote`, `checkout`, `status`, `manage`, `cancel`,
  `reschedule`, `operator.cancel` / `operator.reschedule` / `operator.noShow`, `opsHealth`,
  `opsReconcile`. Each takes an optional `{ signal }`; reads whose answer moves (availability,
  status, manage) are sent `cache: 'no-store'`.
- Every failure — a `validation_failed` envelope, a bare 502 from a proxy, or a dropped
  connection — arrives as a `ReservaApiError` with `status`, `code` (an `ApiErrorCode`) and
  `details`. A network failure carries `status: 0` and `code: 'internal_error'`. Narrow with
  `isReservaApiError(cause)`.

Calendar helpers ship from the same entry, so a date picker stops re-deriving them:
`openDays(response)`, `firstOpenDay(response)`, `isDayDisallowed(response)` (UTC getters, matching
the `Date.UTC` dates a `<calendar-date>` hands its callback), `dateKey(date)` and
`horizonRange(catalog, today)`.

Presentation helpers live in `@reservajs/astro/ui`: the message catalog (`defaultMessages`,
`resolveMessages`, `formatMessage`) plus the formatters Reserva's own pages render with —
`formatDateTime`, `formatDayDate`, `formatDateParts`, `formatPrice`, `googleCalendarUrl`,
`icsDataUrl`.

Rate limiting for the public routes belongs at the Cloudflare edge (WAF or rate-limiting
rules), not inside this library.

One Astro 7 footgun: `src/fetch.ts` in your project is treated as a custom fetch-handler
entrypoint (the `fetchFile` option defaults to `'fetch'`). Reserva does not need that file;
do not use the name for unrelated code.

## Subscribers and the webhook envelope

An in-process hook's `name` matches `^[a-z][a-z0-9-]{0,31}$` and is unique among hooks; its
`events` filter defaults to every event in `BOOKING_EVENTS`. `handler(event, booking, { id,
occurredAt, config })` receives the same wire booking projection an outbound webhook carries,
plus the envelope id below.

The subscribable vocabulary is `WEBHOOK_EVENTS` = `BOOKING_EVENTS` + `SETTINGS_EVENTS`:

| Event | Payload |
| --- | --- |
| `booking.confirmed` | `data.booking` |
| `booking.cancelled_by_customer` | `data.booking` |
| `booking.cancelled_by_operator` | `data.booking` |
| `booking.rescheduled` | `data.booking` |
| `booking.no_show` | `data.booking` |
| `booking.reminder` | `data.booking` — fired by the reconciliation sweep `booking.reminderHoursBefore` hours before the start (default 24, `0` disables); the built-in subscriber is the customer reminder email |
| `settings.changed` | `data.changes` — see below |

`settings.changed` is never implied by an absent `events` filter: a subscriber receives it only
by naming it. It is also never durable — the outbox is keyed by booking, and a settings save has
none — so it is delivered best-effort from the admin request: up to three attempts (2 s then 8 s
backoff), then `logger.error('settings webhook delivery failed', …)` and no incident row. A
missed rebuild is recovered by saving again or deploying by hand.

```json
{
  "apiVersion": 1,
  "id": "settings/<changeBatchId>",
  "event": "settings.changed",
  "occurredAt": "2026-06-14T08:00:00.000Z",
  "data": { "changes": [{ "domain": "setting", "key": "booking.cancelCutoffHours", "action": "upsert", "actor": "ops@example.com" }] }
}
```

`domain` is `setting` | `day_override` | `capacity_default` and `action` is `upsert` | `delete`,
mirroring the `admin_changes` rows the save wrote; `key` is the setting key or the date. New
values are not in the payload — read them back from `/api/booking/catalog`. An in-process hook
subscribed to it receives `(event, null, { id, occurredAt, config, changes })`: `booking` is
`null` for this event, narrowed by the event name.

> **The booking payload's field names are frozen** for this release line
> (`serviceSlug`, `quantity`, `priceMinor` + `currency`, `pickupType`); any further change to
> these names bumps `apiVersion`.

Each webhook delivery POSTs this JSON body:

```json
{
  "apiVersion": 1,
  "id": "<bookingId>/<family>:<name>:<event>[:<discriminator>]",
  "event": "booking.confirmed",
  "occurredAt": "2026-06-14T08:00:00.000Z",
  "data": { "booking": { "id": "...", "reference": "...", "status": "confirmed", "startsAt": "...", "updatedAt": "..." } }
}
```

The envelope is serialized once, in the same atomic write as the booking mutation, and every
retry sends those exact bytes. It is the historical record of what occurred, not a cache of
the booking's current state. Delivery order is not guaranteed: deduplicate on `id`, and
compare `occurredAt`/`booking.updatedAt` before replacing newer local state.

Requests are signed per the [Standard Webhooks](https://www.standardwebhooks.com/)
specification, so any spec-compliant verifier works:

| Header | Value |
| --- | --- |
| `webhook-id` | the envelope's `id` |
| `webhook-timestamp` | Unix seconds, fresh for each attempt (receivers enforce a 300-second tolerance) |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` over `<webhook-id>.<webhook-timestamp>.<body>` |

The signing key is the secret named by `secretBinding`, in the spec's `whsec_<base64>` form
(`openssl rand -base64 32`, stored as `whsec_<that value>`). A non-2xx response or network
failure is retried with backoff and abandoned after the attempt cap or a permanent (4xx)
response, surfacing as an incident in the admin dashboard.
[`../AGENTS.md`](../AGENTS.md) has a verification snippet using the `standardwebhooks` package.

## Behavior notes

Decisions that are easy to mistake for accidents:

- **Confirmation lease.** A payment webhook and a `/status` poll can both observe an
  unconfirmed booking. Reserva acquires a compare-and-set lease (5-minute TTL) before the
  confirm-plus-side-effects section. A blocked attempt returns `503 confirmation_in_progress`:
  the webhook path lets the provider redeliver, the `/status` path re-reads the booking.
- **Webhook hardening guards.** The payment webhook rejects `409 payment_session_mismatch`
  when the event's session conflicts with the stored one, and `409 payment_amount_mismatch`
  when the captured amount differs from the stored price. Both are non-2xx on purpose: an
  amount mismatch must page someone through webhook-failure alerts, not silently confirm.
- **Delayed payment methods are refused, not awaited.** A completed checkout session that is
  not paid means the customer chose a method whose money arrives days later (a voucher, a bank
  debit) — long after the capacity hold dies. Reserva releases the hold, asks the adapter to
  cancel the payment, and answers `200`: the event will never become acceptable, so redelivery
  is pointless. If the money settles anyway, the provider's `async_payment_succeeded` event
  records a full refund in `refund_operations` and issues it through the same idempotent
  `refund` port every other refund uses.
- **Refunds are durable, not in-memory.** A `refund_operations` table records every refund
  decision, with `UNIQUE(booking_id)` as a compare-and-set claim inserted before the payment
  provider is ever called, so racing `refund=full` and `refund=none` requests can never both
  refund; the loser gets `409 refund_conflict`. The provider's refund webhook upserts the same
  table. Partial refunds are out of scope.
- **Delivery state is not an entity flag.** There are no `*_synced` columns on a booking.
  Calendar, email, hook, and webhook delivery live only in `side_effect_operations` rows;
  anything that needs to know derives it from there.
- **Email templates are code, not files.** Per-locale template objects live in the package's
  email module rather than a `templates/{locale}/{event}.ts` layout.

## Why not Astro sessions?

Booking-flow state (holds, checkout progress, confirmation) lives in D1, not Astro's
`session` API. Astro sessions on Cloudflare are backed by Workers KV, which is only
eventually consistent across regions (up to about 60 seconds). A customer can create a hold
in one region and complete checkout through another; booking correctness needs
read-after-write consistency, which D1 provides and KV-backed sessions do not.
