import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository, type BookingInsert, type BookingRepository } from '../../src/repo';
import { seedHold } from './seed';

interface TestEnv {
  RESERVA_DB: D1Database;
}

// Real-D1 coverage for the capacity feature (per-day overrides + capacity defaults) and the two
// hottest list queries (listOccupancyBookings and the admin list queries), following repo-d1.test.ts's
// established pattern (createBookingRepository(db), beforeEach DELETEs, encRepo round trip).
const db = (env as unknown as TestEnv).RESERVA_DB;
const repo = createBookingRepository(db);
const encRepo = createBookingRepository(db, (name) => (name === 'RESERVA_TOKEN_ENC_KEY' ? 'test-only-token-encryption-secret' : undefined));

beforeEach(async () => {
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM capacity_defaults').run();
  await db.prepare('DELETE FROM admin_change_history').run();
});

// The required audit param, threaded through the batched writes below.
// The history rows it produces are covered end to end by tests/workers/admin-history.test.ts —
// this file stays focused on the day-override/capacity-default mechanics it already covered.
const TEST_AUDIT = { actor: 'operator@example.test', changedAt: '2026-08-01T00:00:00.000Z' };

function seedSlotHold(
  repository: BookingRepository,
  id: string,
  startsAt: string,
  endsAt: string,
  holdExpiresAt: string,
  overrides: Partial<BookingInsert> = {},
) {
  return seedHold(repository, {
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
    await repo.upsertDayOverrides(['2026-08-01'], 2, 'initial', TEST_AUDIT);
    await expect(repo.getDayOverride('2026-08-01')).resolves.toEqual({ date: '2026-08-01', capacity: 2, reason: 'initial' });

    // Same date again -> ON CONFLICT(date) DO UPDATE, not a second row.
    await repo.upsertDayOverrides(['2026-08-01'], 5, 'revised', TEST_AUDIT);
    await expect(repo.getDayOverride('2026-08-01')).resolves.toEqual({ date: '2026-08-01', capacity: 5, reason: 'revised' });

    await repo.deleteDayOverrides(['2026-08-01'], TEST_AUDIT);
    await expect(repo.getDayOverride('2026-08-01')).resolves.toBeNull();
  });

  it('listDayOverrides includes rows exactly on the from/to boundaries, excludes rows outside them, and orders by date', async () => {
    for (const [date, capacity, reason] of [
      ['2026-07-31', 1, 'before range'],
      ['2026-08-05', 4, 'on to'],
      ['2026-08-01', 2, 'on from'],
      ['2026-08-06', 5, 'after range'],
      ['2026-08-03', 3, 'middle'],
    ] as const) await repo.upsertDayOverrides([date], capacity, reason, TEST_AUDIT);

    await expect(repo.listDayOverrides('2026-08-01', '2026-08-05')).resolves.toEqual([
      { date: '2026-08-01', capacity: 2, reason: 'on from' },
      { date: '2026-08-03', capacity: 3, reason: 'middle' },
      { date: '2026-08-05', capacity: 4, reason: 'on to' },
    ]);
  });
});

