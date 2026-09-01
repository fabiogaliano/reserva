import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../src/confirmation';
import type { ReservaLogger, ReservaProviders } from '../src/context';
import { createReservaContext } from '../src/context';
import { handleStatus, handlePaymentWebhook } from '../src/handlers';
import { ProviderFailure } from '../src/provider-failure';
import { booking, config } from './fixtures';
import type { SideEffectOperationIdentity } from '../src/repo';
import { fakeRepository, providers, sideEffectOperation, seedSettledConfirmation } from './fakes';

const seedFor = (identity: SideEffectOperationIdentity) => ({ ...identity, eventPayloadJson: null, eventIdPrefix: null });

function paidWebhookProviders(bookingId: string, sessionRef: string, overrides: Partial<ReservaProviders> = {}): ReservaProviders {
  return providers({
    payments: {
      createCheckout: async () => ({ url: '', sessionRef: '' }),
      parseWebhook: async () => ({
        id: 'evt_abandon', type: 'checkout_completed', bookingId, sessionRef,
        paymentRef: 'pi_abandon', paid: true, amountCaptured: 10000, currency: config.business.currency,
      }),
      getSession: async () => ({ status: 'open' }),
      refund: async () => ({ refundRef: 're_abandon', amountMinor: 0 }),
    },
    ...overrides,
  });
}

