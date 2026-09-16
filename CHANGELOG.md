# Changelog

## 0.4.0

### Minor Changes

- b3bb45d: Add an **Opening hours** tab to the admin settings page. Each service's schedule rule exposes its first and last departure as editable `HH:MM` settings, its departure interval in minutes, and the weekdays it covers as a row of checkboxes (`services.<slug>.schedule.<index>.firstStart` / `.lastStart` / `.intervalMin` / `.days`), stored as overrides like every other setting and validated so the first departure never lands after the last and a rule always keeps at least one day. A stored hours row that a later config edit makes invalid is now dropped on its own instead of discarding every override.
  
  `firstStart` and `lastStart` on a schedule rule are now optional and default to `09:00` and `18:00`.
- 3e25e99: Add a **Pricing** tab to the admin settings page. Every pricing tier of every service exposes its amount as an editable setting (`services.<slug>.pricing.<index>.priceMinor`), grouped per service and labelled by the tier's quantity band and pickup option. Amounts are typed in major units (`150`, `150.50`, or `150,50`) and stored as the integer minor-unit value config already uses, with the currency's own decimal count deciding what is accepted. A tier's `maxQuantity` and `pickup` stay deploy-time.
- 37df70b: Rework the admin dashboard and settings pages around a lighter, one-screen-at-a-time layout.
  
  The dashboard is now three tabs (`?tab=upcoming` / `availability` / `attention`) over a day-grouped booking list. Each booking is a native `<details>` row showing time, customer, service · party size · place, and a status only when it is not confirmed; opening it reveals the reference, contact details, price, pickup and booked-on date alongside a **Manage** link. The bookings table is gone, so the list no longer clips on narrow screens. The availability calendar drops the per-cell `units x/y` label in favour of a state dot, keeping the unit load in the cell's accessible name and tooltip. A header link jumps straight to the attention tab, with a count badge when incidents are open.
  
  Settings now read as sentences: each setting is a plain statement with its value in bold and a **Change** action that swaps in the control. A service's departure window, interval and weekdays collapse into two sentences instead of four separate fields.
  
  Both pages keep working with scripting off. Tabs are real links with every panel server-rendered, rows are native disclosures, and settings render the sentence and its control together, with the browser-side script collapsing the control only once it has run.
- b3bb45d: Publish pricing on the public catalog. Every service in `GET /api/booking/catalog` now carries `pricing` — its rules exactly as configured, each `{ maxQuantity, pickup, priceMinor }` with `pickup` null where the service has no pickup axis — and `fromPriceMinor`, the lowest price across those rules, for rendering a "from" price. Both are projected from the merged runtime config, so admin overrides flow through, and `CatalogService` (plus the new `CatalogPricingRule`) is exported from `@reservajs/astro/core`.
  
  A site can now render prices from the engine instead of keeping its own copy. The catalog still never exposes schedules, turnaround, or capacity, and the amount charged still comes from `/api/booking/quote`.

## 0.3.0

### Added

- `scheduledHandler`, a ready-to-use cron Worker handler for reconciliation.
- Packaged API, configuration, customization, deployment, and development guides.

### Changed

- The optional booking, locale, legal, and admin config blocks now receive defaults.
- Cloudflare runtimes read Reserva's own secrets without requiring consumers to restate them.
- Fresh databases initialize from one consolidated migration; databases upgraded through the
  previous migration chain remain compatible.
- The root and core barrels expose only the supported integration contract.

### Removed

- The `@reservajs/astro/providers` barrel subpath. Import each provider from its own subpath.
- The embeddable `AdminDashboard.astro` component. Use Reserva's injected admin route.

## [0.2.0]

First public release, as `@reservajs/astro`. Everything before it shipped privately under a
different package name; `docs/MIGRATING-v2.md` maps every rename.

### Added

