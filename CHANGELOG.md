# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- The `@reservajs/astro/providers` barrel subpath. Import each provider from its own subpath.

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
