import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleAdminGet, handleAdminPost } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');

function adminGetRequest(): Request {
  return new Request('https://example.test/api/booking/admin');
}

function adminPostRequest(fields: Record<string, string>): Request {
  return new Request('https://example.test/api/booking/admin', {
    method: 'POST',
    body: new URLSearchParams(fields),
  });
}

describe('access control (spec §11: admin requires Cloudflare Access)', () => {
  it('rejects GET and POST when verifyAccess is absent, returns false, or throws', async () => {
    const variants: Array<{ label: string; verifyAccess?: () => boolean | Promise<boolean> }> = [
      { label: 'absent' },
      { label: 'returns false', verifyAccess: () => false },
      { label: 'throws', verifyAccess: () => { throw new Error('access check exploded'); } },
    ];
    for (const variant of variants) {
      const context = createBookkitContext({
        config,
        db: {} as D1Database,
        repo: fakeRepository(),
        clock,
        providers: providers(),
        ...(variant.verifyAccess ? { verifyAccess: variant.verifyAccess } : {}),
      });
      const getResponse = await handleAdminGet(adminGetRequest(), context);
      expect(getResponse.status, `GET with verifyAccess ${variant.label}`).toBe(403);
      const postResponse = await handleAdminPost(adminPostRequest({ action: 'clear', date: '2026-06-20' }), context);
      expect(postResponse.status, `POST with verifyAccess ${variant.label}`).toBe(403);
    }
  });
});

describe('GET /admin listing (spec §11 + repo.ts:260-267 filter)', () => {
  it('lists only upcoming confirmed and unexpired-hold bookings, excluding swept-expired holds, cancelled, and past rows', async () => {
    const futureConfirmed = booking({ id: 'b-admin-future-confirmed', reference: 'LVT-2026-100', status: 'confirmed', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z', operatorToken: 'op-future-confirmed', cancelToken: 'cancel-future-confirmed' });
    const futureUnexpiredHold = booking({ id: 'b-admin-future-hold', reference: 'LVT-2026-101', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', startsAt: '2026-06-21T09:00:00.000Z', endsAt: '2026-06-21T10:00:00.000Z', operatorToken: 'op-future-hold', cancelToken: 'cancel-future-hold' });
    const futureExpiredHold = booking({ id: 'b-admin-expired-hold', reference: 'LVT-2026-102', status: 'hold', holdExpiresAt: '2026-06-14T07:00:00.000Z', startsAt: '2026-06-22T09:00:00.000Z', endsAt: '2026-06-22T10:00:00.000Z', operatorToken: 'op-expired-hold', cancelToken: 'cancel-expired-hold' });
    const cancelledFuture = booking({ id: 'b-admin-cancelled', reference: 'LVT-2026-103', status: 'cancelled', cancelledAt: '2026-06-13T08:00:00.000Z', cancelledBy: 'customer', startsAt: '2026-06-23T09:00:00.000Z', endsAt: '2026-06-23T10:00:00.000Z', operatorToken: 'op-cancelled', cancelToken: 'cancel-cancelled' });
    const pastConfirmed = booking({ id: 'b-admin-past', reference: 'LVT-2026-104', status: 'confirmed', startsAt: '2026-06-10T09:00:00.000Z', endsAt: '2026-06-10T10:00:00.000Z', operatorToken: 'op-past', cancelToken: 'cancel-past' });
    const repo = fakeRepository([futureConfirmed, futureUnexpiredHold, futureExpiredHold, cancelledFuture, pastConfirmed]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    const response = await handleAdminGet(adminGetRequest(), context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(futureConfirmed.reference);
    expect(body).toContain(futureUnexpiredHold.reference);
    expect(body).not.toContain(futureExpiredHold.reference);
    expect(body).not.toContain(cancelledFuture.reference);
    expect(body).not.toContain(pastConfirmed.reference);
    // The sweep (called inside handleAdminGet) must have flipped the time-expired hold.
    expect(repo.rows.get(futureExpiredHold.id)?.status).toBe('expired');
  });

  it('manage links carry each row\'s operator token (URL-encoded) and never leak a cancel_token', async () => {
    const first = booking({ id: 'b-admin-links-1', reference: 'LVT-2026-200', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z', operatorToken: 'operator+token/one', cancelToken: 'cancel-token-one-secret' });
    const second = booking({ id: 'b-admin-links-2', reference: 'LVT-2026-201', startsAt: '2026-06-21T09:00:00.000Z', endsAt: '2026-06-21T10:00:00.000Z', operatorToken: 'operator-token-two', cancelToken: 'cancel-token-two-secret' });
    const repo = fakeRepository([first, second]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(first.operatorToken)}`);
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(second.operatorToken)}`);
    expect(body).not.toContain(first.cancelToken);
    expect(body).not.toContain(second.cancelToken);
  });

  it('sets cache-control: no-store and referrer-policy: no-referrer', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminGet(adminGetRequest(), context);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('POST /admin day overrides (spec §11)', () => {
  it('action=set calls upsertDayOverride with a trimmed reason and redirects (303) back to the request URL', async () => {
    const repo = fakeRepository();
    const calls: Array<[string, number, string | null]> = [];
    repo.upsertDayOverride = async (date, capacity, reason) => { calls.push([date, capacity, reason]); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    const request = adminPostRequest({ date: '2026-06-20', capacity: '3', reason: '  closed for maintenance  ', action: 'set' });
    const response = await handleAdminPost(request, context);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(request.url);
    expect(calls).toEqual([['2026-06-20', 3, 'closed for maintenance']]);
  });

  it('action=set with a blank reason passes null', async () => {
    const repo = fakeRepository();
    const calls: Array<[string, number, string | null]> = [];
    repo.upsertDayOverride = async (date, capacity, reason) => { calls.push([date, capacity, reason]); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', capacity: '0', reason: '   ', action: 'set' }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual([['2026-06-20', 0, null]]);
  });

  it('action=clear calls deleteDayOverride', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverride = async (date) => { calls.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual(['2026-06-20']);
  });

  it('rejects an unknown action with 400 validation_failed', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'delete-everything' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('rejects an invalid date with 400', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminPost(adminPostRequest({ date: 'not-a-date', action: 'clear' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });
});
