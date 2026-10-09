# Writing a provider adapter

Reserva talks to the outside world through four interfaces exported from
`@reservajs/astro/core`: `PaymentProvider`, `CalendarProvider`, `EmailProvider` and
`OperationalAlertSink`. None of them is tied to a vendor. Reserva ships `@reservajs/stripe`,
`@reservajs/astro/providers/calendar-google`, `@reservajs/astro/providers/email-brevo` and
`@reservajs/astro/providers/email-none`. For anything else, write an adapter against the
interface.

| Interface | Required | Optional |
|---|---|---|
| `PaymentProvider` | `createCheckout`, `parseWebhook`, `getSession`, `refund` | `cancelPayment`, `validateConfig` |
| `CalendarProvider` | `listEvents`, `createEvent`, `patchEvent`, `deleteEvent` | `cacheKey` |
| `EmailProvider` | `send` | `recipientsForEvent`, `sendToRecipient`, `sendMessage` |
| `OperationalAlertSink` | `send(alert, config)` | none |

An email provider with `sendMessage` also receives operational alerts, unless you set
`providers.alerts`. See [Alerts](./deployment.md#alerts).

## Payment adapters

A payment adapter is a plain object that satisfies `PaymentProvider`. Pass it as
`providers.payments` in your runtime module.

```ts
import type { PaymentProvider } from '@reservajs/astro/core';

export function myProcessor(options: { secretKey: string }): PaymentProvider {
  return {
    async createCheckout(booking, config, routePaths) { /* … */ },
    async parseWebhook(request) { /* … */ },
    async getSession(sessionRef) { /* … */ },
    async refund(paymentRef, expectedAmountMinor) { /* … */ },
  };
}
```

### Four rules

Payments are only correct if all four hold. Breaking one shows up when real money moves.

1. **Tag the payment with the booking.** `createCheckout` must attach `bookingId` to the session
   and to the payment it creates (Stripe: `metadata` and `payment_intent_data.metadata`).
   Refund and dispute events only see the payment, and the webhook is the only place Reserva
   learns which booking an event is about.
2. **Checkout is idempotent per `booking.id`.** A retry after a lost response must return the
   same session, not a second one that could be paid separately.
3. **Refunds are idempotent per `paymentRef`.** Reserva retries refunds, so a second call must
   report the refund that already happened instead of moving money twice. Return the total
   `amountMinor` refunded.
4. **`parseWebhook` throws on a bad signature.** Reserva turns the throw into a `400` and doesn't
   check the body itself. Verify against the raw request bytes; re-serialized JSON won't match.

### Amounts, refs and time

Amounts are in minor units of the booking's currency. Every `*Ref` is the provider's own string;
Reserva stores and returns it without parsing. If `createCheckout` gets an `expiresAt` (UTC ISO),
return the provider's actual expiry, so a repeated call reports the original session's.

### Customer details

`parseWebhook` and `getSession` can return what the payment page collected: `customerName`,
`customerEmail`, `customerPhone`, `pickupAddress` (for a pickup option with `requiresAddress`)
and `guestCount` (for a service with `collectGuestCount`). Leave a key out when the page didn't
ask, and return `null` when it asked and got no usable answer. Reserva saves these at
confirmation and only fills blanks afterwards, so a late or repeated event can't overwrite them.

### Refunds and disputes

Report every refund as a `refunded` event, including partial ones and ones made outside
Reserva. `amountRefunded` is the payment's total refunded so far, not this refund's amount;
Reserva keeps the largest total it sees, so order doesn't matter.

A `dispute_closed` event carries `disputeOutcome`: `'won'` if the money stayed, `'lost'` if it
went back. Leave it out for any other status and the dispute stays open. Both dispute events can
carry `disputeCreatedAt` (ISO 8601), when the processor opened the dispute. Reserva dates the
dispute from it, and uses it to tell a second dispute on the same payment from a redelivery of
the first.

### Optional members

- `cancelPayment?(paymentRef)`: called to stop money that shouldn't have moved. Best effort:
  resolve rather than throw if the provider refuses. Bookings never wait on it.
- `validateConfig?(config)`: runs once at startup. Check your provider's own limits here
  (currencies, locales, session lifetime) and throw with the config path and the fix.

### Delayed payment methods

Reserva doesn't support methods whose money arrives after the hold expires. Refuse them where
the provider lets you, and report an unpaid completion as `paid: false` so Reserva can release
the hold and refund anything that settles later.

### Testing

`tests/payment-port.test.ts` is the contract test. It builds a payment provider from
`@reservajs/astro/core` alone and runs it through checkout, webhook and status. Copy it for your
adapter's tests.

The smallest complete example is the in-memory provider in `src/dev/` (exported as
`@reservajs/astro/dev`). It's a real `PaymentProvider` with no network, short enough to read in
one go.
