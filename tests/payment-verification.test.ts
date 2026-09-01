import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { verifyPayment, type VerifiedPaymentFacts } from '../src/core/payment-verification';
import { handleStatus, handlePaymentWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

interface PaymentCase {
  name: string;
  priceMinor: number;
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  amountTotal?: number;
  currency?: string;
  allowed: boolean;
}

function factsFor(scenario: PaymentCase): VerifiedPaymentFacts {
  return {
    completed: true,
    sessionRef: 'cs_1',
    paid: scenario.paymentStatus === 'paid',
    paymentStatus: scenario.paymentStatus,
    ...(scenario.amountTotal !== undefined ? { amountTotal: scenario.amountTotal } : {}),
    ...(scenario.currency !== undefined ? { currency: scenario.currency } : {}),
    expectedCurrency: config.business.currency,
  };
}

const cases: PaymentCase[] = [
  { name: 'paid paid booking', priceMinor: 10000, paymentStatus: 'paid', amountTotal: 10000, currency: 'eur', allowed: true },
  { name: 'unpaid paid booking', priceMinor: 10000, paymentStatus: 'unpaid', amountTotal: 10000, currency: 'eur', allowed: false },
  { name: 'no-payment-required paid booking', priceMinor: 10000, paymentStatus: 'no_payment_required', amountTotal: 10000, currency: 'eur', allowed: false },
  { name: 'paid free booking', priceMinor: 0, paymentStatus: 'paid', allowed: true },
  { name: 'unpaid free booking', priceMinor: 0, paymentStatus: 'unpaid', allowed: false },
  { name: 'no-payment-required free booking', priceMinor: 0, paymentStatus: 'no_payment_required', allowed: true },
  { name: 'paid booking with missing amount', priceMinor: 10000, paymentStatus: 'paid', currency: 'eur', allowed: false },
  { name: 'paid booking with wrong amount', priceMinor: 10000, paymentStatus: 'paid', amountTotal: 9999, currency: 'eur', allowed: false },
  { name: 'paid booking with wrong currency', priceMinor: 10000, paymentStatus: 'paid', amountTotal: 10000, currency: 'usd', allowed: false },
];

describe('payment verification parity', () => {
  it.each(cases)('makes the same confirmation decision for webhook and status: $name', async (scenario) => {
    const current = booking({
      id: 'b-payment-verification',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_1',
      paymentRef: null,
      priceMinor: scenario.priceMinor,
    });
    expect(verifyPayment(current, factsFor(scenario)).allowed).toBe(scenario.allowed);

    const webhookRepo = fakeRepository([current]);
    const webhookContext = createReservaContext({
      config,
      db: {} as D1Database,
      repo: webhookRepo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      logger: { warn: () => undefined },
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt-payment-verification',
            type: 'checkout_completed',
            bookingId: current.id,
            sessionRef: 'cs_1',
            paid: scenario.paymentStatus === 'paid',
            paymentStatus: scenario.paymentStatus,
            ...(scenario.amountTotal !== undefined ? { amountCaptured: scenario.amountTotal } : {}),
            ...(scenario.currency !== undefined ? { currency: scenario.currency } : {}),
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
      }),
    });
    const webhookResponse = await handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), webhookContext);

    const statusRepo = fakeRepository([current]);
    const statusContext = createReservaContext({
      config,
      db: {} as D1Database,
      repo: statusRepo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      logger: { warn: () => undefined },
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({ id: 'evt_unused', type: 'checkout_completed' }),
          getSession: async () => ({
            id: 'cs_1',
            status: 'complete',
            paymentStatus: scenario.paymentStatus,
            ...(scenario.amountTotal !== undefined ? { amountTotal: scenario.amountTotal } : {}),
            ...(scenario.currency !== undefined ? { currency: scenario.currency } : {}),
          }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
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
