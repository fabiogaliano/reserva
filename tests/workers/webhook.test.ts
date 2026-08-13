import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import Stripe from 'stripe';
import { beforeEach, describe, expect, it } from 'vitest';
import config from '../../examples/client-config';
import type { Booking } from '../../src/core/booking';
import { createBookingRepository, type SideEffectOperationRecord } from '../../src/repo';
import worker, { WEBHOOK_SECRET, calendarEvents, emailOutbox, opsOutbox, resetWebhookWorkerOutboxes } from './worker';

// Plan 015 (audit finding #16): the money path -- a signed checkout.session.completed reaching
// the webhook route and confirming a booking with durable side effects -- was never proven
// assembled. Every request below goes through the real worker (./worker.ts): real
// defineCloudflareBookkitRuntime, a real StripeProvider doing real HMAC signature verification
// (no mocked constructEventAsync anywhere in this file), the real handleStripeWebhook, and real D1.

const db = (env as unknown as { BOOKKIT_DB: D1Database }).BOOKKIT_DB;
const repo = createBookingRepository(db);

// A throwaway client used only to mint Stripe's own test signature headers -- never used to talk
// to Stripe's API, so any syntactically-shaped secret key works.
const signingClient = new Stripe('sk_test_signing_helper');

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  resetWebhookWorkerOutboxes();
});

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

async function seedHeldBooking(id: string): Promise<Booking> {
  const now = new Date().toISOString();
  return repo.insertHold({
    id,
    reference: `WHT-2026-${id}`,
    tourSlug: 'oldTown',
    people: 2,
    pickupType: 'default',
    startsAt: futureIso(30 * 24 * 60 * 60_000),
    endsAt: futureIso(30 * 24 * 60 * 60_000 + 60 * 60_000),
    locale: 'en',
    priceCents: 2500,
    holdExpiresAt: futureIso(60 * 60_000),
    cancelToken: `${id}-cancel-token`,
    operatorToken: `${id}-operator-token`,
    createdAt: now,
    updatedAt: now,
  });
}

interface CheckoutCompletedFixture {
  eventId: string;
  sessionId: string;
  paymentIntent: string;
  bookingId: string;
  amountTotal?: number;
}

function checkoutSessionCompletedPayload(fixture: CheckoutCompletedFixture): string {
  return JSON.stringify({
    id: fixture.eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: fixture.sessionId,
        payment_status: 'paid',
        amount_total: fixture.amountTotal ?? 2500,
        currency: config.business.currency,
        payment_intent: fixture.paymentIntent,
        metadata: { bookingId: fixture.bookingId },
        customer_details: { name: 'Ada Lovelace', email: 'ada@example.test', phone: '+351910000000' },
      },
    },
  });
}

async function signPayload(payload: string, secret: string = WEBHOOK_SECRET): Promise<string> {
  return signingClient.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
}

function webhookRequest(payload: string, signature: string | null): Request {
  const headers = new Headers();
  if (signature !== null) headers.set('stripe-signature', signature);
  return new Request('http://localhost/api/booking/webhooks/stripe', { method: 'POST', headers, body: payload });
}

// The documented integration-test pattern for a modules-format worker's ctx.waitUntil() side
// effects (see tests/workers/worker.ts's fetch signature comment): createExecutionContext() plus
// waitOnExecutionContext() deterministically settles Plan 011's detached-first-attempt Tourflow
// delivery before assertions run, rather than relying on incidental promise-scheduling timing.
async function dispatch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function operation(operations: SideEffectOperationRecord[], kind: string): SideEffectOperationRecord | undefined {
  return operations.find((candidate) => candidate.kind === kind);
}

