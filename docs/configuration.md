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

`occupancy: { seatsPerUnit }` maps a headcount onto capacity units when they are not 1:1: a
booking takes `ceil(quantity / seatsPerUnit)` units, so a party of 5 on a 4-seat vehicle holds
two of them. Omit the key and every booking takes exactly one unit, which is what most
deployments want. A formula-priced service must declare it: the formula multiplies by the same
units checkout reserves, and a headcount with no `seatsPerUnit` has no unit count to multiply by.

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
  { key: 'language', label: 'Preferred language', type: 'select',
    options: [{ value: 'en', label: 'English' }, { value: 'pt', label: 'Português' }] },
],
```

Four types (`text`, `number`, `boolean`, `select`) and three modifiers (`options`, `required`,
`maxLength`) are the entire language; there are no conditional fields, cross-field rules, or
custom validators. Declared fields are published by the catalog endpoint, validated at
checkout, stored on the booking, and rendered on the manage page and admin dashboard. A
service that declares none rejects a non-empty `metadata` body.

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

```ts
// reserva.config.ts (shared by reserva() and the runtime entrypoint)
export default {
  // ...
  routes: { ops: false }, // this site has no operator endpoints; admin stays on
};

// astro.config.ts
reserva({
  config,
  routePrefix: '/en', // mounts every route under /en/..., e.g. /en/api/booking/checkout
})
```
