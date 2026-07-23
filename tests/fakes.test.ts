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

  it('refuses a confirmation lease for an unknown booking id, like the real UPDATE ... WHERE id = ?', async () => {
    const repo = fakeRepository([booking({ id: 'b-known' })]);

    await expect(repo.acquireConfirmationLease('b-unknown', 'token-1', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(false);
    await expect(repo.acquireConfirmationLease('b-known', 'token-1', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(true);
  });
});
