import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import type { ReservaCache } from '../src/context';
import { createReservaContext } from '../src/context';
import { handleAvailability, handleCheckout } from '../src/handlers';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

function memoryCache(): ReservaCache {
  const entries = new Map<string, Response>();
  const keyFor = (request: unknown): string => request instanceof Request ? request.url : String(request);
  return {
    match: async (request) => entries.get(keyFor(request))?.clone(),
    put: async (request, response) => {
      if (!(response instanceof Response)) throw new Error('cache response must be a Response');
      entries.set(keyFor(request), response.clone());
    },
  };
}

function availabilityRequest(service = 'vintage', quantity = 2): Request {
  return new Request(`https://example.test/api/booking/availability?service=${service}&quantity=${quantity}&from=2026-06-15&to=2026-06-15`);
}

function checkoutRequest(): Request {
  return new Request('https://example.test/api/booking/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en' }),
  });
}

describe('calendar availability hardening', () => {
  it('shares normalized calendar occupancy across availability queries with different services and party sizes', async () => {
    let calls = 0;
    const context = createReservaContext({
      config: {
        ...config,
        services: {
          ...config.services,
          second: { ...config.services.vintage!, durationMin: 1_500, turnaroundMin: 0 },
        },
      },
      db: {} as D1Database,
      repo: fakeRepository(),
      cache: memoryCache(),
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        calendar: {
          cacheKey: 'primary',
          listEvents: async () => {
            calls += 1;
            await Promise.resolve();
            return [];
          },
          createEvent: async () => 'cal_1',
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    await Promise.all([
      expect(handleAvailability(availabilityRequest('vintage', 2), context)).resolves.toMatchObject({ status: 200 }),
      expect(handleAvailability(availabilityRequest('second', 3), context)).resolves.toMatchObject({ status: 200 }),
    ]);
    expect(calls).toBe(1);
  });

  it('serves stale normalized occupancy during a calendar outage within the configured grace window', async () => {
    let now = new Date('2026-06-14T08:00:00.000Z');
    let calls = 0;
    let unavailable = false;
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository(),
      cache: memoryCache(),
      clock: () => now,
      providers: providers({
        calendar: {
          listEvents: async () => {
            calls += 1;
            if (unavailable) throw new Error('Google Calendar request failed (429)');
            return [{
              id: 'calendar-event-1',
              start: { dateTime: '2026-06-15T08:00:00.000Z' },
              end: { dateTime: '2026-06-15T10:00:00.000Z' },
              extendedProperties: { private: { reservaBookingId: 'booking-from-calendar' } },
            }];
          },
          createEvent: async () => 'cal_1',
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    await expect(handleAvailability(availabilityRequest(), context)).resolves.toMatchObject({ status: 200 });
    now = new Date(now.getTime() + 61_000);
    unavailable = true;
    const stale = await handleAvailability(availabilityRequest(), context);
    expect(stale.status).toBe(200);
    expect(stale.headers.get('cache-control')).toBe('no-store');
    await expect(stale.json()).resolves.toMatchObject({
      limitedThreshold: config.booking.limitedThreshold,
      days: [{
        slots: expect.not.arrayContaining([expect.objectContaining({ start: expect.stringContaining('T09:00:00') })]),
      }],
    });
    expect(calls).toBe(2);
  });

  it('returns calendar_unavailable rather than a generic error on a cold availability cache', async () => {
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository(),
      cache: memoryCache(),
      providers: providers({
        calendar: {
          listEvents: async () => { throw new Error('Google Calendar request failed (503)'); },
          createEvent: async () => 'cal_1',
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    const response = await handleAvailability(availabilityRequest(), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'calendar_unavailable' } });
  });

  it('does not serve occupancy beyond the configured stale boundary and attempts a fresh read', async () => {
    let now = new Date('2026-06-14T08:00:00.000Z');
    let calls = 0;
    let unavailable = false;
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository(),
      cache: memoryCache(),
      clock: () => now,
      providers: providers({
        calendar: {
          listEvents: async () => {
            calls += 1;
            if (unavailable) throw new Error('Google Calendar request failed (500)');
            return [];
          },
          createEvent: async () => 'cal_1',
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    await expect(handleAvailability(availabilityRequest(), context)).resolves.toMatchObject({ status: 200 });
    now = new Date(now.getTime() + (config.booking.calendarMaxStaleSeconds + 1) * 1_000);
    unavailable = true;
    const response = await handleAvailability(availabilityRequest(), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'calendar_unavailable' } });
    expect(calls).toBe(2);
  });

  it('fails checkout closed before creating a hold when calendar occupancy cannot be verified', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({
        calendar: {
          listEvents: async () => { throw new Error('Google Calendar request failed (503)'); },
          createEvent: async () => 'cal_1',
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    const response = await handleCheckout(checkoutRequest(), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'calendar_unavailable' } });
    expect(repo.rows).toHaveLength(0);
  });

  it('rejects party sizes above the configured pricing maximum before calendar reads', async () => {
    let calls = 0;
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository(),
      providers: providers({
        calendar: {
          listEvents: async () => { calls += 1; return []; },
          createEvent: async () => 'cal_1',
          patchEvent: async () => undefined,
          deleteEvent: async () => undefined,
        },
      }),
    });

    const response = await handleAvailability(availabilityRequest('vintage', 9), context);
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  // The party-size price probe iterates the pickup ids the service's
  // pricing rows declare — a Maze-shaped service has no 'default'/'custom' rows at all, so the old
  // literal-pair probe would have 400'd every availability request for it.
  it('serves availability for a service whose pricing uses only declared non-enum pickup ids', async () => {
    const context = createReservaContext({
      config: {
        ...config,
        services: {
          ...config.services,
          maze: {
            ...config.services.vintage!,
            pricing: [
              { maxQuantity: 4, pickup: 'meeting_point', priceMinor: 18000 },
              { maxQuantity: 4, pickup: 'custom_dropoff', priceMinor: 20000 },
              { maxQuantity: 4, pickup: 'custom_pickup', priceMinor: 20000 },
              { maxQuantity: 4, pickup: 'custom_both', priceMinor: 21000 },
            ],
            location: {
              meetingPoints: config.services.vintage!.location!.meetingPoints!,
              pickupOptions: [
                { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true },
                { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
                { id: 'custom_pickup', requiresAddress: true, usesMeetingPoint: false },
                { id: 'custom_both', requiresAddress: true, usesMeetingPoint: false },
              ],
            },
          },
        },
      },
      db: {} as D1Database,
      repo: fakeRepository(),
      cache: memoryCache(),
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });

    const response = await handleAvailability(availabilityRequest('maze', 2), context);
    expect(response.status).toBe(200);
  });
});
