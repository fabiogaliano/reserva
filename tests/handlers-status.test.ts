import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleStatus, handleStripeWebhook } from '../src/handlers';
import { utcToLocalIso } from '../src/core/time';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

describe('GET /status self-heals a paid hold (spec §6/§11)', () => {
  it('confirms a paid hold, runs calendar+email once, and reports the local-offset start time', async () => {
    const seeded = booking({
      id: 'b-status-paid',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_status_paid',
      stripePaymentIntent: null,
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
    const payload = await response.json() as { status: string; booking: Record<string, unknown> };
    expect(payload.status).toBe('confirmed');
    expect(payload.booking).toMatchObject({
      reference: seeded.reference,
      tourSlug: seeded.tourSlug,
      people: seeded.people,
      meetingPoint: config.tours.vintage!.meetingPoint,
    });
    expect(payload.booking.start).toBe(utcToLocalIso(seeded.startsAt, config.business.timezone));
    expect(payload.booking.start).not.toBe(seeded.startsAt);
    expect(calendarCreates).toBe(1);
    expect(emails).toBe(1);
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
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
    await expect(response.json()).resolves.toEqual({ status: 'pending' });
    expect(calendarCreates).toBe(0);
    expect(repo.rows.get(seeded.id)?.status).toBe('hold');
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
    await expect(noShowResponse.json()).resolves.toEqual({ status: 'cancelled' });
  });
});
