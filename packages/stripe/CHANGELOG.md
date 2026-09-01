# @reservajs/stripe

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0]

First release. The Stripe Checkout adapter previously shipped inside the main package as
`providers/payments-stripe`; it is now its own package so that installing the booking engine
never installs the Stripe SDK.

### Added

- `stripe(options)` — a named factory returning `PaymentProvider`. The implementation class is
  internal: there is no default export and nothing to `new`.
- `paymentMethods` option (`'card'`, `'mb_way'`; defaults to `['card']`), moved out of the
  engine's config because the vocabulary, and the account capability behind it, are Stripe's.
- A synchronous provider validator that owns Stripe's own limits — the 24-hour checkout session
  cap against `booking.holdMinutes`, presentable currencies, and Stripe's checkout locales — and
  fails at runtime-definition initialization naming the offending config path.

### Changed

- Imports only documented `@reservajs/astro` entrypoints (principally
  `@reservajs/astro/core`), and declares `@reservajs/astro@^0.2.0` as a peer dependency.
- Prices always come from the engine's pricing module; the adapter never computes one.
- The refund idempotency marker is `reserva-refund-<paymentIntent>`. A refund retried across the
  rename presents a new key, and Stripe's "already refunded" answer is reconciled through
  `refunds.list` exactly as it is for an expired key — a double refund is not possible.
