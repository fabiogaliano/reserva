# Configuration

Every `ClientConfig` key beyond the quickstart's minimum: what a service declares, how pricing
is shaped, and how to move or switch off the routes Reserva mounts.

`reserva()` runs `validateConfig()` during `astro:config:setup`. Build-time failures include
malformed schedules, invalid timezones, `holdMinutes < 35`, and pricing gaps for any bookable
quantity and pickup combination. Every error names the key path, the violated rule, and the
fix.

[`../AGENTS.md`](../AGENTS.md) has the key-by-key outline with defaults.
[`../examples/configs/`](../examples/configs) has complete configs per business shape, and
[`../examples/smoke-site/src/config.ts`](../examples/smoke-site/src/config.ts) exercises every
optional module at once.

`ClientConfig` is what you write; `ResolvedClientConfig` (also exported from
`@reservajs/astro`) is the same config after defaults and normalization, and is what the
runtime and a provider adapter receive.

## Services and pricing

A service declares its slot geometry (`durationMin`, `turnaroundMin`, and a `schedule` unless it
inherits the top-level `hours`) and its `pricing`, in one of two shapes. `priceMinor` is always
in the minor unit of `business.currency` (4500 = €45.00), and `@reservajs/astro/core` exports
`priceFor`, `resolvedPriceTableFor`, `pricingCombinations`, `lowestPriceMinor` and
`maxQuantityFor`, which accept either shape (and a catalog entry), so a funnel never
reimplements the rule.

**Breakpoint rows** — `pricing: [{ maxQuantity, pickup?, priceMinor }, …]`. The tightest row
whose `maxQuantity` covers the requested quantity wins, whatever order the rows are written in,
so tiers are breakpoints, not per-person maths. Any curve is expressible: a 4th person cheaper,
a flat group rate, a price list copied from a brochure.

**Formula** — `pricing: { baseMinor, surcharges?, maxUnits?, surchargeScope? }`. The party
takes `ceil(quantity / occupancy.seatsPerUnit)` capacity units and pays `baseMinor` per unit,
plus the surcharge of the pickup option it chose: once per unit (`surchargeScope: 'unit'`, the
default) or once per booking (`'booking'`). `maxUnits` caps how many units one booking may
take, so the largest party is `maxUnits × seatsPerUnit`. Any of the three optional fields left
out inherits the top-level `pricing` block, which is where a fleet-wide pick-up surcharge is
written once:

```ts
pricing: { surcharges: { meeting_point: 0, hotel_pickup: 2000 }, maxUnits: 2 },
services: {
  alfama: { /* … */ occupancy: { seatsPerUnit: 4 }, pricing: { baseMinor: 10000 } },
  // A party of 6 on Alfama takes two 4-seat vehicles: 2 × (100 € + 20 €) with hotel pick-up.
}
```

The top-level block defaults to `{ surcharges: {}, maxUnits: 1, surchargeScope: 'unit' }`. Every
pickup option a formula service declares must have a surcharge (`0` for none) in whichever table
it reads; a location-less formula service has no surcharge column. The resolved config
materializes the inherited values onto each service and records which came from the shared block,
so an admin edit of the shared surcharge reaches every service that inherits it.

`occupancy: { seatsPerUnit }` says what one unit of `capacity` holds: a booking takes
`ceil(quantity / seatsPerUnit)` units. Every service that sells parties larger than one must
declare it, because the same `capacity.default: 40` means 40 people or 40 bookings depending on
this one value:

- `{ seatsPerUnit: 1 }` — capacity counts people (covers, class places, seats on a walk).
  A party of 4 takes 4.
- `{ seatsPerUnit: 4 }` — capacity counts 4-seat vehicles (or tables, boats). A party of 5 takes
  two of them.
- `{ seatsPerUnit: N }` with N at least the largest party — every booking takes exactly one unit,
  whatever its size (one private guide per booking).

A service whose largest party is 1 may omit it. A formula-priced service must declare it too: the
formula multiplies by the same units checkout reserves.

`collectGuestCount: true` is for a service sold as "up to N", where `quantity` is the priced tier
rather than the number of people coming. The payment page asks for the exact headcount as an
optional field (on Stripe, a numeric custom field). The answer is stored as `booking.guestCount`
and shown in the admin bookings list, or "≤N" when the payer left it blank. Price and capacity
still follow `quantity`.

## Opening hours

Declare the business's hours once, at the top level, and every service without a `schedule` of
its own inherits them; a service that declares `schedule` keeps it. Each service still derives
its own last departure from a shared `lastEnd`, so a 1-hour and an 8-hour tour that must both be
back by 19:00 sell until 18:00 and 11:00 respectively.

```ts
hours: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastEnd: '19:00', intervalMin: 30 }],
```

Each rule (shared or per service) generates start times from `firstStart` on the interval grid. Say where the
day ends with either `lastStart` (the latest departure) or `lastEnd` (the time the last booking
must be finished by) — one or the other, never both. `lastEnd` is usually what an operator
actually means: the last departure is derived from it as the latest grid start that still fits
`durationMin`, so changing a service's duration no longer means re-doing the subtraction by hand.
A rule that declares neither keeps the historical `lastStart` of `'18:00'`.

