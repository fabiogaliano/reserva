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
      paymentMethods: ['card'],
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
| `paymentMethods` | Checkout payment method types. Defaults to `['card']`; `'mb_way'` is also supported. |
| `termsOfService` | `'required'` (default) records consent at checkout; `'none'` for accounts without a public ToS URL. |
| `productDescription`, `getServiceName`, `pickupFieldLabel` | Copy on the hosted checkout line item and pickup field. Each takes a value or a `(booking, config)` callback. |
| `successUrl`, `cancelUrl` | Override the URLs Reserva derives from `business.url` and its confirmation route. |
| `client` | Inject a Stripe client (tests). |

Stripe's own limits are validated once, when the runtime definition initializes, and the error names
the offending config path: the checkout session cannot stay open longer than 24 hours
(`booking.holdMinutes`), the locale must be one Stripe has checkout copy for, and the currency must
be one Stripe can present.

## Checkout semantics

- One line item for the whole booking, priced by Reserva's pricing module — this adapter never
  computes a price itself.
- The session expires 5 minutes before the booking hold does, so a paid session can never outlive
  the capacity it holds.
- `pickup_address` is collected as a custom field only when the booked service's location option
  declares `requiresAddress`.
- Checkout creation is idempotent per booking, and a refund carries a marker that lets a retry
  recognize a refund it already issued instead of issuing a second one.

## Webhooks

Create a Stripe webhook endpoint pointing at `https://<your site>/api/booking/webhooks/payment` and
subscribe to `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, and
`charge.dispute.created`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`. Signatures are verified
against the raw body before anything is parsed, and an unsigned or tampered request is rejected
without touching the booking.

## License

MIT