function capturingLogger(): { logger: ReservaLogger; errors: Array<[string, Record<string, unknown> | undefined]> } {
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

// Outbox rows stop being retried forever once a provider
// failure is classified permanent, or a retryable failure has exhausted the attempt cap.
describe('outbox permanent-failure classification and attempt cap (plan 016)', () => {
  it('abandons a confirmation-path row after one permanent (401) failure, never claims it again, logs exactly once, and never returns a retryable webhook response', async () => {
    const seeded = booking({ id: 'abandon-401', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_abandon_401' });
    const repo = fakeRepository([seeded]);
    let emailCalls = 0;
    let hookCalls = 0;
    const { logger, errors } = capturingLogger();
    const context = createReservaContext({
      config, db: {} as D1Database, repo, logger,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: paidWebhookProviders(seeded.id, 'cs_abandon_401', {
        email: { send: async () => { emailCalls += 1; throw new ProviderFailure({ status: 401, message: 'Unauthorized' }); } },
      }),
      // A non-durable hook is the replacement for v1's analytics sink: fire-and-forget,
      // still fired exactly once per occurrence and never re-fired by a redelivery.
      hooks: [{ name: 'analytics', handler: async () => { hookCalls += 1; } }],
    });

    const first = await handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context);
    expect(first.status).toBe(200);
    expect(emailCalls).toBe(1);
    expect(hookCalls).toBe(1);
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'abandoned', attemptCount: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('reserva side effect operation abandoned');
    expect(errors[0]?.[1]).toMatchObject({
      bookingId: seeded.id, operation: 'email_confirmation', provider: 'email', status: 401, attemptCount: 1, reason: 'permanent_failure',
    });

    // A webhook redelivery must never reclaim the abandoned row or retry the webhook response.
    const second = await handlePaymentWebhook(new Request('https://example.test/webhook', { method: 'POST' }), context);
    expect(second.status).toBe(200);
    expect(emailCalls).toBe(1);
    expect(hookCalls).toBe(1);
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'abandoned', attemptCount: 1 });

    // Nor must a /status poll.
    const status = await handleStatus(new Request(`https://example.test/status?session_id=${seeded.paymentSessionRef}`), context);
    expect(status.status).toBe(200);
    expect(emailCalls).toBe(1);
    expect(hookCalls).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('resolves failed through attempt 9, abandons on attempt 10 with a bounded max-attempts error, and issues no eleventh provider call', async () => {
    const seeded = booking({ id: 'abandon-cap', status: 'cancelled', cancelledBy: 'customer', cancelledAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const identity: SideEffectOperationIdentity = { family: 'email', event: 'booking.cancelled_by_customer' };
    await repo.recordMutationSideEffectOperations(seeded.id, [seedFor(identity)], '2026-06-14T08:00:00.000Z');
    let calls = 0;
    const { logger, errors } = capturingLogger();
    const context = createReservaContext({
      config, db: {} as D1Database, repo, logger,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ email: { send: async () => { calls += 1; throw new ProviderFailure({ status: 503, message: 'gateway timeout' }); } } }),
    });

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await runOwedMutationSideEffects(context, seeded);
      expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'failed', attemptCount: attempt });
    }
    expect(calls).toBe(9);
    expect(errors).toHaveLength(0);

    await runOwedMutationSideEffects(context, seeded);
    expect(calls).toBe(10);
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'abandoned', attemptCount: 10 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({ reason: 'max_attempts_exceeded', attemptCount: 10, status: 503 });

    await runOwedMutationSideEffects(context, seeded);
    expect(calls).toBe(10);
    expect(errors).toHaveLength(1);
  });

  it('classifies an interleaved tenth claim from the authoritative count instead of a stale list snapshot', async () => {
    const seeded = booking({ id: 'abandon-interleaved-cap', status: 'cancelled', cancelledBy: 'customer', cancelledAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const identity: SideEffectOperationIdentity = { family: 'email', event: 'booking.cancelled_by_customer' };
    await repo.recordMutationSideEffectOperations(seeded.id, [seedFor(identity)], '2026-06-14T08:00:00.000Z');
    const operation = sideEffectOperation(repo, seeded.id, identity);
    if (!operation) throw new Error('seeded operation missing');
    Object.assign(operation, { status: 'failed', attemptCount: 8 });

    let calls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ email: { send: async () => { calls += 1; throw new ProviderFailure({ status: 503, message: 'gateway timeout' }); } } }),
    });
    const claim = repo.claimMutationSideEffectOperation.bind(repo);
    let claimCalls = 0;
    repo.claimMutationSideEffectOperation = async (...args) => {
      claimCalls += 1;
      // Both drains have already listed attempt_count=8 before the nested drain advances it to 9.
      if (claimCalls === 1) await runOwedMutationSideEffects(context, seeded);
      return claim(...args);
    };

    await runOwedMutationSideEffects(context, seeded);
    expect(calls).toBe(2);
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'abandoned', attemptCount: 10 });

    await runOwedMutationSideEffects(context, seeded);
    expect(calls).toBe(2);
  });

  it('keeps retrying a no-status network error instead of abandoning it', async () => {
    const seeded = booking({ id: 'abandon-network', status: 'cancelled', cancelledBy: 'customer', cancelledAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const identity: SideEffectOperationIdentity = { family: 'hook', name: 'ops', event: 'booking.cancelled_by_customer' };
    await repo.recordMutationSideEffectOperations(seeded.id, [seedFor(identity)], '2026-06-14T08:00:00.000Z');
    let calls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
      hooks: [{ name: 'ops', durable: true, handler: async () => { calls += 1; throw new TypeError('fetch failed'); } }],
    });

    await runOwedMutationSideEffects(context, seeded);
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'failed', attemptCount: 1 });

    await runOwedMutationSideEffects(context, seeded);
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'failed', attemptCount: 2 });
    expect(calls).toBe(2);
  });

  it('abandons a confirmation-path durable hook row after a permanent failure and stops handleStatus from re-entering fulfillment for it', async () => {
    const seeded = booking({
      id: 'abandon-hook', status: 'confirmed', paymentSessionRef: 'cs_abandon_hook',
    });
    const repo = fakeRepository([seeded]);
    seedSettledConfirmation(repo, seeded.id);
    const identity: SideEffectOperationIdentity = { family: 'hook', name: 'ops', event: 'booking.confirmed' };
    let pushCalls = 0;
    const { logger, errors } = capturingLogger();
    const context = createReservaContext({
      config, db: {} as D1Database, repo, logger,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
      hooks: [{ name: 'ops', durable: true, handler: async () => { pushCalls += 1; throw new ProviderFailure({ status: 403, message: 'forbidden' }); } }],
    });

    const first = await handleStatus(new Request(`https://example.test/status?session_id=${seeded.paymentSessionRef}`), context);
    expect(first.status).toBe(200);
    expect(pushCalls).toBe(1);
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'abandoned', attemptCount: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({ operation: 'hook:ops:booking.confirmed', provider: 'hook', status: 403, reason: 'permanent_failure' });

    const second = await handleStatus(new Request(`https://example.test/status?session_id=${seeded.paymentSessionRef}`), context);
    expect(second.status).toBe(200);
    // needsFulfillment now sees the row exists (abandoned) and stops re-entering fulfillment
    // (which would otherwise re-run confirmBookingFromPayment on every future poll); the mutation
    // drain's own claim predicate independently also refuses to reclaim the abandoned row.
    expect(pushCalls).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
