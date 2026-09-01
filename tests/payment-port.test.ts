import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { PAYMENT_EVENTS, type ClientConfig, type PaymentProvider } from '../src/core';
import { handleCheckout, handlePaymentWebhook, handleStatus } from '../src/handlers';
import { defineReservaRuntime, defineCloudflareReservaRuntime } from '../src/runtime-context';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

// The payment port has to be implementable by someone who has never read src/providers/stripe.ts.
// This adapter is built ONLY from what @reservajs/astro/core exports (the `PaymentProvider`
// interface and the PAYMENT_EVENTS catalog) and mentions no Stripe identifier anywhere — if a
// vendor concept leaked back into the port's types, this file would stop compiling, and the
// assertions below prove Reserva actually drives a booking through it.
const vendorNeutralPayments: PaymentProvider = {
  async createCheckout(pending) {
    return { url: `https://pay.example/${pending.id}`, sessionRef: `sess_${pending.id}` };
  },
  async parseWebhook(request) {
    const body = await request.json() as { sessionRef: string; amount: number; currency: string };
    return {
      id: 'evt_neutral',
      type: 'checkout_completed',
      sessionRef: body.sessionRef,
      paymentRef: `pay_${body.sessionRef}`,
      paid: true,
      paymentStatus: 'paid',
      amountCaptured: body.amount,
      currency: body.currency,
      customerName: 'Neutral Customer',
      customerEmail: 'neutral@example.test',
    };
  },
  async getSession(sessionRef) {
    return { id: sessionRef, status: 'open', paymentStatus: 'unpaid' };
  },
  async refund(paymentRef, expectedAmountMinor) {
    return { refundRef: `rfnd_${paymentRef}`, amountMinor: expectedAmountMinor };
  },
};

describe('the payment port is implementable without any vendor knowledge (plan 022)', () => {
  it('drives a checkout and a webhook confirmation through an adapter built only from the core seam', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ payments: vendorNeutralPayments }),
    });

    const checkout = await handleCheckout(new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en',
      }),
    }), context);
    expect(checkout.status).toBe(201);
    const { checkoutUrl } = await checkout.json() as { checkoutUrl: string };
    expect(checkoutUrl).toMatch(/^https:\/\/pay\.example\//);

    const held = [...repo.rows.values()][0];
    if (!held) throw new Error('checkout did not create a hold');
    expect(held.paymentSessionRef).toBe(`sess_${held.id}`);

    const webhook = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify({ sessionRef: held.paymentSessionRef, amount: held.priceMinor, currency: held.currency }),
    }), context);
    expect(webhook.status).toBe(200);
    expect(repo.rows.get(held.id)).toMatchObject({ status: 'confirmed', paymentRef: `pay_sess_${held.id}` });
  });

  it('ignores an event outside the published catalog instead of failing the delivery', async () => {
    // PAYMENT_EVENTS is the closed set an adapter maps its vendor's names onto; a provider that
    // forwards anything else (a vendor event Reserva has no opinion about) must get a clean 200 and
    // leave the booking exactly where it was, so the provider stops redelivering it.
    const seeded = booking({ id: 'b-port-unknown-event', status: 'hold', paymentSessionRef: 'cs_port_unknown' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          ...vendorNeutralPayments,
          parseWebhook: async () => ({ id: 'evt_vendor_only', type: 'vendor.internal.thing' }),
        },
      }),
    });

    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(PAYMENT_EVENTS).not.toContain('vendor.internal.thing');
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'hold', paymentRef: seeded.paymentRef });
  });
});

// A provider's own limits are checked once, while the runtime definition initializes — never
// per request and never as a surprise on the first real checkout.
describe('a payment provider rejects an incompatible config at runtime-definition time', () => {
  function providerRejecting(currency: string): PaymentProvider {
    return {
      ...vendorNeutralPayments,
      validateConfig(candidate: ClientConfig) {
        if (candidate.business.currency !== currency) {
          throw new Error(`business.currency "${candidate.business.currency}" is not supported by this provider; use "${currency}".`);
        }
      },
    };
  }

  it('fails while the Cloudflare runtime definition is built, before any request is served', () => {
    expect(() => defineCloudflareReservaRuntime(config, {
      providers: { payments: providerRejecting('usd') },
    })).toThrow(/business\.currency "eur" is not supported by this provider; use "usd"\./);
  });

  it('accepts a config the provider supports', () => {
    expect(() => defineCloudflareReservaRuntime(config, {
      providers: { payments: providerRejecting('eur') },
    })).not.toThrow();
  });

  it('fails at the first context creation when providers come from an env-dependent factory, and only checks once', async () => {
    let validations = 0;
    const payments: PaymentProvider = {
      ...vendorNeutralPayments,
      validateConfig() { validations += 1; },
    };
    const runtime = defineReservaRuntime({
      config,
      createContext: ({ config: validated }) => ({
        config: validated, db: {} as D1Database, repo: fakeRepository(), providers: providers({ payments }),
      }),
    });

    await runtime.createContext({ request: new Request('https://example.test/api/booking/status') });
    await runtime.createContext({ request: new Request('https://example.test/api/booking/status') });
    expect(validations).toBe(1);
  });
});

// The retired calendar_synced/email_synced flags used to gate whether a confirmed booking's read
// paths re-ran fulfillment. With delivery state living only in the outbox rows, /status and the
// manage page must agree on the same booking and leave a settled confirmation alone.
describe('/status and manage report the same settled confirmation without re-running fulfillment', () => {
  it('reports the same booking facts from both read paths and touches no provider', async () => {
    const seeded = booking({
      id: 'b-port-settled', status: 'confirmed', paymentSessionRef: 'cs_port_settled',
      createdAt: '2026-06-14T07:30:00.000Z', updatedAt: '2026-06-14T07:31:00.000Z',
    });
    const repo = fakeRepository([seeded]);
    const now = '2026-06-14T08:00:00.000Z';
    await repo.recordBookingEventOperations(seeded.id, [
      { family: 'calendar_create', eventPayloadJson: null, eventIdPrefix: null },
      { family: 'email_confirmation', eventPayloadJson: null, eventIdPrefix: null },
    ], now);
    for (const row of repo.sideEffectOperations.values()) Object.assign(row, { status: 'succeeded', resolvedAt: now });

    let calendarCalls = 0;
    let emailCalls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock: () => new Date(now),
      providers: providers({
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCalls += 1; return 'cal_unexpected'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
        email: { send: async () => { emailCalls += 1; } },
      }),
    });

    const status = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_port_settled'), context);
    expect(status.status).toBe(200);
    const payload = await status.json() as { status: string; booking: Record<string, unknown> };
    expect(payload.status).toBe('confirmed');
    expect(payload.booking).toMatchObject({
      reference: seeded.reference,
      serviceSlug: seeded.serviceSlug,
      quantity: seeded.quantity,
      priceMinor: seeded.priceMinor,
    });

    const stored = repo.rows.get(seeded.id);
    expect(stored).toMatchObject({ status: 'confirmed', updatedAt: seeded.updatedAt });
    expect(calendarCalls).toBe(0);
    expect(emailCalls).toBe(0);
  });
});
