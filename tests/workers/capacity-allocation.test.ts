import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { localDateKey } from '../../src/core/time';
import { getOccupancyIntervals, isSlotAvailable, maxConcurrentOccupancy, occupancyFor } from '../../src/core/occupancy';
import { createBookingRepository } from '../../src/repo';
import { config, service } from '../fixtures';

interface TestEnv {
  BOOKKIT_DB: D1Database;
}

// BK-CAP-001 / AR-001 (handoff 05): the decisive layer for the atomic capacity guard —
// insertHoldWithCapacity / rescheduleWithCapacity run as single conditional statements, so their
// atomicity claim only means something proven against the real D1 binding (a fake repo's
// "atomicity" is just "no await between check and write", which doesn't exercise the actual SQL).
//
// Each race below follows repo-cas-transitions.test.ts's own established pattern for proving
// atomicity against real D1: two conflicting writes applied in a concrete order, asserting the
// loser reports no change (null/unchanged row) rather than relying on Promise.all — D1 processes
// every statement serially in its own implicit transaction (see the handoff's D1 concurrency FAQ
// citation), so a fixed ordering already proves "at most one winner" for either interleaving;
// running both orderings (where the pair is genuinely symmetric) covers whichever request reaches
// D1 first in production.
const db = (env as unknown as TestEnv).BOOKKIT_DB;
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

