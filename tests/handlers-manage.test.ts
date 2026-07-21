import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleManage } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');

function manageContext(seed: ReturnType<typeof booking>[]) {
  return createBookkitContext({
    config,
    db: {} as D1Database,
    repo: fakeRepository(seed),
    clock,
    providers: providers(),
  });
}

function manageRequest(token?: string): Request {
  const url = new URL('https://example.test/api/booking/manage');
  if (token !== undefined) url.searchParams.set('token', token);
  return new Request(url);
}

// Spec §11: GET /manage is one page serving two capability sets from the same
// token lookup — customer tokens enforce the cancel/reschedule cutoff, operator
// tokens don't (they can also mark no-show once the tour has started).
describe('GET /manage (spec §11)', () => {
  it('customer token outside the cutoff can cancel and reschedule, and reports the booking summary + deadline', async () => {
    const seeded = booking({ id: 'b-manage-customer-open', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const context = manageContext([seeded]);

    const response = await handleManage(manageRequest(seeded.cancelToken), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.role).toBe('customer');
    expect(payload.canCancel).toBe(true);
    expect(payload.canReschedule).toBe(true);
    expect(payload.canNoShow).toBe(false);
    // Deadline is startsAt minus the configured cancel cutoff, independent of "now".
    expect(payload.deadline).toBe('2026-06-14T09:00:00.000Z');
    expect(payload.booking).toMatchObject({
      reference: seeded.reference,
      tourSlug: seeded.tourSlug,
      people: seeded.people,
      meetingPoint: config.tours.vintage!.meetingPoint,
    });
  });

  it('customer token inside the cutoff cannot cancel or reschedule', async () => {
    // Deadline (startsAt - 24h) is 2026-06-13T20:00Z, already before the clock.
    const seeded = booking({ id: 'b-manage-customer-cutoff', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const context = manageContext([seeded]);

    const response = await handleManage(manageRequest(seeded.cancelToken), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.canCancel).toBe(false);
    expect(payload.canReschedule).toBe(false);
  });

  it('operator token inside the cutoff, confirmed, future start: cancel/reschedule are unrestricted but no-show is not yet available', async () => {
    const seeded = booking({ id: 'b-manage-operator-future', status: 'confirmed', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const context = manageContext([seeded]);

    const response = await handleManage(manageRequest(seeded.operatorToken), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.role).toBe('operator');
    // Operator capability doesn't consult the cutoff at all.
    expect(payload.canCancel).toBe(true);
    expect(payload.canReschedule).toBe(true);
    expect(payload.canNoShow).toBe(false);
  });

  it('operator token past the start reports canNoShow true', async () => {
    const seeded = booking({ id: 'b-manage-operator-past', status: 'confirmed', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const context = manageContext([seeded]);

    const response = await handleManage(manageRequest(seeded.operatorToken), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.canNoShow).toBe(true);
  });

  it('rejects an unknown token with 403 forbidden', async () => {
    const context = manageContext([booking({ id: 'b-manage-unknown' })]);
    const response = await handleManage(manageRequest('no-such-token'), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
  });

  it('rejects a missing token with 403 forbidden', async () => {
    const context = manageContext([]);
    const response = await handleManage(manageRequest(), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
  });

  it('checks cancel_token before operator_token: a value that matches one row\'s cancel_token and a different row\'s operator_token resolves to the cancel_token row, as customer', async () => {
    // Real rows never share a token across the two columns, but the handler's lookup order
    // (handlers/index.ts:355-357) is only observable by giving two distinct rows a shared
    // string in the two different columns.
    const shared = 'shared-token-value';
    const bookingA = booking({ id: 'b-manage-precedence-a', cancelToken: shared, operatorToken: 'op-a-token' });
    const bookingB = booking({ id: 'b-manage-precedence-b', cancelToken: 'cancel-b-token', operatorToken: shared });
    const context = manageContext([bookingA, bookingB]);

    const response = await handleManage(manageRequest(shared), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as { role: string; booking: { reference: string } };
    expect(payload.role).toBe('customer');
    expect(payload.booking.reference).toBe(bookingA.reference);

    // Each token still resolves to its own role when queried directly.
    const operatorResponse = await handleManage(manageRequest('op-a-token'), context);
    const operatorPayload = await operatorResponse.json() as { role: string; booking: { reference: string } };
    expect(operatorPayload.role).toBe('operator');
    expect(operatorPayload.booking.reference).toBe(bookingA.reference);

    const customerBResponse = await handleManage(manageRequest('cancel-b-token'), context);
    const customerBPayload = await customerBResponse.json() as { role: string; booking: { reference: string } };
    expect(customerBPayload.role).toBe('customer');
    expect(customerBPayload.booking.reference).toBe(bookingB.reference);
  });
});
