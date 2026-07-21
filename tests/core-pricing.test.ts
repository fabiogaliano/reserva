import { describe, expect, it } from 'vitest';
import { PricingError, pricingCombinations, priceFor, priceForTour } from '../src/core/pricing';
import { config, tour } from './fixtures';

describe('core pricing', () => {
  it('resolves every supported people and pickup combination', () => {
    expect(pricingCombinations(tour)).toHaveLength(16);
    expect(priceForTour(config, 'vintage', 1, 'default')).toBe(10000);
    expect(priceForTour(config, 'vintage', 8, 'custom')).toBe(20000);
  });

  it('fails at runtime for unsupported values rather than silently choosing a price', () => {
    expect(() => priceFor(tour, 9, 'default')).toThrow(PricingError);
    expect(() => priceFor(tour, 0, 'custom')).toThrow(PricingError);
  });
});
