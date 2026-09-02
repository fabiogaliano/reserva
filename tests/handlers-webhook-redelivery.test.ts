import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { handleCustomerCancel, handlePaymentWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import type { SideEffectOperationIdentity } from '../src/repo';
import { fakeRepository, providers, sideEffectOperation } from './fakes';

// Spec §11's most specific required case: webhook non-2xx on calendar OR email failure
// must cause a payment-provider redelivery that re-runs only the sink that hasn't succeeded yet.
// The gating lives in the per-sink side_effect_operations rows (src/confirmation.ts).
describe('webhook partial-failure redelivery re-runs only the unsynced sink', () => {
  it('calendar fails first: healthy email still sends, and redelivery retries only calendar', async () => {
    const seeded = booking({
      id: 'b-redelivery-calendar',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_redelivery_calendar',
      paymentRef: null,
    });
    const repo = fakeRepository([seeded]);
    let calendarCalls = 0;
    let emailCalls = 0;
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_redelivery_calendar',
            type: 'checkout_completed',
            bookingId: seeded.id,
            sessionRef: 'cs_redelivery_calendar',
            paymentRef: 'pi_redelivery_calendar',
            paid: true,
            amountCaptured: seeded.priceMinor,
            currency: config.business.currency,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
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

    const first = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(calendarCalls).toBe(1);
    // Provider failures are isolated per durable row; the webhook still returns non-2xx after
    // every confirmation operation has had its own attempt.
    expect(emailCalls).toBe(1);
    const afterFirst = repo.rows.get(seeded.id);
    expect(afterFirst?.status).toBe('confirmed');
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })).toMatchObject({ status: 'failed' });
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'succeeded' });

    const second = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(second.status).toBe(200);
    expect(calendarCalls).toBe(2);
    expect(emailCalls).toBe(1);
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'confirmed' });
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })).toMatchObject({ status: 'succeeded' });
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'succeeded' });
  });

  it('surfaces a duplicate payment intent from the fake repository as a 409', async () => {
    const first = booking({
      id: 'b-webhook-duplicate-payment-first',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_webhook_duplicate_payment_first',
      paymentRef: null,
    });
    const second = booking({
      id: 'b-webhook-duplicate-payment-second',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_webhook_duplicate_payment_second',
      paymentRef: null,
    });
    const repo = fakeRepository([first, second]);
    let eventIndex = 0;
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ payments: {
        createCheckout: async () => ({ url: '', sessionRef: '' }),
        parseWebhook: async () => {
          const booking = eventIndex++ === 0 ? first : second;
          return {
            id: `evt_webhook_duplicate_payment_${booking.id}`,
            type: 'checkout_completed' as const,
            bookingId: booking.id,
            sessionRef: booking.paymentSessionRef ?? '',
            paymentRef: 'pi_webhook_duplicate_payment',
            paid: true,
            amountCaptured: booking.priceMinor,
            currency: config.business.currency,
          };
        },
        getSession: async () => ({ status: 'open' }),
        refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
      } }),
    });

    const firstResponse = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(firstResponse.status).toBe(200);

    const secondResponse = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toMatchObject({ error: { code: 'duplicate_payment_ref' } });
    expect(repo.rows.get(second.id)).toMatchObject({ status: 'hold', paymentRef: null });
  });

  it('drains a pending cancellation effect when Stripe redelivers a completed session for a terminal booking', async () => {
    const sessionRef = 'cs_redelivery_terminal_mutation';
    const paymentRef = 'pi_redelivery_terminal_mutation';
    const seeded = booking({
      id: 'b-redelivery-terminal-mutation',
      status: 'cancelled',
      cancelledAt: '2026-06-14T07:00:00.000Z',
      cancelledBy: 'operator',
      paymentSessionRef: sessionRef,
      paymentRef: paymentRef,
    });
    const repo = fakeRepository([seeded]);
    const identity: SideEffectOperationIdentity = { family: 'email', event: 'booking.cancelled_by_operator' };
    await repo.recordMutationSideEffectOperations(seeded.id, [{ ...identity, eventPayloadJson: null, eventIdPrefix: null }], '2026-06-14T07:00:00.000Z');
    let emails = 0;
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_redelivery_terminal_mutation',
            type: 'checkout_completed',
            bookingId: seeded.id,
            sessionRef,
            paymentRef,
            paid: true,
            amountCaptured: seeded.priceMinor,
            currency: config.business.currency,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
        email: { send: async () => { emails += 1; } },
      }),
    });

    const response = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);

    expect(response.status).toBe(200);
    expect(emails).toBe(1);
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  });

  // Mirrors the checkout-side redelivery tests above, but for charge.refunded: cancelling a booking
  // that still carries a calendarEventId records a calendar_delete row, owed/retryable like
  // calendar_create is.
  it('a charge.refunded full-refund webhook creates a calendar_delete debt when the delete fails, and Stripe redelivery drains it', async () => {
    const paymentRef = 'pi_redelivery_refund_calendar';
    const seeded = booking({
      id: 'b-redelivery-refund-calendar',
      paymentRef: paymentRef,
      calendarEventId: 'cal-redelivery-refund',
    });
    const repo = fakeRepository([seeded]);
    let deleteAttempts = 0;
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_redelivery_refund_calendar',
            type: 'refunded',
            paymentRef,
            amountCaptured: seeded.priceMinor,
            amountRefunded: seeded.priceMinor,
            refundRef: 're_redelivery_refund_calendar',
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
        },
        calendar: {
          listEvents: async () => [],
          createEvent: async () => 'unused',
          patchEvent: async () => undefined,
          deleteEvent: async () => {
            deleteAttempts += 1;
            if (deleteAttempts === 1) throw new Error('calendar unavailable');
          },
        },
      }),
    });

    const first = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(first.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'succeeded', stripeRefundId: 're_redelivery_refund_calendar' });
    expect(deleteAttempts).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_delete`)).toMatchObject({ status: 'failed' });

    // Stripe redelivers the same event — a booking-touching request for an already-cancelled
    // booking — which drains the owed calendar_delete row; this attempt succeeds.
    const second = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(second.status).toBe(200);
    expect(deleteAttempts).toBe(2);
    expect(repo.rows.get(seeded.id)?.calendarEventId).toBeNull();
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_delete`)).toMatchObject({ status: 'succeeded' });
  });

  it('email fails first (calendar already succeeded): redelivery does not re-run calendar, retries only email, and a failing ops sink never causes a non-2xx', async () => {
    const seeded = booking({
      id: 'b-redelivery-email',
      status: 'hold',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_redelivery_email',
      paymentRef: null,
    });
    const repo = fakeRepository([seeded]);
    let calendarCalls = 0;
    let emailCalls = 0;
    let hookCalls = 0;
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    // A non-durable booking-event hook runs fire-and-forget via waitUntil rather than being
    // awaited by the handler; collect it so the test can wait for it to settle.
    const pending: Promise<unknown>[] = [];
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      logger: { warn: (message, data) => { warnings.push([message, data]); } },
      waitUntil: (task) => pending.push(task),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_redelivery_email',
            type: 'checkout_completed',
            bookingId: seeded.id,
            sessionRef: 'cs_redelivery_email',
            paymentRef: 'pi_redelivery_email',
            paid: true,
            amountCaptured: seeded.priceMinor,
            currency: config.business.currency,
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
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
      }),
      hooks: [{
        name: 'ops',
        handler: async () => {
          hookCalls += 1;
          throw new Error('subscriber unavailable');
        },
      }],
    });

    const first = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(calendarCalls).toBe(1);
    expect(emailCalls).toBe(1);
    const afterFirst = repo.rows.get(seeded.id);
    expect(afterFirst?.status).toBe('confirmed');
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })).toMatchObject({ status: 'succeeded' });
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'failed' });
    expect(afterFirst?.calendarEventId).toBe('cal_redelivery_email');

    const second = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(second.status).toBe(200);
    // Calendar is gated by its own outbox row — it must not be re-run once that row succeeded.
    expect(calendarCalls).toBe(1);
    expect(emailCalls).toBe(2);
    expect(repo.rows.get(seeded.id)).toMatchObject({ status: 'confirmed' });
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })).toMatchObject({ status: 'succeeded' });
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'succeeded' });

    // A non-durable hook is fire-and-forget: even though it always throws here, the webhook
    // response must still be 200, and the failure is only logged.
    await Promise.all(pending);
    expect(hookCalls).toBeGreaterThan(0);
    expect(warnings.some(([message]) => message === 'reserva booking event hook failed')).toBe(true);
  });

  // The already-cancelled branch of the charge.refunded handler never runs a second transition on
  // the booking row — a standalone redelivery must leave the row byte-identical, converging only
  // the refund operation and minting no new side-effect debt.
  it('two redeliveries of the same charge.refunded webhook against an already-cancelled booking never touch the booking row again', async () => {
    const paymentRef = 'pi_redelivery_already_cancelled';
    const seeded = booking({ id: 'b-redelivery-already-cancelled', paymentRef: paymentRef });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => ({
            id: 'evt_redelivery_already_cancelled', type: 'refunded', paymentRef,
            amountCaptured: seeded.priceMinor, amountRefunded: seeded.priceMinor, refundRef: 're_redelivery_already_cancelled',
          }),
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundRef: 're_should_not_run', amountMinor: seeded.priceMinor }),
        },
      }),
    });

    const cancelResponse = await handleCustomerCancel(new Request('https://example.test/api/booking/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: seeded.cancelToken }),
    }), context);
    expect(cancelResponse.status).toBe(200);
    // Snapshot right before the webhook ever arrives — structuredClone (not a reference) so later
    // in-place repo mutations can never make this "pre-webhook" baseline drift along with the row.
    const beforeWebhook = structuredClone(repo.rows.get(seeded.id));
    const sideEffectKeysBefore = [...repo.sideEffectOperations.keys()].sort();

    const first = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(first.status).toBe(200);
    const second = await handlePaymentWebhook(new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' }), context);
    expect(second.status).toBe(200);

    // status, cancelledBy, cancelledAt, updatedAt (and every other field) must deep-equal the
    // ordinary cancellation's row exactly — no second transition, no re-stamped updatedAt.
    expect(repo.rows.get(seeded.id)).toEqual(beforeWebhook);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({
      choice: 'full', status: 'succeeded', stripeRefundId: 're_redelivery_already_cancelled', amountCents: seeded.priceMinor,
    });
    // Neither redelivery mints side-effect debt beyond what the original cancellation created.
    expect([...repo.sideEffectOperations.keys()].sort()).toEqual(sideEffectKeysBefore);
  });
});