describe('signed Stripe webhook through the assembled worker + real D1', () => {
  it('confirms a held booking on a validly-signed checkout.session.completed and settles every durable side effect', async () => {
    const id = 'wh-valid-confirm';
    await seedHeldBooking(id);
    const fixture: CheckoutCompletedFixture = {
      eventId: 'evt_valid_confirm', sessionId: 'cs_valid_confirm', paymentIntent: 'pi_valid_confirm', bookingId: id,
    };
    const payload = checkoutSessionCompletedPayload(fixture);
    const response = await dispatch(webhookRequest(payload, await signPayload(payload)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });

    const confirmed = await repo.getBookingById(id);
    if (!confirmed) throw new Error('booking disappeared');
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      stripeSessionId: fixture.sessionId,
      stripePaymentIntent: fixture.paymentIntent,
      calendarSynced: true,
      emailSynced: true,
      tourflowSynced: true,
    });

    expect(calendarEvents.get(`cal_${id}`)).toBeDefined();
    expect(emailOutbox).toEqual([{ event: 'booking.confirmed', bookingId: id }]);
    expect(opsOutbox).toEqual([{ event: 'booking.confirmed', bookingId: id }]);

    const operations = await repo.listSideEffectOperations(id);
    expect(operation(operations, 'calendar_create')).toMatchObject({ status: 'succeeded', providerResultId: `cal_${id}` });
    expect(operation(operations, 'email_confirmation')).toMatchObject({ status: 'succeeded' });
    expect(operation(operations, 'tourflow:booking.confirmed')).toMatchObject({ status: 'succeeded' });
  });

  it('rejects a tampered body and an unsigned body alike, leaving the booking untouched (sanity check: verification is not bypassed)', async () => {
    const id = 'wh-invalid-signature';
    await seedHeldBooking(id);
    const fixture: CheckoutCompletedFixture = {
      eventId: 'evt_tampered', sessionId: 'cs_tampered', paymentIntent: 'pi_tampered', bookingId: id,
    };
    const payload = checkoutSessionCompletedPayload(fixture);
    const signature = await signPayload(payload);

    // The signature was computed over `payload`; sending a body that differs by even one byte
    // must fail constructEventAsync's HMAC check.
    const tamperedPayload = payload.replace('"paid"', '"unpaid"');
    const tamperedResponse = await dispatch(webhookRequest(tamperedPayload, signature));
    expect(tamperedResponse.status).toBe(400);

    // Sanity check (done criteria): an entirely unsigned request must fail too -- proving there is
    // no bypass path that skips verification when a caller simply omits the header.
    const unsignedResponse = await dispatch(webhookRequest(payload, null));
    expect(unsignedResponse.status).toBe(400);

    const untouched = await repo.getBookingById(id);
    expect(untouched).toMatchObject({ status: 'hold', stripeSessionId: null, stripePaymentIntent: null });
    expect(await repo.listSideEffectOperations(id)).toEqual([]);
    expect(calendarEvents.size).toBe(0);
    expect(emailOutbox).toEqual([]);
    expect(opsOutbox).toEqual([]);
  });

  it('redelivering the same confirmed event is idempotent: no duplicate transition and no duplicate side-effect rows', async () => {
    const id = 'wh-redelivery';
    await seedHeldBooking(id);
    const fixture: CheckoutCompletedFixture = {
      eventId: 'evt_redelivery', sessionId: 'cs_redelivery', paymentIntent: 'pi_redelivery', bookingId: id,
    };
    const payload = checkoutSessionCompletedPayload(fixture);
    const signature = await signPayload(payload);

    const first = await dispatch(webhookRequest(payload, signature));
    expect(first.status).toBe(200);
    const second = await dispatch(webhookRequest(payload, signature));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ received: true });

    const confirmed = await repo.getBookingById(id);
    expect(confirmed).toMatchObject({ status: 'confirmed', stripeSessionId: fixture.sessionId, stripePaymentIntent: fixture.paymentIntent });

    // Every provider call is attempted exactly once, not once per delivery.
    expect(calendarEvents.size).toBe(1);
    expect(emailOutbox).toEqual([{ event: 'booking.confirmed', bookingId: id }]);
    expect(opsOutbox).toEqual([{ event: 'booking.confirmed', bookingId: id }]);

    const operations = await repo.listSideEffectOperations(id);
    expect(operations).toHaveLength(3);
    for (const kind of ['calendar_create', 'email_confirmation', 'tourflow:booking.confirmed']) {
      expect(operation(operations, kind)).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    }
  });

  it('a stale checkout.session.completed for an already-cancelled booking leaves it cancelled (current documented behavior)', async () => {
    const id = 'wh-stale-cancelled';
    await seedHeldBooking(id);
    const now = new Date().toISOString();
    const cancelled = await repo.transitionToCancelled(id, {
      expectedStatusIn: ['hold'], cancelledAt: now, cancelledBy: 'customer', updatedAt: now, mutationSideEffectKinds: [],
    });
    expect(cancelled).toMatchObject({ status: 'cancelled' });

    const fixture: CheckoutCompletedFixture = {
      eventId: 'evt_stale_cancelled', sessionId: 'cs_stale_cancelled', paymentIntent: 'pi_stale_cancelled', bookingId: id,
    };
    const payload = checkoutSessionCompletedPayload(fixture);
    const response = await dispatch(webhookRequest(payload, await signPayload(payload)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });

    // src/handlers/index.ts handleStripeWebhook: confirmBookingFromPayment is a no-op for a
    // booking that isn't hold/expired (it returns the booking unchanged, never re-confirming a
    // cancelled booking), but the unconditional session-id backfill below it still runs -- Stripe's
    // session id is recorded either way, without moving the booking off 'cancelled'.
    const stillCancelled = await repo.getBookingById(id);
    expect(stillCancelled).toMatchObject({ status: 'cancelled', stripeSessionId: fixture.sessionId });
    expect(await repo.listSideEffectOperations(id)).toEqual([]);
    expect(calendarEvents.size).toBe(0);
    expect(emailOutbox).toEqual([]);
    expect(opsOutbox).toEqual([]);
  });
});
