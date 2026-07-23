import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleStripeWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

describe('late checkout.session.completed on an already-expired hold (spec §6)', () => {
  it('still confirms the booking — payment happened inside the session window, so redelivery after an outage must not orphan it', async () => {
    const seeded = booking({
      id: 'b-late-expired',
      status: 'expired',
      holdExpiresAt: null,
      stripeSessionId: 'cs_late',
      customerName: null,
      customerEmail: null,
      customerPhone: null,
      pickupAddress: null,
      calendarSynced: false,
      emailSynced: false,
      tourflowSynced: false,
    });
    const occupied = booking({
      id: 'b-late-occupied',
      status: 'confirmed',
      startsAt: seeded.startsAt,
      endsAt: seeded.endsAt,
      calendarSynced: true,
      emailSynced: true,
    });
    const repo = fakeRepository([seeded, occupied]);
    let calendarCreates = 0;
    let emails = 0;
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const context = createBookkitContext({
      config: { ...config, fleet: { defaultCapacity: 1 } },
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      logger: { warn: (message, data) => { warnings.push([message, data]); } },
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => ({
            id: 'evt_late',
            type: 'checkout.session.completed',
            sessionId: 'cs_late',
            paymentIntent: 'pi_late',
            paid: true,
            amountCaptured: seeded.priceCents,
            customerName: 'Grace Hopper',
            customerEmail: 'grace@example.test',
            customerPhone: '+351920000000',
            pickupAddress: 'Rossio',
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundId: 're_test', amountCents: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => { calendarCreates += 1; return 'cal_late'; },
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
        email: { send: async () => { emails += 1; } },
      }),
    });

    const response = await handleStripeWebhook(new Request('https://example.test/api/booking/webhooks/stripe', { method: 'POST' }), context);

    expect(response.status).toBe(200);
    expect(calendarCreates).toBe(1);
    expect(emails).toBe(1);
    expect(repo.rows.get(seeded.id)).toMatchObject({
      status: 'confirmed',
      customerName: 'Grace Hopper',
      customerEmail: 'grace@example.test',
      customerPhone: '+351920000000',
      pickupAddress: 'Rossio',
    });
    expect(repo.sideEffectOperations.get(`${seeded.id}:oversell`)).toMatchObject({
      status: 'succeeded',
      providerResultId: 'capacity_exceeded',
    });
    // WP-01 (Fix 2) added this warning so operators get a signal on the accepted oversell path.
    expect(warnings).toContainEqual([
      'confirming expired hold after payment; possible one-slot oversell',
      { bookingId: seeded.id, reference: seeded.reference, startsAt: seeded.startsAt },
    ]);
  });
});
