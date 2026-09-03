// Covers the events layer through its public entry points — Stripe webhook/status handlers,
// config validation, runtime factory — against the in-memory repo fake. Signature mechanics live
// in tests/webhooks.test.ts; this covers who receives an event and that durable delivery retries
// from an unchanging stored snapshot.
import type { D1Database } from '@cloudflare/workers-types';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it, vi } from 'vitest';
import { runOwedMutationSideEffects } from '../src/confirmation';
import { createReservaContext, type ReservaProviders } from '../src/context';
import type { BookingEventEnvelope, BookingEventHook } from '../src/core/events';
import { validateConfig, type ResolvedClientConfig } from '../src/core/config';
import { defineCloudflareReservaRuntime } from '../src/runtime-context';
import { handleCustomerReschedule, handleStatus, handlePaymentWebhook } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers, sideEffectOperation, type FakeRepository } from './fakes';

const WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const clock = () => new Date('2026-06-14T08:00:00.000Z');

function webhookConfig(events?: string[]): ResolvedClientConfig {
  return validateConfig({
    ...config,
    webhooks: [{
      name: 'partner',
      url: 'https://partner.test/hooks',
      secretBinding: 'PARTNER_WEBHOOK_SECRET',
      ...(events ? { events } : {}),
    }],
  });
}

function paidWebhookProviders(bookingId: string, sessionRef: string, overrides: Partial<ReservaProviders> = {}): ReservaProviders {
  return providers({
    payments: {
      createCheckout: async () => ({ url: '', sessionRef: '' }),
      parseWebhook: async () => ({
        id: 'evt_events_layer', type: 'checkout_completed', bookingId, sessionRef,
        paymentRef: 'pi_events_layer', paid: true, amountCaptured: 10000, currency: config.business.currency,
      }),
      getSession: async () => ({ status: 'open' }),
      refund: async () => ({ refundRef: 're_events_layer', amountMinor: 0 }),
    },
    ...overrides,
  });
}

// The spec library reads the wall clock for its 300-second tolerance, so verification is pinned to
// the attempt's own signing instant rather than whenever this suite happens to run.
function verifyAttempt(attempt: { body: string; headers: Record<string, string> }): unknown {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(Number(attempt.headers['webhook-timestamp']) * 1000));
    return new Webhook(WEBHOOK_SECRET).verify(attempt.body, {
      'webhook-id': attempt.headers['webhook-id'] ?? '',
      'webhook-timestamp': attempt.headers['webhook-timestamp'] ?? '',
      'webhook-signature': attempt.headers['webhook-signature'] ?? '',
    });
  } finally {
    vi.useRealTimers();
  }
}

function stripeWebhookRequest(): Request {
  return new Request('https://example.test/api/booking/webhooks/payment', { method: 'POST' });
}

function statusRequest(sessionRef: string): Request {
  return new Request(`https://example.test/api/booking/status?session_id=${sessionRef}`);
}

function rescheduleRequest(token: string, newStart: string): Request {
  return new Request('https://example.test/api/booking/reschedule', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, newStart }),
  });
}

// Collects every outbound webhook body so a retry's bytes can be compared with the original's.
function recordingFetch(outcome: () => Response | Promise<Response>) {
  const sent: Array<{ body: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
    const request = init as RequestInit;
    sent.push({ body: String(request.body), headers: request.headers as Record<string, string> });
    return outcome();
  });
  return { sent, fetchImpl };
}

