import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import type { Booking } from '../src/core/booking';
import { handleAvailability, handleCheckout, handleFeed, handleOperatorNoShow, handleStripeWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

describe('Bookkit handlers', () => {
  it('persists a checkout session and confirms idempotently on webhook replay', async () => {
    const repo = fakeRepository();
    let calendarCreates = 0;
    let emails = 0;
    const sharedProviders = providers({
      calendar: {
        listEvents: async () => [],
        createEvent: async () => { calendarCreates += 1; return 'cal_1'; },
        patchEvent: async () => undefined,
        deleteEvent: async () => undefined,
      },
      email: { send: async () => { emails += 1; } },
    });
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: sharedProviders,
    });
    const secondContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: sharedProviders,
    });
    const checkout = await handleCheckout(new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      body: JSON.stringify({ tourSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', people: 2, pickupType: 'default', locale: 'en' }),
      headers: { 'content-type': 'application/json' },
    }), context);
    expect(checkout.status).toBe(201);
    const created = [...repo.rows.values()][0];
    expect(created?.stripeSessionId).toBe('cs_1');

    const [first, second] = await Promise.all([
      handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST', body: 'same' }), context),
      handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST', body: 'same' }), secondContext),
    ]);
    expect([first.status, second.status]).toContain(200);
    expect([first.status, second.status].every((status) => status === 200 || status === 503)).toBe(true);
    const confirmed = repo.rows.get(created?.id ?? '');
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      customerName: 'Ada Lovelace',
      customerEmail: 'ada@example.com',
      customerPhone: '+351910000000',
      pickupAddress: 'Praça do Comércio',
    });
    expect(calendarCreates).toBe(1);
    expect(emails).toBe(1);
  });

  it('returns a retryable webhook error while another confirmation lease is active', async () => {
    const seeded = booking({
      id: 'b-leased',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_1',
      stripePaymentIntent: null,
      calendarSynced: false,
      emailSynced: false,
      tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    await repo.acquireConfirmationLease(seeded.id, 'stalled-worker', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z');
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const blocked = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: 'confirmation_in_progress' } });

    await repo.releaseConfirmationLease(seeded.id, 'stalled-worker');
    const retried = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(retried.status).toBe(200);
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'confirmed', calendarSynced: true, emailSynced: true });
  });

  it('enforces configured hold limits through the repository', async () => {
    const repo = fakeRepository();
    const context = createBookkitContext({
      config: { ...config, booking: { ...config.booking, maxHoldsPerIp: 1 } },
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });
    const checkoutRequest = () => new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({ tourSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', people: 2, pickupType: 'default', locale: 'en' }),
    });

    await expect(handleCheckout(checkoutRequest(), context)).resolves.toMatchObject({ status: 201 });
    const limited = await handleCheckout(checkoutRequest(), context);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'too_many_holds' } });
  });

  it('uses the longest configured tour window during checkout revalidation', async () => {
    const candidateTour = { ...config.tours.vintage!, turnaroundMin: 0, schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '12:00', lastStart: '12:00', intervalMin: 30 }] };
    const longTour = { ...config.tours.vintage!, turnaroundMin: 120, schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '10:00', lastStart: '10:00', intervalMin: 30 }] };
    const multiTourConfig = {
      ...config,
      business: { ...config.business, timezone: 'UTC' },
      tours: { candidate: candidateTour, long: longTour },
      booking: { ...config.booking, minNoticeHours: 0 },
    };
    const existing = booking({
      id: 'long-booking',
      tourSlug: 'long',
      people: 8,
      startsAt: '2026-06-15T10:00:00.000Z',
      endsAt: '2026-06-15T11:00:00.000Z',
    });
    const context = createBookkitContext({
      config: multiTourConfig,
      db: {} as D1Database,
      repo: fakeRepository([existing]),
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const response = await handleCheckout(new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tourSlug: 'candidate', start: '2026-06-15T12:00:00.000Z', people: 2, pickupType: 'default', locale: 'en' }),
    }), context);
    expect(response.status).toBe(409);
  });

  it('does not confirm a paid booking from an unpaid completed event', async () => {
    const seeded = booking({
      id: 'b-unpaid',
      status: 'hold',
      stripeSessionId: 'cs_unpaid',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
    });
    const repo = fakeRepository([seeded]);
    let calendarCreates = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_unpaid', type: 'checkout.session.completed', bookingId: seeded.id, sessionId: 'cs_unpaid', paid: false }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => undefined,
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCreates += 1; return 'cal'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    const response = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('hold');
    expect(calendarCreates).toBe(0);
  });

  it('reports Stripe disputes through waitUntil without delaying the webhook response', async () => {
    const seeded = booking({ id: 'b-dispute', stripePaymentIntent: 'pi_dispute' });
    const repo = fakeRepository([seeded]);
    const pending: Promise<unknown>[] = [];
    let pushedEvent: string | undefined;
    let releaseOps = (): void => undefined;
    const blockedOps = new Promise<void>((resolve) => { releaseOps = resolve; });
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      waitUntil: (promise) => pending.push(promise),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_dispute', type: 'charge.dispute.created', paymentIntent: 'pi_dispute' }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => undefined,
        },
        ops: {
          push: async (event) => {
            pushedEvent = event;
            await blockedOps;
          },
        },
      }),
    });

    const response = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(pushedEvent).toBe('payment.dispute_created');
    expect(pending).toHaveLength(1);
    releaseOps();
    await Promise.all(pending);
  });

  it('returns a redacted, canonicalized feed payload', async () => {
    const seeded = booking({ id: 'b-feed', status: 'confirmed', updatedAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      secrets: async () => 'expected-secret',
      providers: providers(),
    });
    const response = await handleFeed(new Request('https://example.test/api/booking/feed?since=2026-06-01T01:00:00%2B01:00', {
      headers: { authorization: 'Bearer expected-secret' },
    }), context);
    const payload = await response.json() as { bookings: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(payload.bookings[0]).toMatchObject({ id: seeded.id, reference: seeded.reference, status: 'confirmed' });
    expect(payload.bookings[0]).not.toHaveProperty('cancelToken');
    expect(payload.bookings[0]).not.toHaveProperty('operatorToken');
    expect(payload.bookings[0]).not.toHaveProperty('stripeSessionId');
  });

  it('rejects impossible availability dates as validation errors', async () => {
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository(),
      providers: providers(),
    });
    const response = await handleAvailability(new Request('https://example.test/api/booking/availability?tour=vintage&people=2&from=2026-02-30&to=2026-03-01'), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('rejects feed and operator actions without constant-time shared-secret auth', async () => {
    const seeded = booking({ id: 'b1', status: 'confirmed', startsAt: '2026-06-15T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      secrets: async () => 'expected-secret',
      providers: providers(),
    });
    const feed = await handleFeed(new Request('https://example.test/api/booking/feed?since=2026-01-01T00:00:00.000Z', { headers: { authorization: 'Bearer wrong' } }), context);
    expect(feed.status).toBe(403);
    const noShow = await handleOperatorNoShow(new Request('https://example.test/api/booking/operator/no-show', { method: 'POST', body: JSON.stringify({ bookingId: 'b1' }), headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' } }), context);
    expect(noShow.status).toBe(403);
  });

  it('recovers from a reference collision reported by insertHold by retrying with the next sequence', async () => {
    const repo = fakeRepository();
    const realInsertHold = repo.insertHold;
    let insertAttempts = 0;
    repo.insertHold = async (input) => {
      insertAttempts += 1;
      if (insertAttempts === 1) {
        // Simulate a concurrent request winning the race for this exact reference: it lands
        // in the table before we re-check, so our failure-classification finds it taken.
        const winner: Booking = { ...booking(), id: 'winner', reference: input.reference, status: 'hold' };
        repo.rows.set(winner.id, winner);
        throw new Error('UNIQUE constraint failed: bookings.reference');
      }
      return realInsertHold(input);
    };
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const response = await handleCheckout(new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tourSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', people: 2, pickupType: 'default', locale: 'en' }),
    }), context);

    expect(response.status).toBe(201);
    expect(insertAttempts).toBe(2);
    const payload = await response.json() as { reference: string };
    expect(payload.reference).toBe('LVT-2026-002');
  });

  it('logs a warning when a payment confirms an expired hold, but not on the normal hold path', async () => {
    const expiredWarnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const seededExpired = booking({ id: 'b-expired', status: 'expired', holdExpiresAt: null, stripeSessionId: 'cs_expired' });
    const expiredContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seededExpired]),
      logger: { warn: (message, data) => { expiredWarnings.push([message, data]); } },
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_expired', type: 'checkout.session.completed', bookingId: seededExpired.id, sessionId: 'cs_expired', paid: true, amountCaptured: seededExpired.priceCents }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => undefined,
        },
      }),
    });
    const expiredResponse = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), expiredContext);
    expect(expiredResponse.status).toBe(200);
    expect(expiredWarnings).toContainEqual([
      'confirming expired hold after payment; possible one-slot oversell',
      { bookingId: seededExpired.id, reference: seededExpired.reference, startsAt: seededExpired.startsAt },
    ]);

    const holdWarnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const seededHold = booking({ id: 'b-hold', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', stripeSessionId: 'cs_hold' });
    const holdContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seededHold]),
      logger: { warn: (message, data) => { holdWarnings.push([message, data]); } },
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_hold', type: 'checkout.session.completed', bookingId: seededHold.id, sessionId: 'cs_hold', paid: true, amountCaptured: seededHold.priceCents }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => undefined,
        },
      }),
    });
    const holdResponse = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), holdContext);
    expect(holdResponse.status).toBe(200);
    expect(holdWarnings.some(([message]) => message.includes('possible one-slot oversell'))).toBe(false);
  });
});
