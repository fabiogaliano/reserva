import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleStripeWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

// Spec §11's most specific required case: webhook non-2xx on calendar OR email failure
// must cause a Stripe redelivery that re-runs only the still-unsynced sink. The gating
// lives in src/confirmation.ts:54-71 via the calendarSynced/emailSynced flags.
describe('webhook partial-failure redelivery re-runs only the unsynced sink', () => {
  it('calendar fails first: email is never attempted before the calendar throw, and redelivery re-syncs only calendar+email once each', async () => {
    const seeded = booking({
      id: 'b-redelivery-calendar',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_redelivery_calendar',
      stripePaymentIntent: null,
      calendarSynced: false,
      emailSynced: false,
      tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    let calendarCalls = 0;
    let emailCalls = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({
            id: 'evt_redelivery_calendar',
            type: 'checkout.session.completed',
            bookingId: seeded.id,
            sessionId: 'cs_redelivery_calendar',
            paymentIntent: 'pi_redelivery_calendar',
            paid: true,
            amountCaptured: seeded.priceCents,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => {
            calendarCalls += 1;
            if (calendarCalls === 1) throw new Error('calendar unavailable');
            return 'cal_redelivery';
          },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
        email: { send: async () => { emailCalls += 1; } },
      }),
    });

    const first = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(calendarCalls).toBe(1);
    // Calendar dispatch runs before email in confirmBookingFromPaymentUnlocked — a throw
    // there must prevent email from being attempted at all on this delivery.
    expect(emailCalls).toBe(0);
    const afterFirst = repo.rows.get(seeded.id);
    expect(afterFirst?.status).toBe('confirmed');
    expect(afterFirst?.calendarSynced).toBe(false);
    expect(afterFirst?.emailSynced).toBe(false);

    const second = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(second.status).toBe(200);
    expect(calendarCalls).toBe(2);
    expect(emailCalls).toBe(1);
    const afterSecond = repo.rows.get(seeded.id);
    expect(afterSecond).toMatchObject({ status: 'confirmed', calendarSynced: true, emailSynced: true });
  });

  it('email fails first (calendar already succeeded): redelivery does not re-run calendar, retries only email, and a failing ops sink never causes a non-2xx', async () => {
    const seeded = booking({
      id: 'b-redelivery-email',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: 'cs_redelivery_email',
      stripePaymentIntent: null,
      calendarSynced: false,
      emailSynced: false,
      tourflowSynced: false,
    });
    const repo = fakeRepository([seeded]);
    let calendarCalls = 0;
    let emailCalls = 0;
    let opsPushed = 0;
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    // dispatchNonCritical (the ops/analytics sink) runs fire-and-forget via waitUntil rather
    // than being awaited by the handler; collect it so the test can wait for it to settle.
    const pending: Promise<unknown>[] = [];
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      logger: { warn: (message, data) => { warnings.push([message, data]); } },
      waitUntil: (task) => pending.push(task),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({
            id: 'evt_redelivery_email',
            type: 'checkout.session.completed',
            bookingId: seeded.id,
            sessionId: 'cs_redelivery_email',
            paymentIntent: 'pi_redelivery_email',
            paid: true,
            amountCaptured: seeded.priceCents,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCalls += 1; return 'cal_redelivery_email'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
        email: {
          send: async () => {
            emailCalls += 1;
            if (emailCalls === 1) throw new Error('email provider down');
          },
        },
        ops: {
          push: async () => {
            opsPushed += 1;
            throw new Error('ops sink unavailable');
          },
        },
      }),
    });

    const first = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(calendarCalls).toBe(1);
    expect(emailCalls).toBe(1);
    const afterFirst = repo.rows.get(seeded.id);
    expect(afterFirst?.status).toBe('confirmed');
    expect(afterFirst?.calendarSynced).toBe(true);
    expect(afterFirst?.emailSynced).toBe(false);
    expect(afterFirst?.calendarEventId).toBe('cal_redelivery_email');

    const second = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);
    expect(second.status).toBe(200);
    // Calendar is gated by calendarSynced — it must not be re-run once it has succeeded.
    expect(calendarCalls).toBe(1);
    expect(emailCalls).toBe(2);
    const afterSecond = repo.rows.get(seeded.id);
    expect(afterSecond).toMatchObject({ status: 'confirmed', calendarSynced: true, emailSynced: true });

    // The ops (tourflow) sink is fire-and-forget: even though it always throws here, the
    // webhook response must still be 200, and the failure is only logged.
    await Promise.all(pending);
    expect(opsPushed).toBeGreaterThan(0);
    expect(warnings.some(([message]) => message === 'bookkit ops sink failed')).toBe(true);
  });
});
