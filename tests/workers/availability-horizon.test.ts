// Proves a full 365-day availability request completes inside a Worker, against real D1 — the
// old fixed 62-day limit forced callers to chunk-and-merge their requests.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReservaContext } from '../../src/context';
import type { AvailabilityResponse } from '../../src/core/api';
import { handleAvailability } from '../../src/handlers';
import { defineCloudflareReservaRuntime } from '../../src/runtime-context';
import { config as baseConfig } from '../fixtures';
import { providers } from '../fakes';

interface TestEnv {
  RESERVA_DB: D1Database;
}

const db = (env as unknown as TestEnv).RESERVA_DB;
const HORIZON_DAYS = 365;

// minNoticeHours: 0 so today's slots are in range too — the point is the size of the window, not
// the notice policy.
const horizonConfig = {
  ...baseConfig,
  booking: { ...baseConfig.booking, maxHorizonDays: HORIZON_DAYS, minNoticeHours: 0 },
};

// Cloudflare Access stays configured (baseConfig's admin.access) — this test only drives the
// public availability endpoint, and only one admin auth path is allowed.
const runtime = defineCloudflareReservaRuntime(horizonConfig, {
  providers: providers(),
  secretBindings: ['RESERVA_OPERATOR_SECRET'],
});

function dateKey(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function buildContext(request: Request): Promise<ReservaContext> {
  return runtime.createContext({ request, locals: { env: { RESERVA_DB: db } } });
}

// This deployment's documented scale is ~50 bookings a year (docs/decisions.md), spread across the
// horizon so every occupancy window has real rows to intersect.
const SEEDED_BOOKINGS = 50;

beforeAll(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  const context = await buildContext(new Request('https://example.test/api/booking/availability'));
  for (let index = 0; index < SEEDED_BOOKINGS; index += 1) {
    const startsAt = new Date(Date.now() + Math.floor((index * HORIZON_DAYS) / SEEDED_BOOKINGS) * 86_400_000).toISOString();
    const id = `horizon-${index}`;
    await context.repo.insertHold({
      id,
      reference: `LVT-HZN-${index}`,
      serviceSlug: 'vintage',
      quantity: 2,
      pickupType: 'default',
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      cancelToken: `cancel-${id}`,
      operatorToken: `operator-${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await context.repo.transitionToConfirmed(id, { expectedStatusIn: ['hold'], paymentRef: `pi_${id}`, updatedAt: new Date().toISOString() });
  }
});

describe('full-horizon availability', () => {
  it('answers a whole-horizon request in one call, with a day entry for every date', async () => {
    const from = dateKey(0);
    const to = dateKey(HORIZON_DAYS);
    const url = `https://example.test/api/booking/availability?service=vintage&quantity=2&from=${from}&to=${to}`;
    const context = await buildContext(new Request(url));

    const startedAt = Date.now();
    const response = await handleAvailability(new Request(url), context);
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(200);
    const payload = await response.json() as AvailabilityResponse;
    expect(payload.days).toHaveLength(HORIZON_DAYS + 1);
    expect(payload.days[0]?.date).toBe(from);
    expect(payload.days.at(-1)?.date).toBe(to);
    // Bookable slots still come back for a date deep in the horizon — the window isn't silently
    // truncated to keep the response cheap.
    expect(payload.days.some((day) => day.slots.length > 0)).toBe(true);

    // A soft ceiling, not a benchmark — guards against a future quadratic regression. Measured at
    // ~0.5s wall clock here (366 days x 7 slots/day against 50 confirmed bookings).
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('still rejects a request past the horizon, naming the config key', async () => {
    const url = `https://example.test/api/booking/availability?service=vintage&quantity=2&from=${dateKey(0)}&to=${dateKey(HORIZON_DAYS + 2)}`;
    const context = await buildContext(new Request(url));
    const response = await handleAvailability(new Request(url), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'validation_failed', message: `Date range cannot exceed the booking horizon of ${HORIZON_DAYS} days (config.booking.maxHorizonDays); request a narrower range` },
    });
  });
});
