import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { verifyPayment, type VerifiedPaymentFacts } from '../src/core/payment-verification';
import { handleStatus, handleStripeWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

interface PaymentCase {
  name: string;
  priceCents: number;
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  amountTotal?: number;
  currency?: string;
  allowed: boolean;
}

function factsFor(scenario: PaymentCase): VerifiedPaymentFacts {
  return {
    completed: true,
    sessionId: 'cs_1',
    paid: scenario.paymentStatus === 'paid',
    paymentStatus: scenario.paymentStatus,
    ...(scenario.amountTotal !== undefined ? { amountTotal: scenario.amountTotal } : {}),
    ...(scenario.currency !== undefined ? { currency: scenario.currency } : {}),
    expectedCurrency: config.business.currency,
  };
}

const cases: PaymentCase[] = [
  { name: 'paid paid booking', priceCents: 10000, paymentStatus: 'paid', amountTotal: 10000, currency: 'eur', allowed: true },
  { name: 'unpaid paid booking', priceCents: 10000, paymentStatus: 'unpaid', amountTotal: 10000, currency: 'eur', allowed: false },
  { name: 'no-payment-required paid booking', priceCents: 10000, paymentStatus: 'no_payment_required', amountTotal: 10000, currency: 'eur', allowed: false },
  { name: 'paid free booking', priceCents: 0, paymentStatus: 'paid', allowed: true },
  { name: 'unpaid free booking', priceCents: 0, paymentStatus: 'unpaid', allowed: false },
  { name: 'no-payment-required free booking', priceCents: 0, paymentStatus: 'no_payment_required', allowed: true },
  { name: 'paid booking with missing amount', priceCents: 10000, paymentStatus: 'paid', currency: 'eur', allowed: false },
  { name: 'paid booking with wrong amount', priceCents: 10000, paymentStatus: 'paid', amountTotal: 9999, currency: 'eur', allowed: false },
  { name: 'paid booking with wrong currency', priceCents: 10000, paymentStatus: 'paid', amountTotal: 10000, currency: 'usd', allowed: false },
];

describe('payment verification parity', () => {
  it.each(cases)('makes the same confirmation decision for webhook and status: $name', async (scenario) => {
    const current = booking({
      id: 'b-payment-verification',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_1',
      stripePaymentIntent: null,
      priceCents: scenario.priceCents,
    });
    expect(verifyPayment(current, factsFor(scenario)).allowed).toBe(scenario.allowed);

    const webhookRepo = fakeRepository([current]);
    const webhookContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: webhookRepo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      logger: { warn: () => undefined },
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({
            id: 'evt-payment-verification',
            type: 'checkout.session.completed',
            bookingId: current.id,
            sessionId: 'cs_1',
            paid: scenario.paymentStatus === 'paid',
            paymentStatus: scenario.paymentStatus,
            ...(scenario.amountTotal !== undefined ? { amountCaptured: scenario.amountTotal } : {}),
            ...(scenario.currency !== undefined ? { currency: scenario.currency } : {}),
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
      }),
    });
    const webhookResponse = await handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), webhookContext);

    const statusRepo = fakeRepository([current]);
    const statusContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: statusRepo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      logger: { warn: () => undefined },
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_unused', type: 'checkout.session.completed' }),
          getSession: async () => ({
            id: 'cs_1',
            status: 'complete',
            paymentStatus: scenario.paymentStatus,
            ...(scenario.amountTotal !== undefined ? { amountTotal: scenario.amountTotal } : {}),
            ...(scenario.currency !== undefined ? { currency: scenario.currency } : {}),
          }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
      }),
    });
    const statusResponse = await handleStatus(new Request('https://example.test/status?session_id=cs_1'), statusContext);
    const statusPayload = await statusResponse.json() as { status: string };

    expect(webhookResponse.status).toBe(scenario.allowed ? 200 : 409);
    expect(statusPayload.status === 'confirmed').toBe(scenario.allowed);
    expect(webhookRepo.rows.get(current.id)?.status === 'confirmed').toBe(statusRepo.rows.get(current.id)?.status === 'confirmed');
  });
});