```ts
// An 8-hour tour that must be back by 19:00: last departure resolves to 11:00.
schedule: [{ days: [1, 2, 3, 4, 5], firstStart: '09:00', lastEnd: '19:00', intervalMin: 60 }],
```

Rules that match the same date combine, so a split day is two rules. The admin settings page
edits the shared block as one statement (first departure, closing time or last departure, the
interval and the weekdays); a service that declares its own schedule appears under
"Service-specific overrides", folded away by default.

## Site content next to the service

`meta` on a service, and on a meeting point, is an opaque JSON object Reserva stores, validates
for size, and echoes back on the catalog endpoint without ever reading a key of it. It is where a
site keeps the content that belongs to a service but is not a booking rule — a hero image, a
tagline, a meeting point's coordinates — so a static build fetches prices and content in one call
instead of maintaining a parallel file keyed by slug.

```ts
services: {
  alfama: {
    // ...
    meta: { image: '/img/alfama.jpg', tagline: { en: 'The oldest streets', 'pt-PT': 'As ruas mais antigas' } },
    location: {
      meetingPoints: [{ id: 'se', label: 'Sé Cathedral', mapsUrl: '…', meta: { lat: 38.7098, lng: -9.1330 } }],
    },
  },
}
```

Every value must be JSON-serializable (no functions, `BigInt`, `undefined`, or class instances)
and each `meta` object must stay under 8 KB; validation reports
`services.<slug>.meta: must be JSON-serializable and under 8 KB`. The catalog always returns
`meta`, as `{}` when the config declares none.

## The location module

`location` is optional per service. Omit it and the service has no pickup or meeting-point
axis anywhere — not in pricing, checkout, emails, the admin dashboard, or the calendar
description. Declaring it requires `meetingPoints`, `pickupOptions`, or both.

`pickupOptions` is the axis `pricing[].pickup` prices against. Each entry declares
`requiresAddress` (whether the payment adapter collects an address) and `usesMeetingPoint`
(whether the customer also picks a declared point). A location module that declares only
`meetingPoints` implies the single option
`{ id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true }`, and a service with
exactly one option — declared or implied — may leave `pickup` off its pricing rows, since
there is only one value it could take.

Declare one row per combination when pricing is not additive —
[`../examples/configs/tour-operator.ts`](../examples/configs/tour-operator.ts) prices four
pickup combinations outright because "+20 € per custom leg" cannot express the +30 € charged
for both.

Validation requires every `pricing` row's `pickup` to reference a declared id and reports
coverage holes. At checkout, `pickupType` is validated against the declared ids and must be
omitted for a service with no location module. `PickupType` is `string`, not a fixed union:
ids are per-service configuration.

## Declared metadata

`metadataFields` carries anything business-specific that is neither core nor location —
dietary notes, skill level, a table preference:

```ts
metadataFields: [
  { key: 'hotel', label: { en: 'Hotel name', 'pt-PT': 'Nome do hotel' }, type: 'text', required: true, maxLength: 120 },
  { key: 'language', label: 'Preferred language', type: 'select', adminBadge: true,
    options: [{ value: 'en', label: 'English' }, { value: 'pt', label: 'Português' }] },
  { key: 'partner', label: 'Partner', type: 'select', visibility: 'operator',
    options: [{ value: 'acme', label: 'Acme Stays' }] },
],
```

Four types (`text`, `number`, `boolean`, `select`) and three modifiers (`options`, `required`,
`maxLength`) are the entire language; there are no conditional fields, cross-field rules, or
custom validators. Declared fields are published by the catalog endpoint, validated at
checkout, stored on the booking, and rendered on the manage page and admin dashboard. The
dashboard lists every declared field a booking has a value for in that booking's details, after
the price, in declaration order and the admin locale, whatever its `visibility` — including on
cancelled and no-show bookings, which have no manage link. Its search matches a `select` value
by the option label it shows as well as by the stored value. A service that declares none
rejects a non-empty `metadata` body.

Two display settings, independent of each other:

- `visibility: 'customer' | 'operator'` (default `'customer'`) — who is shown the field. An
  `'operator'` field is validated at checkout and stored exactly like any other, but is left
  out of the catalog, the confirmation page and its status payload, the customer's manage page
  and `/api/booking/manage` answer (both `metadata` and `metadataRows`), and customer emails.
  The operator's manage view, owner emails and the admin dashboard still show it. Hidden from
  customers, but still sent by the visitor's browser — treat the value as a claim, not a
  verified fact. Checkout's `validation_failed` answer for a bad value still names the field
  and, for a `select`, lists its options. Webhook and hook payloads carry every field, and a
  custom `EmailRenderer` receives the stored booking as is, so it must leave operator-only
  fields out of customer mail itself. The customer's `metadata` carries only keys the service
  currently declares as customer-visible, so retiring an operator-only field by deleting its
  declaration keeps the values stored before that away from customers too.
