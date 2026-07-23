import { describe, expect, it } from 'vitest';
import { booking } from './fixtures';
import { fakeRepository } from './fakes';

describe('fakeRepository fidelity to the real D1 repository', () => {
  it('exposes usable tokens only through hydrated reads when an encryption key is configured', async () => {
    const seeded = booking({
      id: 'b-token-hydration',
      reference: 'LVT-2026-HYDRATION',
      startsAt: '2026-06-20T09:00:00.000Z',
      updatedAt: '2026-06-14T08:01:00.000Z',
      cancelToken: 'cancel-hydration-token',
      operatorToken: 'operator-hydration-token',
    });
    const withoutKey = fakeRepository([seeded]);
    const withKey = fakeRepository([seeded], { tokenEncryptionKey: 'test-token-key' });

    expect(withoutKey.rows.get(seeded.id)?.operatorToken).toMatch(/^nohash:/);
    await expect(withoutKey.getBookingById(seeded.id)).resolves.toMatchObject({ operatorToken: expect.stringMatching(/^nohash:/) });
    await expect(withKey.getBookingByReference(seeded.reference)).resolves.toMatchObject({ operatorToken: expect.stringMatching(/^nohash:/) });
    await expect(withKey.listOccupancyBookings('2026-06-20T08:00:00.000Z', '2026-06-20T10:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({ operatorToken: expect.stringMatching(/^nohash:/) }),
    ]);
    await expect(withKey.getBookingById(seeded.id)).resolves.toMatchObject({
      cancelToken: seeded.cancelToken,
      operatorToken: seeded.operatorToken,
    });
    await expect(withKey.listUpcoming('2026-06-14T08:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({ operatorToken: seeded.operatorToken }),
    ]);
    await expect(withKey.listSince('2026-06-14T08:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({ cancelToken: seeded.cancelToken }),
    ]);
  });

  it('matches real no-op and conflict-update behavior for partial booking writes', async () => {
    const seeded = booking({ id: 'b-fake-write-parity', customerEmail: 'customer@example.test', updatedAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);

    const patch = { updatedAt: '2026-06-14T08:01:00.000Z' };
    Object.assign(patch, { customerEmail: undefined });
    const updated = await repo.updateBooking(seeded.id, patch);
    expect(updated).toMatchObject({ customerEmail: seeded.customerEmail, updatedAt: '2026-06-14T08:01:00.000Z' });

    await repo.acquireConfirmationLease(seeded.id, 'lease-fake-write-parity', '2026-06-14T08:01:00.000Z', '2026-06-14T08:06:00.000Z');
    const applied = await repo.applyConfirmedPaymentDetails(seeded.id, {}, 'lease-fake-write-parity', '2026-06-14T08:02:00.000Z');
    expect(applied).toBe(false);
    expect(repo.rows.get(seeded.id)?.updatedAt).toBe('2026-06-14T08:01:00.000Z');

    await repo.claimRefundOperation({
      id: 'op-fake-write-original', bookingId: seeded.id, paymentIntent: seeded.stripePaymentIntent, choice: 'full', requestedAt: '2026-06-14T08:00:00.000Z',
    });
    await repo.upsertRefundOperation({
      id: 'op-fake-write-replacement', bookingId: seeded.id, paymentIntent: seeded.stripePaymentIntent, choice: 'full', status: 'failed',
      stripeRefundId: null, amountCents: null, requestedAt: '2026-06-14T08:02:00.000Z', resolvedAt: '2026-06-14T08:02:00.000Z',
    });
    expect(repo.refundOperations.get(seeded.id)?.id).toBe('op-fake-write-original');
  });

  it('refuses a confirmation lease for an unknown booking id, like the real UPDATE ... WHERE id = ?', async () => {
    const repo = fakeRepository([booking({ id: 'b-known' })]);

    await expect(repo.acquireConfirmationLease('b-unknown', 'token-1', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(false);
    await expect(repo.acquireConfirmationLease('b-known', 'token-1', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(true);
  });
});
