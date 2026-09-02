# Reserva — architecture and design law

Distilled from the v2 direction record when the plan ledger was retired
(2026-09; the full wave-by-wave record lives in git history under
`docs/plans/`). This file carries only what still governs future changes.

## System map

Layers bottom-up, each with its single source of truth. Every other surface
derives from that source and none may cache or duplicate it.

| Layer | Single source of truth |
|---|---|
| Declared intent | `ClientConfig` schema (`src/core/config.ts`), validated during Astro config and again when the runtime definition initializes |
| Domain | `Booking` + the status machine + the one pricing path (`src/core/`) |
| State & delivery | `bookings` rows + `side_effect_operations` outbox rows — delivery/sync state lives nowhere else |
| Contract | exported wire types, `API_ERROR_CODES` (+ `ApiErrorCode`), `BOOKING_EVENTS`, the webhook envelope, the `toWireBooking` projection |
| Surfaces | route manifest (`src/routes-manifest.ts`), admin/manage/confirmation pages (`src/ui/pages/`), email renderer + copy catalogs (`src/email/`) |
| Distribution | packed `@reservajs/astro` + `@reservajs/stripe` (`dist/` mirrors `src/`), shipped `AGENTS.md`, contract docs generated from the exported constants with a CI drift check |

## Invariants

Hold at every commit; a change that would break one stops until the design is
revisited.

- Delivery/sync state is derived from outbox rows; no entity flag may
  duplicate it.
- Quote and checkout price through one code path and cannot disagree.
- Every API failure flows through the single error envelope (`src/http.ts`);
  every code comes from the closed `API_ERROR_CODES` set.
- A schema change updates the fingerprint (`src/schema-check.ts`) and its
  preservation test in the same commit.
- A table rebuild migration has exactly one owner: no two migrations may
  rebuild the same table as part of one change wave.

## Design law (agent legibility)

Headless consumers increasingly integrate and operate through coding agents;
Reserva treats them as a first-class audience.

- **One truth per fact.** Routes only in the manifest; prices only in the
  pricing module; email copy only in the extracted catalogs; the public
  booking shape only in `toWireBooking`.
- **Closed, exported vocabularies.** Every finite set ships as a runtime
  value, not just a type (`BOOKING_EVENTS`, `API_ERROR_CODES`, route ids,
  outbox operation families), so an agent or a consumer `switch` can
  enumerate every case and prove exhaustiveness.
- **Self-description.** A deployment answers "what are you?" without source
  access: `GET /api/booking/catalog` (rendering contract) and
  `GET /api/booking/ops/health` (migrations/fingerprint, outbox debt, open
  incidents).
- **Remediating errors.** Every rejection names what was wrong *and* what to
  do: config errors carry the key path, the violated rule, and the fix; API
  envelopes carry enough to correct the request without reading source.
- **Versioned envelopes, one projection.** The webhook envelope carries
  `apiVersion`; pushed and pulled booking shapes come from the same exported
  projection. A durable event's envelope is serialized atomically into its
  outbox row and every retry sends those exact bytes — it is the historical
  truth of the occurrence, never a view of current state.
- **Accretive records.** Knowledge lands where the next reader looks:
  migration files record the why of each backfill; snapshot suites pin
  behavior so every diff maps to a written decision; contract docs are
  generated, never hand-copied.

## Deliberate boundaries

- Cloudflare D1 + Workers are the one blessed target — the atomic capacity
  guards depend on it, and edge-native is the differentiator.
- Stripe Checkout is the only shipped and tested payment implementation; the
  port (`PaymentProvider` from `@reservajs/astro/core`) is public so others
  are writable, with no registry and no speculative second implementation.
- No customer booking-funnel UI ships in the package; `examples/smoke-site`
  is the reference consumer.
- Non-goals: multi-day/date-range rentals, per-seat assigned ticketing,
  per-staff-member scheduling.

## Deferred — with revisit triggers

- **`src/repo.ts` split** (~59 methods): real debt, deliberately deferred —
  the surface is CAS/transaction-sensitive. Revisit once the concurrency
  patterns have been stable for a few months.
- **Enhancer DOM test harness** (manage/admin/settings enhancers have no
  executed-behavior tests): revisit when that UI next changes materially.
- **Per-route path overrides** (beyond the prefix): open; revisit when a
  consumer asks.
- **Broad public provider-error contract**: only the narrow
  operational-alert/reconciliation contracts are exported; the full hierarchy
  stays internal until an external adapter needs it.
- **`listUpcoming` scan + per-row decrypts, per-date occupancy recompute**:
  acceptable at the documented deployment scale; revisit at an order of
  magnitude more bookings.
- **Pre-0008 occupancy backfill**: pre-upgrade rows' occupancy columns are
  NULL by design; a config-aware repair belongs to a deployment's own data
  migration, not to a library migration.