- `adminBadge: boolean` (default `false`) — shows the booking's value as a tag next to its
  status in the admin bookings list and calendar day panel, using the option's label in the
  admin locale (the raw value once that option is no longer declared), with the field's label
  as its tooltip; a booking with no value shows no tag. Tags come in declaration order, ahead of
  the refund and dispute badges and the status, and are drawn without a status dot so they never
  read as one. Allowed on `type: 'select'` only: `adminBadge: true` on any other type fails
  validation, because a tag has to come from a closed set of labels.

  Tagged fields also get their own admin tab, named after the field (or "Tags" when several
  fields are tagged). It lists every option, including ones with no bookings yet, with two
  counts: **Upcoming**, confirmed bookings still ahead, and **Past**, confirmed and no-show
  bookings whose start has passed. Each count opens the bookings list for that value. A value
  still stored on bookings after its option was removed keeps a row under its raw value.
- `adminOptionLink?: string` — a URL shown beside each option on that tab, with a copy button,
  where `{value}` is replaced by the option's URL-encoded value. For a partner field, that's the
  partner's referral link: `'https://example.com/?ref={value}'`. Needs `adminBadge: true` and
  must contain `{value}`.

## Moving and disabling routes

- `routePrefix?: string` (a `reserva()` option) — prepended to every injected route pattern
  and to every URL Reserva's components and pages produce. Normalized and validated at
  `astro:config:setup` (whitespace, `..`, URL syntax characters, and repeated slashes throw).
  With a prefix set, the payment webhook URL is `<site><prefix>/api/booking/webhooks/payment`.
- `config.routes?: { admin?: boolean; ops?: boolean; manage?: boolean }` — turns off the admin
  dashboard, the operator routes, and/or the built-in `/booking/manage` page. All default to
  `true`. `manage` controls only that page: the manage/cancel/reschedule API endpoints stay
  mounted, so a consumer can replace the page with its own UI. The public booking API cannot
  be disabled. A disabled group is never injected and no generated link points at it: with
  `manage: false` emails omit their manage buttons and `<ManageBooking />` throws unless given
  an explicit `endpoint`.
- `config.routes?.cors?: { origins: string[] }` — lets a booking funnel on another site call
  the customer API from the browser, e.g. a WordPress or Next.js site using
  `createReservaClient({ base: 'https://booking.example.com' })`. Each entry is an exact origin
  as the browser sends it (`https://www.example.com`, `http://localhost:4321`): no path, no
  trailing slash, no wildcard. Only the customer API routes answer: `availability`, `checkout`,
  `quote`, `catalog`, `status`, `manageApi`, `cancel` and `reschedule` reply to the preflight
  and carry `Access-Control-Allow-Origin` for a listed origin. The admin, operator, ops and
  payment-webhook routes and the pages never do. Absent, no route sends CORS headers. The
  payment provider still returns the customer to this deployment's `/booking-confirmation`.

```ts
// reserva.config.ts (shared by reserva() and the runtime entrypoint)
export default {
  // ...
  routes: {
    ops: false, // this site has no operator endpoints; admin stays on
    cors: { origins: ['https://www.example.com'] }, // the funnel lives on the marketing site
  },
};

// astro.config.ts
reserva({
  config,
  routePrefix: '/en', // mounts every route under /en/..., e.g. /en/api/booking/checkout
})
```

## Refunds and disputes on a booking

There is nothing to configure: every booking carries what happened to its money after payment.

- `booking.amountRefundedMinor` is the running total of refunds sent on the payment, partial or
  full, whether Reserva issued them (an operator cancellation) or someone did it in the payment
  provider's dashboard. It counts refunds *sent*: one the bank later bounces (rare, such as a closed
  card) stays counted, because the business still owes the customer that money. Reserva does not
  listen for Stripe's `refund.failed`; Stripe notifies the account owner of a failed refund itself.
  A refund event changes nothing else about the booking unless it returns the whole payment, which
  cancels the booking.
- `booking.disputedAt` and `booking.disputeStatus` (`'open' | 'won' | 'lost'`, both `null` when the
  payment was never disputed) record a chargeback or a bank inquiry. The date is when the provider
  opened the dispute (Stripe reports it), or when Reserva first saw it if the provider doesn't say.
  The status turns `won` or `lost` when the provider reports the outcome (with Stripe,
  `charge.dispute.closed`; an inquiry that closes without a chargeback counts as won), and stays
  `open` on an endpoint that is not subscribed to it. When one payment is disputed twice, the
  booking shows the later dispute: it reopens as `open` with the later date, then takes that
  dispute's outcome. A provider that reports no opening time can't tell a second dispute from a
  redelivered first one, so there the second leaves a recorded outcome alone until its own close,
  and the last outcome wins.

The admin dashboard shows both in the bookings list and the calendar day panel, beside the
booking's status: a "Refunded €X" badge (warning tone) whenever any amount was refunded, and a
dispute badge — "Dispute open" and "Dispute lost" in the danger tone, "Dispute won" in the
neutral one, since the money stayed. The booking's details add matching rows after its declared
fields: "Refunded" with the total, and "Dispute" with the outcome and the date it opened
("Open since …", "Won (opened …)", "Lost (opened …)").