async function confirmedBookingWithWebhook(repo: FakeRepository, seededId: string, sessionRef: string, fetchImpl: unknown, pending: Promise<unknown>[]) {
  const context = createReservaContext({
    config: webhookConfig(),
    db: {} as D1Database,
    repo,
    clock,
    secrets: async (name) => (name === 'PARTNER_WEBHOOK_SECRET' ? WEBHOOK_SECRET : undefined),
    waitUntil: (task) => pending.push(task),
    providers: paidWebhookProviders(seededId, sessionRef),
  });
  vi.stubGlobal('fetch', fetchImpl);
  try {
    const response = await handlePaymentWebhook(stripeWebhookRequest(), context);
    await Promise.all(pending.splice(0));
    return { context, response };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('non-durable booking event hooks', () => {
  it('delivers only the events a hook subscribes to', async () => {
    const seeded = booking({ id: 'hook-subscription', startsAt: '2026-06-15T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const received: string[] = [];
    const pending: Promise<unknown>[] = [];
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      waitUntil: (task) => pending.push(task),
      providers: providers(),
      hooks: [{ name: 'rescheduled-only', events: ['booking.rescheduled'], handler: async (event) => { received.push(event); } }],
    });

    await expect(handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T10:00:00.000Z'), context)).resolves.toMatchObject({ status: 200 });
    await Promise.all(pending.splice(0));
    expect(received).toEqual(['booking.rescheduled']);

    const held = booking({ id: 'hook-subscription-hold', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_hook_subscription' });
    repo.rows.set(held.id, held);
    await expect(handlePaymentWebhook(stripeWebhookRequest(), createReservaContext({
      config, db: {} as D1Database, repo, clock,
      waitUntil: (task) => pending.push(task),
      providers: paidWebhookProviders(held.id, 'cs_hook_subscription'),
      hooks: [{ name: 'rescheduled-only', events: ['booking.rescheduled'], handler: async (event) => { received.push(event); } }],
    }))).resolves.toMatchObject({ status: 200 });
    await Promise.all(pending.splice(0));
    // booking.confirmed happened, but this hook never subscribed to it.
    expect(received).toEqual(['booking.rescheduled']);
  });

  it('swallows a failing non-durable hook, logs it once, and keeps the request successful', async () => {
    const seeded = booking({ id: 'hook-error-swallowed', startsAt: '2026-06-15T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const pending: Promise<unknown>[] = [];
    let calls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      logger: { warn: (message, data) => { warnings.push([message, data]); } },
      waitUntil: (task) => pending.push(task),
      providers: providers(),
      hooks: [{ name: 'flaky', handler: async () => { calls += 1; throw new Error('listener exploded'); } }],
    });

    await expect(handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T10:00:00.000Z'), context)).resolves.toMatchObject({ status: 200 });
    await Promise.all(pending.splice(0));

    expect(calls).toBe(1);
    expect(warnings.filter(([message]) => message === 'reserva booking event hook failed')).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({ event: 'booking.rescheduled', hook: 'flaky', bookingId: seeded.id });
    // Never retried: a non-durable hook leaves no outbox row behind.
    expect([...repo.sideEffectOperations.values()].some((row) => row.family === 'hook')).toBe(false);
  });
});

describe('subscriber registration validation', () => {
  const runtimeOptions = { providers: providers() };

  it('rejects an unknown event name in hooks at startup, listing the whole valid vocabulary', () => {
    expect(() => defineCloudflareReservaRuntime(config, {
      ...runtimeOptions,
      hooks: [{ name: 'typo', events: ['booking.canceled'] as never, handler: async () => undefined }],
    })).toThrow(/Unknown booking event "booking\.canceled"\. Valid events: booking\.confirmed, booking\.cancelled_by_customer, booking\.cancelled_by_operator, booking\.rescheduled, booking\.no_show, payment\.dispute_created\./);
  });

  it('rejects an invalid or duplicated hook name at startup', () => {
    expect(() => defineCloudflareReservaRuntime(config, {
      ...runtimeOptions,
      hooks: [{ name: 'Not Valid', handler: async () => undefined }],
    })).toThrow(/Invalid name "Not Valid"/);
    expect(() => defineCloudflareReservaRuntime(config, {
      ...runtimeOptions,
      hooks: [
        { name: 'twice', handler: async () => undefined },
        { name: 'twice', handler: async () => undefined },
      ] satisfies BookingEventHook[],
    })).toThrow(/registered twice/);
  });

  it('rejects an unknown event name in config.webhooks with the same vocabulary', () => {
    expect(() => webhookConfig(['booking.cancelled'])).toThrow(/Unknown booking event .+booking\.cancelled.+Valid events: booking\.confirmed/);
  });

  it('rejects duplicate webhook names', () => {
    const endpoint = { name: 'partner', url: 'https://partner.test/hooks', secretBinding: 'PARTNER_WEBHOOK_SECRET' };
    expect(() => validateConfig({ ...config, webhooks: [endpoint, { ...endpoint, url: 'https://other.test/hooks' }] }))
      .toThrow(/duplicate webhook name .+partner/);
  });
});

describe('durable webhook delivery on the confirmation path', () => {
  it('records the row atomically with the confirmation, and a later /status poll drains it', async () => {
    const seeded = booking({ id: 'webhook-confirm-drain', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_webhook_drain' });
    const repo = fakeRepository([seeded]);
    let attempts = 0;
    const { sent, fetchImpl } = recordingFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      return new Response(null, { status: 204 });
    });
    const pending: Promise<unknown>[] = [];
    const identity = { family: 'webhook' as const, name: 'partner', event: 'booking.confirmed' };

    const { context, response } = await confirmedBookingWithWebhook(repo, seeded.id, 'cs_webhook_drain', fetchImpl, pending);

    // The webhook subscriber's failure never turns the customer's confirmation into an error.
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'failed', attemptCount: 1 });

    vi.stubGlobal('fetch', fetchImpl);
    try {
      await expect(handleStatus(statusRequest('cs_webhook_drain'), context)).resolves.toMatchObject({ status: 200 });
      await Promise.all(pending.splice(0));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    // The retry sent the ORIGINAL bytes: same id, same occurredAt, same booking snapshot.
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(sent[1]?.headers['webhook-id']).toBe(sent[0]?.headers['webhook-id']);
    // Only the signature timestamp is per-attempt, so both attempts still verify — checked at each
    // attempt's own instant, since the spec library enforces a 300-second wall-clock tolerance.
    for (const attempt of sent) expect(() => verifyAttempt(attempt)).not.toThrow();
  });

  // The webhook envelope carries the RAW consumer-declared record (values, not the labeled rows
  // the manage/confirmation/email surfaces render); a collection is `{}` when absent, never `null`.
  it('carries the raw metadata record in data.booking.metadata, and {} when the booking has none', async () => {
    const withMetadata = booking({
      id: 'webhook-metadata', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_webhook_metadata', metadata: { dietary_notes: 'Vegan', seat_pref: 'window' },
    });
    const withoutMetadata = booking({
      id: 'webhook-no-metadata', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_webhook_no_metadata', metadata: null,
    });
    const repo = fakeRepository([withMetadata, withoutMetadata]);
    const { sent, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
    const pending: Promise<unknown>[] = [];

    await confirmedBookingWithWebhook(repo, withMetadata.id, 'cs_webhook_metadata', fetchImpl, pending);
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const secondContext = createReservaContext({
        config: webhookConfig(), db: {} as D1Database, repo, clock,
        secrets: async (name) => (name === 'PARTNER_WEBHOOK_SECRET' ? WEBHOOK_SECRET : undefined),
        waitUntil: (task) => pending.push(task),
        // A distinct paymentRef: paidWebhookProviders hardcodes 'pi_events_layer', which would
        // collide with the first booking's already-confirmed payment_ref (the schema's partial
        // unique index) and 409 instead of confirming.
        providers: {
          ...paidWebhookProviders(withoutMetadata.id, 'cs_webhook_no_metadata'),
          payments: {
            ...paidWebhookProviders(withoutMetadata.id, 'cs_webhook_no_metadata').payments,
            parseWebhook: async () => ({
              id: 'evt_events_layer_2', type: 'checkout_completed', bookingId: withoutMetadata.id, sessionRef: 'cs_webhook_no_metadata',
              paymentRef: 'pi_events_layer_2', paid: true, amountCaptured: 10000, currency: config.business.currency,
            }),
          },
        },
      });
      await handlePaymentWebhook(stripeWebhookRequest(), secondContext);
      await Promise.all(pending.splice(0));
    } finally {
      vi.unstubAllGlobals();
    }

    const envelopes = sent.map((attempt) => JSON.parse(attempt.body) as BookingEventEnvelope);
    const withMetadataEnvelope = envelopes.find((envelope) => envelope.id.startsWith(withMetadata.id));
    const withoutMetadataEnvelope = envelopes.find((envelope) => envelope.id.startsWith(withoutMetadata.id));
    expect(withMetadataEnvelope?.data.booking.metadata).toEqual({ dietary_notes: 'Vegan', seat_pref: 'window' });
    expect(withoutMetadataEnvelope?.data.booking.metadata).toEqual({});
  });

  it('gives a later event a distinct id and its own snapshot while the old row keeps the original', async () => {
    const seeded = booking({
      id: 'webhook-new-event', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_webhook_new_event', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z',
    });
    const repo = fakeRepository([seeded]);
    const { sent, fetchImpl } = recordingFetch(() => { throw new TypeError('fetch failed'); });
    const pending: Promise<unknown>[] = [];

    const { context } = await confirmedBookingWithWebhook(repo, seeded.id, 'cs_webhook_new_event', fetchImpl, pending);

    vi.stubGlobal('fetch', fetchImpl);
    try {
      const rescheduleContext = createReservaContext({
        config: context.config, db: {} as D1Database, repo, clock,
        secrets: async (name) => (name === 'PARTNER_WEBHOOK_SECRET' ? WEBHOOK_SECRET : undefined),
        waitUntil: (task) => pending.push(task),
        providers: providers(),
      });
      const current = repo.rows.get(seeded.id);
      if (!current) throw new Error('booking disappeared');
      await expect(handleCustomerReschedule(rescheduleRequest(current.cancelToken, '2026-06-15T10:00:00.000Z'), rescheduleContext))
        .resolves.toMatchObject({ status: 200 });
      await Promise.all(pending.splice(0));
    } finally {
      vi.unstubAllGlobals();
    }

    const envelopes = sent.map((attempt) => JSON.parse(attempt.body) as BookingEventEnvelope);
    const confirmed = envelopes.find((envelope) => envelope.event === 'booking.confirmed');
    const rescheduled = envelopes.find((envelope) => envelope.event === 'booking.rescheduled');
    expect(confirmed?.id).toBe(`${seeded.id}/webhook:partner:booking.confirmed`);
    expect(rescheduled?.id).toBe(`${seeded.id}/webhook:partner:booking.rescheduled:1`);
    // The confirmation's snapshot still describes the ORIGINAL start, not the rescheduled one.
    expect(confirmed?.data.booking.startsAt).toBe(seeded.startsAt);
    expect(rescheduled?.data.booking.startsAt).toBe('2026-06-15T10:00:00.000Z');
  });

  it('gives two reschedules of one booking distinct event ids under a single clock instant', async () => {
    const seeded = booking({ id: 'webhook-two-reschedules', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const { sent, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
    const pending: Promise<unknown>[] = [];
    const context = createReservaContext({
      config: webhookConfig(), db: {} as D1Database, repo, clock,
      secrets: async (name) => (name === 'PARTNER_WEBHOOK_SECRET' ? WEBHOOK_SECRET : undefined),
      waitUntil: (task) => pending.push(task),
      providers: providers(),
    });

    vi.stubGlobal('fetch', fetchImpl);
    try {
      await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T10:00:00.000Z'), context);
      await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T09:00:00.000Z'), context);
      await Promise.all(pending.splice(0));
    } finally {
      vi.unstubAllGlobals();
    }

    const ids = sent.map((attempt) => (JSON.parse(attempt.body) as BookingEventEnvelope).id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('durable in-process hooks', () => {
  it('receives the occurrence snapshot, not the booking as it looks at delivery time', async () => {
    const seeded = booking({
      id: 'durable-hook-snapshot', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z',
      paymentSessionRef: 'cs_durable_snapshot', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z',
    });
    const repo = fakeRepository([seeded]);
    const delivered: Array<{ id: string; startsAt: string; status: string }> = [];
    const pending: Promise<unknown>[] = [];
    let subscriberUp = false;
    const hook: BookingEventHook = {
      name: 'ops',
      durable: true,
      handler: async (_event, wireBooking, hookContext) => {
        if (!subscriberUp) throw new Error('subscriber unavailable');
        delivered.push({ id: hookContext.id, startsAt: wireBooking.startsAt, status: wireBooking.status });
      },
    };
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      waitUntil: (task) => pending.push(task),
      providers: paidWebhookProviders(seeded.id, 'cs_durable_snapshot'),
      hooks: [hook],
    });

    await expect(handlePaymentWebhook(stripeWebhookRequest(), context)).resolves.toMatchObject({ status: 200 });
    await Promise.all(pending.splice(0));
    expect(delivered).toEqual([]);

    // The booking moves on before the retry lands; the snapshot the hook receives must not.
    const confirmed = repo.rows.get(seeded.id);
    if (!confirmed) throw new Error('booking disappeared');
    const moved = { ...confirmed, startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z' };
    repo.rows.set(seeded.id, moved);
    subscriberUp = true;

    await runOwedMutationSideEffects(context, moved);

    expect(delivered).toEqual([{ id: `${seeded.id}/hook:ops:booking.confirmed`, startsAt: seeded.startsAt, status: 'confirmed' }]);
    expect(sideEffectOperation(repo, seeded.id, { family: 'hook', name: 'ops', event: 'booking.confirmed' }))
      .toMatchObject({ status: 'succeeded' });
  });

  it('abandons a row whose subscriber is no longer registered, logging how to make it deliver', async () => {
    const seeded = booking({ id: 'durable-hook-unregistered', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', paymentSessionRef: 'cs_unregistered' });
    const repo = fakeRepository([seeded]);
    const pending: Promise<unknown>[] = [];
    const errors: Array<[string, Record<string, unknown> | undefined]> = [];
    const identity = { family: 'hook' as const, name: 'ops', event: 'booking.confirmed' };

    // Confirmed while the hook was registered...
    const withHook = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      waitUntil: (task) => pending.push(task),
      providers: paidWebhookProviders(seeded.id, 'cs_unregistered'),
      hooks: [{ name: 'ops', durable: true, handler: async () => { throw new Error('subscriber unavailable'); } }],
    });
    await handlePaymentWebhook(stripeWebhookRequest(), withHook);
    await Promise.all(pending.splice(0));
    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'failed' });

    // ...and the deployment then removed it, leaving a row nothing can ever deliver.
    const withoutHook = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      logger: { error: (message, data) => { errors.push([message, data]); } },
      providers: providers(),
    });
    const confirmed = repo.rows.get(seeded.id);
    if (!confirmed) throw new Error('booking disappeared');
    await runOwedMutationSideEffects(withoutHook, confirmed);

    expect(sideEffectOperation(repo, seeded.id, identity)).toMatchObject({ status: 'abandoned' });
    expect(errors.filter(([message]) => message === 'reserva side effect operation abandoned')).toHaveLength(1);
    expect(String(errors[0]?.[1]?.error)).toContain('register a durable booking-event hook named "ops"');
  });
});
