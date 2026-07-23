import { describe, expect, it } from 'vitest';
import { validateConfig, type PricingRule } from '../src/core/config';
import { PricingError, pricingCombinations, priceFor, priceForTour, resolvedPriceTableFor } from '../src/core/pricing';
import { config, tour } from './fixtures';

describe('core pricing', () => {
  it('resolves every supported people and pickup combination', () => {
    expect(pricingCombinations(tour)).toHaveLength(16);
    expect(priceForTour(config, 'vintage', 1, 'default')).toBe(10000);
    expect(priceForTour(config, 'vintage', 8, 'custom')).toBe(20000);
  });

  it('keeps server prices and the widget lookup table in parity after canonicalization', () => {
    const pricingVariants = [
      [
        { maxPeople: 8, pickup: 'default', priceCents: 18000 },
        { maxPeople: 4, pickup: 'custom', priceCents: 12000 },
        { maxPeople: 4, pickup: 'default', priceCents: 10000 },
        { maxPeople: 8, pickup: 'custom', priceCents: 20000 },
      ],
      [
        { maxPeople: 4, pickup: 'custom', priceCents: 12000 },
        { maxPeople: 8, pickup: 'custom', priceCents: 20000 },
        { maxPeople: 8, pickup: 'default', priceCents: 18000 },
        { maxPeople: 4, pickup: 'default', priceCents: 10000 },
      ],
    ];

    for (const pricing of pricingVariants) {
      const validated = validateConfig({
        ...config,
        tours: {
          ...config.tours,
          vintage: { ...tour, pricing },
        },
      });
      const canonicalTour = validated.tours.vintage;
      if (!canonicalTour) throw new Error('expected vintage tour');
      const prices = resolvedPriceTableFor(canonicalTour);

      for (let people = 1; people <= 8; people += 1) {
        expect(priceFor(canonicalTour, people, 'default')).toBe(people <= 4 ? 10000 : 18000);
        expect(priceFor(canonicalTour, people, 'custom')).toBe(people <= 4 ? 12000 : 20000);
        expect(prices.default[people]).toBe(priceFor(canonicalTour, people, 'default'));
        expect(prices.custom[people]).toBe(priceFor(canonicalTour, people, 'custom'));
      }
    }
  });

  it('keeps the widget lookup table in parity with server priceFor for an unsorted imported config', () => {
    // Reproduces the real integration path, not just already-canonical input: a consumer page
    // typically builds BookingWidget's `pricing` prop straight from its own hand-authored config
    // module (examples/smoke-site/src/config.ts, imported independently of runtime.ts), never
    // touching validateConfig's canonical return. The server, meanwhile, always resolves against
    // context.config, which IS validateConfig's return (see runtime-context.ts). So this test feeds
    // priceFor the validated/canonical tour and resolvedPriceTableFor the raw, never-validated
    // array, and asserts they still agree for every party size — the actual displayed-vs-charged
    // guarantee. This fails on a resolvedPriceTableFor that trusts its input's order (pre-fix) and
    // passes once it canonicalizes independently of what validateConfig did upstream.
    const pricingVariants: PricingRule[][] = [
      [
        { maxPeople: 8, pickup: 'default', priceCents: 18000 },
        { maxPeople: 4, pickup: 'custom', priceCents: 12000 },
        { maxPeople: 4, pickup: 'default', priceCents: 10000 },
        { maxPeople: 8, pickup: 'custom', priceCents: 20000 },
      ],
      [
        { maxPeople: 4, pickup: 'custom', priceCents: 12000 },
        { maxPeople: 8, pickup: 'custom', priceCents: 20000 },
        { maxPeople: 8, pickup: 'default', priceCents: 18000 },
        { maxPeople: 4, pickup: 'default', priceCents: 10000 },
      ],
    ];

    for (const rawPricing of pricingVariants) {
      const rawConfig = {
        ...config,
        tours: { ...config.tours, vintage: { ...tour, pricing: rawPricing } },
      };

      // Server path: goes through config load, exactly like context.config backing checkout/priceFor.
      const canonicalTour = validateConfig(rawConfig).tours.vintage;
      if (!canonicalTour) throw new Error('expected vintage tour');

      // Widget path: the raw array as authored, never passed through validateConfig.
      const widgetPrices = resolvedPriceTableFor({ pricing: rawPricing });

      for (let people = 1; people <= 8; people += 1) {
        for (const pickup of ['default', 'custom'] as const) {
          expect(widgetPrices[pickup][people]).toBe(priceFor(canonicalTour, people, pickup));
        }
      }
    }
  });

  it('fails at runtime for unsupported values rather than silently choosing a price', () => {
    expect(() => priceFor(tour, 9, 'default')).toThrow(PricingError);
    expect(() => priceFor(tour, 0, 'custom')).toThrow(PricingError);
  });
});