- Generic booking-event layer: `BOOKING_EVENTS` as an exported runtime catalog, in-process
  hooks (fire-and-forget or durable) on the runtime, and outbound webhooks declared in config,
  signed per the [Standard Webhooks](https://www.standardwebhooks.com/) specification and
  delivered from the same durable outbox.
- Headless consumer API surface: `POST /api/booking/quote` (the price checkout charges, with
  nothing stored), `GET /api/booking/catalog` (the rendering contract), and
  `GET /api/booking/ops/health` (schema, outbox debt, open incidents). Every request and
  response shape is an exported type, and every failure code is in the exported
  `API_ERROR_CODES` catalog.
- Optional per-service `location` module (meeting points and pickup options) and declared
  `metadataFields` (four types, three modifiers) — both published through the catalog endpoint
  and validated at checkout.
- `adminAuth` port: admin and operator authorization is a documented callback, with Cloudflare
  Access as the default implementation rather than the only one.
- `config.routes.manage` to disable the built-in manage page while keeping its APIs mounted.
- Provider-agnostic `@reservajs/astro/email` exporting `renderDefaultEmail` and its three
  types, so a non-Brevo transport can reuse the maintained template.
- `@reservajs/astro/ui` subpath for the copy seam (`defaultMessages`, `resolveMessages`,
  `formatMessage`, and their types), moved off the root barrel so importing copy no longer
  pulls the build-time integration into a page bundle.
- `AGENTS.md` ships inside the package as the integration contract. Its route, error-code, and
  event tables — and the README's — are generated from the exported constants, with a CI drift
  check.
- `SECURITY.md`, changesets, and `npm publish --dry-run` for both tarballs in CI.

### Changed

- **The package now ships compiled `dist/` output** (JS + declarations + source maps, with the
  two retained `.astro` components and their CSS copied raw into the mirrored tree). Consumers
  no longer need `vite.ssr.noExternal` or `@types/node`.
- **Stripe is a separate package.** `@reservajs/stripe` exposes a named `stripe(options)`
  factory returning `PaymentProvider`; `@reservajs/astro` has no `stripe` dependency, no Stripe
  implementation, and no payment-adapter subpath. Payment-method selection and Stripe's
  locale/currency/session limits moved to the adapter.
- **Domain rename** (one migration, `0018_v2_domain_rename.sql`): tours became services,
  `people` became `quantity`, `priceCents` became `priceMinor` beside a per-booking `currency`,
  and the vendor's name left the core columns (`paymentSessionRef`, `paymentRef`). Any
  ISO 4217 currency is now supported, with correct zero-decimal handling.
- Error codes lost the vendor prefix: `payment_session_mismatch`, `payment_amount_mismatch`,
  `invalid_payment_signature`. The payment webhook route is `/api/booking/webhooks/payment`.
- Bindings, secrets, virtual module ids, asset routes, the migrate bin, and every exported
  symbol carry the Reserva name.

### Removed

- `BookingWidget.astro` is no longer a package export. The reference funnel lives in
  `examples/smoke-site` and is exercised end-to-end as a real consumer.
- The Tourflow provider and its operator feed, replaced by hooks and signed webhooks.
- Per-entity delivery flags (`calendarSynced`, `emailSynced`, `tourflowSynced`) — delivery state
  lives only in `side_effect_operations` rows — plus the dead `remindedAt`/`reviewRequestedAt`
  fields.

## [0.1.0] - 2026-08-03

- Astro 7 integration for server-rendered tour booking on Cloudflare Workers, D1, and the Cache API, configured via a single `reserva()` call plus a user-owned runtime module for provider construction at request time.
- Injected booking API routes (availability, checkout, Stripe webhook, status, manage, cancel, reschedule, operator actions, feed) and server-rendered `/booking/admin`, `/booking/manage`, and booking-confirmation pages, all server-only with `prerender: false`.
- Provider families for payments (Stripe), calendar (Google), email (Brevo, plus a no-op provider), and tour operations (Tourflow), each importable from its own narrow subpath to keep unused SDKs out of the bundle.
- Embeddable `BookingWidget.astro`, `ManageBooking.astro`, and `AdminDashboard.astro` components, themeable entirely through `--bk-*` CSS custom properties with dark-mode defaults, and a typed, locale-overridable UI copy catalog.
- Durable refund operations backed by a `refund_operations` table with a compare-and-set claim per booking, reconciling operator- and Stripe-dashboard-initiated refunds through one record instead of in-memory state.
- Booking tokens (customer cancel token, operator token) hashed at rest with SHA-256, given a shared expiry, and revoked on cancellation, with optional AES-GCM encryption for manage-link regeneration.
- Admin route protection via Cloudflare Access JWT verification plus independent same-origin CSRF protection (Fetch-Metadata/Origin check and a signed, expiring CSRF token) for admin mutations.
- Route customization options (`routePrefix`, `routes.admin`/`routes.ops`) to remount or selectively disable non-load-bearing route groups.
- `reserva-migrate` CLI wrapping `wrangler d1 migrations apply` for applying the package's D1 migrations to local or remote databases.
- A local interactive demo (`examples/smoke-site`) running the full booking flow against Astro dev, Cloudflare workerd, and persistent local D1 with simulated providers.
