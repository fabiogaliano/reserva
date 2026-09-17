import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { maxQuantityFor, validateConfig, type ClientConfig, type ResolvedFormulaPricing } from '../src/core/config';
import { lowestPriceMinor, priceFor, pricingCombinations, PricingError, resolvedPriceTableFor } from '../src/core/pricing';
import { loadMergedConfig, mergeAndValidateSettings, settingDefinitionsFor } from '../src/core/settings';
import { catalogPayload } from '../src/handlers/catalog';
import { handleAdminGet } from '../src/handlers';
import { resolveMessages } from '../src/ui/messages';
import { fakeRepository, providers } from './fakes';

const PICKUP_OPTIONS = [
  { id: 'meeting_point', label: 'Meeting point', requiresAddress: false, usesMeetingPoint: true },
  { id: 'custom_dropoff', label: 'Custom drop-off', requiresAddress: true, usesMeetingPoint: true },
  { id: 'custom_pickup', label: 'Custom pick-up', requiresAddress: true, usesMeetingPoint: false },
  { id: 'custom_both', label: 'Custom pick-up and drop-off', requiresAddress: true, usesMeetingPoint: false },
];
const MEETING_POINTS = [{ id: 'hard-rock', label: 'Hard Rock Cafe', mapsUrl: 'https://maps.google.com/?q=Hard+Rock' }];

// A fleet operator the way MAZE runs one: every tour departs on the same grid and is back by
// closing, one vehicle seats 4, a party of 5-8 takes two, and the pick-up surcharge is the same
// number on every tour. Two services break the pattern on purpose: `private` declares its own
// surcharges, scope and hours; `workshop` is a location-less breakpoint list.
const fleet = {
  business: {
    name: 'Fleet Tours', shortCode: 'FLT', url: 'https://fleet.example', timezone: 'Europe/Lisbon', currency: 'eur',
    contact: { email: 'hello@fleet.example', phone: '+351 000' },
  },
  capacity: { default: 2 },
  admin: { access: { teamDomain: 'https://fleet.cloudflareaccess.com', aud: 'aud' } },
  hours: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastEnd: '19:00', intervalMin: 30 }],
  pricing: { surcharges: { meeting_point: 0, custom_dropoff: 2000, custom_pickup: 2000, custom_both: 3000 }, maxUnits: 2 },
  services: {
    'old-city': {
      title: 'Old City · 1 hour', durationMin: 60, turnaroundMin: 15,
      location: { meetingPoints: MEETING_POINTS, pickupOptions: PICKUP_OPTIONS },
      occupancy: { seatsPerUnit: 4 },
      pricing: { baseMinor: 10000 },
    },
    'full-day': {
      title: 'All City · Full day', durationMin: 480, turnaroundMin: 15,
      location: { meetingPoints: MEETING_POINTS, pickupOptions: PICKUP_OPTIONS },
      occupancy: { seatsPerUnit: 4 },
      pricing: { baseMinor: 48000 },
    },
    private: {
      title: 'Private hire', durationMin: 120, turnaroundMin: 30,
      schedule: [{ days: [1, 2, 3, 4, 5], firstStart: '10:00', lastStart: '14:00', intervalMin: 120 }],
      location: { meetingPoints: MEETING_POINTS, pickupOptions: PICKUP_OPTIONS },
      occupancy: { seatsPerUnit: 4 },
      pricing: { baseMinor: 5000, surcharges: { meeting_point: 0, custom_dropoff: 500, custom_pickup: 500, custom_both: 800 }, surchargeScope: 'booking' },
    },
    workshop: {
      title: 'Workshop', durationMin: 90, turnaroundMin: 0,
      pricing: [{ maxQuantity: 2, priceMinor: 3000 }, { maxQuantity: 6, priceMinor: 7000 }],
    },
  },
  locales: { supported: ['en'], default: 'en' },
} satisfies ClientConfig;

const resolved = validateConfig(fleet);
const formulaOf = (slug: string): ResolvedFormulaPricing => {
  const pricing = resolved.services[slug]!.pricing;
  if (Array.isArray(pricing)) throw new Error(`${slug} prices by rows`);
  return pricing;
};

