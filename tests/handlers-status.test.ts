import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleStatus } from '../src/handlers';
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
          getSession: async () => ({ status: 'complete', paymentStatus: 'paid', paymentIntent: 'pi_status' }),
          refund: async () => undefined,
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
          getSession: async () => ({ status: 'complete', paymentStatus: 'paid', paymentIntent: 'pi_status' }),
          refund: async () => undefined,
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
          refund: async () => undefined,
        },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_expiring'), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'expired' });
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

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_open'), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'pending' });
    expect(calendarCreates).toBe(0);
    expect(repo.rows.get(seeded.id)?.status).toBe('hold');
  });

  it('reports pending for a cancelled booking (spec enum has no cancelled state)', async () => {
    // handleStatus only re-checks Stripe for 'hold'/'expired' bookings; a cancelled booking
    // falls straight through to the tri-state response, which has no 'cancelled' case — this
    // is the spec's own enum gap (see work package 04), pinned here rather than "fixed".
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
          refund: async () => undefined,
        },
      }),
    });

    const response = await handleStatus(new Request('https://example.test/api/booking/status?session_id=cs_status_cancelled'), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'pending' });
  });
});
