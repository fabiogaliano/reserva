import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleCustomerReschedule, handleOperatorCancel, handleOperatorNoShow, handleOperatorReschedule } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');
const validNewStart = '2026-06-15T08:00:00.000Z';

function operatorRequest(path: string, body: Record<string, unknown>, bearer?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Request(`https://example.test/api/booking/operator/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function rescheduleAsCustomer(token: string, newStart: string): Request {
  return new Request('https://example.test/api/booking/reschedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newStart }),
  });
}

function contextWithSecret(seed: ReturnType<typeof booking>[], overrides: Parameters<typeof providers>[0] = {}) {
  return createBookkitContext({
    config,
    db: {} as D1Database,
    repo: fakeRepository(seed),
    clock,
    secrets: async () => 'expected-secret',
    providers: providers(overrides),
  });
}

describe('operator route auth (spec §11 dual-auth resolver)', () => {
  it('rejects a wrong operator token with 403', async () => {
    const seeded = booking({ id: 'b-op-auth-wrong-token' });
    const context = contextWithSecret([seeded]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: 'not-the-token', refund: 'none' }), context);
    expect(response.status).toBe(403);
  });

  it('rejects a missing operator token and missing bearer with 403', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository([booking({ id: 'b-op-auth-missing' })]), clock, providers: providers() });
    const response = await handleOperatorCancel(operatorRequest('cancel', { refund: 'none' }), context);
    expect(response.status).toBe(403);
  });

  it('rejects a customer cancel token used as an operator token (disjoint column lookup)', async () => {
    const seeded = booking({ id: 'b-op-auth-customer-token' });
    const context = contextWithSecret([seeded]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.cancelToken, refund: 'none' }), context);
    expect(response.status).toBe(403);
  });

  it('accepts the bearer + bookingId path with the correct shared secret', async () => {
    const seeded = booking({ id: 'b-op-auth-bearer-ok' });
    const context = contextWithSecret([seeded]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { bookingId: seeded.id, refund: 'none' }, 'expected-secret'), context);
    expect(response.status).toBe(200);
  });

  it('rejects the bearer path with a wrong shared secret', async () => {
    const seeded = booking({ id: 'b-op-auth-bearer-wrong' });
    const context = contextWithSecret([seeded]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { bookingId: seeded.id, refund: 'none' }, 'wrong-secret'), context);
    expect(response.status).toBe(403);
  });

  it('returns 404 not_found for the bearer path with an unknown bookingId', async () => {
    const context = contextWithSecret([]);
    const response = await handleOperatorCancel(operatorRequest('cancel', { bookingId: 'no-such-booking', refund: 'none' }, 'expected-secret'), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('POST /operator/cancel with refund (spec §11)', () => {
  it('refund: full on a confirmed row with a payment intent calls refund() exactly once, and a retried request is idempotent', async () => {
    const seeded = booking({ id: 'b-op-cancel-refund-full', stripePaymentIntent: 'pi_refund_full' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionId: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; } } }),
    });

    const first = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(first.status).toBe(200);
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('operator');
    expect(refunds).toBe(1);

    // Redeliver the same request (simulating a retry): the early return on an
    // already-cancelled row (handlers/index.ts:444) guarantees no second refund.
    const second = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(second.status).toBe(200);
    expect(refunds).toBe(1);
  });

  it('refund: none cancels without ever calling refund()', async () => {
    const seeded = booking({ id: 'b-op-cancel-refund-none', stripePaymentIntent: 'pi_refund_none' });
    const repo = fakeRepository([seeded]);
    let refunds = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionId: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; } } }),
    });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(refunds).toBe(0);
  });

  it('rejects a missing/invalid refund field with 400 validation_failed', async () => {
    const seeded = booking({ id: 'b-op-cancel-missing-refund' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('rejects a cancel on a non-confirmed row with 409 invalid_transition', async () => {
    const seeded = booking({ id: 'b-op-cancel-wrong-state', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'none' }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
  });

  it('a throwing refund() surfaces as a non-2xx response and leaves the row uncancelled', async () => {
    const seeded = booking({ id: 'b-op-cancel-refund-throws', stripePaymentIntent: 'pi_refund_throws' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionId: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { throw new Error('refund provider down'); } } }),
    });

    const response = await handleOperatorCancel(operatorRequest('cancel', { operatorToken: seeded.operatorToken, refund: 'full' }), context);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
  });
});

describe('POST /operator/reschedule cutoff asymmetry (spec §11)', () => {
  it('a booking starting inside the customer cutoff is 403 for customer reschedule but 200 for operator reschedule', async () => {
    const seeded = booking({ id: 'b-op-reschedule-cutoff', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z', calendarEventId: 'cal-op-reschedule' });
    const repo = fakeRepository([seeded]);
    let patches = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => { patches += 1; }, deleteEvent: async () => undefined } }),
    });

    const customerAttempt = await handleCustomerReschedule(rescheduleAsCustomer(seeded.cancelToken, validNewStart), context);
    expect(customerAttempt.status).toBe(403);
    await expect(customerAttempt.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
    expect(repo.rows.get(seeded.id)?.startsAt).toBe(seeded.startsAt);

    const response = await handleOperatorReschedule(operatorRequest('reschedule', { operatorToken: seeded.operatorToken, newStart: validNewStart }), context);
    expect(response.status).toBe(200);
    const row = repo.rows.get(seeded.id);
    expect(row?.startsAt).toBe(validNewStart);
    expect(row?.tourSlug).toBe(seeded.tourSlug);
    expect(row?.people).toBe(seeded.people);
    expect(row?.priceCents).toBe(seeded.priceCents);
    expect(patches).toBe(1);
  });
});

describe('POST /operator/no-show (spec §11)', () => {
  it('rejects marking no-show before the start with 409 invalid_transition', async () => {
    const seeded = booking({ id: 'b-op-noshow-before-start', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
  });

  it('rejects marking no-show on a hold row with 409', async () => {
    const seeded = booking({ id: 'b-op-noshow-hold', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T07:30:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(409);
  });

  it('rejects marking no-show on a cancelled row with 409', async () => {
    const seeded = booking({ id: 'b-op-noshow-cancelled', status: 'cancelled', cancelledAt: '2026-06-13T08:00:00.000Z', cancelledBy: 'customer', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T07:30:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(response.status).toBe(409);
  });

  it('marks a confirmed, past-start booking as no_show, dispatches booking.no_show, and repeating the call is idempotent', async () => {
    const seeded = booking({ id: 'b-op-noshow-valid', status: 'confirmed', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T07:30:00.000Z' });
    const repo = fakeRepository([seeded]);
    const emails: string[] = [];
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({ email: { send: async (event) => { emails.push(event); } } }),
    });

    const first = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(first.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('no_show');
    expect(emails).toEqual(['booking.no_show']);

    const second = await handleOperatorNoShow(operatorRequest('no-show', { operatorToken: seeded.operatorToken }), context);
    expect(second.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('no_show');
    expect(emails).toEqual(['booking.no_show']);
  });
});
