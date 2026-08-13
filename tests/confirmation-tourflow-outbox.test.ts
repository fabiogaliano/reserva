import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../src/confirmation';
import { createBookkitContext } from '../src/context';
import { handleStatus, handleStripeWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const TOURFLOW_CONFIRMED_KIND = 'tourflow:booking.confirmed';

// Plan 011: durable delivery for the booking.confirmed Tourflow event. Complements
// confirmation-outbox.test.ts (calendar/email) and confirmation-mutation-outbox.test.ts
// (cancel/reschedule/no-show) with the same coverage shape for this third, confirmation-path row.
describe('confirmation-path Tourflow outbox (plan 011)', () => {
  it('lets a still-pending detached first attempt block nothing, then fails it and lets a later touch retry it to success', async () => {
    const seeded = booking({
      id: 'tf-transient', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_tf_transient', stripePaymentIntent: null,
      calendarSynced: false, emailSynced: false, tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    let pushCalls = 0;
    // The first push is held open across the whole first request/response — proving the response
    // returns without waiting for it (design decision 3), and that the SAME request's own
    // runOwedMutationSideEffects call correctly finds the row still 'in_flight' and does not
    // double-attempt it.
    let releaseFirstPush = (): void => undefined;
    const firstPushBlocked = new Promise<void>((resolve) => { releaseFirstPush = resolve; });
    const pending: Promise<unknown>[] = [];
    const context = createBookkitContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      waitUntil: (task) => pending.push(task),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({
            id: 'evt_tf_transient', type: 'checkout.session.completed',
            bookingId: seeded.id, sessionId: 'cs_tf_transient', paymentIntent: 'pi_tf_transient',
            paid: true, amountCaptured: seeded.priceCents, currency: config.business.currency,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
        ops: { push: async () => {
          pushCalls += 1;
          if (pushCalls === 1) {
            await firstPushBlocked;
            throw new Error('Tourflow unavailable');
          }
        } },
      }),
    });

    const first = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(first.status).toBe(200);
    // The response already returned even though the first attempt is still blocked — the
    // SAME request's own runOwedMutationSideEffects call found the row 'in_flight' and skipped it.
    expect(pushCalls).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${TOURFLOW_CONFIRMED_KIND}`)).toMatchObject({ status: 'in_flight', attemptCount: 1 });

    releaseFirstPush();
    await Promise.all(pending);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${TOURFLOW_CONFIRMED_KIND}`)).toMatchObject({ status: 'failed', attemptCount: 1 });
    expect(repo.rows.get(seeded.id)?.tourflowSynced).toBe(false);

    // A later booking-touching request (Stripe redelivery) drains the owed row.
    const second = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(second.status).toBe(200);
    expect(pushCalls).toBe(2);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${TOURFLOW_CONFIRMED_KIND}`)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect(repo.rows.get(seeded.id)?.tourflowSynced).toBe(true);
  });

  it('delivers a Tourflow confirmation row a crashed isolate committed but never attempted', async () => {
    const seeded = booking({ id: 'tf-isolate-loss', tourflowSynced: false });
    const repo = fakeRepository([seeded]);
    const now = '2026-06-14T08:00:00.000Z';
    // Simulates confirmWithSideEffectOperations's D1 batch having landed (the row exists) but the
    // isolate dying before scheduleConfirmationTourflowDelivery's detached first attempt ever ran.
    repo.sideEffectOperations.set(`${seeded.id}:${TOURFLOW_CONFIRMED_KIND}`, {
      bookingId: seeded.id, kind: TOURFLOW_CONFIRMED_KIND, status: 'pending', providerResultId: null,
      attemptCount: 0, attemptedAt: null, resolvedAt: null, error: null, createdAt: now, updatedAt: now,
    });
    let pushCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: () => new Date(now),
      providers: providers({ ops: { push: async () => { pushCalls += 1; } } }),
    });

    // A later request touching this booking (mirrors tokenBooking/handleManage/handleStatus).
    await runOwedMutationSideEffects(context, seeded);

    expect(pushCalls).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${TOURFLOW_CONFIRMED_KIND}`)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(repo.rows.get(seeded.id)?.tourflowSynced).toBe(true);
  });

  it('repairs and delivers a legacy confirmed booking that has no Tourflow row yet', async () => {
    const seeded = booking({
      id: 'tf-legacy-unsynced', status: 'confirmed', stripeSessionId: 'cs_tf_legacy_unsynced',
      calendarSynced: true, emailSynced: true, tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    let pushCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ ops: { push: async () => { pushCalls += 1; } } }),
    });

    expect(repo.sideEffectOperations.size).toBe(0);
    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_tf_legacy_unsynced'), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'confirmed' });
    expect(pushCalls).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${TOURFLOW_CONFIRMED_KIND}`)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(repo.rows.get(seeded.id)?.tourflowSynced).toBe(true);
  });

  it('never creates or claims a Tourflow row for an already-synced legacy booking', async () => {
    const seeded = booking({
      id: 'tf-legacy-synced', status: 'confirmed', stripeSessionId: 'cs_tf_legacy_synced',
      calendarSynced: true, emailSynced: true, tourflowSynced: true,
    });
    const repo = fakeRepository([seeded]);
    let pushCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ ops: { push: async () => { pushCalls += 1; } } }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_tf_legacy_synced'), context);

    expect(response.status).toBe(200);
    expect(pushCalls).toBe(0);
    expect(repo.sideEffectOperations.has(`${seeded.id}:${TOURFLOW_CONFIRMED_KIND}`)).toBe(false);
  });

  it('creates no Tourflow row and adds no fulfillment polling when no ops provider is configured', async () => {
    const seeded = booking({
      id: 'tf-no-provider', status: 'confirmed', stripeSessionId: 'cs_tf_no_provider',
      calendarSynced: true, emailSynced: true, tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_tf_no_provider'), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'confirmed' });
    expect(repo.sideEffectOperations.size).toBe(0);
  });

  it('still dispatches booking.confirmed analytics exactly as before the Tourflow durability refactor', async () => {
    const seeded = booking({
      id: 'tf-analytics', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_tf_analytics', stripePaymentIntent: null,
      calendarSynced: false, emailSynced: false, tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    const pending: Promise<unknown>[] = [];
    const tracked: Array<[string, string]> = [];
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: () => new Date('2026-06-14T08:00:00.000Z'),
      waitUntil: (task) => pending.push(task),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({
            id: 'evt_tf_analytics', type: 'checkout.session.completed',
            bookingId: seeded.id, sessionId: 'cs_tf_analytics', paymentIntent: 'pi_tf_analytics',
            paid: true, amountCaptured: seeded.priceCents, currency: config.business.currency,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
        analytics: { track: async (event, item) => { tracked.push([event, item.id]); } },
      }),
    });

    const response = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    await Promise.all(pending);

    expect(tracked).toEqual([['booking.confirmed', seeded.id]]);
  });

  it('never lets both the mutation drain and the confirmation drain claim the same Tourflow confirmation row', async () => {
    const seeded = booking({ id: 'tf-single-drain', tourflowSynced: false });
    const repo = fakeRepository([seeded]);
    const now = '2026-06-14T08:00:00.000Z';
    await repo.recordMutationSideEffectOperations(seeded.id, [TOURFLOW_CONFIRMED_KIND], now);
    let pushCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: () => new Date(now),
      providers: providers({ ops: { push: async () => { pushCalls += 1; } } }),
    });

    await runOwedMutationSideEffects(context, seeded);

    expect(pushCalls).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:${TOURFLOW_CONFIRMED_KIND}`)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    // Only resolveConfirmationTourflowOperation ever sets this flag: had the generic mutation
    // loop claimed the row instead (no isMutationSideEffectKind exclusion), it would have resolved
    // it through resolveMutationSideEffectOperation, leaving tourflow_synced permanently false even
    // though the row itself shows 'succeeded'.
    expect(repo.rows.get(seeded.id)?.tourflowSynced).toBe(true);
  });
});
