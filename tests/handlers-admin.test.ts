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

function adminPostRequest(fields: Record<string, string> | Array<[string, string]>): Request {
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
  it('action=set calls upsertDayOverride with a trimmed reason and redirects (303) back with a saved confirmation', async () => {
    const repo = fakeRepository();
    const calls: Array<[string, number, string | null]> = [];
    repo.upsertDayOverride = async (date, capacity, reason) => { calls.push([date, capacity, reason]); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    const request = adminPostRequest({ date: '2026-06-20', capacity: '3', reason: '  closed for maintenance  ', action: 'set' });
    const response = await handleAdminPost(request, context);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${request.url}?saved=day&date=2026-06-20#bk-override`);
    expect(calls).toEqual([['2026-06-20', 3, 'closed for maintenance']]);
  });

  it('action=close writes capacity 0 to every submitted date (repeated date fields)', async () => {
    const repo = fakeRepository();
    const calls: Array<[string, number, string | null]> = [];
    repo.upsertDayOverride = async (date, capacity, reason) => { calls.push([date, capacity, reason]); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    const response = await handleAdminPost(adminPostRequest([
      ['date', '2026-06-22'], ['date', '2026-06-20'], ['date', '2026-06-20'], ['reason', 'holiday'], ['action', 'close'],
    ]), context);
    expect(response.status).toBe(303);
    // Deduplicated, sorted, and the redirect pins ?date= to the earliest edited day.
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('date')).toBe('2026-06-20');
    expect(calls).toEqual([['2026-06-20', 0, 'holiday'], ['2026-06-22', 0, 'holiday']]);
  });

  it('toDate expands date into a contiguous range for set/close/clear', async () => {
    const repo = fakeRepository();
    const upserts: Array<[string, number]> = [];
    const deletes: string[] = [];
    repo.upsertDayOverride = async (date, capacity) => { upserts.push([date, capacity]); };
    repo.deleteDayOverride = async (date) => { deletes.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-22', capacity: '1', action: 'set' }), context);
    expect(upserts).toEqual([['2026-06-20', 1], ['2026-06-21', 1], ['2026-06-22', 1]]);
    await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-21', action: 'clear' }), context);
    expect(deletes).toEqual(['2026-06-20', '2026-06-21']);
  });

  it('rejects toDate before date with 400 validation_failed', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-19', capacity: '1', action: 'set' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
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

describe('admin settings (?view=settings + settings-save/settings-reset actions)', () => {
  function settingsGetRequest(): Request {
    return new Request('https://example.test/api/booking/admin?view=settings');
  }

  it('renders the settings page with editable fields and marks overridden settings', async () => {
    const repo = fakeRepository();
    repo.settings.set('booking.minNoticeHours', '2');
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminGet(settingsGetRequest(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain('name="booking.minNoticeHours"');
    expect(body).toContain('name="payments.methods"');
    expect(body).toContain('Modified');
    expect(body).toContain('Default: 24');
    // The overridden field offers a per-field reset action.
    expect(body).toContain('value="settings-reset:booking.minNoticeHours"');
    // The deploy-time card lists file-only values.
    expect(body).toContain(config.business.timezone);
  });

  it('shows a saved confirmation after the post-save redirect and resets a single field', async () => {
    const repo = fakeRepository();
    repo.settings.set('booking.minNoticeHours', '2');
    repo.settings.set('booking.maxHorizonDays', '120');
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });

    const reset = await handleAdminPost(adminPostRequest({ action: 'settings-reset:booking.minNoticeHours' }), context);
    expect(reset.status).toBe(303);
    expect(reset.headers.get('location')).toContain('saved=1');
    expect(repo.settings.has('booking.minNoticeHours')).toBe(false);
    // Only the named field resets; the rest of the section keeps its overrides.
    expect(repo.settings.has('booking.maxHorizonDays')).toBe(true);

    const confirmation = await handleAdminGet(new Request('https://example.test/api/booking/admin?view=settings&saved=1'), context);
    expect(await confirmation.text()).toContain('role="status"');
  });

  it('settings-save stores only values that differ from the file config and deletes ones equal to it', async () => {
    const repo = fakeRepository();
    // Pre-existing override that the save sets back to the config value (24) — must be deleted.
    repo.settings.set('booking.minNoticeHours', '2');
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });
    const request = adminPostRequest({
      action: 'settings-save',
      section: 'policy',
      'booking.minNoticeHours': '24',
      'booking.maxHorizonDays': '90',
      'booking.holdMinutes': String(config.booking.holdMinutes),
      'booking.cancelCutoffHours': String(config.booking.cancelCutoffHours),
      'booking.reschedule.cutoffHours': String(config.booking.reschedule.cutoffHours),
      'booking.limitedThreshold': String(config.booking.limitedThreshold),
      'booking.maxHoldsPerIp': '',
      // reschedule.enabled checkbox absent => false
    });
    const response = await handleAdminPost(request, context);
    expect(response.status).toBe(303);
    expect(repo.settings.has('booking.minNoticeHours')).toBe(false);
    expect(repo.settings.get('booking.maxHorizonDays')).toBe('90');
    // Fixture config has reschedule.enabled: true; the absent checkbox stores an explicit false.
    expect(repo.settings.get('booking.reschedule.enabled')).toBe('false');
    expect(repo.settings.has('booking.holdMinutes')).toBe(false);
  });

  it('settings-reset deletes every key in the section', async () => {
    const repo = fakeRepository();
    repo.settings.set('booking.minNoticeHours', '2');
    repo.settings.set('booking.maxHorizonDays', '120');
    repo.settings.set('legal.termsUrl', '"https://elsewhere.test/terms"');
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminPost(adminPostRequest({ action: 'settings-reset', section: 'policy' }), context);
    expect(response.status).toBe(303);
    expect(repo.settings.has('booking.minNoticeHours')).toBe(false);
    expect(repo.settings.has('booking.maxHorizonDays')).toBe(false);
    // Other sections are untouched.
    expect(repo.settings.has('legal.termsUrl')).toBe(true);
  });

  it('rejects invalid values and unknown sections with 400 validation_failed', async () => {
    const repo = fakeRepository();
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });
    const bad = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'legal', 'legal.termsUrl': 'not a url' }), context);
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
    expect(repo.settings.size).toBe(0);
    const unknown = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'nope' }), context);
    expect(unknown.status).toBe(400);
  });
});
