import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import type { Booking } from '../src/core/booking';
import type { ClientConfig, ServiceConfig } from '../src/core/config';
import { handleAvailability, handleCheckout, handleOperatorNoShow, handlePaymentWebhook } from '../src/handlers';
import { booking, config, service } from './fixtures';
import { fakeRepository, providers, sideEffectOperation } from './fakes';

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
      body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en' }),
      headers: { 'content-type': 'application/json' },
    }), context);
    expect(checkout.status).toBe(201);
    const created = [...repo.rows.values()][0];
    expect(created?.paymentSessionRef).toBe('cs_1');

    const [first, second] = await Promise.all([
      handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST', body: 'same' }), context),
      handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST', body: 'same' }), secondContext),
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
      paymentSessionRef: 'cs_1',
      paymentRef: null,
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

    const blocked = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: 'confirmation_in_progress' } });

    await repo.releaseConfirmationLease(seeded.id, 'stalled-worker');
    const retried = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(retried.status).toBe(200);
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'confirmed' });
    // Plan 022: both confirmation rows succeeded is the whole record that the retry delivered.
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })).toMatchObject({ status: 'succeeded' });
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'succeeded' });
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
      body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en' }),
    });

    await expect(handleCheckout(checkoutRequest(), context)).resolves.toMatchObject({ status: 201 });
    const limited = await handleCheckout(checkoutRequest(), context);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'too_many_holds' } });
  });

  it('uses the longest configured service window during checkout revalidation', async () => {
    const candidateTour = { ...config.services.vintage!, turnaroundMin: 0, schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '12:00', lastStart: '12:00', intervalMin: 30 }] };
    const longTour = { ...config.services.vintage!, turnaroundMin: 120, schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '10:00', lastStart: '10:00', intervalMin: 30 }] };
    const multiTourConfig = {
      ...config,
      business: { ...config.business, timezone: 'UTC' },
      services: { candidate: candidateTour, long: longTour },
      booking: { ...config.booking, minNoticeHours: 0 },
    };
    const existing = booking({
      id: 'long-booking',
      serviceSlug: 'long',
      quantity: 8,
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
      body: JSON.stringify({ serviceSlug: 'candidate', start: '2026-06-15T12:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en' }),
    }), context);
    expect(response.status).toBe(409);
  });

  it('does not confirm a paid booking from an unpaid completed event', async () => {
    const seeded = booking({
      id: 'b-unpaid',
      status: 'hold',
      paymentSessionRef: 'cs_unpaid',
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
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({ id: 'evt_unpaid', type: 'checkout_completed', bookingId: seeded.id, sessionRef: 'cs_unpaid', paid: false, amountCaptured: seeded.priceMinor, currency: config.business.currency }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCreates += 1; return 'cal'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(response.status).toBe(409);
    expect(repo.rows.get(seeded.id)?.status).toBe('hold');
    expect(calendarCreates).toBe(0);
  });

  // Plan 021: a dispute is not a booking transition, so its durable row is written directly and
  // drained detached — the webhook response must not wait for a slow subscriber.
  it('reports Stripe disputes through waitUntil without delaying the webhook response', async () => {
    const seeded = booking({ id: 'b-dispute', paymentRef: 'pi_dispute' });
    const repo = fakeRepository([seeded]);
    const pending: Promise<unknown>[] = [];
    let deliveredEvent: string | undefined;
    let releaseHook = (): void => undefined;
    const blockedHook = new Promise<void>((resolve) => { releaseHook = resolve; });
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      waitUntil: (promise) => pending.push(promise),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({ id: 'evt_dispute', type: 'dispute_created', paymentRef: 'pi_dispute' }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
      }),
      hooks: [{
        name: 'ops',
        durable: true,
        handler: async (event) => {
          deliveredEvent = event;
          await blockedHook;
        },
      }],
    });

    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(deliveredEvent).toBe('payment.dispute_created');
    expect(pending).toHaveLength(1);
    releaseHook();
    await Promise.all(pending);
    expect(sideEffectOperation(repo, seeded.id, {
      family: 'hook', name: 'ops', event: 'payment.dispute_created', discriminator: 'evt_dispute',
    })).toMatchObject({ status: 'succeeded' });
  });

  it('rejects impossible availability dates as validation errors', async () => {
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository(),
      providers: providers(),
    });
    const response = await handleAvailability(new Request('https://example.test/api/booking/availability?service=vintage&quantity=2&from=2026-02-30&to=2026-03-01'), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('rejects a multi-century availability range fast, before enumerating or reading occupancy', async () => {
    const repo = fakeRepository();
    let occupancyReads = 0;
    const realListOccupancyBookings = repo.listOccupancyBookings;
    repo.listOccupancyBookings = async (from, to) => {
      occupancyReads += 1;
      return realListOccupancyBookings(from, to);
    };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, providers: providers() });

    const response = await handleAvailability(new Request('https://example.test/api/booking/availability?service=vintage&quantity=2&from=1000-01-01&to=9999-12-31'), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: 'Date range cannot exceed 62 days' } });
    // Enumerating ~3.3M date keys takes seconds and would also drive occupancyReads above 0;
    // this zero proves the cheap span guard rejects the range before ever building that array.
    expect(occupancyReads).toBe(0);
  });

  it('rejects operator actions without constant-time shared-secret auth', async () => {
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
    const noShow = await handleOperatorNoShow(new Request('https://example.test/api/booking/operator/no-show', { method: 'POST', body: JSON.stringify({ bookingId: 'b1' }), headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' } }), context);
    expect(noShow.status).toBe(403);
  });

  it('recovers from 11 consecutive reference collisions — beyond the old retry cap of 8 — without changing the reference format', async () => {
    const repo = fakeRepository();
    // BK-CAP-001: handleCheckout now writes through insertHoldWithCapacity (the atomic
    // capacity-guarded INSERT), not the old unconditional insertHold — hook that entry point so
    // this still exercises the real retry loop instead of silently no-op-ing.
    const realInsertHold = repo.insertHoldWithCapacity;
    let insertAttempts = 0;
    // 11 forced collisions exceeds the old retry cap (8, i.e. attempts 0-7 with an unconditional
    // rethrow on attempt 7): this proves the cap was actually raised to 12, not just that some
    // small number of collisions still fits under the old ceiling. Marking whatever reference
    // was just attempted as taken (rather than pre-computing a fixed sequence range) keeps this
    // deterministic regardless of the now-random 1-5 jump: each attempt is failed and blocked by
    // reacting to its actual generated reference, not by guessing where the jump landed.
    repo.insertHoldWithCapacity = async (input) => {
      insertAttempts += 1;
      if (insertAttempts <= 11) {
        // Simulate concurrent requests winning each candidate before this request can insert it.
        const winner: Booking = { ...booking(), id: `winner-${insertAttempts}`, reference: input.reference, status: 'hold' };
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
      body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en' }),
    }), context);

    expect(response.status).toBe(201);
    expect(insertAttempts).toBe(12);
    const payload = await response.json() as { reference: string };
    expect(payload.reference).toMatch(/^LVT-2026-\d{3,}$/);
  });

  it('logs a warning when a payment confirms an expired hold, but not on the normal hold path', async () => {
    const expiredWarnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const seededExpired = booking({ id: 'b-expired', status: 'expired', holdExpiresAt: null, paymentSessionRef: 'cs_expired' });
    const expiredContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seededExpired]),
      logger: { warn: (message, data) => { expiredWarnings.push([message, data]); } },
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({ id: 'evt_expired', type: 'checkout_completed', bookingId: seededExpired.id, sessionRef: 'cs_expired', paid: true, amountCaptured: seededExpired.priceMinor, currency: config.business.currency }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
      }),
    });
    const expiredResponse = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), expiredContext);
    expect(expiredResponse.status).toBe(200);
    expect(expiredWarnings).toContainEqual([
      'confirming expired hold after payment; possible one-slot oversell',
      { bookingId: seededExpired.id, reference: seededExpired.reference, startsAt: seededExpired.startsAt },
    ]);

    const holdWarnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const seededHold = booking({ id: 'b-hold', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_hold' });
    const holdContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seededHold]),
      logger: { warn: (message, data) => { holdWarnings.push([message, data]); } },
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({ id: 'evt_hold', type: 'checkout_completed', bookingId: seededHold.id, sessionRef: 'cs_hold', paid: true, amountCaptured: seededHold.priceMinor, currency: config.business.currency }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
      }),
    });
    const holdResponse = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), holdContext);
    expect(holdResponse.status).toBe(200);
    expect(holdWarnings.some(([message]) => message.includes('possible one-slot oversell'))).toBe(false);
  });
});

