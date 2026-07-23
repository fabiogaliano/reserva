import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository, HoldLimitExceededError } from '../../src/repo';

interface TestEnv {
  BOOKKIT_DB: D1Database;
}

const db = (env as unknown as TestEnv).BOOKKIT_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM refund_operations').run();
});

describe('D1 booking repository', () => {
  it('creates, reads, updates, and expires a hold through the real D1 binding', async () => {
    const created = await repo.insertHold({
      id: 'booking-1',
      reference: 'BKT-2026-001',
      tourSlug: 'vintage',
      people: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      locale: 'en',
      priceCents: 12000,
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token',
      operatorToken: 'operator-token',
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });

    expect(created).toMatchObject({ status: 'hold', tourSlug: 'vintage', people: 2 });
    await repo.updateBooking(created.id, {
      stripeSessionId: 'cs_test',
      updatedAt: '2026-07-21T10:01:00.000Z',
    });
    await expect(repo.getBookingBySessionId('cs_test')).resolves.toMatchObject({ id: created.id });
    await expect(repo.sweepExpiredHolds('2026-07-21T10:35:00.000Z')).resolves.toBe(0);
    await expect(repo.sweepExpiredHolds('2026-07-21T10:35:00.001Z')).resolves.toBe(1);
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ status: 'expired', holdExpiresAt: null });
  });

  it('serializes confirmation leases and expires holds with compare-and-set semantics', async () => {
    const created = await repo.insertHold({
      id: 'booking-lease',
      reference: 'BKT-2026-002',
      tourSlug: 'vintage',
      people: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T11:00:00.000Z',
      endsAt: '2026-08-01T12:00:00.000Z',
      locale: 'en',
      priceCents: 12000,
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token-lease',
      operatorToken: 'operator-token-lease',
      holdIp: '203.0.113.1',
      maxActiveHoldsForIp: 1,
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });

    await expect(repo.insertHold({
      id: 'booking-over-limit',
      reference: 'BKT-2026-003',
      tourSlug: 'vintage',
      people: 1,
      pickupType: 'default',
      startsAt: '2026-08-01T13:00:00.000Z',
      endsAt: '2026-08-01T14:00:00.000Z',
      locale: 'en',
      priceCents: 12000,
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token-over-limit',
      operatorToken: 'operator-token-over-limit',
      holdIp: '203.0.113.1',
      maxActiveHoldsForIp: 1,
      createdAt: '2026-07-21T10:00:01.000Z',
      updatedAt: '2026-07-21T10:00:01.000Z',
    })).rejects.toBeInstanceOf(HoldLimitExceededError);

    const claims = await Promise.all([
      repo.acquireConfirmationLease(created.id, 'lease-a', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z'),
      repo.acquireConfirmationLease(created.id, 'lease-b', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await repo.releaseConfirmationLease(created.id, claims[0] ? 'lease-a' : 'lease-b');
    await expect(repo.acquireConfirmationLease(created.id, 'lease-c', '2026-07-21T10:00:01.000Z', '2026-07-21T10:05:01.000Z')).resolves.toBe(true);
    await repo.releaseConfirmationLease(created.id, 'lease-c');

    await repo.transitionToConfirmed(created.id, { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
    await expect(repo.expireHold(created.id, '2026-07-21T10:02:00.000Z')).resolves.toBeNull();
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('persists capacity overrides and returns only changed feed rows', async () => {
    await repo.upsertDayOverride('2026-08-01', 1, 'reduced fleet');
    await expect(repo.getDayOverride('2026-08-01')).resolves.toEqual({
      date: '2026-08-01',
      capacity: 1,
      reason: 'reduced fleet',
    });
    await expect(repo.listSince('2026-01-01T00:00:00.000Z')).resolves.toEqual([]);
    await repo.deleteDayOverride('2026-08-01');
    await expect(repo.getDayOverride('2026-08-01')).resolves.toBeNull();
  });
});
