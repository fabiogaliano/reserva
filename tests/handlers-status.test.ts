import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleStatus, handleStripeWebhook } from '../src/handlers';
import { utcToLocalIso } from '../src/core/time';
import { booking, config, tour } from './fixtures';
import { fakeRepository, providers } from './fakes';

function expectSensitiveHeaders(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('GET /status self-heals a paid hold (spec §6/§11)', () => {
  it('confirms a paid hold, runs calendar+email once, and reports the local-offset start time', async () => {
    const seeded = booking({
      id: 'b-status-paid',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_status_paid',
      stripePaymentIntent: null,
      createdAt: '2026-06-14T07:30:00.000Z',
      calendarSynced: false,
      emailSynced: false,
      tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    let calendarCreates = 0;
    let emails = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_unused', type: 'checkout.session.completed' }),
          getSession: async () => ({ id: 'cs_status_paid', status: 'complete', paymentStatus: 'paid', amountTotal: seeded.priceCents, currency: config.business.currency, paymentIntent: 'pi_status' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCreates += 1; return 'cal_status'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
        email: { send: async () => { emails += 1; } },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_paid'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    const payload = await response.json() as { status: string; booking: Record<string, unknown> };
    expect(payload.status).toBe('confirmed');
    expect(payload.booking).toMatchObject({
      reference: seeded.reference,
      tourSlug: seeded.tourSlug,
      start: utcToLocalIso(seeded.startsAt, config.business.timezone),
      end: utcToLocalIso(seeded.endsAt, config.business.timezone),
      people: seeded.people,
      priceCents: seeded.priceCents,
      // Plan 017 (design decision 3): the validated fixture config has no meetingPoint shorthand
      // left on it (normalized into meetingPoints) — this booking has no stored meetingPointId,
      // so confirmationSummary resolves it to the tour's single declared point.
      meetingPoint: { label: tour.meetingPoint!.label, mapsUrl: tour.meetingPoint!.mapsUrl },
      locale: seeded.locale,
    });
    expect(Object.keys(payload.booking).sort()).toEqual([
      'end', 'locale', 'meetingPoint', 'people', 'priceCents', 'reference', 'start', 'tourSlug',
    ]);
    expect(payload.booking).not.toHaveProperty('customerEmail');
    expect(payload.booking).not.toHaveProperty('customerPhone');
    expect(payload.booking).not.toHaveProperty('customerName');
    expect(payload.booking).not.toHaveProperty('pickupAddress');
    expect(payload.booking).not.toHaveProperty('pickupType');
    expect(payload.booking).not.toHaveProperty('status');
    expect(payload.booking.start).toBe(utcToLocalIso(seeded.startsAt, config.business.timezone));
    expect(payload.booking.start).not.toBe(seeded.startsAt);
    expect(calendarCreates).toBe(1);
    expect(emails).toBe(1);
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
  });

  it('resolves the confirmed summary\'s meetingPoint per booking: a chosen second point, and a stored-label fallback for a since-removed id', async () => {
    const points = [
      { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
      { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
    ];
    const { meetingPoint: _meetingPoint, ...vintageWithoutShorthand } = tour;
    const multiPointConfig = { ...config, tours: { ...config.tours, vintage: { ...vintageWithoutShorthand, meetingPoints: points } } };
    const clock = () => new Date('2026-06-14T08:00:00.000Z');

    const chosenSecond = booking({
      id: 'b-status-meeting-point-chosen', status: 'confirmed', stripeSessionId: 'cs_status_meeting_chosen',
      calendarSynced: true, emailSynced: true, createdAt: '2026-06-14T07:00:00.000Z',
      meetingPointId: 'station', meetingPointLabel: 'The Station',
    });
    const removedId = booking({
      id: 'b-status-meeting-point-removed', status: 'confirmed', stripeSessionId: 'cs_status_meeting_removed',
      calendarSynced: true, emailSynced: true, createdAt: '2026-06-14T07:00:00.000Z',
      meetingPointId: 'no-longer-declared', meetingPointLabel: 'The Old Dock',
    });
    const context = createBookkitContext({
      config: multiPointConfig,
      db: {} as D1Database,
      repo: fakeRepository([chosenSecond, removedId]),
      clock,
      providers: providers(),
    });

    const chosenResponse = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_meeting_chosen'), context);
    const chosenPayload = await chosenResponse.json() as { booking: { meetingPoint: unknown } };
    expect(chosenPayload.booking.meetingPoint).toEqual({ label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' });

    const removedResponse = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_meeting_removed'), context);
    const removedPayload = await removedResponse.json() as { booking: { meetingPoint: unknown } };
    expect(removedPayload.booking.meetingPoint).toEqual({ label: 'The Old Dock', mapsUrl: null });
  });

  describe('confirmation summary meeting-point filtering (plan 019 design decision 2)', () => {
    const points = [
      { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
      { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
    ];
    const { meetingPoint: _meetingPoint, ...vintageWithoutShorthand } = tour;
    const mazeConfig = {
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...vintageWithoutShorthand,
          meetingPoints: points,
          pickupOptions: [
            { id: 'default', requiresAddress: false, usesMeetingPoint: true },
            { id: 'custom_pickup', requiresAddress: true, usesMeetingPoint: false },
            { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
          ],
          pricing: [
            { maxPeople: 8, pickup: 'default', priceCents: 18000 },
            { maxPeople: 8, pickup: 'custom_pickup', priceCents: 20000 },
            { maxPeople: 8, pickup: 'custom_dropoff', priceCents: 21000 },
          ],
        },
      },
    };
    const clock = () => new Date('2026-06-14T08:00:00.000Z');

    function mazeContext(seed: ReturnType<typeof booking>[]) {
      return createBookkitContext({ config: mazeConfig, db: {} as D1Database, repo: fakeRepository(seed), clock, providers: providers() });
    }

    it('omits meetingPoint for a declared usesMeetingPoint: false option (custom_pickup)', async () => {
      const seeded = booking({
        id: 'b-status-pickup-false', status: 'confirmed', stripeSessionId: 'cs_status_pickup_false',
        calendarSynced: true, emailSynced: true, createdAt: '2026-06-14T07:00:00.000Z',
        pickupType: 'custom_pickup', pickupAddress: 'Hotel Mundial, Lisbon',
        meetingPointId: 'square', meetingPointLabel: 'The Square',
      });
      const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_pickup_false'), mazeContext([seeded]));
      const payload = await response.json() as { booking: Record<string, unknown> };
      expect(payload.booking).not.toHaveProperty('meetingPoint');
      expect(payload.booking).not.toHaveProperty('pickupAddress');
      expect(Object.keys(payload.booking).sort()).toEqual(['end', 'locale', 'people', 'priceCents', 'reference', 'start', 'tourSlug']);
    });

    it('includes the chosen point for a declared usesMeetingPoint: true option (custom_dropoff)', async () => {
      const seeded = booking({
        id: 'b-status-pickup-true', status: 'confirmed', stripeSessionId: 'cs_status_pickup_true',
        calendarSynced: true, emailSynced: true, createdAt: '2026-06-14T07:00:00.000Z',
        pickupType: 'custom_dropoff', pickupAddress: 'Hotel Mundial, Lisbon',
        meetingPointId: 'station', meetingPointLabel: 'The Station',
      });
      const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_pickup_true'), mazeContext([seeded]));
      const payload = await response.json() as { booking: { meetingPoint: unknown } };
      expect(payload.booking.meetingPoint).toEqual({ label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' });
    });

    it('includes the meeting point for a stored id no longer declared (pre-018 fallback)', async () => {
      const seeded = booking({
        id: 'b-status-pickup-undeclared', status: 'confirmed', stripeSessionId: 'cs_status_pickup_undeclared',
        calendarSynced: true, emailSynced: true, createdAt: '2026-06-14T07:00:00.000Z',
        pickupType: 'no_longer_declared', pickupAddress: null,
        meetingPointId: 'square', meetingPointLabel: 'The Square',
      });
      const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_pickup_undeclared'), mazeContext([seeded]));
      const payload = await response.json() as { booking: { meetingPoint: unknown } };
      expect(payload.booking.meetingPoint).toEqual({ label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' });
    });
  });

  it('returns 200 with the current state (not 503) when a concurrent confirmation lease is held, without running duplicate side effects', async () => {
    const seeded = booking({
      id: 'b-status-leased',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_status_leased',
      stripePaymentIntent: null,
      calendarSynced: false,
      emailSynced: false,
      tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    // Simulate another worker (e.g. the webhook) mid-confirmation, as handlers-lifecycle does.
    await repo.acquireConfirmationLease(seeded.id, 'other-worker', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z');
    let calendarCreates = 0;
    let emails = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_unused', type: 'checkout.session.completed' }),
          getSession: async () => ({ id: 'cs_status_leased', status: 'complete', paymentStatus: 'paid', amountTotal: seeded.priceCents, currency: config.business.currency, paymentIntent: 'pi_status' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCreates += 1; return 'cal_status'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
        email: { send: async () => { emails += 1; } },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_leased'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    const payload = await response.json() as { status: string };
    expect(payload.status).toBe('pending');
    expect(calendarCreates).toBe(0);
    expect(emails).toBe(0);
    expect(repo.rows.get(seeded.id)?.status).toBe('hold');
  });

  it('runs side effects exactly once when the webhook and /status confirm the same paid session concurrently', async () => {
    const seeded = booking({
      id: 'b-status-race',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_status_race',
      stripePaymentIntent: null,
      calendarSynced: false,
      emailSynced: false,
      tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    // Gate the session lookup so both handlers have read the hold row before either
    // reaches the confirmation lease — the interleaving pattern from handlers-checkout-race.
    let readers = 0;
    let releaseReaders = (): void => undefined;
    const bothRead = new Promise<void>((resolve) => { releaseReaders = resolve; });
    const realGetBookingBySessionId = repo.getBookingBySessionId;
    repo.getBookingBySessionId = async (sessionId) => {
      const result = await realGetBookingBySessionId(sessionId);
      readers += 1;
      if (readers >= 2) releaseReaders();
      await bothRead;
      return result;
    };
    let calendarCreates = 0;
    let emails = 0;
    const sharedProviders = providers({
      payments: {
        createCheckout: async () => ({ url: '', sessionId: '' }),
        parseWebhook: async () => ({ id: 'evt_race', type: 'checkout.session.completed', sessionId: 'cs_status_race', paymentIntent: 'pi_race', paid: true, amountCaptured: seeded.priceCents, currency: config.business.currency }),
        getSession: async () => ({ id: 'cs_status_race', status: 'complete', paymentStatus: 'paid', amountTotal: seeded.priceCents, currency: config.business.currency, paymentIntent: 'pi_race' }),
        refund: async () => ({ refundId: 're_test', amountCents: 0 }),
      },
      calendar: {
        listEvents: async () => [],
        createEvent: async () => { calendarCreates += 1; return 'cal_race'; },
        patchEvent: async () => undefined,
        deleteEvent: async () => undefined,
      },
      email: { send: async () => { emails += 1; } },
    });
    // Separate contexts simulate the two requests landing on different isolates:
    // each has its own in-process confirmationLocks map, so only the shared
    // repository's confirmation lease can serialize the confirm paths.
    const webhookContext = createBookkitContext({ config, db: {} as D1Database, repo, clock: () => new Date('2026-06-14T08:00:00.000Z'), providers: sharedProviders });
    const statusContext = createBookkitContext({ config, db: {} as D1Database, repo, clock: () => new Date('2026-06-14T08:00:00.000Z'), providers: sharedProviders });

    const [webhookResponse, statusResponse] = await Promise.all([
      handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST', body: 'raw' }), webhookContext),
      handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_race'), statusContext),
    ]);

    // Contract: the webhook confirms (200) or defers to Stripe redelivery (503);
    // /status never errors — it reports confirmed, or pending while the other side holds the lease.
    expect([200, 503]).toContain(webhookResponse.status);
    expect(statusResponse.status).toBe(200);
    expectSensitiveHeaders(statusResponse);
    const statusPayload = await statusResponse.json() as { status: string };
    expect(['confirmed', 'pending']).toContain(statusPayload.status);
    expect(calendarCreates).toBe(1);
    expect(emails).toBe(1);
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'confirmed', calendarSynced: true, emailSynced: true });
  });

  it('expires the hold when the Stripe session itself expired', async () => {
    const seeded = booking({
      id: 'b-status-expiring',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_status_expiring',
    });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_unused', type: 'checkout.session.completed' }),
          getSession: async () => ({ status: 'expired' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_expiring'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    await expect(response.json()).resolves.toEqual({ status: 'expired' });
    expect(repo.rows.get(seeded.id)?.status).toBe('expired');
  });

  it('reports pending when a completed expired session fails payment verification', async () => {
    const seeded = booking({
      id: 'b-status-expired-mismatch',
      status: 'expired',
      stripeSessionId: 'cs_status_expired_mismatch',
      priceCents: 10000,
    });
    const repo = fakeRepository([seeded]);
    const warnings: Array<{ message: string; data: Record<string, unknown> | undefined }> = [];
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      logger: { warn: (message, data) => { warnings.push({ message, data }); } },
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_unused', type: 'checkout.session.completed' }),
          getSession: async () => ({
            id: 'cs_status_expired_mismatch',
            status: 'complete',
            paymentStatus: 'paid',
            amountTotal: 9999,
            currency: config.business.currency,
          }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_expired_mismatch'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    await expect(response.json()).resolves.toEqual({ status: 'pending' });
    expect(warnings).toEqual([{
      message: 'Stripe payment verification rejected',
      data: { bookingId: seeded.id, reason: 'amount_mismatch' },
    }]);
    expect(repo.rows.get(seeded.id)?.status).toBe('expired');
  });

  it('reports not_found for an unknown session_id', async () => {
    const repo = fakeRepository();
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_unknown'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    await expect(response.json()).resolves.toEqual({ status: 'not_found' });
  });

  it('reports pending for a still-open session, without touching Stripe-side effects', async () => {
    const seeded = booking({
      id: 'b-status-open',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_status_open',
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
          parseWebhook: async () => ({ id: 'evt_unused', type: 'checkout.session.completed' }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCreates += 1; return 'cal'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_open'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    await expect(response.json()).resolves.toEqual({ status: 'pending' });
    expect(calendarCreates).toBe(0);
    expect(repo.rows.get(seeded.id)?.status).toBe('hold');
  });

  it('withholds confirmed details after the status detail grace window', async () => {
    const seeded = booking({
      id: 'b-status-confirmed-aged',
      stripeSessionId: 'cs_status_confirmed_aged',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-06-14T08:00:00.000Z',
      calendarSynced: true,
      emailSynced: true,
    });
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seeded]),
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_confirmed_aged'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual({ status: 'confirmed' });
    expect(payload).not.toHaveProperty('booking');
  });

  it('does not renew confirmed details when fulfillment updates the booking', async () => {
    const now = '2026-06-14T08:00:00.000Z';
    const seeded = booking({
      id: 'b-status-confirmed-renewal',
      stripeSessionId: 'cs_status_confirmed_renewal',
      createdAt: '2026-06-14T03:00:00.000Z',
      updatedAt: '2026-06-14T07:59:00.000Z',
      calendarSynced: false,
      emailSynced: true,
    });
    const repo = fakeRepository([seeded]);
    repo.sideEffectOperations.set(`${seeded.id}:calendar_create`, {
      bookingId: seeded.id, kind: 'calendar_create', status: 'failed', providerResultId: null,
      attemptCount: 1, attemptedAt: seeded.updatedAt, resolvedAt: seeded.updatedAt, error: 'Calendar unavailable',
      createdAt: seeded.updatedAt, updatedAt: seeded.updatedAt, failureStartedAt: null, nextAttemptAt: null,
    });
    repo.sideEffectOperations.set(`${seeded.id}:email_confirmation`, {
      bookingId: seeded.id, kind: 'email_confirmation', status: 'succeeded', providerResultId: null,
      attemptCount: 1, attemptedAt: seeded.updatedAt, resolvedAt: seeded.updatedAt, error: null,
      createdAt: seeded.updatedAt, updatedAt: seeded.updatedAt, failureStartedAt: null, nextAttemptAt: null,
    });
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date(now),
      providers: providers(),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_confirmed_renewal'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    await expect(response.json()).resolves.toEqual({ status: 'confirmed' });
    expect(repo.rows.get(seeded.id)).toMatchObject({ createdAt: seeded.createdAt, updatedAt: now, calendarSynced: true });
  });

  it('does not treat reschedule mutation rows as confirmation fulfillment debt', async () => {
    const seeded = booking({
      id: 'b-status-mutation-isolation', status: 'confirmed', stripeSessionId: 'cs_status_mutation_isolation',
      calendarSynced: true, emailSynced: true,
    });
    const repo = fakeRepository([seeded]);
    await repo.recordMutationSideEffectOperations(seeded.id, [
      'email:booking.rescheduled:customer:1', 'tourflow:booking.rescheduled:1',
    ], '2026-06-14T07:00:00.000Z');
    const email = repo.sideEffectOperations.get(`${seeded.id}:email:booking.rescheduled:customer:1`);
    const tourflow = repo.sideEffectOperations.get(`${seeded.id}:tourflow:booking.rescheduled:1`);
    if (!email || !tourflow) throw new Error('mutation rows were not seeded');
    repo.sideEffectOperations.set(`${seeded.id}:email:booking.rescheduled:customer:1`, { ...email, status: 'failed', error: 'retry later' });
    repo.sideEffectOperations.set(`${seeded.id}:tourflow:booking.rescheduled:1`, {
      ...tourflow, status: 'in_flight', attemptedAt: '2026-06-14T07:59:00.000Z', attemptCount: 1,
    });
    const sentEvents: string[] = [];
    const configuredProviders = providers({ email: {
      send: async (event) => { sentEvents.push(event); },
      sendToRecipient: async (_recipient, event) => {
        sentEvents.push(event);
        throw new Error('reschedule retry remains owed');
      },
    } });
    delete configuredProviders.ops;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: configuredProviders,
      logger: { warn: () => undefined },
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_mutation_isolation'), context);
    expect(response.status).toBe(200);
    expect(sentEvents).toEqual(['booking.rescheduled']);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.rescheduled:customer:1`)).toMatchObject({ status: 'failed' });
    expect(repo.sideEffectOperations.get(`${seeded.id}:tourflow:booking.rescheduled:1`)).toMatchObject({ status: 'in_flight' });
  });

  it('returns sensitive headers for a missing session_id error', async () => {
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository(),
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status'), context);
    expect(response.status).toBe(400);
    expectSensitiveHeaders(response);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('reports cancelled for cancelled and no-show bookings so terminal states do not poll forever', async () => {
    const seeded = booking({
      id: 'b-status-cancelled',
      status: 'cancelled',
      stripeSessionId: 'cs_status_cancelled',
      cancelledAt: '2026-06-13T08:00:00.000Z',
      cancelledBy: 'customer',
    });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({ id: 'evt_unused', type: 'checkout.session.completed' }),
          getSession: async () => { throw new Error('getSession should not be called for a cancelled booking'); },
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_cancelled'), context);
    expect(response.status).toBe(200);
    expectSensitiveHeaders(response);
    await expect(response.json()).resolves.toEqual({ status: 'cancelled' });

    const noShowRepo = fakeRepository([booking({ id: 'b-status-no-show', status: 'no_show', stripeSessionId: 'cs_status_no_show' })]);
    const noShowContext = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: noShowRepo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });
    const noShowResponse = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_no_show'), noShowContext);
    expectSensitiveHeaders(noShowResponse);
    await expect(noShowResponse.json()).resolves.toEqual({ status: 'cancelled' });
  });
});
