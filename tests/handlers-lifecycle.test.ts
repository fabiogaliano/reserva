import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import type { Booking } from '../src/core/booking';
import type { ResolvedClientConfig, ResolvedServiceConfig } from '../src/core/config';
import type { BookingEventHookArgs } from '../src/core/events';
import { handleAvailability, handleCheckout, handleOperatorNoShow, handlePaymentWebhook } from '../src/handlers';
import { booking, config, service } from './fixtures';
import { ReferenceConflictError } from '../src/repo';
import { fakeRepository, providers, sideEffectOperation } from './fakes';

describe('Reserva handlers', () => {
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
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: sharedProviders,
    });
    const secondContext = createReservaContext({
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
    const context = createReservaContext({
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
    // Both confirmation rows succeeded is the whole record that the retry delivered.
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })).toMatchObject({ status: 'succeeded' });
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'succeeded' });
  });

  it('enforces configured hold limits through the repository', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({
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
    const context = createReservaContext({
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

  // A completed session that is not paid means a delayed payment method got past the dashboard.
  // Reserva does not support them: the hold is released, the payment is cancelled best-effort, and
  // the event is acknowledged so the provider stops redelivering something that will never confirm.
  function refusedDelayedPaymentContext(cancelPayment?: (paymentRef: string) => Promise<void>) {
    const seeded = booking({
      id: 'b-unpaid',
      status: 'hold',
      paymentSessionRef: 'cs_unpaid',
      paymentRef: 'pi_unpaid',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
    });
    const repo = fakeRepository([seeded]);
    let calendarCreates = 0;
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({ id: 'evt_unpaid', type: 'checkout_completed', bookingId: seeded.id, sessionRef: 'cs_unpaid', paid: false, paymentStatus: 'unpaid', paymentRef: 'pi_unpaid', amountCaptured: seeded.priceMinor, currency: config.business.currency }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
          ...(cancelPayment ? { cancelPayment } : {}),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCreates += 1; return 'cal'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });
    return { seeded, repo, context, calendarCreates: () => calendarCreates };
  }

  it('refuses an unpaid completed event: expires the hold, cancels the payment, and acknowledges', async () => {
    const cancelled: string[] = [];
    const { seeded, repo, context, calendarCreates } = refusedDelayedPaymentContext(async (paymentRef) => { cancelled.push(paymentRef); });

    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('expired');
    expect(cancelled).toEqual(['pi_unpaid']);
    expect(calendarCreates()).toBe(0);
    // The customer may never poll `status`, so the operator's incident is opened here, and under
    // the same key the status page would use, so the two paths collapse into one incident.
    const incidents = (await repo.listOpenIncidents(10)).filter((incident) => incident.bookingId === seeded.id);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ action: 'payment_verification_rejected', sourceKey: `${seeded.id}:payment_not_paid`, status: 'open' });
  });

  it('still acknowledges a refused unpaid event when cancelling the payment throws', async () => {
    const { seeded, repo, context } = refusedDelayedPaymentContext(async () => { throw new Error('stripe refused the cancel'); });

    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('expired');
  });

  // A dispute is not a booking transition, so its durable row is written directly and
  // drained detached — the webhook response must not wait for a slow subscriber.
  it('reports Stripe disputes through waitUntil without delaying the webhook response', async () => {
    const seeded = booking({ id: 'b-dispute', paymentRef: 'pi_dispute' });
    const repo = fakeRepository([seeded]);
    const pending: Promise<unknown>[] = [];
    let deliveredEvent: string | undefined;
    let releaseHook = (): void => undefined;
    const blockedHook = new Promise<void>((resolve) => { releaseHook = resolve; });
    const context = createReservaContext({
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
        // The handler signature is a tuple union now (`settings.changed` carries no booking), so the
        // parameter list is spelled out rather than narrowed to a single argument.
        handler: async (...args: BookingEventHookArgs) => {
          deliveredEvent = args[0];
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
    const context = createReservaContext({
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
    const context = createReservaContext({ config, db: {} as D1Database, repo, providers: providers() });

    const response = await handleAvailability(new Request('https://example.test/api/booking/availability?service=vintage&quantity=2&from=1000-01-01&to=9999-12-31'), context);
    expect(response.status).toBe(400);
    // The bound is the deployment's own maxHorizonDays (180 in
    // the fixture), and the message names the config key so a caller can correct the request.
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'validation_failed', message: 'Date range cannot exceed the booking horizon of 180 days (config.booking.maxHorizonDays); request a narrower range' },
    });
    // Enumerating ~3.3M date keys takes seconds and would also drive occupancyReads above 0;
    // this zero proves the cheap span guard rejects the range before ever building that array.
    expect(occupancyReads).toBe(0);
  });

  it('rejects operator actions without constant-time shared-secret auth', async () => {
    const seeded = booking({ id: 'b1', status: 'confirmed', startsAt: '2026-06-15T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({
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

  // The pre-read is gone: a taken reference now comes back from the insert itself as a
  // ReferenceConflictError, which the checkout loop answers by regenerating the sequence. Hooked at
  // insertHoldWithCapacity (the atomic capacity-guarded INSERT) because that is the entry point
  // handleCheckout writes through.
  function collidingCheckout(collisions: number) {
    const repo = fakeRepository();
    const realInsertHold = repo.insertHoldWithCapacity;
    let insertAttempts = 0;
    // Marking whatever reference was just attempted as taken (rather than a fixed sequence range)
    // keeps this deterministic despite the random 1-5 jump between attempts.
    repo.insertHoldWithCapacity = async (input) => {
      insertAttempts += 1;
      if (insertAttempts <= collisions) {
        // Simulate concurrent requests winning each candidate before this request can insert it.
        const winner: Booking = { ...booking(), id: `winner-${insertAttempts}`, reference: input.reference, status: 'hold' };
        repo.rows.set(winner.id, winner);
        throw new ReferenceConflictError(input.reference);
      }
      return realInsertHold(input);
    };
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });
    const response = handleCheckout(new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en' }),
    }), context);
    return { response, attempts: () => insertAttempts };
  }

  it('regenerates the reference after consecutive collisions, up to the retry cap, without changing its format', async () => {
    const { response, attempts } = collidingCheckout(4);
    const resolved = await response;

    expect(resolved.status).toBe(201);
    expect(attempts()).toBe(5);
    const payload = await resolved.json() as { reference: string };
    expect(payload.reference).toMatch(/^LVT-2026-\d{3,}$/);
  });

  it('gives up rather than looping when the regenerated reference keeps colliding', async () => {
    const { response, attempts } = collidingCheckout(5);
    const resolved = await response;

    expect(resolved.status).toBe(500);
    expect(attempts()).toBe(5);
  });

  it('logs a warning when a payment confirms an expired hold, but not on the normal hold path', async () => {
    const expiredWarnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const seededExpired = booking({ id: 'b-expired', status: 'expired', holdExpiresAt: null, paymentSessionRef: 'cs_expired' });
    const expiredContext = createReservaContext({
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
    const holdContext = createReservaContext({
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

// checkout's meetingPointId field — required only for a
// multi-point service's default (free) pickup; validated against the declared set whenever supplied
// (including for a custom pickup); the resolved id is always what gets stored.
describe('checkout meetingPointId', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const multiPointConfig = { ...config, services: { ...config.services, vintage: { ...service, location: { ...service.location!, meetingPoints: points } } } };

  function checkoutContext(configOverride = config) {
    const repo = fakeRepository();
    const context = createReservaContext({
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
    await expect(defaultResponse.json()).resolves.toMatchObject({
      error: {
        code: 'validation_failed',
        message: 'meetingPointId must be one of: square, station',
        details: { field: 'meetingPointId', allowed: ['square', 'station'] },
      },
    });

    const { context: customContext } = checkoutContext(multiPointConfig);
    const customResponse = await handleCheckout(checkoutRequest({ pickupType: 'custom', meetingPointId: 'bogus' }), customContext);
    expect(customResponse.status).toBe(400);
    await expect(customResponse.json()).resolves.toMatchObject({
      error: { code: 'validation_failed', message: 'meetingPointId must be one of: square, station' },
    });
  });

  it('stores the single declared point\'s id for a single-point service when the field is omitted', async () => {
    const { repo, context } = checkoutContext(config);
    const response = await handleCheckout(checkoutRequest({}), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)).toMatchObject({ meetingPointId: 'default', meetingPointLabel: service.location!.meetingPoints![0]!.label });
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

// parsePickup validates pickupType against the service's own declared option ids instead of a
// fixed 'default'/'custom' enum; meetingPointId re-keys onto usesMeetingPoint, since a "custom
// drop-off" can still start at a meeting point even though it also collects an address.
describe('checkout pickupType', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  // A Maze-shaped four-option service, built inline — fixtures.ts stays the two-option default/custom
  // service so every other suite's byte-identical assertions keep holding.
  const mazeTour: ResolvedServiceConfig = {
    ...service,
    location: {
      meetingPoints: points,
      pickupOptions: [
        { id: 'default', label: 'Default', requiresAddress: false, usesMeetingPoint: true },
        { id: 'custom_pickup', label: 'Custom pickup', requiresAddress: true, usesMeetingPoint: false },
        { id: 'custom_dropoff', label: 'Custom dropoff', requiresAddress: true, usesMeetingPoint: true },
        { id: 'meet_elsewhere', label: 'Meet elsewhere', requiresAddress: false, usesMeetingPoint: true },
      ],
    },
    pricing: [
      { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
      { maxQuantity: 8, pickup: 'custom_pickup', priceMinor: 20000 },
      { maxQuantity: 8, pickup: 'custom_dropoff', priceMinor: 21000 },
      { maxQuantity: 8, pickup: 'meet_elsewhere', priceMinor: 19000 },
    ],
  };
  const mazeConfig: ResolvedClientConfig = { ...config, services: { ...config.services, vintage: mazeTour } };

  function checkoutContext(configOverride: ResolvedClientConfig = mazeConfig) {
    const repo = fakeRepository();
    const context = createReservaContext({
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

  it('a two-option (default/custom) service still accepts both ids', async () => {
    const { repo, context } = checkoutContext(config);
    const response = await handleCheckout(checkoutRequest({ pickupType: 'custom' }), context);
    expect(response.status).toBe(201);
    const { bookingId } = await response.json() as { bookingId: string };
    expect(repo.rows.get(bookingId)).toMatchObject({ pickupType: 'custom', priceMinor: 12000 });
  });

  // DEFAULT_PICKUP_OPTIONS injection (and its pinned error message) is gone — every
  // location-ful service now declares its own options explicitly, so an invalid or missing
  // pickup always gets the generic "must be one of" / "is required" wording. The diagnostics name
  // `pickup`, the one spelling, even when the request used the accepted `pickupType` fallback.
  it('names the declared ids for an invalid pickup, and reports missing separately', async () => {
    const { context } = checkoutContext(config);
    const invalidResponse = await handleCheckout(checkoutRequest({ pickupType: 'bogus' }), context);
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: {
        code: 'validation_failed',
        message: 'pickup must be one of: default, custom',
        details: { field: 'pickup', allowed: ['default', 'custom'] },
      },
    });
    const missingResponse = await handleCheckout(checkoutRequest({ pickupType: undefined }), context);
    expect(missingResponse.status).toBe(400);
    await expect(missingResponse.json()).resolves.toMatchObject({
      error: { code: 'validation_failed', message: 'pickup is required' },
    });
  });

  it('a declared service distinguishes a missing pickup from an undeclared one', async () => {
    const { context } = checkoutContext();
    const response = await handleCheckout(checkoutRequest({ pickupType: undefined }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'validation_failed', message: 'pickup is required' },
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
    await expect(dropoffResponse.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: 'meetingPointId must be one of: square, station' } });

    const { context: pickupContext } = checkoutContext();
    const pickupResponse = await handleCheckout(checkoutRequest({ pickupType: 'custom_pickup', meetingPointId: 'bogus' }), pickupContext);
    expect(pickupResponse.status).toBe(400);
    await expect(pickupResponse.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: 'meetingPointId must be one of: square, station' } });
  });
});
