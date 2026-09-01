import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository, type BookingInsert, type BookingRepository } from '../../src/repo';

interface TestEnv {
  BOOKKIT_DB: D1Database;
}

// Plan 003: real-D1 coverage for the capacity feature (per-day overrides + capacity defaults) and
// the two hottest list queries (listOccupancyBookings/listUpcoming), none of which ran against
// actual SQL before this file existed — see tests/workers/repo-d1.test.ts for the established
// pattern this file follows (createBookingRepository(db) on the BOOKKIT_DB binding, beforeEach
// DELETEs, encRepo for the token-encryption round trip).
const db = (env as unknown as TestEnv).BOOKKIT_DB;
const repo = createBookingRepository(db);
const encRepo = createBookingRepository(db, (name) => (name === 'BOOKKIT_TOKEN_ENC_KEY' ? 'test-only-token-encryption-secret' : undefined));

beforeEach(async () => {
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM capacity_defaults').run();
});

function seedHold(
  repository: BookingRepository,
  id: string,
  startsAt: string,
  endsAt: string,
  holdExpiresAt: string,
  overrides: Partial<BookingInsert> = {},
) {
  return repository.insertHold({
    id,
    reference: `BKT-2026-${id}`,
    serviceSlug: 'vintage',
    quantity: 2,
    pickupType: 'default',
    startsAt,
    endsAt,
    locale: 'en',
    priceMinor: 10000,
    currency: 'eur',
    holdExpiresAt,
    cancelToken: `cancel-${id}`,
    operatorToken: `operator-${id}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('day overrides against real D1', () => {
  it('round trips through upsert, a conflict-path update, and delete', async () => {
    await repo.upsertDayOverride('2026-08-01', 2, 'initial');
    await expect(repo.getDayOverride('2026-08-01')).resolves.toEqual({ date: '2026-08-01', capacity: 2, reason: 'initial' });

    // Same date again -> ON CONFLICT(date) DO UPDATE, not a second row.
    await repo.upsertDayOverride('2026-08-01', 5, 'revised');
    await expect(repo.getDayOverride('2026-08-01')).resolves.toEqual({ date: '2026-08-01', capacity: 5, reason: 'revised' });

    await repo.deleteDayOverride('2026-08-01');
    await expect(repo.getDayOverride('2026-08-01')).resolves.toBeNull();
  });

  it('listDayOverrides includes rows exactly on the from/to boundaries, excludes rows outside them, and orders by date', async () => {
    await repo.upsertDayOverride('2026-07-31', 1, 'before range');
    await repo.upsertDayOverride('2026-08-05', 4, 'on to');
    await repo.upsertDayOverride('2026-08-01', 2, 'on from');
    await repo.upsertDayOverride('2026-08-06', 5, 'after range');
    await repo.upsertDayOverride('2026-08-03', 3, 'middle');

    await expect(repo.listDayOverrides('2026-08-01', '2026-08-05')).resolves.toEqual([
      { date: '2026-08-01', capacity: 2, reason: 'on from' },
      { date: '2026-08-03', capacity: 3, reason: 'middle' },
      { date: '2026-08-05', capacity: 4, reason: 'on to' },
    ]);
  });
});

describe('capacity defaults against real D1', () => {
  it('round trips through upsert, a conflict-path update, and delete', async () => {
    await repo.upsertCapacityDefault('2026-08-10', 3, 'van in service');
    await expect(repo.listCapacityDefaults()).resolves.toEqual([{ fromDate: '2026-08-10', capacity: 3, reason: 'van in service' }]);

    await repo.upsertCapacityDefault('2026-08-10', 1, 'van out of service');
    await expect(repo.listCapacityDefaults()).resolves.toEqual([{ fromDate: '2026-08-10', capacity: 1, reason: 'van out of service' }]);

    await repo.deleteCapacityDefault('2026-08-10');
    await expect(repo.listCapacityDefaults()).resolves.toEqual([]);
  });

  it('listCapacityDefaults orders by from_date regardless of insert order', async () => {
    await repo.upsertCapacityDefault('2026-09-01', 2, null);
    await repo.upsertCapacityDefault('2026-08-01', 4, null);
    await repo.upsertCapacityDefault('2026-08-15', 3, null);

    await expect(repo.listCapacityDefaults()).resolves.toEqual([
      { fromDate: '2026-08-01', capacity: 4, reason: null },
      { fromDate: '2026-08-15', capacity: 3, reason: null },
      { fromDate: '2026-09-01', capacity: 2, reason: null },
    ]);
  });
});

describe('plural batched day-override methods against real D1', () => {
  it('upsertDayOverrides lands every date in a single db.batch() call, and deleteDayOverrides removes exactly those dates', async () => {
    const dates = ['2026-08-01', '2026-08-02', '2026-08-03'];
    await repo.upsertDayOverrides(dates, 1, 'holiday');
    await expect(repo.listDayOverrides('2026-08-01', '2026-08-03')).resolves.toEqual(
      dates.map((date) => ({ date, capacity: 1, reason: 'holiday' })),
    );

    await repo.deleteDayOverrides(['2026-08-01', '2026-08-03']);
    await expect(repo.listDayOverrides('2026-08-01', '2026-08-03')).resolves.toEqual([
      { date: '2026-08-02', capacity: 1, reason: 'holiday' },
    ]);
  });

  it('upsertDayOverrides overwrites an existing row on conflict, same as the singular method', async () => {
    await repo.upsertDayOverride('2026-08-01', 5, 'original');
    await repo.upsertDayOverrides(['2026-08-01'], 2, 'batched update');
    await expect(repo.getDayOverride('2026-08-01')).resolves.toEqual({ date: '2026-08-01', capacity: 2, reason: 'batched update' });
  });

  it('an empty dates array is a no-op for both plural methods', async () => {
    await repo.upsertDayOverride('2026-08-01', 5, 'untouched');
    await repo.upsertDayOverrides([], 9, 'should never land');
    await repo.deleteDayOverrides([]);
    await expect(repo.listDayOverrides('2026-01-01', '2026-12-31')).resolves.toEqual([
      { date: '2026-08-01', capacity: 5, reason: 'untouched' },
    ]);
  });
});

describe('listOccupancyBookings(from, to) against real D1', () => {
  it('includes starts_at exactly at from, excludes exactly at to, excludes cancelled/no_show, includes hold/confirmed, ordered by starts_at', async () => {
    // Inserted out of starts_at order, so a passing assertion actually proves ORDER BY starts_at
    // rather than just mirroring insertion order.
    await seedHold(repo, 'occ-confirmed', '2026-08-01T12:00:00.000Z', '2026-08-01T13:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('occ-confirmed', { expectedStatusIn: ['hold'], updatedAt: '2026-08-01T00:01:00.000Z' });

    await seedHold(repo, 'occ-on-from', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', '2026-12-31T00:00:00.000Z');

    await seedHold(repo, 'occ-on-to', '2026-08-02T00:00:00.000Z', '2026-08-02T01:00:00.000Z', '2026-12-31T00:00:00.000Z');

    await seedHold(repo, 'occ-cancelled', '2026-08-01T14:00:00.000Z', '2026-08-01T15:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToCancelled('occ-cancelled', {
      expectedStatusIn: ['hold'], cancelledAt: '2026-08-01T00:02:00.000Z', cancelledBy: 'customer', updatedAt: '2026-08-01T00:02:00.000Z',
    });

    await seedHold(repo, 'occ-noshow', '2026-08-01T16:00:00.000Z', '2026-08-01T17:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('occ-noshow', { expectedStatusIn: ['hold'], updatedAt: '2026-08-01T00:01:00.000Z' });
    await repo.transitionToNoShow('occ-noshow', { expectedStatusIn: ['confirmed'], updatedAt: '2026-08-01T00:03:00.000Z' });

    const result = await repo.listOccupancyBookings('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
    expect(result.map((booking) => booking.id)).toEqual(['occ-on-from', 'occ-confirmed']);
  });
});

describe('listUpcoming(now) against real D1', () => {
  const now = '2026-08-01T00:00:00.000Z';

  it('includes future confirmed and live holds, excludes an exactly-expired hold and a past confirmed booking, ordered by starts_at', async () => {
    await seedHold(repo, 'future-confirmed', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('future-confirmed', { expectedStatusIn: ['hold'], updatedAt: now });

    await seedHold(repo, 'live-hold', '2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z', '2026-08-01T00:00:01.000Z');

    // hold_expires_at exactly equal to now: the query's `hold_expires_at > ?` is strict, so this
    // must be excluded, not a boundary-inclusive match.
    await seedHold(repo, 'expired-hold', '2026-08-04T09:00:00.000Z', '2026-08-04T10:00:00.000Z', now);

    await seedHold(repo, 'past-confirmed', '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('past-confirmed', { expectedStatusIn: ['hold'], updatedAt: now });

    const result = await repo.listUpcoming(now);
    expect(result.map((booking) => booking.id)).toEqual(['live-hold', 'future-confirmed']);
  });

  it('without a token encryption key, hydrates nohash:-prefixed placeholder tokens (mirrors repo-d1.test.ts\'s no-key expectations)', async () => {
    await seedHold(repo, 'token-plain', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', '2026-12-31T00:00:00.000Z', {
      cancelToken: 'plain-cancel', operatorToken: 'plain-operator',
    });

    const [result] = await repo.listUpcoming(now);
    expect(result?.cancelToken).toMatch(/^nohash:/);
    expect(result?.operatorToken).toMatch(/^nohash:/);
  });

  it('with a token encryption key configured, hydrates the real presented tokens (full encrypt-at-insert/decrypt-at-read round trip)', async () => {
    await seedHold(encRepo, 'token-enc', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', '2026-12-31T00:00:00.000Z', {
      cancelToken: 'real-cancel', operatorToken: 'real-operator',
    });

    const [result] = await encRepo.listUpcoming(now);
    expect(result?.cancelToken).toBe('real-cancel');
    expect(result?.operatorToken).toBe('real-operator');
  });
});
