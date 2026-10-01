import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { localDateKey } from '../../src/core/time';
import { getOccupancyIntervals, isSlotAvailable, maxConcurrentOccupancy, occupancyFor } from '../../src/core/occupancy';
import { createBookingRepository } from '../../src/repo';
import { config, service } from '../fixtures';
import { seedHold } from './seed';

interface TestEnv {
  RESERVA_DB: D1Database;
}

// insertHoldWithCapacity/rescheduleWithCapacity's atomicity only means something proven against
// real D1, not a fake repo. Each race applies two conflicting writes in a fixed order and asserts
// the loser reports no change — D1 processes statements serially, so one ordering already proves "at most one winner".
const db = (env as unknown as TestEnv).RESERVA_DB;
const repo = createBookingRepository(db);

const TOUR_SLUG = 'vintage';
const TIMEZONE = config.business.timezone;

beforeEach(async () => {
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM capacity_defaults').run();
  await db.prepare('DELETE FROM refund_operations').run();
});

function occupancyEndsAt(endsAt: string, turnaroundMin = service.turnaroundMin): string {
  return new Date(new Date(endsAt).getTime() + turnaroundMin * 60_000).toISOString();
}

function buildHold(id: string, startsAt: string, endsAt: string, quantity: number, defaultCapacity: number, now = '2026-08-09T10:00:00.000Z') {
  return {
    id,
    reference: `BKT-2026-${id}`,
    serviceSlug: TOUR_SLUG,
    quantity,
    pickupType: 'default' as const,
    startsAt,
    endsAt,
    locale: 'en',
    priceMinor: 10000,
    currency: 'eur',
    holdExpiresAt: '2026-12-31T00:00:00.000Z',
    cancelToken: `cancel-${id}`,
    operatorToken: `operator-${id}`,
    createdAt: now,
    updatedAt: now,
    occupancyUnits: occupancyFor(service, quantity),
    occupancyEndsAt: occupancyEndsAt(endsAt),
    localDate: localDateKey(startsAt, TIMEZONE),
    defaultCapacity,
  };
}

function buildReschedule(expectedStartsAt: string, startsAt: string, endsAt: string, quantity: number, defaultCapacity: number, now = '2026-08-09T11:00:00.000Z') {
  return {
    expectedStatus: 'confirmed' as const,
    expectedStartsAt,
    startsAt,
    endsAt,
    rescheduledFrom: expectedStartsAt,
    updatedAt: now,
    now,
    occupancyUnits: occupancyFor(service, quantity),
    occupancyEndsAt: occupancyEndsAt(endsAt),
    localDate: localDateKey(startsAt, TIMEZONE),
    defaultCapacity,
  };
}

async function seedConfirmed(id: string, startsAt: string, endsAt: string, quantity: number, defaultCapacity: number): Promise<void> {
  const created = await repo.insertHoldWithCapacity(buildHold(id, startsAt, endsAt, quantity, defaultCapacity));
  if (!created) throw new Error(`seed insert for ${id} unexpectedly lost the capacity guard`);
  const confirmed = await repo.transitionToConfirmed(id, { expectedStatusIn: ['hold'], updatedAt: '2026-08-09T10:01:00.000Z' });
  if (!confirmed) throw new Error(`seed confirm for ${id} failed`);
}

const TARGET_START = '2026-08-10T09:00:00.000Z';
const TARGET_END = '2026-08-10T10:00:00.000Z';

// What availability reads for the target day, so a parity check compares the guard with it rather
// than with a hand-built booking.
function listTargetDay() {
  return repo.listOccupancyBookings('2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z');
}

