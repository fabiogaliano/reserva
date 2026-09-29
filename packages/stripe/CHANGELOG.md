# @reservajs/stripe

## 0.8.0

### Minor Changes

- 54fcfe3: The Stripe adapter no longer depends on the Stripe SDK. It calls Stripe's REST API with `fetch` and verifies webhook signatures with WebCrypto, matching the SDK's API version, request encoding, retries, error classes and signature checks. A Worker no longer loads about 550 KB of SDK code on the first payment request in each isolate, which could exceed the Workers Free plan's 10 ms CPU limit and fail checkouts, refunds and webhooks with error 1102. The `stripe()` options and exported types are unchanged. A stripe-node instance can still be injected through `client`.

### Patch Changes

- Updated dependencies [4d5e7ea]
- Updated dependencies [9693ccc]
- Updated dependencies [5b2d1a1]
  - @reservajs/astro@0.14.0

## 0.7.1

### Patch Changes

- Updated dependencies [5b499ee]
- Updated dependencies [8db20d1]
  - @reservajs/astro@0.13.0

## 0.7.0

### Minor Changes

- b9cb33a: Refund totals and dispute outcomes on every booking.
  
  **Run `bunx reserva-migrate` after upgrading.** Migration `0007_refunds_disputes.sql` adds `amount_refunded_minor`, `disputed_at` and `dispute_status` to bookings, filled from the refunds and disputes already on record (an earlier dispute starts as `open`, since its outcome was never stored). Earlier releases kept a dispute only as the notification it triggered, so one that arrived while no owner email or durable hook was set up for `payment.dispute_created` left nothing to carry over.
  
  **Add `charge.dispute.closed` to your Stripe webhook endpoint.** Without it nothing breaks, but disputes stay `open`.
  
  - `booking.amountRefundedMinor` is the running total of refunds sent on the payment, partial or full, from Reserva or the Stripe dashboard. A partial refund made in the dashboard used to be logged and dropped; it is now recorded and still leaves the booking confirmed. A full refund cancels the booking as before. Events arriving out of order never lower the total.
  - `booking.disputedAt` and `booking.disputeStatus` (`'open' | 'won' | 'lost'`, `null` when never disputed) record chargebacks and bank inquiries. Closing a dispute sends no email and leaves the booking as it is. When a payment is disputed a second time, the booking reopens as `open` with the later dispute's date and then takes its outcome.
  - `PAYMENT_EVENTS` gains `dispute_closed`, and `PaymentEventParsed` gains `disputeOutcome` and `disputeCreatedAt`, the processor's own opening time, which dates the dispute whatever order its events arrive in. `DisputeStatus` and `DisputeOutcome` are exported from `@reservajs/astro/core`. A payment adapter reports `amountRefunded` as the payment's cumulative total.
  - `@reservajs/stripe` maps `charge.dispute.closed`: `won` and `warning_closed` (an inquiry closed without a chargeback) are won; `lost` and `prevented` (settled by refunding the cardholder) are lost. Any other status leaves the dispute open. Both dispute events carry the Stripe dispute's `created` time.

### Patch Changes

- Updated dependencies [81a7901]
- Updated dependencies [b91cbf4]
- Updated dependencies [b9cb33a]
  - @reservajs/astro@0.12.0

## 0.6.0

### Minor Changes

- fff54ea: Exact guest count for "up to N" services.
  
  **Run `bunx reserva-migrate` after upgrading.** Migration `0006_guest_count.sql` adds a `guest_count` column to bookings.
  
  - Set `collectGuestCount: true` on a service to ask the payer how many people are coming. The field is optional and never blocks payment.
  - The answer is stored as `booking.guestCount`. Price and capacity still follow `quantity`.
  - `@reservajs/stripe` adds it as an optional numeric field on Stripe Checkout. Change its label with `guestCountFieldLabel`.

### Patch Changes

- Updated dependencies [40390d7]
- Updated dependencies [fff54ea]
  - @reservajs/astro@0.11.0

## 0.5.2

### Patch Changes

- 50b8530: Confirmation and manage page fixes.
  
  **Run `bunx reserva-migrate` after upgrading.** Migration `0005_calendar_patch_outbox.sql` adds a `calendar_patch` outbox family (ops health can now report it).
  
  **Breaking:** `icsText` and `icsDataUrl` from `@reservajs/astro/ui` now take a second argument, `{ uid, generatedAt }`. Use `calendarUid(reference, businessUrl)` for the `uid`.
  
  - A reschedule succeeds as soon as the booking moves. The calendar update now goes through the outbox (retried, then raised as an incident), so a calendar outage no longer turns a finished reschedule into a 500. The incident is titled "Calendar not updated".
  - Rescheduling to the time the booking already has succeeds without doing anything, so a double-submitted form no longer errors.
  - The reschedule calendar no longer counts the customer's own booking against capacity. Availability accepts the booking's manage token in the `x-reserva-manage-token` header (`MANAGE_TOKEN_HEADER`, or `manageToken` on the client). That answer is never cached.
  - The reschedule picker no longer fails with a 400 when its range crosses a daylight-saving change.
  - After cancelling, the customer sees a "Booking cancelled" page instead of "Link not valid".
  - The manage page shows both the cancel and the reschedule deadline, and says when one has passed. Form errors come back as a readable message, and buttons are disabled while a form is sending.
  - The confirmation page keeps waiting after a server error instead of saying the booking wasn't found. With JavaScript it checks the status in the background and announces progress to screen readers. `?locale=pt` now finds `pt-PT`.
  - Calendar files use one UID per booking (`<reference>@<your host>`), so two bookings at the same time no longer clash. `DTSTAMP` is the time the file was made.
  - Multi-day bookings show their end date. After the 4-hour detail window, the page no longer says a confirmation email is on its way.
  - Customer pages get a "Skip to content" link, and the theme toggle works on every confirmation and manage page.
  - Checkout's metadata errors include `details.field` (`metadata.<key>`) for every rule.
  - The low-availability hint now reads "Room for {n} more bookings", with a new singular key `widget.limitedOne`. If you override `widget.limited`, override `widget.limitedOne` too.
  - `createReservaClient({ base })` accepts a trailing slash.
  - Stripe: the default success URL includes `&locale=`.
  
  New message keys: `widget.limitedOne`, `confirmation.pollChecking`, `confirmation.pollUpdated`, `confirmation.summaryLead`, `manage.reschedulePolicy`, `manage.cancelClosed`, `manage.rescheduleClosed`, `manage.cancelDoneTitle`, `manage.cancelDoneBody`, `manage.cancelDoneRefund`, `manage.bookAgain`.
- Updated dependencies [50b8530]
- Updated dependencies [50b8530]
- Updated dependencies [50b8530]
  - @reservajs/astro@0.10.0

## 0.5.1

### Patch Changes

- Updated dependencies [7f5d276]
  - @reservajs/astro@0.9.0

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
