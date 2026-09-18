# @reservajs/stripe

## 0.5.0

### Minor Changes

- 295ae19: Partial refunds. `refund` on the operator cancel request accepts `partial` alongside `none` and `full`, with `refundAmountMinor` (at least 1, below the booking price) naming the amount. Migration `0004_partial_refunds.sql` widens the `refund_operations.choice` CHECK and adds `requested_amount_cents`, so a reconciler retry replays the decided amount rather than the booking price; two `partial` requests for different amounts are different decisions and the loser gets `409 refund_conflict`. Still one refund per booking, decided at cancellation.
  
  The Stripe adapter now sends `amount` explicitly on every refund instead of relying on Stripe's refund-the-remainder default. A refund that is mid-retry across the upgrade presents the same idempotency key with different parameters and fails until the key ages out (~24h), then succeeds on a fresh attempt — visible as a refund incident, never a double refund.
  
  Message keys `manage.refundPartial`, `manage.refundAmount`, `manage.refundAmountHint` added. Email copy `refund.timing` reworded to make no claim about how much is returned.

### Patch Changes

- Updated dependencies [295ae19]
  - @reservajs/astro@0.8.0

## 0.4.2

### Patch Changes

- Updated dependencies [3afca1a]
  - @reservajs/astro@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [f107671]
  - @reservajs/astro@0.6.0

## 0.4.0

Breaking release, paired with `@reservajs/astro` 0.5.0. Peer range is now `^0.5.0`.

### Breaking

- Payment methods come from the Stripe dashboard. The `paymentMethods` option and the
  `StripePaymentMethod` and `stripePaymentMethodTypes` exports are gone. Apple Pay, Google Pay and
  Link show up without a code change.
- Delayed methods are excluded and refused. Sessions send `excluded_payment_method_types` from
  `STRIPE_DELAYED_PAYMENT_METHOD_TYPES` and `submit_type: 'book'`. A completed-but-unpaid session
  releases the hold and cancels the payment. Subscribe your webhook to
  `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`.
- One name per option: `secretKey`, `client`, `successUrl`, `cancelUrl`, `lineItemName`. The
  aliases (`apiKey`, `stripe`, `stripeClient`, `getSuccessUrl`, `getCancelUrl`, the five
  line-item spellings) are removed.
- `cancelUrl` defaults to `business.url`; `lineItemName` defaults to the service's localized title.
- The default success URL uses `?sessionId=`.

### Changed

- `createCheckout` returns `expiresAt`, and the provider implements `cancelPayment`.
- `charge.refunded` reports `refundRef: null`. Stripe stopped expanding the charge's refunds list in
  API 2022-11-15, so the cancel-on-full-refund path keys off the amounts.

## 0.3.1

### Patch Changes

- Updated dependencies [b3bb45d]
- Updated dependencies [3e25e99]
- Updated dependencies [37df70b]
- Updated dependencies [b3bb45d]
  - @reservajs/astro@0.4.0

## 0.3.0

### Changed

- Booking callbacks receive Reserva's fully resolved runtime config.
- The `@reservajs/astro` peer dependency now targets the coordinated `0.3.x` release.

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
