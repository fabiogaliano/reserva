// Plan 027 (design decision 5 / step 5): checkout is a locale-bearing entrypoint, so it negotiates
// the requested tag instead of rejecting anything that isn't declared verbatim. What matters is
// what gets STORED on the booking: every later surface (emails, manage page, confirmation) resolves
// its copy from that value, so it must always be one of the deployment's supported locales.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { handleCheckout } from '../src/handlers';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

// The fixture deployment supports ['en', 'pt-BR'] with 'en' as its default.
function checkoutWithLocale(locale: string): Request {
  return new Request('https://example.test/api/booking/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale }),
  });
}

async function storedLocaleFor(locale: string): Promise<string | undefined> {
  const repo = fakeRepository();
  const context = createReservaContext({
    config,
    db: {} as D1Database,
    repo,
    clock: () => new Date('2026-06-14T08:00:00.000Z'),
    providers: providers(),
  });
  const response = await handleCheckout(checkoutWithLocale(locale), context);
  expect(response.status).toBe(201);
  return [...repo.rows.values()][0]?.locale;
}

describe('checkout locale negotiation (plan 027 design decision 5)', () => {
  it('stores the negotiated regional variant for a bare language tag', async () => {
    await expect(storedLocaleFor('pt')).resolves.toBe('pt-BR');
  });

  it('stores an exactly supported tag unchanged', async () => {
    await expect(storedLocaleFor('pt-BR')).resolves.toBe('pt-BR');
    await expect(storedLocaleFor('en')).resolves.toBe('en');
  });

  it('falls back to the default locale instead of rejecting an unsupported language', async () => {
    await expect(storedLocaleFor('de-CH')).resolves.toBe('en');
  });

  it('still requires the field itself', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers(),
    });
    const response = await handleCheckout(new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default' }),
    }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: 'locale is required' } });
  });
});
