# @reservajs/stripe

The official Stripe Checkout adapter for [Reserva](https://www.npmjs.com/package/@reservajs/astro).

Reserva's payment interface isn't tied to any processor, so you can write an adapter for
another one. Stripe is the only one shipped and tested.

```sh
bun add @reservajs/astro @reservajs/stripe
```

## Setup

`stripe(options)` returns a `PaymentProvider`. Pass it in your runtime module
(`src/reserva-runtime.ts` by default):

```ts
import { defineCloudflareReservaRuntime } from '@reservajs/astro/runtime';
import { stripe } from '@reservajs/stripe';

export default defineCloudflareReservaRuntime<Env>({
  providers: ({ env }) => ({
    payments: stripe({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    }),
  }),
});
```

### Options

| Option | Purpose |
|---|---|
| `secretKey` | Stripe secret key. Required. |
| `webhookSecret` | Signing secret of the endpoint you point at `/api/booking/webhooks/payment`. Required. |
| `termsOfService` | `'required'` (default) asks for consent at checkout; `'none'` for accounts without a public terms URL. |
| `lineItemName`, `productDescription`, `pickupFieldLabel`, `guestCountFieldLabel` | Copy on the hosted checkout line item, pickup field and headcount field. Each takes a value or a `(booking, config)` callback. `lineItemName` defaults to the service's localized `title`; `guestCountFieldLabel` to "Exact number of guests" (Stripe allows 50 characters). |
| `successUrl`, `cancelUrl` | Override the URLs Reserva derives from `business.url` and its confirmation route. Each takes a string or a `(booking, config)` callback; `cancelUrl` defaults to `business.url`. |
| `now` | Inject a clock (tests). |
| `client` | Inject a Stripe client (tests). |

Stripe's own limits are checked once at startup, and an error names the config path: a checkout
session can't stay open more than 24 hours (`booking.holdMinutes`), and the locales and currency
must be ones Stripe Checkout supports.

## Payment methods

Turn payment methods on in the Stripe dashboard. The adapter never sends
`payment_method_types`, so Apple Pay, Google Pay, Link and anything else you enable appear at
checkout without a code change.

**Don't enable delayed payment methods** such as Multibanco, SEPA Direct Debit or bank
transfer. Their money arrives days after the booking's hold expires. Every session excludes
them through `excluded_payment_method_types` (the exported `STRIPE_DELAYED_PAYMENT_METHOD_TYPES`:
bank debits, bank transfer, vouchers). If one gets used anyway, Reserva refuses the checkout: the
hold is released, the payment is cancelled where Stripe allows, and the customer sees a "we
couldn't take this payment" page. Money that settles anyway is refunded in full automatically.

## Checkout semantics

- One line item for the whole booking, at the price Reserva computed, partner discount
  included. The adapter never computes a price.
- `submit_type: 'book'`, so Stripe's button reads "Book".
- The session expires 5 minutes before the hold, so a session can't be paid after its slot is
  released.
- `pickup_address` is asked for only when the chosen pickup option has `requiresAddress`.
- `guest_count` is an optional number field, added only when the service sets
  `collectGuestCount`. A blank or unusable answer is stored as no headcount and never blocks
  payment.
- Creating a checkout is idempotent per booking, and a retried refund recognizes one it already
  made instead of refunding twice.

## Webhooks

Create a webhook endpoint at `https://<your site>/api/booking/webhooks/payment` and subscribe it
to these seven events:

- `checkout.session.completed`
- `checkout.session.expired`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

`charge.refunded` also fires for partial refunds and ones made in the dashboard; Reserva stores
the charge's refunded total on the booking. `charge.dispute.closed` records how a dispute ended.
Without it, disputes stay open on the booking. Stripe's statuses map to an outcome by whether you
kept the money:

| Stripe `status` | Outcome |
|---|---|
| `won` | won |
| `warning_closed` (an inquiry closed without a chargeback) | won |
| `lost` | lost |
| `prevented` (settled by refunding the cardholder through a prevention programme) | lost |
| anything else | none: the dispute stays open and Reserva logs a warning |

Put the endpoint's signing secret in `STRIPE_WEBHOOK_SECRET`. The signature is checked against
the raw body before anything is parsed, and an unsigned or altered request is rejected without
touching the booking.

**Pin the endpoint's API version** in the Stripe dashboard instead of leaving it on the account
default. The payload's shape follows that version, so a default that changes could change the
fields this adapter reads without any deploy on your side.

## License

MIT
