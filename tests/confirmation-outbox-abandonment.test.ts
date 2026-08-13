import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../src/confirmation';
import type { BookkitLogger, BookkitProviders } from '../src/context';
import { createBookkitContext } from '../src/context';
import { handleStatus, handleStripeWebhook } from '../src/handlers';
import { ProviderFailure } from '../src/provider-failure';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

function paidWebhookProviders(bookingId: string, sessionId: string, overrides: Partial<BookkitProviders> = {}): BookkitProviders {
  return providers({
    payments: {
      createCheckout: async () => ({ url: '', sessionId: '' }),
      parseWebhook: async () => ({
        id: 'evt_abandon', type: 'checkout.session.completed', bookingId, sessionId,
        paymentIntent: 'pi_abandon', paid: true, amountCaptured: 10000, currency: config.business.currency,
      }),
      getSession: async () => ({ status: 'open' }),
      refund: async () => ({ refundId: 're_abandon', amountCents: 0 }),
    },
    ...overrides,
  });
}

function capturingLogger(): { logger: BookkitLogger; errors: Array<[string, Record<string, unknown> | undefined]> } {
  const errors: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    errors,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: (message, data) => { errors.push([message, data]); },
    },
  };
}

// Plan 016 (audit finding #12, scoped): outbox rows stop being retried forever once a provider
// failure is classified permanent, or a retryable failure has exhausted the attempt cap.
describe('outbox permanent-failure classification and attempt cap (plan 016)', () => {
  it('abandons a confirmation-path row after one permanent (401) failure, never claims it again, logs exactly once, and never returns a retryable webhook response', async () => {
    const seeded = booking({ id: 'abandon-401', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', stripeSessionId: 'cs_abandon_401' });
    const repo = fakeRepository([seeded]);
    let emailCalls = 0;
    const { logger, errors } = capturingLogger();
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, logger,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_abandon_401', {
        email: { send: async () => { emailCalls += 1; throw new ProviderFailure({ status: 401, message: 'Unauthorized' }); } },
      }),
    });

    const first = await handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context);
    expect(first.status).toBe(200);
    expect(emailCalls).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email_confirmation`)).toMatchObject({ status: 'abandoned', attemptCount: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('bookkit side effect operation abandoned');
    expect(errors[0]?.[1]).toMatchObject({
      bookingId: seeded.id, kind: 'email_confirmation', provider: 'email', status: 401, attemptCount: 1, reason: 'permanent_failure',
    });

    // A webhook redelivery must never reclaim the abandoned row or retry the webhook response.
    const second = await handleStripeWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context);
    expect(second.status).toBe(200);
    expect(emailCalls).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email_confirmation`)).toMatchObject({ status: 'abandoned', attemptCount: 1 });

    // Nor must a /status poll.
    const status = await handleStatus(new Request(`https://example.test/status?session_id=${seeded.stripeSessionId}`), context);
    expect(status.status).toBe(200);
    expect(emailCalls).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('resolves failed through attempt 9, abandons on attempt 10 with a bounded max-attempts error, and issues no eleventh provider call', async () => {
    const seeded = booking({ id: 'abandon-cap', status: 'cancelled', cancelledBy: 'customer', cancelledAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const kind = 'email:booking.cancelled_by_customer';
    await repo.recordMutationSideEffectOperations(seeded.id, [kind], '2026-06-14T08:00:00.000Z');
    let calls = 0;
    const { logger, errors } = capturingLogger();
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, logger,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ email: { send: async () => { calls += 1; throw new ProviderFailure({ status: 503, message: 'gateway timeout' }); } } }),
    });

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await runOwedMutationSideEffects(context, seeded);
      expect(repo.sideEffectOperations.get(`${seeded.id}:${kind}`)).toMatchObject({ status: 'failed', attemptCount: attempt });
    }
    expect(calls).toBe(9);
    expect(errors).toHaveLength(0);

    await runOwedMutationSideEffects(context, seeded);
    expect(calls).toBe(10);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${kind}`)).toMatchObject({ status: 'abandoned', attemptCount: 10 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({ reason: 'max_attempts_exceeded', attemptCount: 10, status: 503 });

    await runOwedMutationSideEffects(context, seeded);
    expect(calls).toBe(10);
    expect(errors).toHaveLength(1);
  });

  it('keeps retrying a no-status network error instead of abandoning it', async () => {
    const seeded = booking({ id: 'abandon-network', status: 'cancelled', cancelledBy: 'customer', cancelledAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const kind = 'tourflow:booking.cancelled_by_customer';
    await repo.recordMutationSideEffectOperations(seeded.id, [kind], '2026-06-14T08:00:00.000Z');
    let calls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ ops: { push: async () => { calls += 1; throw new TypeError('fetch failed'); } } }),
    });

    await runOwedMutationSideEffects(context, seeded);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${kind}`)).toMatchObject({ status: 'failed', attemptCount: 1 });

    await runOwedMutationSideEffects(context, seeded);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${kind}`)).toMatchObject({ status: 'failed', attemptCount: 2 });
    expect(calls).toBe(2);
  });

  it('abandons the confirmation-path Tourflow row after a permanent failure and stops handleStatus from re-entering fulfillment for it', async () => {
    const seeded = booking({
      id: 'abandon-tourflow', status: 'confirmed', stripeSessionId: 'cs_abandon_tourflow',
      calendarSynced: true, emailSynced: true, tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    let pushCalls = 0;
    const { logger, errors } = capturingLogger();
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, logger,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ ops: { push: async () => { pushCalls += 1; throw new ProviderFailure({ status: 403, message: 'forbidden' }); } } }),
    });

    const first = await handleStatus(new Request(`https://example.test/status?session_id=${seeded.stripeSessionId}`), context);
    expect(first.status).toBe(200);
    expect(pushCalls).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:tourflow:booking.confirmed`)).toMatchObject({ status: 'abandoned', attemptCount: 1 });
    expect(repo.rows.get(seeded.id)?.tourflowSynced).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({ kind: 'tourflow:booking.confirmed', provider: 'tourflow', status: 403, reason: 'permanent_failure' });

    const second = await handleStatus(new Request(`https://example.test/status?session_id=${seeded.stripeSessionId}`), context);
    expect(second.status).toBe(200);
    // needsFulfillment's third clause now sees the abandoned row and stops re-entering fulfillment
    // (which would otherwise re-run confirmBookingFromPayment on every future poll); the mutation
    // drain's own claim predicate independently also refuses to reclaim the abandoned row.
    expect(pushCalls).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
