import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import type { PaymentEventParsed, PaymentProvider } from '../src/core/events';
import { handlePaymentWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRefundTracker, fakeRepository, providers } from './fakes';

// `async_payment_succeeded` is the money for a delayed payment method arriving days after Reserva
// already refused the checkout and released the hold (that refusal is covered in
// tests/handlers-lifecycle.test.ts). There is no booking to confirm, so the money goes back — and
// the provider is always told 200, because redelivering will never produce a different answer.
describe('payment webhook: async_payment_succeeded', () => {
  function asyncPaymentContext(refund: PaymentProvider['refund'], eventOverrides: Partial<PaymentEventParsed> = {}) {
    const seeded = booking({
      id: 'b-async', status: 'expired', holdExpiresAt: null,
      paymentSessionRef: 'cs_async', paymentRef: 'pi_async',
    });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_async', type: 'async_payment_succeeded', bookingId: seeded.id,
            sessionRef: 'cs_async', paymentRef: 'pi_async',
            amountCaptured: seeded.priceMinor, currency: config.business.currency,
            ...eventOverrides,
          }),
          getSession: async () => ({ status: 'open' }),
          refund,
        },
      }),
    });
    const deliver = () => handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    return { seeded, repo, deliver };
  }

  it('refunds the settled payment in full and acknowledges, leaving the booking refused', async () => {
    const tracker = fakeRefundTracker();
    const { seeded, repo, deliver } = asyncPaymentContext(tracker.refund);

    const response = await deliver();

    expect(response.status).toBe(200);
    expect(tracker.expectedAmounts).toEqual([seeded.priceMinor]);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({
      bookingId: seeded.id, paymentIntent: 'pi_async', choice: 'full',
      status: 'succeeded', stripeRefundId: 're_pi_async',
    });
    // A refused booking is never resurrected by the late money.
    expect(repo.rows.get(seeded.id)?.status).toBe('expired');
  });

  it('acknowledges a failed refund and leaves the row for the retry loop instead of raising an incident', async () => {
    const tracker = fakeRefundTracker(() => { throw new Error('stripe is down'); });
    const { seeded, repo, deliver } = asyncPaymentContext(tracker.refund);

    const response = await deliver();

    expect(response.status).toBe(200);
    const operation = repo.refundOperations.get(seeded.id);
    expect(operation?.status).not.toBe('succeeded');
    // The durable row IS the retry: the scheduled executor picks the booking up again, so the
    // webhook has nothing left to alert about.
    await expect(repo.listRefundExecutionCandidateBookingIds('2026-06-14T08:00:00.000Z', '2026-06-14T07:00:00.000Z', 10))
      .resolves.toContain(seeded.id);
    await expect(repo.countOpenIncidents()).resolves.toBe(0);
  });

  it('does not refund again when the provider redelivers an already-refunded event', async () => {
    const tracker = fakeRefundTracker();
    const { deliver } = asyncPaymentContext(tracker.refund);

    await deliver();
    const redelivery = await deliver();

    expect(redelivery.status).toBe(200);
    expect(tracker.idempotencyKeys).toHaveLength(1);
  });

  it('never refunds an amount that does not match the refused booking, and still acknowledges', async () => {
    const tracker = fakeRefundTracker();
    const { seeded, repo, deliver } = asyncPaymentContext(tracker.refund, { amountCaptured: 500 });

    const response = await deliver();

    expect(response.status).toBe(200);
    expect(tracker.idempotencyKeys).toEqual([]);
    expect(repo.refundOperations.get(seeded.id)).toBeUndefined();
  });
});
