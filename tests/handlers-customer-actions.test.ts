import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { DEFAULT_TOKEN_EXPIRY_DAYS } from '../src/core/config';
import {
  handleAvailability,
  handleCustomerCancel,
  handleCustomerReschedule,
  handleManage,
  handleOperatorCancel,
  handleOperatorReschedule,
} from '../src/handlers';
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
    expect(response.headers.get('cache-control')).toBe('no-store');
    const row = repo.rows.get(seeded.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('customer');
    expect(row?.cancelledAt).not.toBeNull();
    expect(deletes).toBe(1);
    expect(emails).toEqual(['booking.cancelled_by_customer']);
  });

  // BK-SEC-002: a successful cancel now revokes the customer's cancel_token (migrations/
  // 0009_token_hashing.sql — cancel_token_revoked_at), since a cancelled booking's link has no
  // further legitimate customer use. That changes what a same-token retry sees: it can no longer
  // re-authenticate at all, so it gets 403 forbidden (the same denial an unknown token gets, per
  // the "no oracle" requirement) rather than replaying the old idempotent 200. The property this
  // test actually cares about — a repeat request can never cause a second calendar delete or a
  // second email — holds even more strongly now: the retry cannot get far enough to attempt the
  // mutation at all.
  it('revokes the customer token on a successful cancel, so a same-token retry is denied like an unknown token — without ever risking a second calendar delete or email', async () => {
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
    expect(second.status).toBe(403);
    await expect(second.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
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

  it('records a failed calendar deletion for an operator retry after cancellation', async () => {
    const seeded = booking({ id: 'b-cancel-calendar-fails', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-fails' });
    const repo = fakeRepository([seeded]);
    let attempts = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        calendar: {
          listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => undefined,
          deleteEvent: async () => { attempts += 1; if (attempts === 1) throw new Error('calendar unavailable'); },
        },
      }),
    });

    const response = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_delete`)).toMatchObject({ status: 'failed' });

    const retry = await handleOperatorCancel(new Request('https://example.test/api/booking/operator/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorToken: seeded.operatorToken, refund: 'none' }),
    }), context);
    expect(retry.status).toBe(200);
    expect(attempts).toBe(2);
    expect(repo.rows.get(seeded.id)?.calendarEventId).toBeNull();
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_delete`)).toMatchObject({ status: 'succeeded' });
  });

  // src/core/occupancy.ts:158-185 dedups a calendar-sourced interval against its booking only
  // while that booking is still active (hold/confirmed) — a cancelled row is excluded from
  // listOccupancyBookings entirely, so once cancelled its calendarEventId no longer suppresses
  // the matching calendar event. That's the real failure mode a transient delete failure exposes:
  // Stripe/D1 already show the booking as cancelled, but the *calendar* event survives (delete
  // failed), so it still occupies the slot until a later request drains the calendar_delete debt.
  it('a stale calendar event survives a failed delete: occupancy still blocks the slot until a later request drains the debt and frees it', async () => {
    const singleCapacityConfig = { ...config, capacity: { default: 1 } };
    const seeded = booking({
      id: 'b-calendar-debt-occupancy', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z',
      calendarEventId: 'cal-debt',
    });
    const repo = fakeRepository([seeded]);
    let eventDeleted = false;
    let deleteAttempts = 0;
    const context = createBookkitContext({
      config: singleCapacityConfig,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        calendar: {
          listEvents: async () => (eventDeleted ? [] : [{
            id: 'cal-debt',
            start: { dateTime: seeded.startsAt },
            end: { dateTime: seeded.endsAt },
          }]),
          createEvent: async () => 'unused',
          patchEvent: async () => undefined,
          deleteEvent: async () => {
            deleteAttempts += 1;
            if (deleteAttempts === 1) throw new Error('calendar unavailable');
            eventDeleted = true;
          },
        },
      }),
    });

    const cancelResponse = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(cancelResponse.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_delete`)).toMatchObject({ status: 'failed' });

    const availabilityRequest = () => new Request('https://example.test/api/booking/availability?service=vintage&quantity=1&from=2026-06-15&to=2026-06-15');
    const blocked = await handleAvailability(availabilityRequest(), context);
    expect(blocked.status).toBe(200);
    const blockedPayload = await blocked.json() as { days: Array<{ slots: Array<{ start: string }> }> };
    // The slot the stale event occupies (local 10:00, this booking's own former slot) is missing —
    // capacity 1 is still fully consumed by the undeleted calendar event, not by the (now
    // cancelled, and thus excluded) booking row itself.
    expect(blockedPayload.days[0]?.slots).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ start: expect.stringContaining('T10:00:00') }),
    ]));

    // Any later booking-touching request (here, the operator's manage-page lookup) drains the
    // owed calendar_delete debt — this attempt succeeds.
    const manageResponse = await handleManage(new Request(`https://example.test/api/booking/manage?token=${seeded.operatorToken}`), context);
    expect(manageResponse.status).toBe(200);
    expect(deleteAttempts).toBe(2);
    expect(repo.rows.get(seeded.id)?.calendarEventId).toBeNull();
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_delete`)).toMatchObject({ status: 'succeeded' });

    const freed = await handleAvailability(availabilityRequest(), context);
    const freedPayload = await freed.json() as { days: Array<{ slots: Array<{ start: string }> }> };
    expect(freedPayload.days[0]?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ start: expect.stringContaining('T10:00:00') }),
    ]));
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

describe('POST /operator/cancel (spec §11)', () => {
  it('an operator-initiated cancel creates a calendar_delete debt on a failed delete, and a retry drains it', async () => {
    const seeded = booking({ id: 'b-operator-cancel-calendar-debt', calendarEventId: 'cal-operator-cancel-debt' });
    const repo = fakeRepository([seeded]);
    let attempts = 0;
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock,
      providers: providers({
        calendar: {
          listEvents: async () => [], createEvent: async () => 'unused', patchEvent: async () => undefined,
          deleteEvent: async () => { attempts += 1; if (attempts === 1) throw new Error('calendar unavailable'); },
        },
      }),
    });
    const operatorCancelRequest = () => new Request('https://example.test/api/booking/operator/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorToken: seeded.operatorToken, refund: 'none' }),
    });

    const response = await handleOperatorCancel(operatorCancelRequest(), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.status).toBe('cancelled');
    expect(attempts).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_delete`)).toMatchObject({ status: 'failed' });

    const retry = await handleOperatorCancel(operatorCancelRequest(), context);
    expect(retry.status).toBe(200);
    expect(attempts).toBe(2);
    expect(repo.rows.get(seeded.id)?.calendarEventId).toBeNull();
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_delete`)).toMatchObject({ status: 'succeeded' });
  });
});

describe('POST /reschedule (customer, spec §11)', () => {
  it('happy path: moves to a new valid slot on the same service, preserves party/price, patches the calendar, and dispatches booking.rescheduled', async () => {
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
    expect(response.headers.get('cache-control')).toBe('no-store');
    const row = repo.rows.get(seeded.id);
    expect(row?.startsAt).toBe(validNewStart);
    expect(row?.endsAt).toBe('2026-06-15T09:00:00.000Z');
    expect(row?.rescheduledFrom).toBe(seeded.startsAt);
    expect(row?.priceMinor).toBe(seeded.priceMinor);
    expect(row?.serviceSlug).toBe(seeded.serviceSlug);
    expect(row?.quantity).toBe(seeded.quantity);
    expect(patches).toBe(1);
    expect(emails).toEqual(['booking.rescheduled']);
  });

  it('retries a failed calendar patch at the same target without a second reschedule notification, and a later genuine move is not suppressed by the no-op guard', async () => {
    const seeded = booking({
      id: 'b-reschedule-patch-retry', startsAt: '2026-06-15T09:00:00.000Z',
      endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-retry',
    });
    const repo = fakeRepository([seeded]);
    let patches = 0;
    const emails: string[] = [];
    // The no-op guard (rescheduleWithToken: next.startsAt === booking.startsAt) must skip
    // rescheduleWithCapacity entirely on the same-target retry — only calendarPatch may run again.
    const realRescheduleWithCapacity = repo.rescheduleWithCapacity;
    let capacityWrites = 0;
    repo.rescheduleWithCapacity = async (id, input) => {
      capacityWrites += 1;
      return realRescheduleWithCapacity(id, input);
    };
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({
        calendar: {
          listEvents: async () => [], createEvent: async () => 'unused', deleteEvent: async () => undefined,
          patchEvent: async () => { patches += 1; if (patches === 1) throw new Error('calendar unavailable'); },
        },
        email: { send: async (event) => { emails.push(event); } },
      }),
    });

    const first = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(first.status).toBe(500);
    expect(repo.rows.get(seeded.id)?.startsAt).toBe(validNewStart);
    expect(repo.sideEffectOperations.size).toBe(1);
    expect(capacityWrites).toBe(1);

    const retry = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(retry.status).toBe(200);
    expect(patches).toBe(2);
    expect(emails).toEqual(['booking.rescheduled']);
    expect(repo.sideEffectOperations.size).toBe(1);
    // The no-op retry repaired the calendar patch but made no capacity-changing repository write —
    // rescheduleWithCapacity was called only for the original (real) move, never for this retry.
    expect(capacityWrites).toBe(1);

    // A genuine follow-up move (B -> C) must not be swallowed by the no-op guard: it creates a
    // second reschedule outbox version and dispatches a second notification.
    const secondMove = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T08:30:00.000Z'), context);
    expect(secondMove.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.startsAt).toBe('2026-06-15T08:30:00.000Z');
    expect(capacityWrites).toBe(2);
    expect(patches).toBe(3);
    expect(emails).toEqual(['booking.rescheduled', 'booking.rescheduled']);
    expect(repo.sideEffectOperations.size).toBe(2);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.rescheduled:2`)).toMatchObject({ status: 'succeeded' });
  });

  it('operator path: retries a failed calendar patch at the same target without a second reschedule notification', async () => {
    const seeded = booking({
      id: 'b-op-reschedule-patch-retry', startsAt: '2026-06-15T09:00:00.000Z',
      endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-op-retry',
    });
    const repo = fakeRepository([seeded]);
    let patches = 0;
    const emails: string[] = [];
    const realRescheduleWithCapacity = repo.rescheduleWithCapacity;
    let capacityWrites = 0;
    repo.rescheduleWithCapacity = async (id, input) => {
      capacityWrites += 1;
      return realRescheduleWithCapacity(id, input);
    };
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({
        calendar: {
          listEvents: async () => [], createEvent: async () => 'unused', deleteEvent: async () => undefined,
          patchEvent: async () => { patches += 1; if (patches === 1) throw new Error('calendar unavailable'); },
        },
        email: { send: async (event) => { emails.push(event); } },
      }),
    });
    const operatorRescheduleRequest = (newStart: string) => new Request('https://example.test/api/booking/operator/reschedule', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorToken: seeded.operatorToken, newStart }),
    });

    const first = await handleOperatorReschedule(operatorRescheduleRequest(validNewStart), context);
    expect(first.status).toBe(500);
    expect(repo.rows.get(seeded.id)?.startsAt).toBe(validNewStart);
    expect(repo.sideEffectOperations.size).toBe(1);
    expect(capacityWrites).toBe(1);

    const retry = await handleOperatorReschedule(operatorRescheduleRequest(validNewStart), context);
    expect(retry.status).toBe(200);
    expect(patches).toBe(2);
    expect(emails).toEqual(['booking.rescheduled']);
    expect(repo.sideEffectOperations.size).toBe(1);
    expect(capacityWrites).toBe(1);
  });

  it('excludes its own occupancy at the route layer: moving within an overlapping window at capacity 1 must not 409 against itself', async () => {
    const singleCapacityConfig = { ...config, capacity: { default: 1 } };
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
    const singleCapacityConfig = { ...config, capacity: { default: 1 } };
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

  // BK-SEC-002 (patch-11-r1 MEDIUM 2): tokens_expire_at must track the booking's CURRENT endsAt,
  // not whatever it was at checkout — otherwise a reschedule that moves a booking out drops its
  // manage link's expiry before the (new, later) service date, and one moved in leaves an
  // over-long window relative to the new (earlier) end. repo.tokenState mirrors the DB-side
  // tokens_expire_at column (see tests/fakes.ts).
  it('moves tokens_expire_at to (new endsAt + tokenExpiryDays) on a LATER reschedule', async () => {
    const seeded = booking({ id: 'b-reschedule-expiry-later', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const newStart = '2026-06-15T10:00:00.000Z'; // later than the original 09:00 start, still on-grid
    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, newStart), context);
    expect(response.status).toBe(200);
    const row = repo.rows.get(seeded.id);
    expect(row?.endsAt).toBe('2026-06-15T11:00:00.000Z'); // 60-min service, moved an hour later
    const expected = new Date(new Date(row!.endsAt).getTime() + DEFAULT_TOKEN_EXPIRY_DAYS * 86_400_000).toISOString();
    expect(repo.tokenState.get(seeded.id)?.tokensExpireAt).toBe(expected);
  });

  it('moves tokens_expire_at to (new endsAt + tokenExpiryDays) on an EARLIER reschedule', async () => {
    const seeded = booking({ id: 'b-reschedule-expiry-earlier', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const newStart = '2026-06-15T08:00:00.000Z'; // earlier than the original 09:00 start, still on-grid
    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, newStart), context);
    expect(response.status).toBe(200);
    const row = repo.rows.get(seeded.id);
    expect(row?.endsAt).toBe('2026-06-15T09:00:00.000Z'); // 60-min service, moved an hour earlier
    const expected = new Date(new Date(row!.endsAt).getTime() + DEFAULT_TOKEN_EXPIRY_DAYS * 86_400_000).toISOString();
    expect(repo.tokenState.get(seeded.id)?.tokensExpireAt).toBe(expected);
    // Sanity: the new expiry is earlier than it would have been off the ORIGINAL endsAt, proving
    // this tracks the booking's current end, not a value frozen at checkout.
    const staleExpiry = new Date(new Date(seeded.endsAt).getTime() + DEFAULT_TOKEN_EXPIRY_DAYS * 86_400_000).toISOString();
    expect(repo.tokenState.get(seeded.id)?.tokensExpireAt).not.toBe(staleExpiry);
  });
});