describe('shared opening hours', () => {
  it('every service without a schedule inherits the hours block and derives its own last departure', () => {
    expect(resolved.services['old-city']?.scheduleSource).toBe('hours');
    expect(resolved.services['old-city']?.schedule).toEqual([{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastEnd: '19:00', lastStart: '18:00', intervalMin: 30 }]);
    expect(resolved.services['full-day']?.schedule[0]?.lastStart).toBe('11:00');
    expect(resolved.services['workshop']?.schedule[0]?.lastStart).toBe('17:30');
  });

  it('a service that declares its own schedule keeps it', () => {
    expect(resolved.services.private?.scheduleSource).toBe('service');
    expect(resolved.services.private?.schedule[0]).toMatchObject({ firstStart: '10:00', lastStart: '14:00' });
  });

  it('re-validates unchanged, so the runtime and the settings merge see one shape', () => {
    expect(validateConfig(resolved)).toEqual(resolved);
  });

  it('a service with no schedule and no hours block is a named error', () => {
    const { hours: _hours, ...noHours } = fleet;
    expect(() => validateConfig(noHours)).toThrow(/service old-city declares no schedule and there is no top-level hours block/);
  });

  it('a closing time no service duration fits is reported on the hours block, naming the service', () => {
    expect(() => validateConfig({ ...fleet, hours: [{ ...fleet.hours[0]!, lastEnd: '15:00' }] }))
      .toThrow(/hours\.0: lastEnd 15:00 leaves no room for a 480-minute booking of service full-day/);
  });
});

describe('formula pricing', () => {
  it('materializes the inherited fields on every formula service and records where they came from', () => {
    expect(formulaOf('old-city')).toEqual({
      baseMinor: 10000,
      surcharges: { meeting_point: 0, custom_dropoff: 2000, custom_pickup: 2000, custom_both: 3000 },
      maxUnits: 2,
      surchargeScope: 'unit',
      seatsPerUnit: 4,
      inherited: { surcharges: true, maxUnits: true, surchargeScope: true },
    });
    expect(formulaOf('private')).toMatchObject({
      surcharges: { custom_both: 800 }, maxUnits: 2, surchargeScope: 'booking',
      inherited: { surcharges: false, maxUnits: true, surchargeScope: false },
    });
  });

  it('charges base × units plus the surcharge, per unit by default and once per booking when asked', () => {
    const oldCity = resolved.services['old-city']!;
    expect(priceFor(oldCity, 3, 'meeting_point')).toBe(10000);
    expect(priceFor(oldCity, 3, 'custom_both')).toBe(13000);
    expect(priceFor(oldCity, 4, 'custom_both')).toBe(13000);
    expect(priceFor(oldCity, 5, 'meeting_point')).toBe(20000);
    expect(priceFor(oldCity, 8, 'custom_both')).toBe(26000);
    const hire = resolved.services.private!;
    expect(priceFor(hire, 8, 'custom_both')).toBe(5000 * 2 + 800);
  });

  it('refuses a party that needs more units than allowed, and an unknown or missing pickup', () => {
    const oldCity = resolved.services['old-city']!;
    expect(() => priceFor(oldCity, 9, 'meeting_point')).toThrow(PricingError);
    expect(() => priceFor(oldCity, 2, 'helicopter')).toThrow(PricingError);
    expect(() => priceFor(oldCity, 2, null)).toThrow(PricingError);
    expect(maxQuantityFor(oldCity)).toBe(8);
  });

  it('builds the same tables a breakpoint list would, keyed by the declared pickup ids', () => {
    const table = resolvedPriceTableFor(resolved.services['old-city']!);
    expect(Object.keys(table)).toEqual(['meeting_point', 'custom_dropoff', 'custom_pickup', 'custom_both']);
    expect(table.custom_both!.slice(1)).toEqual([13000, 13000, 13000, 13000, 26000, 26000, 26000, 26000]);
    expect(pricingCombinations(resolved.services['old-city']!)).toHaveLength(32);
    expect(lowestPriceMinor(resolved.services['old-city']!)).toBe(10000);
    // Breakpoint rows still work unchanged next to formula services.
    expect(priceFor(resolved.services.workshop!, 3, null)).toBe(7000);
    expect(maxQuantityFor(resolved.services.workshop!)).toBe(6);
  });

  it('every declared pickup option must be priced, reported on the block the table came from', () => {
    const { custom_both: _both, ...partial } = fleet.pricing.surcharges;
    expect(() => validateConfig({ ...fleet, pricing: { ...fleet.pricing, surcharges: partial } }))
      .toThrow(/pickup option custom_both, so pricing\.surcharges must price it/);
    const ownPartial = { ...fleet, services: { ...fleet.services, private: { ...fleet.services.private, pricing: { ...fleet.services.private.pricing, surcharges: { meeting_point: 0 } } } } };
    expect(() => validateConfig(ownPartial)).toThrow(/custom_dropoff, so services\.private\.pricing\.surcharges must price it/);
  });

  it('a formula service must declare occupancy, since that is what checkout counts units with', () => {
    const { occupancy: _dropped, ...noOccupancy } = fleet.services['old-city'];
    expect(() => validateConfig({ ...fleet, services: { ...fleet.services, 'old-city': noOccupancy } }))
      .toThrow(/services\.old-city\.occupancy\.seatsPerUnit must be declared/);
  });

  it('a config that writes amounts and also claims them inherited gets the amounts it wrote', () => {
    const claimed = {
      ...fleet.services.private,
      pricing: { ...fleet.services.private.pricing, maxUnits: 2, inherited: { surcharges: true, maxUnits: true, surchargeScope: true } },
    };
    const config = validateConfig({ ...fleet, services: { ...fleet.services, private: claimed } });
    expect(config.services.private?.pricing).toMatchObject({
      surcharges: { custom_both: 800 }, surchargeScope: 'booking', maxUnits: 2,
      inherited: { surcharges: false, maxUnits: true, surchargeScope: false },
    });
  });
});

