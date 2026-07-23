import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleCheckout } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const checkoutRequest = (people: number) => new Request('https://example.test/api/booking/checkout', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tourSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', people, pickupType: 'default', locale: 'en' }),
});

describe('checkout race for the last slot (BK-CAP-001 / AR-001 — was spec §11 / §6 accepted TOCTOU, now fixed)', () => {
  // Intentional behavior-change test, not a weakening: this is the same interleaving harness
  // that used to prove the accepted oversell window (both checkouts succeeding). It now proves
  // the fix — insertHoldWithCapacity re-evaluates occupancy inside the same atomic INSERT as the
  // write, so only one of two requests that both read the slot as empty can still win the write.
  it('lets only one of two concurrent checkouts hold the last slot when interleaved: one 201, one 409, exactly one hold row', async () => {
    const repo = fakeRepository();
    const singleCapacityConfig = { ...config, fleet: { defaultCapacity: 1 } };
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
    const context = createBookkitContext({
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
    const singleCapacityConfig = { ...config, fleet: { defaultCapacity: 1 } };
    const context = createBookkitContext({
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

  it('rejects a checkout whose larger party (2 occupancy units) would exceed capacity already partly held', async () => {
    // Default fixture capacity is 2. A held party of 2 uses 1 occupancy unit (occupancyFor
    // returns 1 for people <= 4), leaving 1 unit free — not enough for a party of 5, which
    // needs 2 units (occupancyFor returns 2 for people > 4).
    const existingHold = booking({
      id: 'b-existing-hold',
      status: 'hold',
      people: 2,
      startsAt: '2026-06-15T08:00:00.000Z',
      endsAt: '2026-06-15T09:00:00.000Z',
      holdExpiresAt: '2026-06-14T09:00:00.000Z',
      stripeSessionId: null,
    });
    const repo = fakeRepository([existingHold]);
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const response = await handleCheckout(checkoutRequest(5), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'slot_unavailable' } });
  });
});
