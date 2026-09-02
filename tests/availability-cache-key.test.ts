// availabilityInput validates exactly service/quantity/from/to, but the cache key used to be the
// whole sorted request URL — an extra query parameter (tracking nonce, cache-buster) minted a
// fresh entry, bypassing and bloating the 60s public availability cache.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import type { ReservaCache } from '../src/context';
import { createReservaContext } from '../src/context';
import { handleAvailability } from '../src/handlers';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

function memoryCache(): ReservaCache & { keys: () => string[] } {
  const entries = new Map<string, Response>();
  const keyFor = (request: unknown): string => request instanceof Request ? request.url : String(request);
  return {
    match: async (request) => entries.get(keyFor(request))?.clone(),
    put: async (request, response) => {
      if (!(response instanceof Response)) throw new Error('cache response must be a Response');
      entries.set(keyFor(request), response.clone());
    },
    keys: () => [...entries.keys()],
  };
}

function contextWithoutCalendar(cache: ReservaCache, listOccupancyBookings: () => void) {
  const repo = fakeRepository();
  const originalListOccupancyBookings = repo.listOccupancyBookings.bind(repo);
  repo.listOccupancyBookings = (from, to) => {
    listOccupancyBookings();
    return originalListOccupancyBookings(from, to);
  };
  return createReservaContext({
    config,
    db: {} as D1Database,
    repo,
    cache,
    clock: () => new Date('2026-06-14T08:00:00.000Z'),
    // handleAvailability's request-scope cache only engages with no calendar provider. The key
    // must be omitted, not set to undefined — exactOptionalPropertyTypes rejects an explicit
    // undefined for the optional ReservaProviders.calendar.
    providers: (({ calendar: _calendar, ...rest }) => rest)(providers()),
  });
}

describe('availability cache key', () => {
  it('produces the same cache key for requests differing only by an unvalidated extra parameter', async () => {
    let computeCount = 0;
    const cache = memoryCache();
    const context = contextWithoutCalendar(cache, () => { computeCount += 1; });

    const base = 'https://example.test/api/booking/availability?service=vintage&quantity=2&from=2026-06-15&to=2026-06-15';
    await expect(handleAvailability(new Request(base), context)).resolves.toMatchObject({ status: 200 });
    await expect(handleAvailability(new Request(`${base}&nonce=whatever-junk`), context)).resolves.toMatchObject({ status: 200 });

    expect(computeCount).toBe(1);
    expect(cache.keys()).toHaveLength(1);
  });

  it('produces a different cache key when a validated parameter actually differs', async () => {
    let computeCount = 0;
    const cache = memoryCache();
    const context = contextWithoutCalendar(cache, () => { computeCount += 1; });

    await expect(handleAvailability(
      new Request('https://example.test/api/booking/availability?service=vintage&quantity=2&from=2026-06-15&to=2026-06-15'),
      context,
    )).resolves.toMatchObject({ status: 200 });
    await expect(handleAvailability(
      new Request('https://example.test/api/booking/availability?service=vintage&quantity=3&from=2026-06-15&to=2026-06-15'),
      context,
    )).resolves.toMatchObject({ status: 200 });

    expect(computeCount).toBe(2);
    expect(cache.keys()).toHaveLength(2);
  });
});
