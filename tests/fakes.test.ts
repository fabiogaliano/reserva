import { describe, expect, it } from 'vitest';
import { booking } from './fixtures';
import { fakeRepository } from './fakes';

describe('fakeRepository fidelity to the real D1 repository', () => {
  it('refuses a confirmation lease for an unknown booking id, like the real UPDATE ... WHERE id = ?', async () => {
    const repo = fakeRepository([booking({ id: 'b-known' })]);

    await expect(repo.acquireConfirmationLease('b-unknown', 'token-1', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(false);
    await expect(repo.acquireConfirmationLease('b-known', 'token-1', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(true);
  });
});