// Plan 017 (design decision 2): checkout's meetingPointId field — required only for a
// multi-point service's default (free) pickup; validated against the declared set whenever supplied
// (including for a custom pickup); the resolved id is always what gets stored.
describe('checkout meetingPointId (plan 017 design decision 2)', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const { meetingPoint: _meetingPoint, ...vintageWithoutShorthand } = service;
  const multiPointConfig = { ...config, services: { ...config.services, vintage: { ...vintageWithoutShorthand, meetingPoints: points } } };

  function checkoutContext(configOverride = config) {
    const repo = fakeRepository();
    const context = createBookkitContext({
      config: configOverride,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });
    return { repo, context };
  }

  function checkoutRequest(body: Record<string, unknown>): Request {
    return new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en', ...body }),
    });
  }

  it('rejects a 2-point service\'s default pickup with 400 when meetingPointId is missing', async () => {
    const { context } = checkoutContext(multiPointConfig);
    const response = await handleCheckout(checkoutRequest({}), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('meetingPointId is required') } });
  });

  it('rejects an unknown meetingPointId with 400 for both default and custom pickup', async () => {
    const { context: defaultContext } = checkoutContext(multiPointConfig);
    const defaultResponse = await handleCheckout(checkoutRequest({ meetingPointId: 'bogus' }), defaultContext);
    expect(defaultResponse.status).toBe(400);
    await expect(defaultResponse.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('Unknown meetingPointId') } });

    const { context: customContext } = checkoutContext(multiPointConfig);
    const customResponse = await handleCheckout(checkoutRequest({ pickupType: 'custom', meetingPointId: 'bogus' }), customContext);
    expect(customResponse.status).toBe(400);
    await expect(customResponse.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('Unknown meetingPointId') } });
  });

  it('stores the single declared point\'s id for a single-point service when the field is omitted', async () => {
    const { repo, context } = checkoutContext(config);
    const response = await handleCheckout(checkoutRequest({}), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)).toMatchObject({ meetingPointId: 'default', meetingPointLabel: service.meetingPoint!.label });
  });

  it('does not require meetingPointId for a custom pickup, and stores the resolved first point', async () => {
    const { repo, context } = checkoutContext(multiPointConfig);
    const response = await handleCheckout(checkoutRequest({ pickupType: 'custom' }), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)).toMatchObject({ meetingPointId: 'square', meetingPointLabel: 'The Square' });
  });

  it('stores the chosen second point\'s id and label for a 2-point service', async () => {
    const { repo, context } = checkoutContext(multiPointConfig);
    const response = await handleCheckout(checkoutRequest({ meetingPointId: 'station' }), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)).toMatchObject({ meetingPointId: 'station', meetingPointLabel: 'The Station' });
  });
});

