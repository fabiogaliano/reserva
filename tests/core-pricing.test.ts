import { describe, expect, it } from 'vitest';
import { validateConfig, type PricingRule } from '../src/core/config';
import { PricingError, pricingCombinations, priceFor, priceForService, resolvedPriceTableFor } from '../src/core/pricing';
import { config, service } from './fixtures';

describe('core pricing', () => {
  it('resolves every supported quantity and pickup combination', () => {
    expect(pricingCombinations(service)).toHaveLength(16);
    expect(priceForService(config, 'vintage', 1, 'default')).toBe(10000);
    expect(priceForService(config, 'vintage', 8, 'custom')).toBe(20000);
  });

  it('keeps server prices and the widget lookup table in parity after canonicalization', () => {
    const pricingVariants = [
      [
        { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
        { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
        { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
        { maxQuantity: 8, pickup: 'custom', priceMinor: 20000 },
      ],
      [
        { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
        { maxQuantity: 8, pickup: 'custom', priceMinor: 20000 },
        { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
        { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
      ],
    ];

    for (const pricing of pricingVariants) {
      const validated = validateConfig({
        ...config,
        services: {
          ...config.services,
          vintage: { ...service, pricing },
        },
      });
      const canonicalService = validated.services.vintage;
      if (!canonicalService) throw new Error('expected vintage service');
      const prices = resolvedPriceTableFor(canonicalService);

      for (let quantity = 1; quantity <= 8; quantity += 1) {
        expect(priceFor(canonicalService, quantity, 'default')).toBe(quantity <= 4 ? 10000 : 18000);
        expect(priceFor(canonicalService, quantity, 'custom')).toBe(quantity <= 4 ? 12000 : 20000);
        expect(prices.default![quantity]).toBe(priceFor(canonicalService, quantity, 'default'));
        expect(prices.custom![quantity]).toBe(priceFor(canonicalService, quantity, 'custom'));
      }
    }
  });

  it('keeps the widget lookup table in parity with server priceFor for an unsorted imported config', () => {
    // Reproduces the real integration path, not just already-canonical input: a consumer page
    // typically builds BookingWidget's `pricing` prop straight from its own hand-authored config
    // module (examples/smoke-site/src/config.ts, imported independently of runtime.ts), never
    // touching validateConfig's canonical return. The server, meanwhile, always resolves against
    // context.config, which IS validateConfig's return (see runtime-context.ts). So this test feeds
    // priceFor the validated/canonical service and resolvedPriceTableFor the raw, never-validated
    // array, and asserts they still agree for every party size — the actual displayed-vs-charged
    // guarantee. This fails on a resolvedPriceTableFor that trusts its input's order (pre-fix) and
    // passes once it canonicalizes independently of what validateConfig did upstream.
    const pricingVariants: PricingRule[][] = [
      [
        { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
        { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
        { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
        { maxQuantity: 8, pickup: 'custom', priceMinor: 20000 },
      ],
      [
        { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
        { maxQuantity: 8, pickup: 'custom', priceMinor: 20000 },
        { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
        { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
      ],
    ];

    for (const rawPricing of pricingVariants) {
      const rawConfig = {
        ...config,
        services: { ...config.services, vintage: { ...service, pricing: rawPricing } },
      };

      // Server path: goes through config load, exactly like context.config backing checkout/priceFor.
      const canonicalService = validateConfig(rawConfig).services.vintage;
      if (!canonicalService) throw new Error('expected vintage service');

      // Widget path: the raw array as authored, never passed through validateConfig.
      const widgetPrices = resolvedPriceTableFor({ pricing: rawPricing });

      for (let quantity = 1; quantity <= 8; quantity += 1) {
        for (const pickup of ['default', 'custom'] as const) {
          expect(widgetPrices[pickup]![quantity]).toBe(priceFor(canonicalService, quantity, pickup));
        }
      }
    }
  });

  it('fails at runtime for unsupported values rather than silently choosing a price', () => {
    expect(() => priceFor(service, 9, 'default')).toThrow(PricingError);
    expect(() => priceFor(service, 0, 'custom')).toThrow(PricingError);
  });
});

// Plan 018 (design decision 2/3): Maze Services' motivating case — four declared pickup options
// priced outright (180/200/200/210 €), not as a surcharge on top of the meeting-point price.
// custom_both must resolve to 210 €, not 180 + 20 + 20 = 220 €, proving priceFor's per-(pickup,
// maxQuantity) lookup stays non-additive once the axis is a service-declared id set instead of a fixed
// default/custom pair.
describe('non-additive pickup options (Maze fixture)', () => {
  const mazePricing: PricingRule[] = [
    { maxQuantity: 4, pickup: 'meeting_point', priceMinor: 18000 },
    { maxQuantity: 4, pickup: 'custom_dropoff', priceMinor: 20000 },
    { maxQuantity: 4, pickup: 'custom_pickup', priceMinor: 20000 },
    { maxQuantity: 4, pickup: 'custom_both', priceMinor: 21000 },
  ];
  const mazeTour = {
    ...service,
    pickupOptions: [
      { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true },
      { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
      { id: 'custom_pickup', requiresAddress: true, usesMeetingPoint: false },
      { id: 'custom_both', requiresAddress: true, usesMeetingPoint: false },
    ],
    pricing: mazePricing,
  };

  it('resolves each option to its own stated price, not an additive sum of the others', () => {
    const validated = validateConfig({
      ...config,
      services: { ...config.services, vintage: mazeTour },
    });
    const canonicalService = validated.services.vintage;
    if (!canonicalService) throw new Error('expected vintage service');

    expect(priceFor(canonicalService, 2, 'meeting_point')).toBe(18000);
    expect(priceFor(canonicalService, 2, 'custom_dropoff')).toBe(20000);
    expect(priceFor(canonicalService, 2, 'custom_pickup')).toBe(20000);
    // Not 18000 + 2000 + 2000 = 22000 — the combined option's price is stated outright.
    expect(priceFor(canonicalService, 2, 'custom_both')).toBe(21000);
  });

  it('derives the price table key set from the distinct pickup values declared in the pricing rows', () => {
    const table = resolvedPriceTableFor({ pricing: mazePricing });
    expect(Object.keys(table).sort()).toEqual(['custom_both', 'custom_dropoff', 'custom_pickup', 'meeting_point']);
    expect(table.meeting_point?.[2]).toBe(18000);
    expect(table.custom_dropoff?.[2]).toBe(20000);
    expect(table.custom_pickup?.[2]).toBe(20000);
    expect(table.custom_both?.[2]).toBe(21000);
  });

  it('always serializes default before custom, regardless of pricing-row order (widget byte-identity)', () => {
    // The widget embeds JSON.stringify of this table in its markup; the pre-018 table always
    // inserted { default, custom } in that fixed order, so a legacy config whose raw pricing array
    // lists custom rows first must not change the rendered bytes.
    const customFirst: PricingRule[] = [
      { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
      { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
    ];
    expect(Object.keys(resolvedPriceTableFor({ pricing: customFirst }))).toEqual(['default', 'custom']);
    // Declared non-default/custom ids keep their first-occurrence order after the pinned pair.
    expect(Object.keys(resolvedPriceTableFor({ pricing: [...mazePricing, ...customFirst] })))
      .toEqual(['default', 'custom', 'meeting_point', 'custom_dropoff', 'custom_pickup', 'custom_both']);
  });
});
