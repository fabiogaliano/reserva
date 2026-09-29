// Proves a full 365-day horizon can be read inside a Worker against real D1, in the consecutive
// 62-day requests the per-request cap allows (what the client's availability() does for a caller).
import { env } from 'cloudflare:workers';
import virtualConfig from 'virtual:reserva/config';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReservaContext } from '../../src/context';
import { MAX_AVAILABILITY_RANGE_DAYS, type AvailabilityDay, type AvailabilityResponse } from '../../src/core/api';
import { handleAvailability } from '../../src/handlers';
import { defineCloudflareReservaRuntime } from '../../src/runtime-context';
import { providers } from '../fakes';

interface TestEnv {
  RESERVA_DB: D1Database;
}

const db = (env as unknown as TestEnv).RESERVA_DB;
const HORIZON_DAYS = 365;

// minNoticeHours: 0 so today's slots are in range too — the point is the size of the window, not
// the notice policy. The runtime takes no config argument any more, so the widened horizon is
// written into `virtual:reserva/config` itself. `vi.mock` cannot reach it here: the workers pool
// evaluates its `main` entry (tests/workers/worker.ts) before the test module, so
// src/runtime-context is already bound to the real virtual module by the time a mock could be
// registered.
virtualConfig.config = {
  ...virtualConfig.config,
  booking: { ...virtualConfig.config.booking, maxHorizonDays: HORIZON_DAYS, minNoticeHours: 0 },
};

// Cloudflare Access stays configured (the fixture's admin.access) — this test only drives the
// public availability endpoint, and only one admin auth path is allowed.
const runtime = defineCloudflareReservaRuntime({
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
  it('answers the whole horizon in consecutive capped requests, with a day entry for every date', async () => {
    const from = dateKey(0);
    const to = dateKey(HORIZON_DAYS);
    const days: AvailabilityDay[] = [];
    const startedAt = Date.now();
    for (let offset = 0; offset <= HORIZON_DAYS; offset += MAX_AVAILABILITY_RANGE_DAYS) {
      const chunkTo = dateKey(Math.min(offset + MAX_AVAILABILITY_RANGE_DAYS - 1, HORIZON_DAYS));
      const url = `https://example.test/api/booking/availability?service=vintage&quantity=2&from=${dateKey(offset)}&to=${chunkTo}`;
      const response = await handleAvailability(new Request(url), await buildContext(new Request(url)));
      expect(response.status).toBe(200);
      days.push(...(await response.json() as AvailabilityResponse).days);
    }
    const elapsedMs = Date.now() - startedAt;

    expect(days).toHaveLength(HORIZON_DAYS + 1);
    expect(days[0]?.date).toBe(from);
    expect(days.at(-1)?.date).toBe(to);
    // Bookable slots still come back for a date deep in the horizon — the window isn't silently
    // truncated to keep the response cheap.
    expect(days.some((day) => day.slots.length > 0)).toBe(true);

    // A soft ceiling, not a benchmark — guards against a future quadratic regression.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('rejects one request spanning more than the per-request cap, even inside the horizon', async () => {
    const url = `https://example.test/api/booking/availability?service=vintage&quantity=2&from=${dateKey(0)}&to=${dateKey(MAX_AVAILABILITY_RANGE_DAYS)}`;
    const response = await handleAvailability(new Request(url), await buildContext(new Request(url)));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed', details: { field: 'to' } } });
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
