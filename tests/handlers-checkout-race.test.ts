import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { handleCheckout } from '../src/handlers';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const checkoutRequest = (quantity: number) => new Request('https://example.test/api/booking/checkout', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity, pickup: 'default', locale: 'en' }),
});

describe('checkout race for the last slot (was spec §11 / §6 accepted TOCTOU, now fixed)', () => {
  // Intentional behavior-change test, not a weakening: insertHoldWithCapacity now re-evaluates
  // occupancy inside the same atomic INSERT as the write, so only one of two requests that both
  // read the slot as empty can still win it.
  it('lets only one of two concurrent checkouts hold the last slot when interleaved: one 201, one 409, exactly one hold row', async () => {
    const repo = fakeRepository();
    const singleCapacityConfig = { ...config, capacity: { default: 1 } };
    // Gate listOccupancyBookings so both requests finish reading (and see the slot
    // empty) before either proceeds to insertHoldWithCapacity — this forces the interleaving
    // that used to cause the oversell; the atomic write below is what now prevents it.
    let readers = 0;
    let releaseReaders = (): void => undefined;
    const bothRead = new Promise<void>((resolve) => { releaseReaders = resolve; });
    const realListOccupancyBookings = repo.listOccupancyBookings;
    repo.listOccupancyBookings = async (from, to) => {
      const result = await realListOccupancyBookings(from, to);
      readers += 1;
      if (readers >= 2) releaseReaders();
      await bothRead;
      return result;
    };
    const context = createReservaContext({
      config: singleCapacityConfig,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const [first, second] = await Promise.all([
      handleCheckout(checkoutRequest(2), context),
      handleCheckout(checkoutRequest(2), context),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    await expect(loser.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
    expect([...repo.rows.values()].filter((row) => row.status === 'hold')).toHaveLength(1);
  });

  it('rejects the second sequential checkout for the last slot with 409 slot_unavailable', async () => {
    const repo = fakeRepository();
    const singleCapacityConfig = { ...config, capacity: { default: 1 } };
    const context = createReservaContext({
      config: singleCapacityConfig,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const first = await handleCheckout(checkoutRequest(2), context);
    expect(first.status).toBe(201);

    const second = await handleCheckout(checkoutRequest(2), context);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
    expect([...repo.rows.values()].filter((row) => row.status === 'hold')).toHaveLength(1);
  });
});
