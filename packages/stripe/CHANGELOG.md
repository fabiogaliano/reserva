# @reservajs/stripe

## 0.4.0

### Minor Changes

- 893229a: One vocabulary across the endpoints: `serviceSlug`, `pickup`, `start` and `sessionId`.
  
  Availability reads `?serviceSlug=`, status reads `?sessionId=`, the checkout body reads `pickup`
  and the reschedule body reads `start`. The previous spellings (`?service=`, `?session_id=`,
  `pickupType`, `newStart`) still read for one minor and log `deprecated field` once per isolate per
  field; they are removed from the exported request types now. `ManageBooking.pickup` replaces
  `ManageBooking.pickupType`, `CheckoutRequest.pickup` replaces `CheckoutRequest.pickupType`, and
  `RescheduleRequest`/`CancelRequest` are exported for the first time. The Stripe adapter's default
  success URL emits `sessionId={CHECKOUT_SESSION_ID}`. The webhook envelope's booking keeps
  `pickupType`, which stays frozen for this release line.
- 893229a: Provider options: one name per option, one export per class.
  
  `stripe(options)` keeps `secretKey`, `webhookSecret`, `client`, `now`, `successUrl`, `cancelUrl`,
  `lineItemName`, `productDescription`, `pickupFieldLabel` and `termsOfService`; `apiKey`, `stripe`,
  `stripeClient`, `getSuccessUrl`, `getCancelUrl` and the five line-item-name spellings are gone.
  `cancelUrl` now defaults to `business.url` rather than a guessed `/services/<slug>` page, and
  `lineItemName` defaults to the service's localized title. `charge.refunded` no longer reports a
  `refundRef`: Stripe stopped expanding the charge's `refunds` list in API 2022-11-15, so the dead
  lookup is removed and the cancel-on-full-refund path keys off the amounts.
  
  `GoogleAuthOptions` and `GoogleCalendarProviderOptions` drop every alias (`googleSaEmail`,
  `saEmail`, `googleSaPrivateKey`, `privateKey`, `googleImpersonateEmail`, `subject`, `fetchImpl`,
  `clock`, `apiBaseUrl`, `calendarApiUrl`), and `@reservajs/astro/providers/calendar-google` exports
  only the named `GoogleCalendarProvider`. `verifyAccessJwt` options keep `now` and `jwksTtlMs`.
  
  `PaymentProvider`'s doc comments now state the metadata, idempotency and signature contract, and
  the new `docs/providers.md` walks through writing a payment adapter.
- 893229a: Stripe payment methods are now managed in the Stripe dashboard, and delayed payment methods are
  refused safely.
  
  **Breaking (`@reservajs/stripe`):** the `paymentMethods` option and the `StripePaymentMethod` and
  `stripePaymentMethodTypes` exports are removed, and sessions no longer send `payment_method_types`.
  Delete `paymentMethods` from your `stripe({ … })` call and enable the methods you want in the
  Stripe dashboard — Apple Pay, Google Pay and Link now appear without a code change.
  
  - Sessions send `excluded_payment_method_types` from the new exported
    `STRIPE_DELAYED_PAYMENT_METHOD_TYPES` constant (bank debits, bank transfer, vouchers), and
    `submit_type: 'book'`.
  - `createCheckout` now returns `expiresAt` alongside `url` and `sessionRef`; `PaymentProvider`
    gained the optional field and an optional best-effort `cancelPayment(paymentRef)`, implemented
    for Stripe with `paymentIntents.cancel`.
  - A completed-but-unpaid checkout session releases the hold, cancels the payment, and answers
    `200` with a warning instead of `409 payment_amount_mismatch`.
    `checkout.session.async_payment_succeeded` records and issues a full refund;
    `checkout.session.async_payment_failed` releases the hold. Subscribe your webhook endpoint to
    both new event types.

### Patch Changes

- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
- Updated dependencies [893229a]
  - @reservajs/astro@0.5.0

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
