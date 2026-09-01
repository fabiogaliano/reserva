# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
