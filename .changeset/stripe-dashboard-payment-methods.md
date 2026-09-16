---
"@reservajs/stripe": minor
"@reservajs/astro": minor
---

Stripe payment methods are now managed in the Stripe dashboard, and delayed payment methods are
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