describe('capacity defaults against real D1', () => {
  it('round trips through upsert, a conflict-path update, and delete', async () => {
    await repo.upsertCapacityDefault('2026-08-10', 3, 'van in service', TEST_AUDIT);
    await expect(repo.listCapacityDefaults()).resolves.toEqual([{ fromDate: '2026-08-10', capacity: 3, reason: 'van in service' }]);

    await repo.upsertCapacityDefault('2026-08-10', 1, 'van out of service', TEST_AUDIT);
    await expect(repo.listCapacityDefaults()).resolves.toEqual([{ fromDate: '2026-08-10', capacity: 1, reason: 'van out of service' }]);

    await repo.deleteCapacityDefault('2026-08-10', TEST_AUDIT);
    await expect(repo.listCapacityDefaults()).resolves.toEqual([]);
  });

  it('listCapacityDefaults orders by from_date regardless of insert order', async () => {
    await repo.upsertCapacityDefault('2026-09-01', 2, null, TEST_AUDIT);
    await repo.upsertCapacityDefault('2026-08-01', 4, null, TEST_AUDIT);
    await repo.upsertCapacityDefault('2026-08-15', 3, null, TEST_AUDIT);

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
    await repo.upsertDayOverrides(dates, 1, 'holiday', TEST_AUDIT);
    await expect(repo.listDayOverrides('2026-08-01', '2026-08-03')).resolves.toEqual(
      dates.map((date) => ({ date, capacity: 1, reason: 'holiday' })),
    );

    await repo.deleteDayOverrides(['2026-08-01', '2026-08-03'], TEST_AUDIT);
    await expect(repo.listDayOverrides('2026-08-01', '2026-08-03')).resolves.toEqual([
      { date: '2026-08-02', capacity: 1, reason: 'holiday' },
    ]);
  });

  // Rollback of a failed half is proven in tests/workers/admin-history.test.ts.
  it('upsertDayOverrides writes one admin_change_history row per date, atomically with the day_overrides rows', async () => {
    const dates = ['2026-08-01', '2026-08-02'];
    await repo.upsertDayOverrides(dates, 2, 'batched history', TEST_AUDIT);

    const history = await repo.listAdminChangeHistory(10);
    expect(history).toHaveLength(2);
    expect(history.every((entry) => entry.domain === 'day_override' && entry.action === 'upsert'
      && entry.actor === TEST_AUDIT.actor && entry.changedAt === TEST_AUDIT.changedAt
      && entry.value === JSON.stringify({ capacity: 2, reason: 'batched history' }))).toBe(true);
    expect(new Set(history.map((entry) => entry.itemKey))).toEqual(new Set(dates));

    await repo.deleteDayOverrides(dates, TEST_AUDIT);
    const afterDelete = await repo.listAdminChangeHistory(10);
    expect(afterDelete).toHaveLength(4);
    expect(afterDelete.filter((entry) => entry.action === 'delete')).toHaveLength(2);
  });

  it('an empty dates array is a no-op for both plural methods', async () => {
    await repo.upsertDayOverrides(['2026-08-01'], 5, 'untouched', TEST_AUDIT);
    await repo.upsertDayOverrides([], 9, 'should never land', TEST_AUDIT);
    await repo.deleteDayOverrides([], TEST_AUDIT);
    await expect(repo.listDayOverrides('2026-01-01', '2026-12-31')).resolves.toEqual([
      { date: '2026-08-01', capacity: 5, reason: 'untouched' },
    ]);
  });
});

