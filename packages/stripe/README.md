# @reservajs/stripe

The official Stripe Checkout adapter for [Reserva](https://www.npmjs.com/package/@reservajs/astro).

Reserva's payment port is provider-neutral and documented, so anyone can write an adapter for
another processor. Stripe is the only one that is officially shipped and tested.

```sh
bun add @reservajs/astro @reservajs/stripe
```

## Setup

`stripe(options)` returns a `PaymentProvider`. Wire it in your runtime module — the same file that
`reserva({ runtimeEntrypoint })` points at:

```ts
import { defineCloudflareReservaRuntime } from '@reservajs/astro/runtime';
import { stripe } from '@reservajs/stripe';
import config from './reserva.config';

export default defineCloudflareReservaRuntime<Env>(config, {
  providers: ({ env }) => ({
    payments: stripe({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    }),
  }),
});
```

There is no class to construct and no default export: the factory is the whole surface.

### Options

| Option | Purpose |
|---|---|
| `secretKey` | Stripe secret key. Required. |
| `webhookSecret` | Signing secret of the endpoint you point at `/api/booking/webhooks/payment`. Required. |
| `termsOfService` | `'required'` (default) records consent at checkout; `'none'` for accounts without a public ToS URL. |
| `lineItemName`, `productDescription`, `pickupFieldLabel` | Copy on the hosted checkout line item and pickup field. Each takes a value or a `(booking, config)` callback. `lineItemName` defaults to the service's localized `title`. |
| `successUrl`, `cancelUrl` | Override the URLs Reserva derives from `business.url` and its confirmation route. Each takes a string or a `(booking, config)` callback; `cancelUrl` defaults to `business.url`. |
| `now` | Inject a clock (tests). |
| `client` | Inject a Stripe client (tests). |

Stripe's own limits are validated once, when the runtime definition initializes, and the error names
the offending config path: the checkout session cannot stay open longer than 24 hours
(`booking.holdMinutes`), the locale must be one Stripe has checkout copy for, and the currency must
be one Stripe can present.

## Payment methods

Payment methods are managed in the Stripe dashboard. This adapter never sends
`payment_method_types`, so Apple Pay, Google Pay, Link and anything else you enable there show up
at checkout without a code change.

**Reserva does not support delayed payment methods. Do not enable Multibanco, SEPA Direct Debit, or
bank transfer in the Stripe dashboard.** Their money arrives days after the booking's capacity hold
expires, so there is nothing left to confirm. As a guard, every session is created with
`excluded_payment_method_types` set to the exported `STRIPE_DELAYED_PAYMENT_METHOD_TYPES` constant
(bank debits, bank transfer, vouchers). If one is enabled and used anyway, Reserva refuses the
checkout — the hold is released, the payment intent is cancelled where Stripe allows it, and the
customer sees a "we couldn't take this payment" page. Money that settles regardless arrives as
`checkout.session.async_payment_succeeded` and is refunded in full automatically.

## Checkout semantics

- One line item for the whole booking, priced by Reserva's pricing module — this adapter never
  computes a price itself.
- `submit_type: 'book'`, so Stripe's button reads "Book".
- The session expires 5 minutes before the booking hold does, so a paid session can never outlive
  the capacity it holds.
- `pickup_address` is collected as a custom field only when the booked service's location option
  declares `requiresAddress`.
- Checkout creation is idempotent per booking, and a refund carries a marker that lets a retry
  recognize a refund it already issued instead of issuing a second one.

## Webhooks

Create a Stripe webhook endpoint pointing at `https://<your site>/api/booking/webhooks/payment` and
subscribe to exactly these six events:

- `checkout.session.completed`
- `checkout.session.expired`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `charge.refunded`
- `charge.dispute.created`

Put its signing secret in `STRIPE_WEBHOOK_SECRET`. Signatures are verified
against the raw body before anything is parsed, and an unsigned or tampered request is rejected
without touching the booking.

**Set the webhook endpoint's API version explicitly** in the Stripe dashboard rather than leaving it
on "your account's default". The event payload's shape follows the endpoint's version, so an account
default that moves under you can change the fields this adapter reads without any deploy on your side.

## License

MIT
