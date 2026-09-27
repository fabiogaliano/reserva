// A new booking's reference continues from the highest one already used that year. Operators delete
// test and abandoned rows, and numbering from a row count would then land back inside the range
// already taken, colliding until checkout gives up.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { handleCheckout } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

function checkout(): Request {
  return new Request('https://example.test/api/booking/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en' }),
  });
}

async function referenceAfter(existing: string[]): Promise<string | undefined> {
  // Cancelled and weeks away, so the seeded rows never touch the checkout's capacity.
  const seeded = existing.map((reference, index) => booking({
    id: `seed-${index}`, reference, status: 'cancelled',
    startsAt: '2026-09-01T09:00:00.000Z', endsAt: '2026-09-01T10:00:00.000Z',
    operatorToken: `op-seed-${index}`, cancelToken: `c-seed-${index}`,
  }));
  const repo = fakeRepository(seeded);
  const context = createReservaContext({ config, db: {} as D1Database, repo, clock: () => new Date('2026-06-14T08:00:00.000Z'), providers: providers() });
  const response = await handleCheckout(checkout(), context);
  expect(response.status).toBe(201);
  return [...repo.rows.values()].find((row) => !existing.includes(row.reference))?.reference;
}

describe('checkout reference numbering', () => {
  it('starts the year at 001', async () => {
    await expect(referenceAfter([])).resolves.toBe('LVT-2026-001');
  });

  it('continues after the highest reference when earlier rows were deleted', async () => {
    await expect(referenceAfter(['LVT-2026-003', 'LVT-2026-040'])).resolves.toBe('LVT-2026-041');
  });

  it('ignores other years and non-numeric suffixes', async () => {
    await expect(referenceAfter(['LVT-2025-900', 'LVT-2026-X99', 'LVT-2026-007'])).resolves.toBe('LVT-2026-008');
  });
});
