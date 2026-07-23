import { describe, expect, it } from 'vitest';
import { peopleValuesForTour, validateConfig } from '../src/core/config';
import { priceFor } from '../src/core/pricing';
import { config, tour } from './fixtures';

describe('core config and pricing validation', () => {
  it('accepts a valid config and infers people ranges from pricing breakpoints', () => {
    expect(validateConfig(config)).toEqual(config);
    expect(peopleValuesForTour(tour)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(priceFor(tour, 5, 'custom')).toBe(20000);
  });

  it('canonicalizes out-of-order pricing tiers for each pickup type', () => {
    const validated = validateConfig({
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...tour,
          pricing: [
            { maxPeople: 8, pickup: 'custom', priceCents: 20000 },
            { maxPeople: 8, pickup: 'default', priceCents: 18000 },
            { maxPeople: 4, pickup: 'custom', priceCents: 12000 },
            { maxPeople: 4, pickup: 'default', priceCents: 10000 },
          ],
        },
      },
    });
    const canonicalTour = validated.tours.vintage;
    if (!canonicalTour) throw new Error('expected vintage tour');

    expect(canonicalTour.pricing).toEqual([
      { maxPeople: 4, pickup: 'custom', priceCents: 12000 },
      { maxPeople: 4, pickup: 'default', priceCents: 10000 },
      { maxPeople: 8, pickup: 'custom', priceCents: 20000 },
      { maxPeople: 8, pickup: 'default', priceCents: 18000 },
    ]);
    expect(priceFor(canonicalTour, 2, 'default')).toBe(10000);
  });

  it('rejects a duplicate breakpoint that would shadow a pricing rule with an actionable diagnostic', () => {
    const invalid = {
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...tour,
          pricing: [...tour.pricing, { maxPeople: 4, pickup: 'default', priceCents: 9000 }],
        },
      },
    };

    expect(() => validateConfig(invalid)).toThrow(/tour vintage pricing rule 4 \(pickup=default, maxPeople=4\) duplicates and shadows rule 0; remove or change one breakpoint/);
  });

  it('rejects a missing pickup variant for a supported people count', () => {
    const invalid = {
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...config.tours.vintage!,
          pricing: config.tours.vintage!.pricing.filter((row) => row.pickup !== 'custom' || row.maxPeople !== 8),
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/missing custom pricing for people=5/);
  });

  it('rejects a hold below the Stripe expiry safety margin', () => {
    expect(() => validateConfig({ ...config, booking: { ...config.booking, holdMinutes: 34 } })).toThrow(/at least 35/);
  });

  it('rejects a hold above the Stripe 24h checkout-session cap (BK-CONFIG-001) and accepts the boundary', () => {
    expect(() => validateConfig({ ...config, booking: { ...config.booking, holdMinutes: 1441 } })).toThrow(/at most 1440/);
    expect(() => validateConfig({ ...config, booking: { ...config.booking, holdMinutes: 1440 } })).not.toThrow();
  });

  it('rejects a locale outside Stripe Checkout support', () => {
    expect(() => validateConfig({ ...config, locales: { supported: ['en', 'xx'], default: 'en' } })).toThrow(/not supported by Stripe/);
  });

  it('requires the admin domain to be a bare HTTPS Cloudflare Access origin', () => {
    for (const accessTeamDomain of [
      'http://team.cloudflareaccess.com',
      'https://team.cloudflareaccess.com/admin',
      'https://team.cloudflareaccess.com?next=/admin',
      'https://team.example.com',
    ]) {
      expect(() => validateConfig({ ...config, admin: { ...config.admin, accessTeamDomain } })).toThrow();
    }
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('accepts equal season endpoints as a one-day inclusive range', () => {
    const oneDay = {
      ...config,
      tours: {
        vintage: {
          ...tour,
          schedule: [{ ...tour.schedule[0]!, from: '06-15', to: '06-15' }],
        },
      },
    };
    expect(() => validateConfig(oneDay)).not.toThrow();
  });

  it('surfaces a throwing occupancy resolver as a path-specific validation issue', () => {
    const invalid = {
      ...config,
      tours: {
        vintage: {
          ...tour,
          occupancyFor: () => {
            throw new Error('resolver failed');
          },
        },
      },
    };
    try {
      validateConfig(invalid);
      throw new Error('expected validation to fail');
    } catch (error) {
      const issues = (error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues ?? [];
      expect(issues[0]?.path).toEqual(['tours', 'vintage', 'occupancyFor']);
      expect(issues[0]?.message).toContain('resolver failed');
    }
  });

  it('allows a season range that wraps across year-end', () => {
    const wrapped = {
      ...config,
      tours: {
        vintage: {
          ...tour,
          schedule: [{ ...tour.schedule[0], from: '11-01', to: '02-28' }],
        },
      },
    };
    expect(() => validateConfig(wrapped)).not.toThrow();
  });
});
