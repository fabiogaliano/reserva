// Plan 027 (design decision 1, step 7): the anti-drift guarantee. The quote endpoint exists
// because the first consumer had to reimplement the pricing matrix client-side; the only thing
// that makes it safe is that it prices through the SAME code path checkout charges through. These
// tests assert that over a real (service x quantity x pickup) matrix by running both endpoints and
// comparing the quote against the amount actually persisted on the booking row — not by inspecting
// the shared function, which would prove nothing about the endpoints.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext, type BookkitContext } from '../src/context';
import type { ClientConfig, ServiceConfig } from '../src/core/config';
import { handleCheckout, handleQuote } from '../src/handlers';
import { config, service } from './fixtures';
import { fakeRepository, providers } from './fakes';

// A second, location-less service (plan 023) so the matrix covers both pricing axes: quantity
// tiers alone, and quantity tiers x declared pickup ids.
const cruise: ServiceConfig = {
  durationMin: 60,
  turnaroundMin: 30,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '12:00', intervalMin: 30 }],
  pricing: [
    { maxQuantity: 2, priceMinor: 4200 },
    { maxQuantity: 4, priceMinor: 7900 },
  ],
};

const matrixConfig: ClientConfig = { ...config, services: { vintage: service, cruise } };

const START = '2026-06-15T08:00:00.000Z';

function context(): BookkitContext {
  return createBookkitContext({
    config: matrixConfig,
    db: {} as D1Database,
    repo: fakeRepository(),
    clock: () => new Date('2026-06-14T08:00:00.000Z'),
    providers: providers(),
  });
}

async function quote(body: Record<string, unknown>, ctx = context()): Promise<Response> {
  return handleQuote(new Request('https://example.test/api/booking/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), ctx);
}

// Returns the price the booking row was actually created with — what the customer is charged.
async function chargedPriceMinor(body: Record<string, unknown>): Promise<number | undefined> {
  const repo = fakeRepository();
  const ctx = createBookkitContext({
    config: matrixConfig,
    db: {} as D1Database,
    repo,
    clock: () => new Date('2026-06-14T08:00:00.000Z'),
    providers: providers(),
  });
  const response = await handleCheckout(new Request('https://example.test/api/booking/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, start: START, locale: 'en' }),
  }), ctx);
  expect(response.status).toBe(201);
  return [...repo.rows.values()][0]?.priceMinor;
}

describe('POST /api/booking/quote (plan 027 design decision 1)', () => {
  it('quotes exactly what checkout charges for every (service, quantity, pickup) combination', async () => {
    const cases: Array<{ serviceSlug: string; quantity: number; pickup?: string }> = [];
    for (const quantity of [1, 2, 4, 5, 8]) {
      for (const pickup of ['default', 'custom']) cases.push({ serviceSlug: 'vintage', quantity, pickup });
    }
    for (const quantity of [1, 2, 3, 4]) cases.push({ serviceSlug: 'cruise', quantity });

    for (const entry of cases) {
      const quoted = await (await quote(entry)).json() as { priceMinor: number; currency: string };
      const checkoutBody = entry.pickup === undefined
        ? { serviceSlug: entry.serviceSlug, quantity: entry.quantity }
        : { serviceSlug: entry.serviceSlug, quantity: entry.quantity, pickupType: entry.pickup };
      const charged = await chargedPriceMinor(checkoutBody);
      expect(quoted.priceMinor, `quote != charge for ${JSON.stringify(entry)}`).toBe(charged);
      expect(quoted.currency).toBe(matrixConfig.business.currency);
    }
  });

  it('returns the tier price and the deployment currency, nothing else', async () => {
    const response = await quote({ serviceSlug: 'vintage', quantity: 5, pickup: 'custom' });
    expect(response.status).toBe(200);
    // No breakdown field (design decision 1): flat totals only.
    await expect(response.json()).resolves.toEqual({ priceMinor: 20000, currency: 'eur' });
  });

  it('rejects the same pickup mistakes checkout rejects, with the same remediating messages', async () => {
    const missing = await quote({ serviceSlug: 'vintage', quantity: 2 });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: 'pickup is required' } });

    const unknown = await quote({ serviceSlug: 'vintage', quantity: 2, pickup: 'helicopter' });
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({ error: { message: 'pickup must be one of: default, custom' } });

    // Location-less service: the field must not be sent at all (plan 023 decision 3).
    const unexpected = await quote({ serviceSlug: 'cruise', quantity: 2, pickup: 'default' });
    expect(unexpected.status).toBe(400);
    await expect(unexpected.json()).resolves.toMatchObject({ error: { message: 'This service has no location module; do not send pickup' } });
  });

  it('rejects an unknown service and an unpriceable party size', async () => {
    const unknownService = await quote({ serviceSlug: 'nope', quantity: 2, pickup: 'default' });
    expect(unknownService.status).toBe(400);
    await expect(unknownService.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: 'Unknown service' } });

    const tooLarge = await quote({ serviceSlug: 'vintage', quantity: 9, pickup: 'default' });
    expect(tooLarge.status).toBe(400);
    await expect(tooLarge.json()).resolves.toMatchObject({ error: { message: 'quantity must not exceed the configured maximum of 8' } });

    const zero = await quote({ serviceSlug: 'cruise', quantity: 0 });
    expect(zero.status).toBe(400);
    await expect(zero.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('accepts a locale for payload symmetry with checkout and still rejects a non-string one', async () => {
    await expect((await quote({ serviceSlug: 'cruise', quantity: 2, locale: 'pt' })).status).toBe(200);
    expect((await quote({ serviceSlug: 'cruise', quantity: 2, locale: 42 })).status).toBe(400);
  });

  it('is POST-only', async () => {
    const response = await handleQuote(new Request('https://example.test/api/booking/quote'), context());
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'method_not_allowed' } });
  });
});
