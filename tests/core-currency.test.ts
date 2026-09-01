import type { D1Database } from '@cloudflare/workers-types';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createReservaContext } from '../src/context';
import { validateConfig } from '../src/core/config';
import { minorUnitFactor, toMajorUnits } from '../src/core/currency';
import { handleCheckout } from '../src/handlers';
import { stripe, type StripeClient } from '@reservajs/stripe';
import { formatPrice } from '../src/ui/format';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

// Prices are stored in a currency's MINOR unit. For a zero-decimal currency like JPY the minor
// unit IS the major unit, so dividing by a hard-coded 100 shows ¥12,000 as ¥120 — the whole
// point of routing every division through minorUnitFactor. These tests follow one non-EUR,
// zero-decimal price all the way from config validation to what the customer actually reads.
function configIn(currency: string) {
  return validateConfig({ ...config, business: { ...config.business, currency } });
}

function stripeClient() {
  const sessions = {
    create: vi.fn(async (_params: Stripe.Checkout.SessionCreateParams, _options?: { idempotencyKey?: string }) => (
      { id: 'cs_currency', url: 'https://checkout.test/cs_currency' }
    )),
    retrieve: vi.fn(async () => ({ id: 'cs_currency', status: 'open', payment_status: 'unpaid' })),
  };
  return {
    sessions,
    client: {
      checkout: { sessions },
      refunds: { create: vi.fn(), list: vi.fn(async () => ({ data: [] })) },
      webhooks: { constructEventAsync: vi.fn() },
    } as unknown as StripeClient,
  };
}

describe('currency plumbing (plan 022 design decision 2)', () => {
  it('accepts any lowercase ISO 4217 code and rejects anything that is not one', () => {
    for (const currency of ['eur', 'jpy', 'usd', 'kwd']) {
      expect(configIn(currency).business.currency).toBe(currency);
    }
    for (const bad of ['EUR', 'euro', 'e', '€']) {
      expect(() => configIn(bad), `${bad} should not validate`).toThrow(/ISO 4217/);
    }
  });

  it('knows the minor unit of zero-, two- and three-decimal currencies', () => {
    expect(minorUnitFactor('jpy')).toBe(1);
    expect(minorUnitFactor('eur')).toBe(100);
    expect(minorUnitFactor('kwd')).toBe(1000);
    // An unlisted code falls back to the ISO default of two decimals rather than throwing.
    expect(minorUnitFactor('zzz')).toBe(100);
  });

  it('formats a zero-decimal price as whole units, not one-hundredth of it', () => {
    // 12000 minor units is ¥12,000 — a hard-coded `/ 100` would have rendered ¥120.
    expect(formatPrice(12000, 'en', 'jpy')).toBe('¥12,000');
    expect(formatPrice(12000, 'en', 'eur')).toBe('€120.00');
    expect(toMajorUnits(12000, 'jpy')).toBe(12000);
  });

  it('sends the booking price to the payment provider in that currency, in minor units', async () => {
    const { client, sessions } = stripeClient();
    const jpyConfig = configIn('jpy');
    const provider = stripe({
      secretKey: 'sk_test', webhookSecret: 'whsec_test', client,
      now: () => new Date('2026-06-14T08:00:00.000Z'),
      getSuccessUrl: () => 'https://example.test/booking-confirmation?session_id={CHECKOUT_SESSION_ID}',
      getCancelUrl: () => 'https://example.test/',
    });
    const repo = fakeRepository();
    const context = createReservaContext({
      config: jpyConfig, db: {} as D1Database, repo,
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      providers: providers({ payments: provider }),
    });

    const response = await handleCheckout(new Request('https://example.test/api/booking/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceSlug: 'vintage', start: '2026-06-15T08:00:00.000Z', quantity: 2, pickupType: 'default', locale: 'en' }),
    }), context);
    expect(response.status).toBe(201);

    // Stripe takes the smallest currency unit, which for JPY is the yen itself — the stored
    // priceMinor goes across untouched, and the session is denominated in the configured currency.
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [expect.objectContaining({ price_data: expect.objectContaining({ currency: 'jpy', unit_amount: 10000 }) })],
    }), expect.anything());

    // The booking row records the currency its price is denominated in, so a later render or refund
    // can never re-interpret the amount under a different one.
    const held = [...repo.rows.values()][0];
    expect(held).toMatchObject({ priceMinor: 10000, currency: 'jpy' });
    expect(formatPrice(held?.priceMinor ?? 0, 'en', held?.currency ?? '')).toBe('¥10,000');
  });

  it('rejects a currency the Stripe adapter cannot present, without touching core validation', () => {
    // Core accepts any ISO code; the vendor limit belongs to the adapter.
    expect(() => configIn('kpw')).not.toThrow();
    const provider = stripe({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client: stripeClient().client });
    expect(() => provider.validateConfig!(configIn('kpw'))).toThrow(/business\.currency/);
  });
});
