# The booking API

What each endpoint takes and returns, the typed client, partner offers, webhooks, and the
reasons behind a few status codes. The route table is in the
[README](../README.md#injected-routes) and in [`AGENTS.md`](../AGENTS.md).

A booking goes `catalog` (what can be booked) → `availability` (when) → `quote` (how much) →
`checkout` (hold the slot, open the payment page). The payment provider then sends the
customer to `/booking-confirmation?sessionId=…`, which polls `status` until the payment webhook
confirms the booking.

## Endpoints

### `GET /api/booking/catalog?locale=`

Everything a booking form needs before a date is picked. Per service: `slug`, `title` in the
requested locale, `durationMin`, `location` (or `null`), `metadataFields` (`[]` when none;
operator-only fields are left out), `pricing`, `maxQuantity` (the largest party it prices),
`fromPriceMinor` (the lowest price, for a "from €X" label) and `meta`. At the top level:
`locales`, `currency`, `maxHorizonDays` and `policy` (`cancelCutoffHours`,
`reschedule.enabled`, `reschedule.cutoffHours`).

`pricing` comes back as configured: rows of `{ maxQuantity, pickup, priceMinor }` (`pickup` is
`null` without a pickup axis), or a formula `{ baseMinor, surcharges, maxUnits, surchargeScope,
seatsPerUnit }` with inherited values filled in. `meta` is the JSON object the config declared
for the service or meeting point, returned as is (`{}` when none), so a site gets prices and its
own content in one call.

The catalog never exposes schedules, turnaround, capacity or occupancy. It's cached for 60
seconds. The amount actually charged always comes from `quote`.

### `GET /api/booking/availability?serviceSlug=&quantity=&from=&to=`

Bookable slots per day. Each slot is `{ start, date, time, remaining }`. `start` is the ISO
instant with its offset; `date` (`YYYY-MM-DD`) and `time` (`HH:MM`) are the same moment in the
business timezone. `remaining` is a number only at or below `booking.limitedThreshold`, and
`null` above it, so exact capacity stays private. `quantity` defaults to 1.

One request covers at most 62 days (`MAX_AVAILABILITY_RANGE_DAYS`) and never goes past
`maxHorizonDays`. A longer range is `400 validation_failed` with `details.field: 'to'`. The
client's `availability()` splits long ranges for you.

For a reschedule picker, send the booking's manage token in the `x-reserva-manage-token` header
(`MANAGE_TOKEN_HEADER`, or `manageToken` on the client). The booking's own slot then doesn't
count against it. That answer is never cached, and an unknown or revoked token gets the normal
answer.

### `POST /api/booking/quote`

`{ serviceSlug, quantity, pickup?, referralCode? }` →
`{ priceMinor, currency, pricing, referral, quoteFingerprint }`.

Checkout prices through the same code, so a quote and the charge can't disagree. `pricing` is
the breakdown: `originalTotalMinor`, `serviceDiscountMinor`, `pickupDiscountMinor`,
`savingsMinor`, `priceMinor`, and the service and pickup subtotals (`null` for row pricing,
which can't be split). `referral.status` is `none`, `active` or `unavailable`. Never cached.

### `POST /api/booking/referral`

`{ referralCode }` → `{ status: 'active', benefits }` or `{ status: 'unavailable' }`. Each
benefit is `{ serviceSlug, serviceDiscountBasisPoints, waivedPickupIds }`. Unknown and archived
codes look the same. A partner whose offer is switched off, or a deployment with offers
disabled, answers `active` with empty `benefits`. Partner names, ids and other codes are never
returned, and there's no endpoint that lists partners. Never cached.

### `POST /api/booking/checkout`

`{ serviceSlug, start, quantity, locale, pickup?, meetingPointId?, metadata?, referralCode?, quoteFingerprint? }`
→ `{ checkoutUrl, bookingId, reference, paymentDeadline }`.

`meetingPointId` is required when the chosen pickup option uses a meeting point and the service
has more than one; with a single point it's picked for you. `paymentDeadline` (UTC) is when the
payment page closes. The hold can outlive it by a few minutes.

### `GET /api/booking/status?sessionId=`

What the confirmation page polls. `status` is one of `pending`, `confirmed`, `failed`,
`cancelled`, `expired`, `not_found`.

`failed` means the payment session completed but the payment wasn't acceptable: a delayed
payment method, or an amount or currency that doesn't match. No booking is made, the hold is
released, the payment is cancelled where the adapter can, and an incident opens for the
operator. It won't change on a later poll.

For four hours after the booking was created, `confirmed` carries the full booking. After that
it carries only `{ reference, serviceTitle, start, end, locale }` (`ConfirmationSummary`), and
the page says the details were emailed. Operator-only fields never appear.

### `GET /api/booking/manage?token=`

The booking behind a manage token. `cancelDeadline` and `rescheduleDeadline` are the two
cutoffs, as UTC instants; they're separate policies. A customer token gets `metadata` and `metadataRows` without operator-only
fields; an operator token gets everything.

### `GET /api/booking/ops/health`

Behind admin auth. Reports `schema` (migrations applied, fingerprint match), `outbox` (pending
and abandoned counts per family, oldest pending age), `incidents` (open count), `security`
(whether the CSRF and token-encryption secrets are set, and which admin auth is in use) and
`reconciliation` (`lastRunAt`, `lastSummary`). Its only write: it opens a
`reconciliation_stale` incident when the sweep hasn't run for three cadences, and resolves it
once the sweep runs again.

### `/booking/assets/reserva.css` and `reserva.js`

Static assets for the server-rendered pages. See
[customization](./customization.md#components-and-theming).

## Types and errors

Every request and response type is exported from `@reservajs/astro/core`:
`AvailabilityResponse`, `QuoteRequest`/`QuoteResponse`,
`ResolveReferralRequest`/`ReferralResolution`, `CheckoutRequest`/`CheckoutResponse`,
`CatalogResponse`, `StatusResponse`, `ConfirmationSummary`, `ManageResponse`,
`CancelRequest`/`RescheduleRequest`, `ManageActionResponses`, `OpsHealthResponse`,
`ApiErrorEnvelope`, `ApiErrorDetails`. Lists are always present, empty when there's nothing.
Optional modules are always present, `null` when off.

Every error is `{ error: { code, message, details? } }`. `code` comes from `API_ERROR_CODES`
(with the `ApiErrorCode` type and `isApiErrorCode` guard). `validation_failed` messages name the
field and the rule. `details` can carry `field`, `allowed` (the accepted values, for closed sets
like service slugs, pickup ids or select options) and `quote` (on `quote_changed`). Switch on
`code`, not on `message`.

## Partner offers and referral codes

### In the admin

Partners live at `/booking/admin?view=partners`, behind the same auth, origin checks and CSRF
tokens as the settings page. There's a list, a page per partner (`&partner=<id>`) with its
referral link, offer, price preview and archive/restore, and an add form (`&partner=new`).

- Codes are lowercase (`a-z`, `0-9`, `-`, `_`, up to 64 characters), can't be changed, and
  stay reserved after a partner is archived.
- Archiving stops new attribution and discounts. Switching an offer off keeps its values and
  keeps attribution working.
- Saves are revision-checked: a concurrent edit gets `409 partner_conflict`. Each save is
  recorded under Settings → Recent changes. Partner saves don't fire `settings.changed`.
- A referral link is `<business.url>?ref=<code>`.

An offer is a percentage off the service price (up to two decimals), free pickup on chosen
pickup options, or both. Discounts apply to the service subtotal only. A waived pickup still
collects its address if it requires one. Offers need formula pricing: a service priced by rows
can't be split into service and pickup, so it can't carry an offer.

### Turning offers on

Offers are off by default. Enable them with the server-only `partnerOffers` runtime option,
never in `ClientConfig`:

```ts
// in defineCloudflareReservaRuntime<Env>({ … })
partnerOffers: ({ env }) => ({
  enabled: env.RESERVA_PARTNER_OFFERS_ENABLED === 'true',
  minimumChargeMinorByCurrency: { eur: 50 },
  legacyMetadataField: 'partner', // optional, see below
}),
```

Set the minimum to your payment provider's smallest allowed charge. Reserva doesn't look it
up. The admin refuses an offer that would bring a price below the minimum, and the settings
page refuses a price change that would do the same to a saved offer. If an offer still can't be
sold on a service (say, the minimum was raised later), that service is left out of the offer:
it's charged the normal price, and the partner's page says so.

Only enable offers once your booking form shows live quotes and handles a changed price (below).

### In your booking form

1. Read `ref` from the page URL, lowercase it, and keep it for the session. A malformed code is
   `400 validation_failed` on `referralCode`.
2. Call `resolveReferral({ referralCode })` to show what the partner's offer gives, per service.
3. Send `referralCode` to `quote()` and show the result. Keep its `quoteFingerprint`.
4. Send `referralCode` and that `quoteFingerprint` to `checkout()`.

With a `referralCode`, checkout requires `quoteFingerprint` (`400 validation_failed` without
it), even for an unknown code or a partner with no offer. Without a code, the fingerprint is
optional. Checkout recomputes the price
on its own; the fingerprint only checks that the customer saw the same price. Never send prices
or discounts from the browser.

If the price or the offer changed since the quote, checkout answers `409 quote_changed` before
it holds anything, with the new quote in `error.details.quote`. Show it and let the customer
confirm again. `503 partner_storage_unavailable` is temporary: retry, and don't drop the code
or fall back to full price. A party size or pickup the service can't price is
`400 validation_failed`, not a changed quote.

```ts
try {
  await reserva.checkout({ serviceSlug, start, quantity, locale, referralCode, quoteFingerprint });
} catch (cause) {
  if (isReservaApiError(cause) && cause.code === 'quote_changed') showNewPrice(cause.details?.quote);
}
```

### What the booking keeps

The checkout reads settings and the offer once, and that read is what the booking gets. Later
edits apply to later checkouts. The partner (`booking.partnerId`, `partnerAttribution`) and the
price breakdown (`partnerPricing`) are written with the hold and can't be changed through
metadata or later edits. Payment checks, reschedules and refunds use the stored
`booking.priceMinor` and currency. Confirmation and manage responses show the breakdown as
`booking.pricing` (`null` without a referral) and never show which partner it was. Webhook
field names are unchanged.

### Migrating from a metadata field

Sites that tracked partners with a `select` metadata field can set `legacyMetadataField` to
that field's key. Checkouts that send the code only in metadata then get attributed to the
matching partner in the admin, even with offers off. Codes are looked up in the partner list,
not in the field's options. An active code keeps its value in an operator-only field; unknown,
archived and malformed codes are stripped from new bookings, and past bookings are untouched. If
the partner list can't be read, the booking goes through without attribution. A checkout that
sends different codes in metadata and `referralCode` is rejected.

Once offers are enabled, a metadata-only referral is rejected with `validation_failed` on
`metadata.<field>`, so older clients retry without it. Move them to `referralCode` with a
fingerprint.

## Prices

A service prices by rows (`{ maxQuantity, pickup?, priceMinor }`, where the smallest row that
fits the party wins) or by formula (`baseMinor` per capacity unit, times the units the party
needs, plus the pickup surcharge). `@reservajs/astro/core` exports helpers that apply both, so
your form doesn't re-implement them. They accept a catalog entry or a raw config service, in
any row order:

```ts
import { priceFor, resolvedPriceTableFor, pricingCombinations, lowestPriceMinor, maxQuantityFor } from '@reservajs/astro/core';

priceFor(service, 3, 'custom_pickup');    // one price, in minor units
resolvedPriceTableFor(service);           // { [pickup or '']: number[] } indexed by quantity
pricingCombinations(service);             // [{ quantity, pickup, priceMinor }, …]
maxQuantityFor(service);                  // the largest party the service prices
lowestPriceMinor(service);                // the "from" price (also fromPriceMinor)
```

`isPricingFormula(service.pricing)` tells the two shapes apart. These give list prices; a
partner's discount only shows up in `quote`.

## Locales

Endpoints that take a locale match it against `locales.supported` by longest prefix and fall
back to `locales.default`. Every label in config (titles, meeting points, pickup labels and
hints, metadata labels) is a string or a `Record<locale, string>`, resolved the same way, so
`title` and `serviceTitle` come back in the request's or the booking's locale.

## Field names

Requests use `serviceSlug`, `pickup`, `start` and `sessionId` everywhere. The webhook booking
still calls the pickup `pickupType`.

## The typed client

`@reservajs/astro/client` is safe to ship to the browser: it imports only wire types, error
codes and route patterns.

```ts
import virtualConfig from 'virtual:reserva/config';
import { createReservaClient, isReservaApiError } from '@reservajs/astro/client';

const reserva = createReservaClient({ paths: virtualConfig.routes.paths });

const catalog = await reserva.catalog({ locale: 'pt-PT' });
const days = await reserva.availability({ serviceSlug: 'old-town', quantity: 2, from, to });
const { checkoutUrl } = await reserva.checkout({ serviceSlug, start, quantity, locale, pickup });
```

- Pass either `paths` (the deployment's route table, `routePrefix` included) or `base` (a
  prefix or another origin). With neither, it uses the default paths on the current origin. A
  `base` on another origin needs your site in `routes.cors.origins`
  ([configuration](./configuration.md#routes-and-cors)).
- `fetch` replaces the transport (tests, server-side calls). `bearer` is the operator secret
  for the `operator.*`, `opsHealth` and `opsReconcile` methods.
- Methods: `catalog`, `availability`, `quote`, `resolveReferral`, `checkout`, `status`,
  `manage`, `cancel`, `reschedule`, `operator.cancel`, `operator.reschedule`,
  `operator.noShow`, `opsHealth`, `opsReconcile`. Each takes an optional `{ signal }`.
  Availability, quote, referral, status and manage are sent with `cache: 'no-store'`.
- Every failure throws a `ReservaApiError` with `status`, `code` and `details`, whether it's an
  API error, a bare 502 from a proxy, or a dropped connection (`status: 0`,
  `code: 'internal_error'`). Check with `isReservaApiError(cause)`.

Date-picker helpers ship from the same entry: `openDays(response)`, `firstOpenDay(response)`,
`isDayDisallowed(response)` (UTC getters, matching the `Date.UTC` dates `<calendar-date>`
passes), `dateKey(date)` and `horizonRange(catalog, today)`.

`@reservajs/astro/ui` has the message catalog (`defaultMessages`, `resolveMessages`,
`formatMessage`) and the formatters Reserva's own pages use: `formatDateTime`, `formatDayDate`,
`formatDateParts`, `formatPrice`, `googleCalendarUrl`, and
`icsDataUrl(event, { uid, generatedAt })`. Build `uid` with
`calendarUid(reference, businessUrl)` to match the one in Reserva's pages and emails.

Rate limiting belongs at the Cloudflare edge (WAF or rate-limiting rules), not in Reserva.

Astro 7 treats `src/fetch.ts` as a custom fetch entrypoint. Reserva doesn't need one; don't use
that filename for anything else.

## Webhooks

### Subscribers

A hook's `name` matches `^[a-z][a-z0-9-]{0,31}$` and is unique. Its `events` filter defaults to
all of `BOOKING_EVENTS`. `handler(event, booking, { id, occurredAt, config })` receives the same
booking a webhook carries, plus the envelope id.

You can subscribe to `WEBHOOK_EVENTS`, which is `BOOKING_EVENTS` plus `settings.changed`:

| Event | Payload |
| --- | --- |
| `booking.confirmed` | `data.booking` |
| `booking.cancelled_by_customer` | `data.booking` |
| `booking.cancelled_by_operator` | `data.booking` |
| `booking.rescheduled` | `data.booking` |
| `booking.no_show` | `data.booking` |
| `booking.reminder` | `data.booking`, sent by the sweep `booking.reminderHoursBefore` hours before the start (default 24, `0` turns it off) |
| `payment.dispute_created` | `data.booking` |
| `settings.changed` | `data.changes` |

### The envelope

```json
{
  "apiVersion": 1,
  "id": "<bookingId>/<family>:<name>:<event>[:<discriminator>]",
  "event": "booking.confirmed",
  "occurredAt": "2026-06-14T08:00:00.000Z",
  "data": { "booking": { "id": "...", "reference": "...", "status": "confirmed", "startsAt": "...", "updatedAt": "..." } }
}
```

The envelope is written in the same transaction as the change that caused it, and every retry
sends the same bytes. It records what happened at that moment, not the booking's current state.
Deliveries can arrive out of order: deduplicate on `id`, and compare `occurredAt` or
`booking.updatedAt` before overwriting newer data. The booking's field names (`serviceSlug`,
`quantity`, `priceMinor`, `currency`, `pickupType`) are fixed for `apiVersion: 1`.

### Signatures

Deliveries are signed per [Standard Webhooks](https://www.standardwebhooks.com/), so any
compliant verifier works:

| Header | Value |
| --- | --- |
| `webhook-id` | the envelope's `id` |
| `webhook-timestamp` | Unix seconds, new on each attempt (receivers allow 300 seconds) |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` over `<webhook-id>.<webhook-timestamp>.<body>` |

The key is the secret named by `secretBinding`, as `whsec_<base64>`: generate it with
`openssl rand -base64 32` and store `whsec_<that value>`. A non-2xx response or a network error
is retried with backoff. After the last attempt, or on a permanent 4xx, the delivery is
abandoned and shows up as an incident in the admin. [`AGENTS.md`](../AGENTS.md) has a
verification example.

### `settings.changed`

Fires once per admin save of settings, day overrides or capacity defaults. A subscriber only
gets it by naming it. It's not durable, since the outbox is per booking: Reserva tries three
times (after 2 s, then 8 s), then logs `settings webhook delivery failed` and gives up. Save
again or deploy by hand if a rebuild was missed.

```json
{
  "apiVersion": 1,
  "id": "settings/<changeBatchId>",
  "event": "settings.changed",
  "occurredAt": "2026-06-14T08:00:00.000Z",
  "data": { "changes": [{ "domain": "setting", "key": "booking.cancelCutoffHours", "action": "upsert", "actor": "ops@example.com" }] }
}
```

`domain` is `setting`, `day_override` or `capacity_default`; `action` is `upsert` or `delete`;
`key` is the setting key or the date. New values aren't included: read them from the catalog. A
hook gets `(event, null, { id, occurredAt, config, changes })`.

## Behavior notes

These look like bugs but are deliberate.

- **Confirmation lease.** A payment webhook and a `status` poll can both try to confirm the same
  booking. The first takes a 5-minute lease; the other gets `503 confirmation_in_progress`. The
  webhook is redelivered by the provider, and the poll just reads again.
- **Webhook guards.** The payment webhook answers `409 payment_session_mismatch` when the
  event's session doesn't match the booking's, and `409 payment_amount_mismatch` when the amount
  paid differs from the stored price. Both are errors on purpose, so they trigger webhook-failure
  alerts instead of confirming quietly.
- **Delayed payment methods are refused.** A completed session that isn't paid means a method
  whose money arrives days later, after the hold has expired. Reserva releases the hold, asks
  the adapter to cancel the payment, and answers `200`, since a retry won't change anything. If
  the money arrives anyway, it's refunded in full through the normal refund path.
- **One refund per booking.** Each refund decision is recorded in `refund_operations` before the
  provider is called, with one row per booking, so two conflicting refunds can't both go
  through. The second gets `409 refund_conflict`. `refund` is `none`, `full` or `partial`;
  `partial` takes `refundAmountMinor`, at least 1 and below the price. Further refunds are made
  in the provider's dashboard, and Reserva records them from the webhook without cancelling the
  booking.
- **Delivery state lives in the outbox.** Bookings have no `*_synced` columns. Whether a
  calendar event, email, hook or webhook was delivered is only in `side_effect_operations`.

## Why not Astro sessions?

Booking state lives in D1, not in Astro's `session` API. On Cloudflare, Astro sessions use
Workers KV, which can take up to about 60 seconds to agree across regions. A customer can hold a
slot through one region and pay through another, and bookings need to read their own writes.
D1 does that; KV doesn't.