// Plan 018 (design decision 6): parsePickup validates pickupType against the service's own declared
// option ids (via pickupOptionFor) instead of a fixed 'default'/'custom' enum, and the
// meetingPointId requirement re-keys onto the chosen option's usesMeetingPoint instead of
// `pickupType === 'default'` — Maze's "custom drop-off" still starts at a meeting point even though
// it also collects an address.
describe('checkout pickupType (plan 018 design decision 6)', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const { meetingPoint: _meetingPoint, ...vintageWithoutShorthand } = service;
  // A Maze-shaped four-option service, built inline — fixtures.ts stays the two-option default/custom
  // service so every other suite's byte-identical assertions keep holding.
  const mazeTour: ServiceConfig = {
    ...vintageWithoutShorthand,
    meetingPoints: points,
    pickupOptions: [
      { id: 'default', requiresAddress: false, usesMeetingPoint: true },
      { id: 'custom_pickup', requiresAddress: true, usesMeetingPoint: false },
      { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
      { id: 'meet_elsewhere', requiresAddress: false, usesMeetingPoint: true },
    ],
    pricing: [
      { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
      { maxQuantity: 8, pickup: 'custom_pickup', priceMinor: 20000 },
      { maxQuantity: 8, pickup: 'custom_dropoff', priceMinor: 21000 },
      { maxQuantity: 8, pickup: 'meet_elsewhere', priceMinor: 19000 },
    ],
  };
  const mazeConfig: ClientConfig = { ...config, services: { ...config.services, vintage: mazeTour } };

  function checkoutContext(configOverride: ClientConfig = mazeConfig) {
    const repo = fakeRepository();
    const context = createBookkitContext({
      config: configOverride,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });
    return { repo, context };
  }

  function checkoutRequest(body: Record<string, unknown>): Request {
    return new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en', ...body }),
    });
  }

  it('accepts a declared non-enum pickupType end-to-end, pricing it from the service\'s own rows', async () => {
    const { repo, context } = checkoutContext();
    const response = await handleCheckout(checkoutRequest({ pickupType: 'meet_elsewhere', meetingPointId: 'station' }), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)).toMatchObject({ pickupType: 'meet_elsewhere', priceMinor: 19000, meetingPointId: 'station', meetingPointLabel: 'The Station' });
  });

  it('400s an undeclared pickupType, naming the service\'s valid ids', async () => {
    const { context } = checkoutContext();
    const response = await handleCheckout(checkoutRequest({ pickupType: 'bogus' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'validation_failed', message: expect.stringContaining('default, custom_pickup, custom_dropoff, meet_elsewhere') },
    });
  });

  it('a legacy two-option service still accepts exactly default/custom byte-identically', async () => {
    // config.services.vintage carries no pickupOptions — pickupOptionFor falls back to
    // DEFAULT_PICKUP_OPTIONS, so this is the same request the pre-018 suite already exercises.
    const { repo, context } = checkoutContext(config);
    const response = await handleCheckout(checkoutRequest({ pickupType: 'custom' }), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)).toMatchObject({ pickupType: 'custom', priceMinor: 12000 });
  });

  it('a legacy two-option service keeps the exact pre-018 validation error for an invalid AND a missing pickupType', async () => {
    // The byte-identity done criterion covers error bodies too — API callers may match on the
    // message — so the default pair must never emit the new "must be one of" wording.
    const { context } = checkoutContext(config);
    for (const body of [{ pickupType: 'bogus' }, { pickupType: undefined }]) {
      const response = await handleCheckout(checkoutRequest(body), context);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'validation_failed', message: 'pickupType must be default or custom' },
      });
    }
  });

  it('a declared service distinguishes a missing pickupType from an undeclared one', async () => {
    const { context } = checkoutContext();
    const response = await handleCheckout(checkoutRequest({ pickupType: undefined }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'validation_failed', message: 'pickupType is required' },
    });
  });

  it('requires meetingPointId for an option with usesMeetingPoint: true even when it also requires an address (Maze\'s custom drop-off)', async () => {
    const { context } = checkoutContext();
    const response = await handleCheckout(checkoutRequest({ pickupType: 'custom_dropoff' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('meetingPointId is required') } });
  });

  it('does not require meetingPointId for an option with usesMeetingPoint: false (Maze\'s custom pickup), and stores the resolved first point', async () => {
    const { repo, context } = checkoutContext();
    const response = await handleCheckout(checkoutRequest({ pickupType: 'custom_pickup' }), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)).toMatchObject({ pickupType: 'custom_pickup', meetingPointId: 'square', meetingPointLabel: 'The Square' });
  });

  it('still validates a supplied meetingPointId against the declared set for both option shapes', async () => {
    const { context: dropoffContext } = checkoutContext();
    const dropoffResponse = await handleCheckout(checkoutRequest({ pickupType: 'custom_dropoff', meetingPointId: 'bogus' }), dropoffContext);
    expect(dropoffResponse.status).toBe(400);
    await expect(dropoffResponse.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('Unknown meetingPointId') } });

    const { context: pickupContext } = checkoutContext();
    const pickupResponse = await handleCheckout(checkoutRequest({ pickupType: 'custom_pickup', meetingPointId: 'bogus' }), pickupContext);
    expect(pickupResponse.status).toBe(400);
    await expect(pickupResponse.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('Unknown meetingPointId') } });
  });
});
