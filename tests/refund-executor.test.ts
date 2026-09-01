import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { attemptRefund } from '../src/refund-executor';
import { SIDE_EFFECT_MAX_ATTEMPTS } from '../src/repo';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-08-14T10:00:00.000Z');

// attemptRefund's `claim` branch is exercised only by the scheduled
// reconciler, so these are the first tests to reach it. The `claim`-less
// branch (the HTTP path) is already exhaustively covered end to end through
// tests/handlers-operator.test.ts and friends, unchanged by this extraction.
describe('attemptRefund with an execution claim (the scheduled-reconciler branch)', () => {
  function contextFor(seed: ReturnType<typeof booking>[], overrides: Parameters<typeof providers>[0] = {}) {
    const repo = fakeRepository(seed);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers(overrides) });
    return { repo, context };
  }

  it('a retryable Stripe failure resolves failed with a backoff next_attempt_at (attempt 1)', async () => {
    const seeded = booking({ id: 'refund-exec-retryable', status: 'cancelled', paymentRef: 'pi_exec_retryable' });
    const { repo, context } = contextFor([seeded], {
      payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => { throw new Error('unused'); },
        getSession: async () => ({ status: 'open' }),
        refund: async () => { throw new Error('stripe unavailable'); },
      },
    });
    await repo.claimRefundOperation({ id: 'op-1', bookingId: seeded.id, paymentIntent: seeded.paymentRef, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });

    const outcome = await attemptRefund(context, seeded, 'op-1', 'full', seeded.paymentRef, { attemptNumber: 1 });
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
    const stored = repo.refundOperations.get(seeded.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.nextAttemptAt).toBe('2026-08-14T10:05:00.000Z');
  });

  it('a retryable Stripe failure abandons once attemptNumber reaches the cap, with no next_attempt_at', async () => {
    const seeded = booking({ id: 'refund-exec-exhausted', status: 'cancelled', paymentRef: 'pi_exec_exhausted' });
    const { repo, context } = contextFor([seeded], {
      payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => { throw new Error('unused'); },
        getSession: async () => ({ status: 'open' }),
        refund: async () => { throw new Error('stripe unavailable'); },
      },
    });
    await repo.claimRefundOperation({ id: 'op-2', bookingId: seeded.id, paymentIntent: seeded.paymentRef, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });

    const outcome = await attemptRefund(context, seeded, 'op-2', 'full', seeded.paymentRef, { attemptNumber: SIDE_EFFECT_MAX_ATTEMPTS });
    expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
    const stored = repo.refundOperations.get(seeded.id);
    expect(stored?.status).toBe('abandoned');
    expect(stored?.nextAttemptAt).toBeNull();
  });

  it('a permanent (non-retryable) Stripe failure abandons immediately, even on the first attempt', async () => {
    const seeded = booking({ id: 'refund-exec-permanent', status: 'cancelled', paymentRef: 'pi_exec_permanent' });
    const permanentError = Object.assign(new Error('card issuer declined the refund'), { status: 400, retryable: false });
    const { repo, context } = contextFor([seeded], {
      payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => { throw new Error('unused'); },
        getSession: async () => ({ status: 'open' }),
        refund: async () => { throw permanentError; },
      },
    });
    await repo.claimRefundOperation({ id: 'op-3', bookingId: seeded.id, paymentIntent: seeded.paymentRef, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });

    const outcome = await attemptRefund(context, seeded, 'op-3', 'full', seeded.paymentRef, { attemptNumber: 1 });
    expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
    expect(repo.refundOperations.get(seeded.id)?.status).toBe('abandoned');
  });

  it('a successful claimed attempt resolves succeeded exactly like the unclaimed HTTP path', async () => {
    const seeded = booking({ id: 'refund-exec-success', status: 'cancelled', paymentRef: 'pi_exec_success' });
    const { repo, context } = contextFor([seeded], {
      payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => { throw new Error('unused'); },
        getSession: async () => ({ status: 'open' }),
        refund: async () => ({ refundRef: 're_exec_success', amountMinor: seeded.priceMinor }),
      },
    });
    await repo.claimRefundOperation({ id: 'op-4', bookingId: seeded.id, paymentIntent: seeded.paymentRef, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });

    const outcome = await attemptRefund(context, seeded, 'op-4', 'full', seeded.paymentRef, { attemptNumber: 1 });
    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'succeeded', stripeRefundId: 're_exec_success' });
  });

  it('a claimed attempt still skips Stripe entirely for choice none and for a missing payment intent', async () => {
    const noneBooking = booking({ id: 'refund-exec-none', status: 'cancelled', paymentRef: null });
    const { repo: noneRepo, context: noneContext } = contextFor([noneBooking]);
    await noneRepo.claimRefundOperation({ id: 'op-5', bookingId: noneBooking.id, paymentIntent: null, choice: 'none', requestedAt: '2026-08-14T09:00:00.000Z' });
    const noneOutcome = await attemptRefund(noneContext, noneBooking, 'op-5', 'none', null, { attemptNumber: 1 });
    expect(noneOutcome).toEqual({ kind: 'succeeded' });

    const missingIntentBooking = booking({ id: 'refund-exec-missing-intent', status: 'cancelled', paymentRef: null });
    const { repo: missingRepo, context: missingContext } = contextFor([missingIntentBooking]);
    await missingRepo.claimRefundOperation({ id: 'op-6', bookingId: missingIntentBooking.id, paymentIntent: null, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });
    const missingOutcome = await attemptRefund(missingContext, missingIntentBooking, 'op-6', 'full', null, { attemptNumber: 1 });
    expect(missingOutcome).toEqual({ kind: 'payment_ref_missing' });
    expect(missingRepo.refundOperations.get(missingIntentBooking.id)?.status).toBe('failed');
  });
});
