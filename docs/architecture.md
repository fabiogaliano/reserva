# Architecture

How Reserva is put together, the rules every change must keep, and what's deliberately left out.

## System map

Each layer has one source of truth. Everything else derives from it and never copies it.

| Layer | Source of truth |
|---|---|
| Config | the `ClientConfig` schema (`src/core/config.ts`), validated at build time and again when the runtime starts |
| Domain | `Booking`, its status machine, and the one pricing path (`src/core/`) |
| State and delivery | `bookings` rows and `side_effect_operations` outbox rows; delivery state lives nowhere else |
| Partners | the D1 partner registry (`src/partners.ts`); bookings keep a snapshot of the partner and price taken at checkout |
| Contract | exported wire types, `API_ERROR_CODES`, `BOOKING_EVENTS`, the webhook envelope, the `toWireBooking` projection |
| Surfaces | the route manifest (`src/routes-manifest.ts`), the pages (`src/ui/pages/`), the email renderer and copy (`src/email/`) |
| Distribution | `@reservajs/astro` and `@reservajs/stripe`, the shipped `AGENTS.md`, and docs generated from the exported constants |

## Invariants

These hold at every commit. A change that would break one waits until the design is
reconsidered.

- Delivery state comes from outbox rows. No flag on a booking duplicates it.
- Quote and checkout price through the same code and can't disagree.
- Every API error goes through one envelope (`src/http.ts`) with a code from `API_ERROR_CODES`.
- A booking's price and partner are fixed at checkout. Later edits to settings or offers don't
  change them.
- A schema change updates the fingerprint (`src/schema-check.ts`) and its test in the same
  commit.
- Only one migration rebuilds a given table within one change.

## Design rules

Many people will wire Reserva in through a coding agent, so the library is written to be read
by one.

- **One place per fact.** Routes only in the manifest, prices only in the pricing module, email
  copy only in the catalogs, the public booking shape only in `toWireBooking`.
- **Closed sets ship as values.** `BOOKING_EVENTS`, `API_ERROR_CODES`, route ids and outbox
  families are exported at runtime, not just as types, so a consumer can list every case.
- **A deployment describes itself.** `GET /api/booking/catalog` says what can be booked, and
  `GET /api/booking/ops/health` reports migrations, outbox debt and open incidents.
- **Errors say how to fix them.** Config errors carry the key path, the rule and the fix. API
  errors carry enough to correct the request without reading source.
- **Versioned envelopes, one projection.** Webhooks carry `apiVersion`, and pushed and pulled
  bookings come from the same projection. An event's envelope is written with the change that
  caused it, and retries send the same bytes.
- **Records build up where the next reader looks.** Migrations explain their backfills,
  snapshot tests pin behavior so every diff maps to a decision, and contract docs are
  generated.

## Boundaries

- Cloudflare Workers and D1 are the only target. The atomic capacity checks depend on D1.
- Stripe Checkout is the only shipped payment adapter. `PaymentProvider` is public so others can
  be written; there's no registry.
- No customer booking form ships in the package. `examples/smoke-site` is the reference.
- Out of scope: multi-day rentals, assigned seating, per-staff scheduling.

## Deferred

Each with what would make it worth revisiting.

- **Splitting `src/repo.ts`.** Real debt, but every method is sensitive to transactions and
  compare-and-set. Revisit once those patterns have been stable for a few months.
- **Tests for the admin, manage and settings enhancers** (the client-side scripts). Revisit next
  time that UI changes substantially.
- **Per-route path overrides**, beyond the prefix. Revisit when someone asks.
- **A public provider error hierarchy.** Only the alert and reconciliation contracts are
  exported. Revisit when an external adapter needs more.
- **Admin search and calendar cost.** Free-text search scans up to a fixed cap in memory, and
  the calendar recomputes each day's peak on every load. Fine at today's scale; revisit at ten
  times the bookings.
- **Bookings with no stored occupancy units** count as one unit. Re-counting them needs the
  deployment's config, so it belongs in that deployment's own data migration, not in Reserva's.
