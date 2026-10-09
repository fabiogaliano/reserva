import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { DEFAULT_TOKEN_EXPIRY_DAYS } from '../src/core/config';
import {
  handleAvailability,
  handleCustomerCancel,
  handleCustomerReschedule,
  handleManage,
  handleOperatorCancel,
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
    body: JSON.stringify({ token, start: newStart }),
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
    const context = createReservaContext({
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

  // A successful cancel revokes the customer's cancel_token, since a cancelled booking's link has
  // no further legitimate use — a same-token retry now gets 403 (same denial as an unknown token,
  // no oracle) instead of replaying the old idempotent 200, so it can never reach the mutation at all.
  it('revokes the customer token on a successful cancel, so a same-token retry is denied like an unknown token — without ever risking a second calendar delete or email', async () => {
    const seeded = booking({ id: 'b-cancel-idempotent', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-idempotent' });
    const repo = fakeRepository([seeded]);
    let deletes = 0;
    const emails: string[] = [];
    const context = createReservaContext({
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
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
    expect(repo.rows.get(seeded.id)?.status).toBe('confirmed');
  });

  it('an operator refund:none cancel on a customer-cancelled booking succeeds and drains the owed calendar delete', async () => {
    const seeded = booking({ id: 'b-cancel-calendar-fails', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-fails' });
    const repo = fakeRepository([seeded]);
    let attempts = 0;
    const context = createReservaContext({
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

  // A cancelled row is excluded from listOccupancyBookings entirely, so its calendarEventId no
  // longer suppresses the matching calendar event — a failed delete leaves a stale calendar event
  // that still occupies the slot until a later request drains the calendar_delete debt.
  it('a stale calendar event survives a failed delete: occupancy still blocks the slot until a later request drains the debt and frees it', async () => {
    const singleCapacityConfig = { ...config, capacity: { default: 1 } };
    const seeded = booking({
      id: 'b-calendar-debt-occupancy', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z',
      calendarEventId: 'cal-debt',
    });
    const repo = fakeRepository([seeded]);
    let eventDeleted = false;
    let deleteAttempts = 0;
    const context = createReservaContext({
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

    const availabilityRequest = () => new Request('https://example.test/api/booking/availability?serviceSlug=vintage&quantity=1&from=2026-06-15&to=2026-06-15');
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
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

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
    const context = createReservaContext({
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
    const context = createReservaContext({
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

  it('reports success once the move commits, owes a failed calendar patch to the outbox, and a same-target resubmit drains it without a second notification', async () => {
    const seeded = booking({
      id: 'b-reschedule-patch-retry', startsAt: '2026-06-15T09:00:00.000Z',
      endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-retry',
    });
    const repo = fakeRepository([seeded]);
    let patches = 0;
    const emails: string[] = [];
    // The same-target resubmit must skip rescheduleWithCapacity entirely.
    const realRescheduleWithCapacity = repo.rescheduleWithCapacity;
    let capacityWrites = 0;
    repo.rescheduleWithCapacity = async (id, input) => {
      capacityWrites += 1;
      return realRescheduleWithCapacity(id, input);
    };
    const context = createReservaContext({
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
    expect(first.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.startsAt).toBe(validNewStart);
    expect(patches).toBe(1);
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_patch:1`)).toMatchObject({ status: 'failed' });
    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.rescheduled:1`)).toMatchObject({ status: 'succeeded' });
    expect(capacityWrites).toBe(1);

    const retry = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(retry.status).toBe(200);
    expect(patches).toBe(2);
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_patch:1`)).toMatchObject({ status: 'succeeded' });
    expect(emails).toEqual(['booking.rescheduled']);
    expect(repo.sideEffectOperations.size).toBe(2);
    expect(capacityWrites).toBe(1);

    // A genuine follow-up move (B -> C) must not be swallowed by the no-op guard: it creates a
    // second reschedule outbox version and dispatches a second notification.
    const secondMove = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T08:30:00.000Z'), context);
    expect(secondMove.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.startsAt).toBe('2026-06-15T08:30:00.000Z');
    expect(capacityWrites).toBe(2);
    expect(patches).toBe(3);
    expect(emails).toEqual(['booking.rescheduled', 'booking.rescheduled']);
    expect(repo.sideEffectOperations.size).toBe(4);
    expect(repo.sideEffectOperations.get(`${seeded.id}:email:booking.rescheduled:2`)).toMatchObject({ status: 'succeeded' });
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_patch:2`)).toMatchObject({ status: 'succeeded' });
  });

  it('treats a resubmit to the current start as a no-op success even once the new start is inside the cutoff', async () => {
    // Moved to a start 20h away (inside the 24h cutoff): the resubmitted form must not bounce
    // off past_cutoff, because the booking is already exactly where it asked to be.
    const seeded = booking({ id: 'b-reschedule-noop-cutoff', startsAt: '2026-06-15T04:00:00.000Z', endsAt: '2026-06-15T05:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const emails: string[] = [];
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ email: { send: async (event) => { emails.push(event); } } }),
    });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, seeded.startsAt), context);
    expect(response.status).toBe(200);
    expect(emails).toEqual([]);
    expect(repo.rows.get(seeded.id)?.updatedAt).toBe(seeded.updatedAt);
  });

  // The no-op must not become a way to hear "rescheduled" from a deployment that offers no
  // rescheduling at all.
  it('refuses even a same-start resubmit when rescheduling is switched off', async () => {
    const seeded = booking({ id: 'b-reschedule-noop-disabled', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z' });
    const disabled = { ...config, booking: { ...config.booking, reschedule: { ...config.booking.reschedule, enabled: false } } };
    const context = createReservaContext({ config: disabled, db: {} as D1Database, repo: fakeRepository([seeded]), clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, seeded.startsAt), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
  });

  it('reports success when it loses the write to a concurrent move to the very same slot', async () => {
    const seeded = booking({ id: 'b-reschedule-concurrent-same', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });
    // The twin request commits between this one's read and its write.
    const realRescheduleWithCapacity = repo.rescheduleWithCapacity;
    repo.rescheduleWithCapacity = async (id, input) => {
      const current = repo.rows.get(id)!;
      repo.rows.set(id, { ...current, startsAt: input.startsAt, endsAt: input.endsAt });
      return realRescheduleWithCapacity(id, input);
    };

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(200);
    expect(repo.rows.get(seeded.id)?.startsAt).toBe(validNewStart);
  });

  it('excludes its own occupancy at the route layer: moving within an overlapping window at capacity 1 must not 409 against itself', async () => {
    const singleCapacityConfig = { ...config, capacity: { default: 1 } };
    // Local 09:00-10:00 (UTC 08:00-09:00). Moving to local 09:30 overlaps the old
    // occupied window (which extends to 10:30 local with the 30-min turnaround).
    const seeded = booking({ id: 'b-reschedule-own-occupancy', startsAt: '2026-06-15T08:00:00.000Z', endsAt: '2026-06-15T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config: singleCapacityConfig, db: {} as D1Database, repo, clock, providers: providers() });

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
    const context = createReservaContext({ config: singleCapacityConfig, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T08:30:00.000Z'), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
    expect(repo.rows.get(seeded.id)?.startsAt).toBe(seeded.startsAt);
  });

  it('rejects a reschedule inside the cutoff with 403 past_cutoff', async () => {
    const seeded = booking({ id: 'b-reschedule-cutoff', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
  });

  it('rejects a reschedule with 403 past_cutoff when reschedule is disabled in config, even outside the cancel cutoff', async () => {
    const disabledConfig: typeof config = { ...config, booking: { ...config.booking, reschedule: { ...config.booking.reschedule, enabled: false } } };
    const seeded = booking({ id: 'b-reschedule-disabled', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config: disabledConfig, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'past_cutoff' } });
  });

  it('rejects an off-grid newStart with 409 slot_unavailable', async () => {
    const seeded = booking({ id: 'b-reschedule-off-grid', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, '2026-06-15T08:15:00.000Z'), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
  });

  it('rejects a wrong-state (hold) row with 409 invalid_transition', async () => {
    const seeded = booking({ id: 'b-reschedule-wrong-state', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleCustomerReschedule(rescheduleRequest(seeded.cancelToken, validNewStart), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_transition' } });
  });

  // tokens_expire_at must track the booking's CURRENT endsAt, not whatever it was at checkout —
  // otherwise a reschedule that moves a booking out drops the manage link's expiry too early.
  it('moves tokens_expire_at to (new endsAt + tokenExpiryDays) on an EARLIER reschedule', async () => {
    const seeded = booking({ id: 'b-reschedule-expiry-earlier', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

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

describe('calendar sync without a calendar provider', () => {
  it('records no calendar delete or patch for an event made while a calendar was configured (the rows could never run)', async () => {
    const cancelled = booking({ id: 'b-no-calendar-cancel', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-old-1' });
    const moved = booking({ id: 'b-no-calendar-move', startsAt: '2026-06-15T09:00:00.000Z', endsAt: '2026-06-15T10:00:00.000Z', calendarEventId: 'cal-old-2' });
    const repo = fakeRepository([cancelled, moved]);
    const { calendar: _unused, ...noCalendar } = providers();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: noCalendar });

    expect((await handleCustomerCancel(cancelRequest(cancelled.cancelToken), context)).status).toBe(200);
    expect((await handleCustomerReschedule(rescheduleRequest(moved.cancelToken, validNewStart), context)).status).toBe(200);

    const families = [...repo.sideEffectOperations.values()].map((operation) => operation.family);
    expect(families).not.toContain('calendar_delete');
    expect(families).not.toContain('calendar_patch');
  });
});