describe('listOccupancyBookings(from, to) against real D1', () => {
  it('includes starts_at exactly at from, excludes exactly at to, excludes cancelled/no_show, includes hold/confirmed, ordered by starts_at', async () => {
    // Inserted out of starts_at order, so a passing assertion actually proves ORDER BY starts_at
    // rather than just mirroring insertion order.
    await seedSlotHold(repo, 'occ-confirmed', '2026-08-01T12:00:00.000Z', '2026-08-01T13:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('occ-confirmed', { expectedStatusIn: ['hold'], updatedAt: '2026-08-01T00:01:00.000Z' });

    await seedSlotHold(repo, 'occ-on-from', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', '2026-12-31T00:00:00.000Z');

    await seedSlotHold(repo, 'occ-on-to', '2026-08-02T00:00:00.000Z', '2026-08-02T01:00:00.000Z', '2026-12-31T00:00:00.000Z');

    await seedSlotHold(repo, 'occ-cancelled', '2026-08-01T14:00:00.000Z', '2026-08-01T15:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToCancelled('occ-cancelled', {
      expectedStatusIn: ['hold'], cancelledAt: '2026-08-01T00:02:00.000Z', cancelledBy: 'customer', updatedAt: '2026-08-01T00:02:00.000Z',
    });

    await seedSlotHold(repo, 'occ-noshow', '2026-08-01T16:00:00.000Z', '2026-08-01T17:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('occ-noshow', { expectedStatusIn: ['hold'], updatedAt: '2026-08-01T00:01:00.000Z' });
    await repo.transitionToNoShow('occ-noshow', { expectedStatusIn: ['confirmed'], updatedAt: '2026-08-01T00:03:00.000Z' });

    const result = await repo.listOccupancyBookings('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
    expect(result.map((booking) => booking.id)).toEqual(['occ-on-from', 'occ-confirmed']);
  });
});

describe('listLiveBookings against real D1', () => {
  const now = '2026-08-01T00:00:00.000Z';
  const before = '2026-09-01T00:00:00.000Z';

  it('includes confirmed and live holds in [from, before), excludes an expired hold and rows outside the window, ordered by starts_at', async () => {
    await seedSlotHold(repo, 'future-confirmed', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('future-confirmed', { expectedStatusIn: ['hold'], updatedAt: now });

    await seedSlotHold(repo, 'live-hold', '2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z', '2026-08-01T00:00:01.000Z');

    await seedSlotHold(repo, 'expired-hold', '2026-08-04T09:00:00.000Z', '2026-08-04T10:00:00.000Z', '2026-07-31T23:59:59.999Z');

    await seedSlotHold(repo, 'past-confirmed', '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('past-confirmed', { expectedStatusIn: ['hold'], updatedAt: now });

    // Exactly on `before`: the upper bound is exclusive.
    await seedSlotHold(repo, 'on-before', before, '2026-09-01T01:00:00.000Z', '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed('on-before', { expectedStatusIn: ['hold'], updatedAt: now });

    const result = await repo.listLiveBookings(now, before, now, 10);
    expect(result.map((booking) => booking.id)).toEqual(['live-hold', 'future-confirmed']);
    await expect(repo.listLiveBookings(now, before, now, 1)).resolves.toHaveLength(1);
  });

  it('without a token encryption key, hydrates nohash:-prefixed placeholder tokens (mirrors repo-d1.test.ts\'s no-key expectations)', async () => {
    await seedSlotHold(repo, 'token-plain', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', '2026-12-31T00:00:00.000Z', {
      cancelToken: 'plain-cancel', operatorToken: 'plain-operator',
    });

    const listed = await repo.listAdminBookings({ from: now }, { order: 'asc', limit: 10, offset: 0 });
    expect(listed[0]?.cancelToken).toMatch(/^nohash:/);
    expect(listed[0]?.operatorToken).toMatch(/^nohash:/);

    // Nothing to decrypt with, so the explicit hydration pass leaves the placeholders in place.
    const [result] = await repo.hydrateBookingTokens(listed);
    expect(result?.cancelToken).toMatch(/^nohash:/);
    expect(result?.operatorToken).toMatch(/^nohash:/);
  });

  it('with a token encryption key configured, hydrateBookingTokens restores the real presented tokens (full encrypt-at-insert/decrypt-at-read round trip)', async () => {
    await seedSlotHold(encRepo, 'token-enc', '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', '2026-12-31T00:00:00.000Z', {
      cancelToken: 'real-cancel', operatorToken: 'real-operator',
    });

    // The list query itself no longer decrypts — an AES-GCM pass per row the renderer may never
    // emit is waste — so the placeholders survive until the caller asks for the real tokens.
    const listed = await encRepo.listAdminBookings({ from: now }, { order: 'asc', limit: 10, offset: 0 });
    expect(listed[0]?.cancelToken).toMatch(/^nohash:/);
    expect(listed[0]?.operatorToken).toMatch(/^nohash:/);

    const [result] = await encRepo.hydrateBookingTokens(listed);
    expect(result?.cancelToken).toBe('real-cancel');
    expect(result?.operatorToken).toBe('real-operator');
  });
});

describe('listAdminBookings/countAdminBookings against real D1', () => {
  const now = '2026-08-01T00:00:00.000Z';

  async function seedConfirmed(id: string, startsAt: string): Promise<void> {
    await seedSlotHold(repo, id, startsAt, new Date(Date.parse(startsAt) + 3_600_000).toISOString(), '2026-12-31T00:00:00.000Z');
    await repo.transitionToConfirmed(id, { expectedStatusIn: ['hold'], updatedAt: now });
  }

  it('applies the window and status in SQL, so "All" is every status and a status filter is a subset of it', async () => {
    await seedConfirmed('adm-past', '2026-07-20T09:00:00.000Z');
    await seedConfirmed('adm-upcoming', '2026-08-05T09:00:00.000Z');
    // A hold that lapsed and was swept: still an upcoming row, with status expired.
    await seedSlotHold(repo, 'adm-expired', '2026-08-06T09:00:00.000Z', '2026-08-06T10:00:00.000Z', '2026-07-31T00:00:00.000Z');
    await repo.sweepExpiredHolds(now);

    const all = await repo.listAdminBookings({ from: now }, { order: 'asc', limit: 10, offset: 0 });
    expect(all.map((booking) => booking.id)).toEqual(['adm-upcoming', 'adm-expired']);
    await expect(repo.countAdminBookings({ from: now })).resolves.toBe(2);

    const confirmed = await repo.listAdminBookings({ from: now, status: 'confirmed' }, { order: 'asc', limit: 10, offset: 0 });
    expect(confirmed.map((booking) => booking.id)).toEqual(['adm-upcoming']);
    await expect(repo.countAdminBookings({ from: now, status: 'expired' })).resolves.toBe(1);

    const past = await repo.listAdminBookings({ before: now }, { order: 'desc', limit: 10, offset: 0 });
    expect(past.map((booking) => booking.id)).toEqual(['adm-past']);

    // The default "Active" view: a set of statuses, bound as parameters in one IN clause.
    const active = await repo.listAdminBookings({ from: now, statuses: ['confirmed', 'hold', 'no_show'] }, { order: 'asc', limit: 10, offset: 0 });
    expect(active.map((booking) => booking.id)).toEqual(['adm-upcoming']);
    await expect(repo.countAdminBookings({ from: now, statuses: ['confirmed', 'expired'] })).resolves.toBe(2);
    await expect(repo.countAdminBookings({ from: now, statuses: [] })).resolves.toBe(0);
  });

  it('reads the highest numeric reference under a prefix, past deleted rows and odd suffixes', async () => {
    await expect(repo.maxReferenceSequence('BKT-2026-')).resolves.toBe(0);
    const hold = (id: string, reference: string) =>
      seedSlotHold(repo, id, '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', '2026-12-31T00:00:00.000Z', { reference });
    await hold('ref-a', 'BKT-2026-003');
    await hold('ref-b', 'BKT-2026-040');
    await hold('ref-c', 'BKT-2026-X99');
    await hold('ref-d', 'BKT-2025-900');
    await hold('ref-e', 'bkt-2026-500');
    await expect(repo.maxReferenceSequence('BKT-2026-')).resolves.toBe(40);
    await expect(repo.maxReferenceSequence('BKT-2025-')).resolves.toBe(900);
  });

  it('pages in the requested direction with an id tie-break, so no row repeats or goes missing across pages', async () => {
    await seedConfirmed('adm-b', '2026-08-05T09:00:00.000Z');
    await seedConfirmed('adm-a', '2026-08-05T09:00:00.000Z');
    await seedConfirmed('adm-c', '2026-08-06T09:00:00.000Z');

    const ascending = [
      ...await repo.listAdminBookings({ from: now }, { order: 'asc', limit: 2, offset: 0 }),
      ...await repo.listAdminBookings({ from: now }, { order: 'asc', limit: 2, offset: 2 }),
    ];
    expect(ascending.map((booking) => booking.id)).toEqual(['adm-a', 'adm-b', 'adm-c']);

    const descending = await repo.listAdminBookings({ from: now }, { order: 'desc', limit: 10, offset: 0 });
    expect(descending.map((booking) => booking.id)).toEqual(['adm-c', 'adm-b', 'adm-a']);
  });
});
