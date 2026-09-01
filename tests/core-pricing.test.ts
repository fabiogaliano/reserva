import { describe, expect, it } from 'vitest';
import { validateConfig, type PricingRule, type ServiceConfig } from '../src/core/config';
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

// Plan 023 (design decision 2): a service with no `location` module has no pickup axis at all —
// pricing rules omit `pickup` entirely and selection is by quantity tier alone.
describe('location-less pricing (tiers only)', () => {
  const tieredPricing: PricingRule[] = [
    { maxQuantity: 4, priceMinor: 10000 },
    { maxQuantity: 8, priceMinor: 18000 },
  ];
  const tieredService: ServiceConfig = {
    durationMin: service.durationMin,
    turnaroundMin: service.turnaroundMin,
    schedule: service.schedule,
    pricing: tieredPricing,
  };

  it('resolves a price by quantity alone, with a null pickup', () => {
    expect(priceFor(tieredService, 2, null)).toBe(10000);
    expect(priceFor(tieredService, 8, null)).toBe(18000);
    expect(() => priceFor(tieredService, 9, null)).toThrow(PricingError);
  });

  it('builds a single-column resolved price table keyed by the empty string', () => {
    const table = resolvedPriceTableFor(tieredService);
    expect(Object.keys(table)).toEqual(['']);
    expect(table['']?.[2]).toBe(10000);
    expect(table['']?.[8]).toBe(18000);
  });

  it('pricingCombinations reports a null pickup for every quantity', () => {
    const combinations = pricingCombinations(tieredService);
    expect(combinations).toHaveLength(8);
    expect(combinations.every((row) => row.pickup === null)).toBe(true);
  });

  it('validates cleanly through validateConfig and prices identically after canonicalization', () => {
    const validated = validateConfig({
      ...config,
      services: { vintage: tieredService },
    });
    const canonical = validated.services.vintage!;
    expect(canonical.location).toBeUndefined();
    expect(priceFor(canonical, 3, null)).toBe(10000);
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
    location: {
      meetingPoints: service.location!.meetingPoints!,
      pickupOptions: [
        { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true },
        { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
        { id: 'custom_pickup', requiresAddress: true, usesMeetingPoint: false },
        { id: 'custom_both', requiresAddress: true, usesMeetingPoint: false },
      ],
    },
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

  // Plan 023 (design decision 2): pickupIdsFor's 'default'/'custom' pinning is gone — it existed
  // only for byte-identity with the removed pre-018 widget markup. The key order is now plain
  // first-occurrence order from the (maxQuantity-sorted) pricing rows.
  it('orders table keys by first occurrence, with no default/custom pinning', () => {
    const customFirst: PricingRule[] = [
      { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
      { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
    ];
    expect(Object.keys(resolvedPriceTableFor({ pricing: customFirst }))).toEqual(['custom', 'default']);
    expect(Object.keys(resolvedPriceTableFor({ pricing: [...mazePricing, ...customFirst] })))
      .toEqual(['meeting_point', 'custom_dropoff', 'custom_pickup', 'custom_both', 'custom', 'default']);
  });
});