describe('atomic capacity allocation against real D1 (BK-CAP-001 / AR-001)', () => {
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

    it('checkout B commits first: B wins the last unit, A is rejected', async () => {
      const b = await repo.insertHoldWithCapacity(buildHold('checkout-b', TARGET_START, TARGET_END, 2, 1));
      expect(b).toMatchObject({ status: 'hold', startsAt: TARGET_START });
      const a = await repo.insertHoldWithCapacity(buildHold('checkout-a', TARGET_START, TARGET_END, 2, 1));
      expect(a).toBeNull();

      const holds = (await db.prepare("SELECT id FROM bookings WHERE status = 'hold'").all<{ id: string }>()).results;
      expect(holds).toHaveLength(1);
      expect(holds[0]?.id).toBe('checkout-b');
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

    it('rb commits first: rb takes the last remaining unit, ra is rejected', async () => {
      await seed();
      const rb = await repo.rescheduleWithCapacity('rb', buildReschedule('2026-08-10T15:00:00.000Z', TARGET_START, TARGET_END, 2, 2));
      expect(rb).toMatchObject({ startsAt: TARGET_START });
      const ra = await repo.rescheduleWithCapacity('ra', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 2, 2));
      expect(ra).toBeNull();

      await expect(repo.getBookingById('ra')).resolves.toMatchObject({ startsAt: '2026-08-10T13:00:00.000Z' });
      const inWindow = (await db.prepare("SELECT id FROM bookings WHERE starts_at = ? AND status = 'confirmed'").bind(TARGET_START).all<{ id: string }>()).results;
      expect(inWindow.map((row) => row.id).sort()).toEqual(['c0', 'rb']);
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
      await repo.upsertDayOverride(localDate, 1, 'capacity reduced');

      const rescheduled = await repo.rescheduleWithCapacity('ra', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 2, 2));
      expect(rescheduled).toBeNull();
      await expect(repo.getBookingById('ra')).resolves.toMatchObject({ startsAt: '2026-08-10T13:00:00.000Z' });

      const inWindow = (await db.prepare("SELECT id FROM bookings WHERE starts_at = ? AND status = 'confirmed'").bind(TARGET_START).all<{ id: string }>()).results;
      expect(inWindow).toHaveLength(1); // just c0 -- within the overridden capacity of 1.
    });

    // The reschedule's own atomic guard resolved capacity at the moment IT ran (still 2), so it
    // correctly succeeds -- a later override is a forward-looking capacity change, not a retroactive
    // eviction of an already-confirmed booking (oversell repair for pre-existing rows is out of
    // scope per the handoff). What the override DOES do is bind on every write from that point on,
    // which the final insertHoldWithCapacity call below confirms.
    it('the reschedule commits first (capacity is still 2 when it runs): it succeeds, and the override that lands right after does not retroactively evict it but still governs the next write', async () => {
      await seed();
      const rescheduled = await repo.rescheduleWithCapacity('ra', buildReschedule('2026-08-10T13:00:00.000Z', TARGET_START, TARGET_END, 2, 2));
      expect(rescheduled).toMatchObject({ startsAt: TARGET_START });

      await repo.upsertDayOverride(localDate, 1, 'capacity reduced');

      const inWindow = (await db.prepare("SELECT id FROM bookings WHERE starts_at = ? AND status = 'confirmed'").bind(TARGET_START).all<{ id: string }>()).results;
      expect(inWindow.map((row) => row.id).sort()).toEqual(['c0', 'ra']); // not retroactively evicted.

      const blocked = await repo.insertHoldWithCapacity(buildHold('checkout-after-override', TARGET_START, TARGET_END, 2, 2));
      expect(blocked).toBeNull(); // the override is authoritative for every write from here on.
    });
  });

  describe('occupancy-units parity: the SQL guard must agree with core/occupancy.ts for multi-unit parties', () => {
    // occupancyFor(service, 5) is 2 (tests/fixtures.ts: quantity > 4 costs 2 units), matching the
    // handoff's own example for exercising multi-unit accounting.
    it('rejects a request that would push a multi-unit party over capacity, exactly where maxConcurrentOccupancy says it must', async () => {
      await seedConfirmed('multi-unit', TARGET_START, TARGET_END, 5, 2);

      const rejected = await repo.insertHoldWithCapacity(buildHold('single-unit-over', TARGET_START, TARGET_END, 2, 2));
      expect(rejected).toBeNull();

      const referenceBooking = { id: 'multi-unit', status: 'confirmed' as const, startsAt: TARGET_START, endsAt: TARGET_END, holdExpiresAt: null, quantity: 5 };
      const intervals = getOccupancyIntervals({ bookings: [referenceBooking], service, now: '2026-08-09T10:00:00.000Z' });
      expect(maxConcurrentOccupancy(intervals, TARGET_START, occupancyEndsAt(TARGET_END))).toBe(2);
      expect(isSlotAvailable(TARGET_START, TARGET_END, { capacity: 2, intervals, requestedUnits: 1, turnaroundMin: service.turnaroundMin })).toBe(false);
    });

    it('accepts a request that fits alongside a multi-unit party, exactly where maxConcurrentOccupancy says it must', async () => {
      await seedConfirmed('multi-unit', TARGET_START, TARGET_END, 5, 3);

      const accepted = await repo.insertHoldWithCapacity(buildHold('single-unit-fits', TARGET_START, TARGET_END, 2, 3));
      expect(accepted).toMatchObject({ status: 'hold', startsAt: TARGET_START });

      const referenceBooking = { id: 'multi-unit', status: 'confirmed' as const, startsAt: TARGET_START, endsAt: TARGET_END, holdExpiresAt: null, quantity: 5 };
      const intervals = getOccupancyIntervals({ bookings: [referenceBooking], service, now: '2026-08-09T10:00:00.000Z' });
      expect(isSlotAvailable(TARGET_START, TARGET_END, { capacity: 3, intervals, requestedUnits: 1, turnaroundMin: service.turnaroundMin })).toBe(true);
    });
  });

  describe('disjoint-overlap parity: max-concurrency guard vs a naive SUM-of-overlaps guard (patch-05-r1 Fix 1)', () => {
    // Both neighbors overlap the REQUESTED window but never overlap EACH OTHER inside it (A's
    // occupancy ends at 11:30, B's starts at 12:00), so the true max-concurrent occupancy at any
    // single point in the window is 1, not 2. A SUM-of-overlaps guard double-counts both
    // neighbors (1 + 1 = 2) and wrongly rejects a 1-unit request against capacity 2; the correct
    // guard must agree with maxConcurrentOccupancy (1) and accept (1 + 1 <= 2). This is the exact
    // shape the handoff's own example describes (bookings at 10:00 and 12:00, request at 11:00).
    const NEIGHBOR_A_START = '2026-08-10T10:00:00.000Z';
    const NEIGHBOR_A_END = '2026-08-10T11:00:00.000Z'; // occupancy window [10:00, 11:30) after +30 turnaround
    const NEIGHBOR_B_START = '2026-08-10T12:00:00.000Z';
    const NEIGHBOR_B_END = '2026-08-10T13:00:00.000Z'; // occupancy window [12:00, 13:30)
    const REQUEST_START = '2026-08-10T11:00:00.000Z';
    const REQUEST_END = '2026-08-10T12:00:00.000Z'; // occupancy window [11:00, 12:30) straddles both neighbors

    function crossCheckRealSemantic(): void {
      const referenceBookings = [
        { id: 'neighbor-a', status: 'confirmed' as const, startsAt: NEIGHBOR_A_START, endsAt: NEIGHBOR_A_END, holdExpiresAt: null, quantity: 2 },
        { id: 'neighbor-b', status: 'confirmed' as const, startsAt: NEIGHBOR_B_START, endsAt: NEIGHBOR_B_END, holdExpiresAt: null, quantity: 2 },
      ];
      const intervals = getOccupancyIntervals({ bookings: referenceBookings, service, now: '2026-08-09T10:00:00.000Z' });
      expect(maxConcurrentOccupancy(intervals, REQUEST_START, occupancyEndsAt(REQUEST_END))).toBe(1);
      expect(isSlotAvailable(REQUEST_START, REQUEST_END, { capacity: 2, intervals, requestedUnits: 1, turnaroundMin: service.turnaroundMin })).toBe(true);
    }

    it('insertHoldWithCapacity accepts a request straddling two neighbors that never overlap each other, which a SUM guard would wrongly reject', async () => {
      await seedConfirmed('neighbor-a', NEIGHBOR_A_START, NEIGHBOR_A_END, 2, 2);
      await seedConfirmed('neighbor-b', NEIGHBOR_B_START, NEIGHBOR_B_END, 2, 2);
      crossCheckRealSemantic();

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
      crossCheckRealSemantic();

      const rescheduled = await repo.rescheduleWithCapacity('mover', buildReschedule('2026-08-10T15:00:00.000Z', REQUEST_START, REQUEST_END, 2, 2));
      expect(rescheduled).toMatchObject({ startsAt: REQUEST_START });
    });
  });

  describe('rescheduleWithCapacity self-heals legacy occupancy_units (patch-05-r1 Fix 3)', () => {
    it('sets occupancy_units on a pre-migration-style NULL row it moves, matching occupancyFor(service, quantity)', async () => {
      const now = '2026-08-09T10:00:00.000Z';
      // insertHold (not insertHoldWithCapacity) never writes occupancy_units/occupancy_ends_at,
      // reproducing a pre-migration-0008 row -- exactly the NULL-column case migrations/
      // 0008_occupancy_capacity.sql documents.
      await repo.insertHold({
        id: 'legacy-row', reference: 'BKT-2026-legacy-row', serviceSlug: TOUR_SLUG, quantity: 5,
        pickupType: 'default', startsAt: '2026-08-10T13:00:00.000Z', endsAt: '2026-08-10T14:00:00.000Z',
        locale: 'en', priceMinor: 10000, currency: 'eur', holdExpiresAt: '2026-12-31T00:00:00.000Z',
        cancelToken: 'cancel-legacy-row', operatorToken: 'operator-legacy-row', createdAt: now, updatedAt: now,
      });
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
});