describe('catalog projection', () => {
  it('publishes the formula with its materialized fields and no config provenance', () => {
    const payload = catalogPayload(resolved, 'en', resolveMessages(resolved, 'en'));
    const oldCity = payload.services.find((entry) => entry.slug === 'old-city')!;
    expect(oldCity.pricing).toEqual({
      baseMinor: 10000,
      surcharges: { meeting_point: 0, custom_dropoff: 2000, custom_pickup: 2000, custom_both: 3000 },
      maxUnits: 2,
      surchargeScope: 'unit',
      seatsPerUnit: 4,
    });
    expect(oldCity.maxQuantity).toBe(8);
    expect(oldCity.fromPriceMinor).toBe(10000);
    // The published shape prices identically to the config it came from.
    expect(resolvedPriceTableFor(oldCity)).toEqual(resolvedPriceTableFor(resolved.services['old-city']!));
    const workshop = payload.services.find((entry) => entry.slug === 'workshop')!;
    expect(workshop.pricing).toEqual([{ maxQuantity: 2, pickup: null, priceMinor: 3000 }, { maxQuantity: 6, pickup: null, priceMinor: 7000 }]);
    expect(workshop.maxQuantity).toBe(6);
  });
});

describe('admin settings over shared blocks', () => {
  const keysIn = (section: string) => settingDefinitionsFor(resolved).filter((entry) => entry.section === section);

  it('the hours section is the shared block plus, as overrides, the rules of services that own theirs', () => {
    const hours = keysIn('hours');
    expect(hours.filter((entry) => !entry.override).map((entry) => entry.key)).toEqual([
      'hours.0.firstStart', 'hours.0.lastEnd', 'hours.0.intervalMin', 'hours.0.days',
    ]);
    expect(hours.filter((entry) => entry.override).map((entry) => entry.key)).toEqual([
      'services.private.schedule.0.firstStart', 'services.private.schedule.0.lastStart', 'services.private.schedule.0.intervalMin', 'services.private.schedule.0.days',
    ]);
    expect(hours[0]?.scheduleRule).toEqual({ ruleIndex: 0, rule: resolved.hours![0] });
  });

  it('editing the shared closing time moves every inheriting service’s last departure', () => {
    const merged = mergeAndValidateSettings(resolved, { 'hours.0.lastEnd': '"17:00"' });
    expect(merged.services['old-city']?.schedule[0]).toMatchObject({ lastEnd: '17:00', lastStart: '16:00' });
    expect(merged.services['full-day']?.schedule[0]?.lastStart).toBe('09:00');
    expect(merged.services.private?.schedule[0]?.lastStart).toBe('14:00');
    expect(resolved.services['old-city']?.schedule[0]?.lastStart).toBe('18:00');
  });

  it('the pricing section is the shared surcharges and group size, then a base price per formula service', () => {
    const pricing = keysIn('pricing');
    expect(pricing.filter((entry) => !entry.override).map((entry) => entry.key)).toEqual([
      'pricing.surcharges.meeting_point', 'pricing.surcharges.custom_dropoff', 'pricing.surcharges.custom_pickup', 'pricing.surcharges.custom_both',
      'pricing.maxUnits', 'pricing.surchargeScope',
      'services.old-city.pricing.baseMinor', 'services.full-day.pricing.baseMinor', 'services.private.pricing.baseMinor',
      'services.workshop.pricing.0.priceMinor', 'services.workshop.pricing.1.priceMinor',
    ]);
    expect(pricing.filter((entry) => entry.override).map((entry) => entry.key)).toEqual([
      'services.private.pricing.surcharges.meeting_point', 'services.private.pricing.surcharges.custom_dropoff',
      'services.private.pricing.surcharges.custom_pickup', 'services.private.pricing.surcharges.custom_both',
      'services.private.pricing.surchargeScope',
    ]);
    expect(pricing.find((entry) => entry.key === 'pricing.surcharges.custom_both')?.pricingFormula)
      .toMatchObject({ field: 'surcharge', pickupId: 'custom_both', services: [resolved.services['old-city'], resolved.services['full-day']] });
  });

  it('a shared surcharge edit reaches every inheriting service and leaves a declaring one alone', () => {
    const merged = mergeAndValidateSettings(resolved, { 'pricing.surcharges.custom_both': '4000', 'pricing.maxUnits': '1', 'pricing.surchargeScope': 'false' });
    expect(priceFor(merged.services['old-city']!, 3, 'custom_both')).toBe(14000);
    expect(maxQuantityFor(merged.services['old-city']!)).toBe(4);
    expect(formulaOf('old-city').surcharges.custom_both).toBe(3000);
    expect(merged.services.private?.pricing).toMatchObject({ surcharges: { custom_both: 800 }, maxUnits: 1, surchargeScope: 'booking' });
  });

  it('a service’s own surcharge and base price edit only that service', () => {
    const merged = mergeAndValidateSettings(resolved, { 'services.private.pricing.surcharges.custom_both': '1000', 'services.old-city.pricing.baseMinor': '12000' });
    expect(priceFor(merged.services.private!, 1, 'custom_both')).toBe(6000);
    expect(priceFor(merged.services['old-city']!, 1, 'custom_both')).toBe(15000);
    expect(priceFor(merged.services['full-day']!, 1, 'custom_both')).toBe(51000);
  });

  it('a stored row nobody defines any more is dropped with a warning instead of carried silently', () => {
    const warnings: string[] = [];
    const merged = loadMergedConfig(resolved, { 'services.old-city.pricing.0.priceMinor': '9000' }, (warning) => warnings.push(warning.key));
    expect(warnings).toEqual(['services.old-city.pricing.0.priceMinor']);
    expect(priceFor(merged.services['old-city']!, 1, 'meeting_point')).toBe(10000);
    expect(merged).toEqual(resolved);
  });

  it('renders the shared blocks first and folds service-specific values into a closed disclosure', async () => {
    const context = createReservaContext({ config: resolved, db: {} as D1Database, repo: fakeRepository(), clock: () => new Date('2026-06-14T08:00:00.000Z'), adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: async () => undefined });
    const body = await (await handleAdminGet(new Request('https://fleet.example/api/booking/admin?view=settings'), context)).text();
    expect(body).toContain('All services');
    expect(body).toContain('name="hours.0.lastEnd"');
    expect(body).toContain('name="hours.0.lastEnd" value="19:00"');
    expect(body).toContain('Custom pick-up and drop-off surcharge');
    expect(body).toContain('name="pricing.surcharges.custom_both"');
    expect(body).toContain('name="services.old-city.pricing.baseMinor"');
    expect(body).toContain('<details class="bk-overrides"><summary>Service-specific overrides (1)</summary>');
    expect(body.indexOf('name="hours.0.firstStart"')).toBeLessThan(body.indexOf('name="services.private.schedule.0.firstStart"'));
    // A service inheriting the shared block has no block of its own.
    expect(body).not.toContain('name="services.old-city.schedule.0.firstStart"');
  });
});
