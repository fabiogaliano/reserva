// The reschedule picker asks availability for the slots its own booking could move to. Without
// the manage token that booking counts against capacity, so at capacity 1 the customer's own slot
// (and every slot overlapping it) reads as taken.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import type { ReservaCache } from '../src/context';
import { createReservaContext } from '../src/context';
import { MANAGE_TOKEN_HEADER } from '../src/core';
import { handleAvailability } from '../src/handlers';
import { booking, config } from './fixtures';
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

const own = booking({ id: 'b-own', startsAt: '2026-06-15T08:00:00.000Z', endsAt: '2026-06-15T09:00:00.000Z' });

function setup() {
  const repo = fakeRepository([own]);
  let computeCount = 0;
  const listOccupancyBookings = repo.listOccupancyBookings.bind(repo);
  repo.listOccupancyBookings = (from, to) => {
    computeCount += 1;
    return listOccupancyBookings(from, to);
  };
  const cache = memoryCache();
  const context = createReservaContext({
    config: { ...config, capacity: { default: 1 } },
    db: {} as D1Database,
    repo,
    cache,
    clock: () => new Date('2026-06-14T08:00:00.000Z'),
    // The shared availability cache only engages with no calendar provider.
    providers: (({ calendar: _calendar, ...rest }) => rest)(providers()),
  });
  return { context, cache, computes: () => computeCount };
}

const url = 'https://example.test/api/booking/availability?serviceSlug=vintage&quantity=2&from=2026-06-15&to=2026-06-15';
const request = (token?: string) => new Request(url, token ? { headers: { [MANAGE_TOKEN_HEADER]: token } } : {});
type Payload = { days: Array<{ slots: Array<{ start: string }> }> };
const starts = async (response: Response) => ((await response.json()) as Payload).days[0]!.slots.map((slot) => slot.start);

describe('availability with a manage token', () => {
  it('leaves the token holder’s own booking out of the count, for both customer and operator tokens', async () => {
    const { context } = setup();
    const anonymous = await starts(await handleAvailability(request(), context));
    expect(anonymous.some((start) => start.startsWith('2026-06-15T09:00'))).toBe(false);

    for (const token of [own.cancelToken, own.operatorToken]) {
      const response = await handleAvailability(request(token), context);
      expect(response.status).toBe(200);
      expect(await starts(response)).toEqual(expect.arrayContaining([expect.stringMatching(/^2026-06-15T09:00/)]));
    }
  });

  it('never caches the per-booking answer, shared or downstream', async () => {
    const { context, cache } = setup();
    const response = await handleAvailability(request(own.cancelToken), context);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(cache.keys()).toHaveLength(0);

    // A later anonymous request must still see the booking counted.
    const anonymous = await starts(await handleAvailability(request(), context));
    expect(anonymous.some((start) => start.startsWith('2026-06-15T09:00'))).toBe(false);
  });

  it('treats an unknown token exactly like no token, cache included', async () => {
    const { context, computes } = setup();
    const anonymous = await handleAvailability(request(), context);
    const anonymousBody = await anonymous.text();
    const garbage = await handleAvailability(request('not-a-real-token'), context);
    expect(await garbage.text()).toBe(anonymousBody);
    expect(garbage.headers.get('cache-control')).toBe(anonymous.headers.get('cache-control'));
    // Served from the shared entry the anonymous request wrote, not recomputed.
    expect(computes()).toBe(1);
  });
});
