# The booking API

The injected endpoints in detail — the ones whose contract is not obvious from their name —
plus the wire types, the error envelope, and the deliberate behavior behind a few status codes.

The canonical route table is generated from the package's route manifest and lives in
[`../README.md`](../README.md#injected-routes); [`../AGENTS.md`](../AGENTS.md) carries the same
table inside the published tarball.

## Endpoint notes

- `GET /api/booking/availability?service=&quantity=&from=&to=` — bookable slots per day. Each
  slot's `remaining: number | null` is published only at or below
  `config.booking.limitedThreshold` and `null` above it (exact capacity is deployment-private).
  The range may span up to `maxHorizonDays`; a consumer never chunks requests.
- `POST /api/booking/quote` — `{ serviceSlug, quantity, pickup?, locale? }` →
  `{ priceMinor, currency }`. The same validation and pricing path checkout charges on: a
  consumer that shows a price never computes one.
- `GET /api/booking/catalog?locale=` — everything needed to build a booking flow before a date
  is chosen: per service `slug`, locale-resolved `title`, `durationMin`, `location` (or
  `null`), `metadataFields` (`[]` for none); top-level `locales`, `currency`,
  `maxHorizonDays`. Never exposes schedules, pricing rules, capacity, or occupancy.
  `Cache-Control: public, max-age=60`.
- `POST /api/booking/checkout` —
  `{ serviceSlug, start, quantity, pickupType?, locale, meetingPointId?, metadata? }`.
  `meetingPointId` is required when the service declares more than one meeting point and the
  selected pickup option uses one; a single-point service resolves to its first declared
  point.
- `GET /api/booking/ops/health` — read-only deployment health behind admin auth: `schema`
  (migrations and fingerprint), `outbox` (pending/abandoned counts by family, oldest pending
  age), `incidents` (open count).
- `GET /booking/assets/reserva.css` and `/booking/assets/reserva.js` — static first-party
  assets for the server-rendered pages; see
  [`customization.md`](./customization.md#components-and-theming).

## Wire types and error codes

Every request and response shape is exported as a type from `@reservajs/astro/core`
(`AvailabilityResponse`, `QuoteRequest`/`QuoteResponse`, `CheckoutRequest`/`CheckoutResponse`,
`CatalogResponse`, `StatusResponse`, `ManageResponse`, `ManageActionResponses`,
`OpsHealthResponse`, `ApiErrorEnvelope`); the handlers are typed against the same
declarations. Collections are always present and empty (`[]`, `{}`) and optional modules are
always present and `null`, so nothing branches on key presence.

Every failure is `{ error: { code, message } }`. The `code` is one of a closed set exported as
`API_ERROR_CODES` (with the `ApiErrorCode` union and `isApiErrorCode` guard), listed in the
[README](../README.md#injected-routes). `validation_failed` messages name the offending field
and the rule that rejected it.

Locale-bearing endpoints negotiate the requested tag against `config.locales.supported` by
longest prefix match; an unsupported tag falls back to `locales.default`.

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
