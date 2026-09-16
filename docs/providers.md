# Writing a provider adapter

Reserva talks to the outside world through four ports, all declared in `src/core/events.ts` and
exported from `@reservajs/astro/core`: `PaymentProvider`, `CalendarProvider`, `EmailProvider` and
`OperationalAlertSink`. None of them names a vendor. Reserva ships `@reservajs/stripe`,
`@reservajs/astro/providers/calendar-google`, `@reservajs/astro/providers/email-brevo` and
`@reservajs/astro/providers/email-none`; anything else is an adapter you (or a community package)
can write against the port alone.

## Writing a payment adapter

A payment adapter is an object satisfying `PaymentProvider`. There is no base class to extend and
nothing to register: the runtime module passes your instance as `providers.payments`.

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

### The contract

Four rules carry the correctness of the whole payment path. They are restated on the port's own
doc comments, and a breach of any one of them is invisible until money is involved.

**Metadata.** `createCheckout` must attach `bookingId` to the session *and* to the payment object
the session creates (Stripe: `metadata` and `payment_intent_data.metadata`). The webhook is the
only place Reserva can recover which booking an event belongs to, and charge-level events —
refunds, disputes — never see the session's copy.

**Idempotency, checkout.** `createCheckout` must be idempotent per `booking.id`. A lost response
followed by a retry has to land on the same payment session, not mint a second one that can be
paid independently of the hold.

**Idempotency, refund.** `refund` must be idempotent per `paymentRef`. Reserva retries refunds from
a durable outbox, so a second call for the same payment must report the refund that already
happened rather than move money twice. Return the cumulative `amountMinor` the operation satisfied.

**Signatures.** `parseWebhook` must throw when the signature does not verify. Reserva turns the
throw into a `400` and never inspects the body itself, so a lenient implementation accepts forged
events. Verify against the raw request bytes — re-serializing the parsed JSON breaks the signature.

### Amounts, refs and time

Every amount is minor units of the booking's own currency (`config.business.currency`). Every
`*Ref` is an opaque provider string Reserva stores and echoes back; it never parses one.
`createCheckout`'s optional `expiresAt` is a UTC ISO instant — return the provider's own value, not
the one you requested, so an idempotent replay reports the original session's expiry.

### Optional members

- `cancelPayment?(paymentRef)` — best effort by contract. Reserva calls it to stop money that
  should never have moved. Resolve, never throw, when the provider refuses; a booking is never
  blocked on it.
- `validateConfig?(config)` — a synchronous check run once when the runtime definition initializes,
  never per request. This is where your provider's own limits live (supported currencies, locales,
  maximum session lifetime). Throw with the offending config path and the fix, so a misconfigured
  deployment fails to start with something actionable.

### Delayed payment methods

Reserva does not support payment methods whose money arrives after the capacity hold expires. An
adapter should refuse them where the provider allows it, and must report an unpaid completion
honestly (`paid: false`) so Reserva can release the hold and refund anything that settles later.

### Testing your adapter

`tests/payment-port.test.ts` is the contract test. It builds a payment provider from
`@reservajs/astro/core` exports alone, with no vendor identifier anywhere, and drives it through
checkout, webhook and status. Copy it as the starting point for your own adapter's suite.

The smallest complete implementation is the in-memory dev provider in `src/dev/` (exported as
`@reservajs/astro/dev`): it is a real `PaymentProvider` with no network at all, and it is short
enough to read in one sitting.
