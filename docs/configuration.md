# Configuration

Everything you can put in `reserva.config.ts` beyond the quickstart.

`reserva()` validates the config when Astro starts, so mistakes fail the build: a malformed
schedule, an unknown timezone, `holdMinutes` below 35, a party size or pickup with no price.
Each error names the key path and the rule it broke.

[`AGENTS.md`](../AGENTS.md#config-schema-outline) lists every key with its default.
[`examples/configs/`](../examples/configs) has full configs for several kinds of business, and
[`examples/smoke-site/src/config.ts`](../examples/smoke-site/src/config.ts) uses every optional
module at once.

`ClientConfig` is what you write. `ResolvedClientConfig` (also from `@reservajs/astro`) is the
same config with defaults applied; it's what the runtime and adapters receive.

## Services and pricing

A service declares its slot (`durationMin`, `turnaroundMin`, and a `schedule` unless it uses the
shared `hours`) and its `pricing`. Prices are in the currency's minor unit: `4500` is €45.00.

**Rows**: `pricing: [{ maxQuantity, pickup?, priceMinor }, …]`. The smallest `maxQuantity` that
fits the party wins, in any row order. Rows are breakpoints, so any price curve works: a cheaper
fourth person, a flat group rate, a brochure price list.

**Formula**: `pricing: { baseMinor, surcharges?, maxUnits?, surchargeScope? }`. A party takes
`ceil(quantity / occupancy.seatsPerUnit)` capacity units and pays `baseMinor` per unit, plus the
chosen pickup option's surcharge, either per unit (`surchargeScope: 'unit'`, the default) or
once per booking (`'booking'`). `maxUnits` caps the units per booking, so the largest party is
`maxUnits × seatsPerUnit`. Any of the optional fields left out comes from the top-level
`pricing` block, so a fleet-wide pickup surcharge is written once:

```ts
pricing: { surcharges: { meeting_point: 0, hotel_pickup: 2000 }, maxUnits: 2 },
services: {
  alfama: { /* … */ occupancy: { seatsPerUnit: 4 }, pricing: { baseMinor: 10000 } },
  // A party of 6 takes two 4-seat vehicles: 2 × (€100 + €20) with hotel pickup.
}
```

The top-level block defaults to `{ surcharges: {}, maxUnits: 1, surchargeScope: 'unit' }`. Every
pickup option on a formula service needs a surcharge (`0` for none). When the admin edits the
shared surcharge, every service that inherits it follows.

Partner offers only work on formula-priced services. See
[Partner offers](./api.md#partner-offers-and-referral-codes).

### Occupancy

`occupancy: { seatsPerUnit }` says what one unit of `capacity` holds. A booking takes
`ceil(quantity / seatsPerUnit)` units. It decides whether `capacity.default: 40` means 40 people
or 40 bookings, so any service that sells parties larger than one must declare it:

- `{ seatsPerUnit: 1 }`: capacity counts people (covers, class places). A party of 4 takes 4.
- `{ seatsPerUnit: 4 }`: capacity counts 4-seat vehicles, tables or boats. A party of 5 takes 2.
- `{ seatsPerUnit: N }`, with N at least the largest party: every booking takes one unit (one
  private guide per booking).

A service whose largest party is 1 can leave it out. Formula pricing needs it, because the
formula charges per unit. Each booking stores its units when it's made, so changing
`seatsPerUnit` later only affects new bookings.

### Guest count

`collectGuestCount: true` is for services sold as "up to N", where `quantity` is the price tier
rather than the headcount. The payment page asks for the exact number of guests as an optional
field. It's stored as `booking.guestCount` and shown in the admin, or "≤N" when left blank. Price
and capacity still follow `quantity`.

## Opening hours

Declare hours once at the top level and every service without its own `schedule` uses them.
Each service still works out its own last departure from a shared `lastEnd`, so a 1-hour and an
8-hour tour that must both be back by 19:00 sell until 18:00 and 11:00.

```ts
hours: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastEnd: '19:00', intervalMin: 30 }],
```

A rule generates start times from `firstStart` every `intervalMin`. End the day with either
`lastStart` (the last departure) or `lastEnd` (when the last booking must finish), not both.
`lastEnd` is usually what an operator means: the last departure becomes the latest start that
still fits `durationMin`, so changing a duration doesn't mean redoing the sum. With neither,
`lastStart` is `'18:00'`.

```ts
// An 8-hour tour that must be back by 19:00: the last departure is 11:00.
schedule: [{ days: [1, 2, 3, 4, 5], firstStart: '09:00', lastEnd: '19:00', intervalMin: 60 }],
```

Rules that match the same day add up, so a split day is two rules. The admin settings page edits
the shared hours; services with their own schedule appear under "Service-specific overrides".

## Site content: `meta`

`meta` on a service or a meeting point is a JSON object Reserva stores and returns on the
catalog without reading it. Use it for content that belongs with a service but isn't a booking
rule, like an image, a tagline or coordinates, so your site doesn't need a separate file keyed
by slug.

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

Values must be JSON-serializable (no functions, `BigInt`, `undefined` or class instances), and
each `meta` object must be under 8 KB. The catalog returns `{}` when there's none.

## Locations and pickup

`location` is optional. Without it, a service has no pickup or meeting point anywhere: not in
pricing, checkout, emails, the admin or the calendar. With it, declare `meetingPoints`,
`pickupOptions`, or both.

`pickupOptions` are what `pricing[].pickup` refers to. Each has a `label`, an optional `hint`,
`requiresAddress` (the payment page asks for an address) and `usesMeetingPoint` (the customer
also picks a meeting point). A location with only `meetingPoints` implies one option,
`{ id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true }`. A service with
exactly one option can leave `pickup` off its pricing rows.

When prices don't add up neatly, write one row per combination.
[`examples/configs/tour-operator.ts`](../examples/configs/tour-operator.ts) prices four pickup
combinations outright, because "+€20 per custom leg" can't express +€30 for both legs.

Every `pickup` in `pricing` must be a declared id, and validation reports any combination left
without a price. Pickup ids are your own strings; Reserva gives them no meaning.

## Metadata fields

`metadataFields` collects anything else your business needs, like dietary notes, skill level or a
table preference:

```ts
metadataFields: [
  { key: 'hotel', label: { en: 'Hotel name', 'pt-PT': 'Nome do hotel' }, type: 'text', required: true, maxLength: 120 },
  { key: 'language', label: 'Preferred language', type: 'select', adminBadge: true,
    options: [{ value: 'en', label: 'English' }, { value: 'pt', label: 'Português' }] },
  { key: 'channel', label: 'Sales channel', type: 'select', visibility: 'operator',
    options: [{ value: 'phone', label: 'Phone' }, { value: 'desk', label: 'Hotel desk' }] },
],
```

There are four types (`text`, `number`, `boolean`, `select`) and three rules (`options`,
`required`, `maxLength`). No conditional fields, cross-field rules or custom validators. Fields
are published in the catalog, validated at checkout, stored on the booking, and shown on the
manage page and in the admin. A service with no fields rejects any `metadata`.

For partners and referral codes, use the [partners admin](./api.md#partner-offers-and-referral-codes)
rather than a metadata field.

**`visibility: 'operator'`** (default `'customer'`) hides a field from customers: the catalog,
the confirmation page, the customer's manage page and API answer, and customer emails. The
operator's manage view, owner emails and the admin still show it. The visitor's browser still
sends the value, so treat it as a claim, not a fact. Webhooks and hooks get every field, and a
custom email renderer gets the stored booking as is, so it has to leave operator-only fields out
of customer mail itself. Customers only ever see keys the service currently declares as
customer-visible.

**`adminBadge: true`** shows the value as a tag on the booking in the admin list and calendar,
using the option's label (or the raw value once the option is gone). `select` fields only.
Tagged fields also get their own admin tab, named after the field ("Tags" when there are
several), listing every option with **Upcoming** and **Past** booking counts. Each count opens
the matching bookings.

**`adminOptionLink`** shows a link with a copy button next to each option on that tab, with
`{value}` replaced by the option's value. It needs `adminBadge: true` and must contain
`{value}`.

## Routes and CORS

- **`routePrefix`** (a `reserva()` option) is added to every route and every URL Reserva
  generates. With `routePrefix: '/en'`, the payment webhook is
  `<site>/en/api/booking/webhooks/payment`.
- **`config.routes.admin`, `.ops`, `.manage`** (all `true` by default) turn off the admin
  dashboard, the operator routes, or the built-in `/booking/manage` page. `manage: false` only
  removes the page: the manage, cancel and reschedule APIs stay, so you can build your own. Emails
  then leave out manage buttons, and `<ManageBooking />` needs an explicit `endpoint`. The
  customer API can't be turned off.
- **`config.routes.cors.origins`** lets a booking form on another site call the customer API
  from the browser, for example a WordPress or Next.js site using
  `createReservaClient({ base: 'https://booking.example.com' })`. List exact origins
  (`https://www.example.com`, `http://localhost:4321`): no path, trailing slash or wildcard.
  Only `availability`, `checkout`, `quote`, `resolveReferral`, `catalog`, `status`,
  `manageApi`, `cancel` and `reschedule` answer cross-origin. Without the key, no route sends
  CORS headers. Payment still returns customers to this deployment's `/booking-confirmation`.

```ts
// reserva.config.ts
export default {
  // ...
  routes: {
    ops: false,                                      // no operator endpoints; admin stays on
    cors: { origins: ['https://www.example.com'] },  // the booking form lives on the main site
  },
};

// astro.config.ts
reserva({ config, routePrefix: '/en' }) // every route under /en/…
```

## Refunds and disputes

Nothing to configure. Every booking records what happened to its money after payment.

- **`booking.amountRefundedMinor`** is the total refunded, partial or full, whether from Reserva
  or the provider's dashboard. It counts refunds sent: one the bank bounces later still counts,
  because the business still owes it. Only a full refund cancels the booking.
- **`booking.disputedAt`** and **`booking.disputeStatus`** (`'open' | 'won' | 'lost'`, both
  `null` if never disputed) track chargebacks and bank inquiries. The status changes when the
  provider reports the outcome (Stripe: `charge.dispute.closed`; an inquiry closed without a
  chargeback counts as won). If a payment is disputed twice, the booking shows the later one.

The admin shows a "Refunded €X" badge and a "Dispute open / won / lost" badge next to the
booking's status, with matching rows in its details.