describe('atomic capacity allocation against real D1', () => {
  describe('concurrent last-unit checkout x2', () => {
    it('checkout A commits first: A wins the last unit, B is rejected', async () => {
      const a = await repo.insertHoldWithCapacity(buildHold('checkout-a', TARGET_START, TARGET_END, 2, 1));
      expect(a).toMatchObject({ status: 'hold', startsAt: TARGET_START });
      const b = await repo.insertHoldWithCapacity(buildHold('checkout-b', TARGET_START, TARGET_END, 2, 1));
      expect(b).toBeNull();

      const holds = (await db.prepare("SELECT id FROM bookings WHERE status = 'hold'").all<{ id: string }>()).results;
      expect(holds).toHaveLength(1);
      expect(holds[0]?.id).toBe('checkout-a');
    });
  });

  describe('reschedule x2 into one remaining unit', () => {
    // Capacity 2, one unit already occupied by c0 in the target window, so ra and rb (each
    // moving in from a non-overlapping original slot) are contending for exactly one free unit.
    async function seed(): Promise<void> {
      await seedConfirmed('c0', TARGET_START, TARGET_END, 2, 2);
      await seedConfirmed('ra', '2026-08-10T13:00:00.000Z', '2026-08-10T14:00:00.000Z', 2, 2);
      await seedConfirmed('rb', '2026-08-10T15:00:00.000Z', '2026-08-10T16:00:00.000Z', 2, 2);
    }

    it('ra commits first: ra takes the last remaining unit, rb is rejected', async () => {
      await seed();
      const ra = await repo.rescheduleWithCapacity('ra', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 2, 2));
      expect(ra).toMatchObject({ startsAt: TARGET_START });
      const rb = await repo.rescheduleWithCapacity('rb', buildReschedule('2026-08-10T15:00:00.000Z', TARGET_START, TARGET_END, 2, 2));
      expect(rb).toBeNull();

      await expect(repo.getBookingById('rb')).resolves.toMatchObject({ startsAt: '2026-08-10T15:00:00.000Z' });
      const inWindow = (await db.prepare("SELECT id FROM bookings WHERE starts_at = ? AND status = 'confirmed'").bind(TARGET_START).all<{ id: string }>()).results;
      expect(inWindow.map((row) => row.id).sort()).toEqual(['c0', 'ra']);
    });
  });

  describe('reschedule vs checkout for the same last unit', () => {
    it('reschedule commits first: it takes the last unit, the racing checkout is rejected', async () => {
      await seedConfirmed('ra', '2026-08-10T13:00:00.000Z', '2026-08-10T14:00:00.000Z', 2, 1);
      const rescheduled = await repo.rescheduleWithCapacity('ra', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 2, 1));
      expect(rescheduled).toMatchObject({ startsAt: TARGET_START });
      const checkout = await repo.insertHoldWithCapacity(buildHold('checkout-vs-reschedule', TARGET_START, TARGET_END, 2, 1));
      expect(checkout).toBeNull();
    });

    it('checkout commits first: it takes the last unit, the racing reschedule is rejected', async () => {
      await seedConfirmed('ra', '2026-08-10T13:00:00.000Z', '2026-08-10T14:00:00.000Z', 2, 1);
      const checkout = await repo.insertHoldWithCapacity(buildHold('checkout-vs-reschedule', TARGET_START, TARGET_END, 2, 1));
      expect(checkout).toMatchObject({ status: 'hold', startsAt: TARGET_START });
      const rescheduled = await repo.rescheduleWithCapacity('ra', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 2, 1));
      expect(rescheduled).toBeNull();
      await expect(repo.getBookingById('ra')).resolves.toMatchObject({ startsAt: '2026-08-10T13:00:00.000Z' });
    });
  });

  describe('reschedule vs an admin day-override shrinking capacity concurrently', () => {
    // c0 already occupies 1 of 2 units in the target window; ra (elsewhere) wants the other one.
    async function seed(): Promise<void> {
      await seedConfirmed('c0', TARGET_START, TARGET_END, 2, 2);
      await seedConfirmed('ra', '2026-08-10T13:00:00.000Z', '2026-08-10T14:00:00.000Z', 2, 2);
    }
    const localDate = localDateKey(TARGET_START, TIMEZONE);

    it('the override commits first (capacity shrinks to 1 before the reschedule runs): the reschedule is rejected and final occupancy stays within the new capacity', async () => {
      await seed();
      await repo.upsertDayOverrides([localDate], 1, 'capacity reduced', { actor: 'operator@example.test', changedAt: '2026-08-09T10:00:00.000Z' });

      const rescheduled = await repo.rescheduleWithCapacity('ra', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 2, 2));
      expect(rescheduled).toBeNull();
      await expect(repo.getBookingById('ra')).resolves.toMatchObject({ startsAt: '2026-08-10T13:00:00.000Z' });

      const inWindow = (await db.prepare("SELECT id FROM bookings WHERE starts_at = ? AND status = 'confirmed'").bind(TARGET_START).all<{ id: string }>()).results;
      expect(inWindow).toHaveLength(1); // just c0 -- within the overridden capacity of 1.
    });

    // The reschedule's own guard resolved capacity when IT ran (still 2), so it succeeds — a later
    // override doesn't retroactively evict an already-confirmed booking, it only governs writes
    // from that point on, as the final insertHoldWithCapacity call below confirms.
    it('the reschedule commits first (capacity is still 2 when it runs): it succeeds, and the override that lands right after does not retroactively evict it but still governs the next write', async () => {
      await seed();
      const rescheduled = await repo.rescheduleWithCapacity('ra', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 2, 2));
      expect(rescheduled).toMatchObject({ startsAt: TARGET_START });

      await repo.upsertDayOverrides([localDate], 1, 'capacity reduced', { actor: 'operator@example.test', changedAt: '2026-08-09T10:00:00.000Z' });

      const inWindow = (await db.prepare("SELECT id FROM bookings WHERE starts_at = ? AND status = 'confirmed'").bind(TARGET_START).all<{ id: string }>()).results;
      expect(inWindow.map((row) => row.id).sort()).toEqual(['c0', 'ra']); // not retroactively evicted.

      const blocked = await repo.insertHoldWithCapacity(buildHold('checkout-after-override', TARGET_START, TARGET_END, 2, 2));
      expect(blocked).toBeNull(); // the override is authoritative for every write from here on.
    });
  });

  describe('occupancy-units parity: the SQL guard must agree with core/occupancy.ts for multi-unit parties', () => {
    // occupancyFor(service, 5) is 2 (tests/fixtures.ts: quantity > 4 costs 2 units), which is what
    // exercises multi-unit accounting here.
    it('rejects a request that would push a multi-unit party over capacity, exactly where maxConcurrentOccupancy says it must', async () => {
      await seedConfirmed('multi-unit', TARGET_START, TARGET_END, 5, 2);

      const rejected = await repo.insertHoldWithCapacity(buildHold('single-unit-over', TARGET_START, TARGET_END, 2, 2));
      expect(rejected).toBeNull();

      const intervals = getOccupancyIntervals({ bookings: await listTargetDay(), service, now: '2026-08-09T10:00:00.000Z' });
      expect(maxConcurrentOccupancy(intervals, TARGET_START, occupancyEndsAt(TARGET_END))).toBe(2);
      expect(isSlotAvailable(TARGET_START, TARGET_END, { capacity: 2, intervals, requestedUnits: 1, turnaroundMin: service.turnaroundMin })).toBe(false);
    });

    it('accepts a request that fits alongside a multi-unit party, exactly where maxConcurrentOccupancy says it must', async () => {
      await seedConfirmed('multi-unit', TARGET_START, TARGET_END, 5, 3);
      const intervals = getOccupancyIntervals({ bookings: await listTargetDay(), service, now: '2026-08-09T10:00:00.000Z' });

      const accepted = await repo.insertHoldWithCapacity(buildHold('single-unit-fits', TARGET_START, TARGET_END, 2, 3));
      expect(accepted).toMatchObject({ status: 'hold', startsAt: TARGET_START });
      expect(isSlotAvailable(TARGET_START, TARGET_END, { capacity: 3, intervals, requestedUnits: 1, turnaroundMin: service.turnaroundMin })).toBe(true);
    });
  });

  describe('disjoint-overlap parity: max-concurrency guard vs a naive SUM-of-overlaps guard (patch-05-r1 Fix 1)', () => {
    // Both neighbors overlap the requested window but never overlap each other inside it, so true
    // max-concurrent occupancy is 1, not 2 — a SUM-of-overlaps guard double-counts them and wrongly
    // rejects a 1-unit request against capacity 2; the correct guard agrees with maxConcurrentOccupancy.
    const NEIGHBOR_A_START = '2026-08-10T10:00:00.000Z';
    const NEIGHBOR_A_END = '2026-08-10T11:00:00.000Z'; // occupancy window [10:00, 11:30) after +30 turnaround
    const NEIGHBOR_B_START = '2026-08-10T12:00:00.000Z';
    const NEIGHBOR_B_END = '2026-08-10T13:00:00.000Z'; // occupancy window [12:00, 13:30)
    const REQUEST_START = '2026-08-10T11:00:00.000Z';
    const REQUEST_END = '2026-08-10T12:00:00.000Z'; // occupancy window [11:00, 12:30) straddles both neighbors

    async function crossCheckRealSemantic(): Promise<void> {
      const neighbors = (await listTargetDay()).filter((listed) => listed.id.startsWith('neighbor-'));
      const intervals = getOccupancyIntervals({ bookings: neighbors, service, now: '2026-08-09T10:00:00.000Z' });
      expect(maxConcurrentOccupancy(intervals, REQUEST_START, occupancyEndsAt(REQUEST_END))).toBe(1);
      expect(isSlotAvailable(REQUEST_START, REQUEST_END, { capacity: 2, intervals, requestedUnits: 1, turnaroundMin: service.turnaroundMin })).toBe(true);
    }

    it('insertHoldWithCapacity accepts a request straddling two neighbors that never overlap each other, which a SUM guard would wrongly reject', async () => {
      await seedConfirmed('neighbor-a', NEIGHBOR_A_START, NEIGHBOR_A_END, 2, 2);
      await seedConfirmed('neighbor-b', NEIGHBOR_B_START, NEIGHBOR_B_END, 2, 2);
      await crossCheckRealSemantic();

      // A naive SUM-of-overlaps guard computes occupied = 1 (neighbor-a) + 1 (neighbor-b) = 2 (both
      // overlap the request window) plus the requested unit = 3 > capacity 2, and rejects. The
      // atomic SQL guard must instead agree with maxConcurrentOccupancy above and accept.
      const accepted = await repo.insertHoldWithCapacity(buildHold('straddling-request', REQUEST_START, REQUEST_END, 2, 2));
      expect(accepted).toMatchObject({ status: 'hold', startsAt: REQUEST_START });
    });

    it('rescheduleWithCapacity accepts the same straddling move that a SUM guard would wrongly reject', async () => {
      await seedConfirmed('neighbor-a', NEIGHBOR_A_START, NEIGHBOR_A_END, 2, 2);
      await seedConfirmed('neighbor-b', NEIGHBOR_B_START, NEIGHBOR_B_END, 2, 2);
      await seedConfirmed('mover', '2026-08-10T15:00:00.000Z', '2026-08-10T16:00:00.000Z', 2, 2);
      await crossCheckRealSemantic();

      const rescheduled = await repo.rescheduleWithCapacity('mover', buildReschedule('2026-08-10T15:00:00.000Z', REQUEST_START, REQUEST_END, 2, 2));
      expect(rescheduled).toMatchObject({ startsAt: REQUEST_START });
    });
  });

  describe('rescheduleWithCapacity self-heals legacy occupancy_units (patch-05-r1 Fix 3)', () => {
    it('sets occupancy_units on a pre-migration-style NULL row it moves, matching occupancyFor(service, quantity)', async () => {
      const now = '2026-08-09T10:00:00.000Z';
      // Clearing occupancy_units/occupancy_ends_at after the insert reproduces a pre-migration-0008
      // row -- exactly the NULL-column case migrations/0008_occupancy_capacity.sql documents.
      await seedHold(repo, {
        id: 'legacy-row', reference: 'BKT-2026-legacy-row', serviceSlug: TOUR_SLUG, quantity: 5,
        pickupType: 'default', startsAt: '2026-08-10T13:00:00.000Z', endsAt: '2026-08-10T14:00:00.000Z',
        locale: 'en', priceMinor: 10000, currency: 'eur', holdExpiresAt: '2026-12-31T00:00:00.000Z',
        cancelToken: 'cancel-legacy-row', operatorToken: 'operator-legacy-row', createdAt: now, updatedAt: now,
      });
      await db.prepare('UPDATE bookings SET occupancy_units = NULL, occupancy_ends_at = NULL WHERE id = ?').bind('legacy-row').run();
      await repo.transitionToConfirmed('legacy-row', { expectedStatusIn: ['hold'], updatedAt: now });

      const before = (await db.prepare('SELECT occupancy_units, occupancy_ends_at FROM bookings WHERE id = ?')
        .bind('legacy-row').all<{ occupancy_units: number | null; occupancy_ends_at: string | null }>()).results[0];
      expect(before?.occupancy_units).toBeNull();
      expect(before?.occupancy_ends_at).toBeNull();

      const rescheduled = await repo.rescheduleWithCapacity('legacy-row', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 5, 2));
      expect(rescheduled).toMatchObject({ startsAt: TARGET_START });

      const after = (await db.prepare('SELECT occupancy_units, occupancy_ends_at FROM bookings WHERE id = ?')
        .bind('legacy-row').all<{ occupancy_units: number | null; occupancy_ends_at: string | null }>()).results[0];
      expect(after?.occupancy_units).toBe(occupancyFor(service, 5)); // 2 -- was left NULL forever pre-fix.
      expect(after?.occupancy_ends_at).toBe(occupancyEndsAt(TARGET_END));
    });
  });
  describe('hold expiry boundary', () => {
    it('a hold whose expires_at == now is both counted by capacity and returned by listLiveBookings (admin day view hid it)', async () => {
      const now = '2026-08-09T10:00:00.000Z';
      const held = await repo.insertHoldWithCapacity({ ...buildHold('boundary-hold', TARGET_START, TARGET_END, 2, 1), holdExpiresAt: now });
      expect(held).not.toBeNull();

      await expect(repo.insertHoldWithCapacity(buildHold('boundary-rival', TARGET_START, TARGET_END, 2, 1, now))).resolves.toBeNull();
      await expect(repo.sweepExpiredHolds(now)).resolves.toBe(0);
      const live = await repo.listLiveBookings('2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z', now, 10);
      expect(live.map((booking) => booking.id)).toEqual(['boundary-hold']);
    });
  });
});
