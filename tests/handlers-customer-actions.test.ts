import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleCustomerCancel, handleCustomerReschedule } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');

function cancelRequest(token: string): Request {
  return new Request('https://example.test/api/booking/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

function rescheduleRequest(token: string, newStart: string): Request {
  return new Request('https://example.test/api/booking/reschedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newStart }),
  });
}

// A future slot on-grid for 2026-06-15 given the fixture's Europe/Lisbon schedule
// (local 09:00-12:00 every 30 min, i.e. UTC 08:00-11:00 in June/WEST).
const validNewStart = '2026-06-15T08:00:00.000Z';

describe('POST /cancel (customer, spec §11)', () => {
  it('happy path outside the cutoff: cancels, deletes the calendar event once, and dispatches booking.cancelled_by_customer', async () => {
    const seeded = booking({ id: 'b-cancel-happy', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-happy' });
    const repo = fakeRepository([seeded]);
    let deletes = 0;
    const emails: string[] = [];
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        calendar: { listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => undefined, deleteEvent: async () => { deletes += 1; } },
        email: { send: async (event) => { emails.push(event); } },
      }),
    });

    const response = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('customer');
    expect(row?.cancelledAt).not.toBeNull();
    expect(deletes).toBe(1);
    expect(emails).toEqual(['booking.cancelled_by_customer']);
  });

  it('is idempotent: cancelling an already-cancelled booking again returns ok without a second calendar delete or email', async () => {
    const seeded = booking({ id: 'b-cancel-idempotent', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-idempotent' });
    const repo = fakeRepository([seeded]);
    let deletes = 0;
    const emails: string[] = [];
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        calendar: { listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => undefined, deleteEvent: async () => { deletes += 1; } },
        email: { send: async (event) => { emails.push(event); } },
      }),
    });

    const first = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(first.status).toBe(200);
    const second = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ ok: true });
    expect(deletes).toBe(1);
    expect(emails).toEqual(['booking.cancelled_by_customer']);
  });

  it('rejects a cancel inside the cutoff with 403 past_cutoff, leaving the row unchanged', async () => {
    const seeded = booking({ id: 'b-cancel-cutoff', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
  });

  it('surfaces a calendar delete failure as a non-2xx response and leaves the row uncancelled', async () => {
    // handleCustomerCancel deletes the calendar event before the DB update,
    // so a delete failure must prevent the row from ever transitioning to cancelled.
    const seeded = booking({ id: 'b-cancel-calendar-fails', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-fails' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        calendar: { listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => undefined, deleteEvent: async () => { throw new Error('calendar unavailable'); } },
      }),
    });

    const response = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBeLessThan(300);
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
  });

  it('rejects cancel on a wrong-state (hold) row with 409 invalid_transition', async () => {
    const seeded = booking({ id: 'b-cancel-wrong-state', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
    expect(repo.rows.get(seeded.id)?.status).toBe('hold');
  });
});

describe('POST /reschedule (customer, spec §11)', () => {
  it('happy path: moves to a new valid slot on the same tour, preserves party/price, patches the calendar, and dispatches booking.rescheduled', async () => {
    const seeded = booking({
      id: 'b-reschedule-happy',
      startsAt: '2026-06-15T09:00:00.000Z',
      endsAt: '2026-06-15T10:00:00.000Z',
      calendarEventId: 'cal-reschedule',
    });
    const repo = fakeRepository([seeded]);
    let patches = 0;
    const emails: string[] = [];
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        calendar: { listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => { patches += 1; }, deleteEvent: async () => undefined },
        email: { send: async (event) => { emails.push(event); } },
      }),
    });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const row = repo.rows.get(seeded.id);
    expect(row?.startsAt).toBe(validNewStart);
    expect(row?.endsAt).toBe('2026-06-15T09:00:00.000Z');
    expect(row?.rescheduledFrom).toBe(seeded.startsAt);
    expect(row?.priceCents).toBe(seeded.priceCents);
    expect(row?.tourSlug).toBe(seeded.tourSlug);
    expect(row?.people).toBe(seeded.people);
    expect(patches).toBe(1);
    expect(emails).toEqual(['booking.rescheduled']);
  });

  it('excludes its own occupancy at the route layer: moving within an overlapping window at capacity 1 must not 409 against itself', async () => {
    const singleCapacityConfig = { ...config, fleet: { defaultCapacity: 1 } };
    // Local 09:00-10:00 (UTC 08:00-09:00). Moving to local 09:30 overlaps the old
    // occupied window (which extends to 10:30 local with the 30-min turnaround).
    const seeded = booking({ id: 'b-reschedule-own-occupancy', startsAt: '2026-06-15T08:00:00.000Z', endsAt: '2026-06-15T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config: singleCapacityConfig, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T08:30:00.000Z'), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.startsAt).toBe('2026-06-15T08:30:00.000Z');
  });

  it('inverse control: the same move fails with 409 slot_unavailable when a second confirmed booking occupies the target window', async () => {
    const singleCapacityConfig = { ...config, fleet: { defaultCapacity: 1 } };
    const seeded = booking({ id: 'b-reschedule-blocked', startsAt: '2026-06-15T08:00:00.000Z', endsAt: '2026-06-15T09:00:00.000Z' });
    const blocker = booking({
      id: 'b-reschedule-blocker',
      cancelToken: 'blocker-cancel-token',
      operatorToken: 'blocker-operator-token',
      startsAt: '2026-06-15T08:30:00.000Z',
      endsAt: '2026-06-15T09:30:00.000Z',
    });
    const repo = fakeRepository([seeded, blocker]);
    const context = createBookkitContext({ config: singleCapacityConfig, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T08:30:00.000Z'), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
    expect(repo.rows.get(seeded.id)?.startsAt).toBe(seeded.startsAt);
  });

  it('rejects a reschedule inside the cutoff with 403 past_cutoff', async () => {
    const seeded = booking({ id: 'b-reschedule-cutoff', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
  });

  it('rejects a reschedule with 403 past_cutoff when reschedule is disabled in config, even outside the cancel cutoff', async () => {
    const disabledConfig: typeof config = { ...config, booking: { ...config.booking, reschedule: { ...config.booking.reschedule, enabled: false } } };
    const seeded = booking({ id: 'b-reschedule-disabled', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config: disabledConfig, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
  });

  it('rejects an off-grid newStart with 409 slot_unavailable', async () => {
    const seeded = booking({ id: 'b-reschedule-off-grid', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T08:15:00.000Z'), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
  });

  it('rejects a wrong-state (hold) row with 409 invalid_transition', async () => {
    const seeded = booking({ id: 'b-reschedule-wrong-state', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
  });
});
