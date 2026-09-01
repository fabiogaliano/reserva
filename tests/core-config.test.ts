import { describe, expect, it } from 'vitest';
import type { ServiceConfig } from '../src/core/config';
import { DEFAULT_PICKUP_OPTIONS, meetingPointForBooking, quantityValuesForService, pickupOptionFor, resolveMeetingPoint, validateConfig } from '../src/core/config';
import { priceFor } from '../src/core/pricing';
import { config, service } from './fixtures';

describe('core config and pricing validation', () => {
  it('accepts a valid config and infers quantity ranges from pricing breakpoints', () => {
    // Plan 017 (design decision 1): validateConfig normalizes the meetingPoint shorthand into a
    // canonical meetingPoints array (and clears the shorthand — see the idempotency test below),
    // so the validated config is no longer a byte-for-byte copy of the input fixture — the
    // fixture's shorthand is still what the config declares, though.
    // Plan 018 (design decision 1): validateConfig also injects the default pickupOptions pair
    // when a service declares none, same canonicalize-on-validate move.
    const { meetingPoint: _meetingPoint, ...vintageWithoutShorthand } = service;
    expect(validateConfig(config)).toEqual({
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...vintageWithoutShorthand,
          meetingPoints: [{ id: 'default', ...service.meetingPoint }],
          pickupOptions: DEFAULT_PICKUP_OPTIONS,
        },
      },
    });
    expect(quantityValuesForService(service)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(priceFor(service, 5, 'custom')).toBe(20000);
  });

  it('normalizes the meetingPoint shorthand to a canonical meetingPoints array and clears the shorthand', () => {
    const validated = validateConfig(config);
    expect(validated.services.vintage?.meetingPoints).toEqual([
      { id: 'default', label: service.meetingPoint!.label, mapsUrl: service.meetingPoint!.mapsUrl },
    ]);
    expect(validated.services.vintage?.meetingPoint).toBeUndefined();
  });

  it('stays idempotent when re-validated (defineBookkitRuntime/defineCloudflareBookkitRuntime validate once at definition and createBookkitContext validates again on every request)', () => {
    const validated = validateConfig(config);
    expect(() => validateConfig(validated)).not.toThrow();
    expect(validateConfig(validated)).toEqual(validated);
    // Plan 018 (design decision 1): pickupOptions injection must be idempotent too — a second
    // validateConfig pass over the already-normalized config (the same double-validate path
    // defineBookkitRuntime/createBookkitContext exercise) neither re-injects nor drops it.
    expect(validated.services.vintage?.pickupOptions).toEqual(DEFAULT_PICKUP_OPTIONS);
    expect(validateConfig(validated).services.vintage?.pickupOptions).toEqual(DEFAULT_PICKUP_OPTIONS);
  });

  it('rejects a service that declares both meetingPoint and meetingPoints', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          meetingPoints: [{ id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' }],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/declare either meetingPoint or meetingPoints, not both/);
  });

  it('rejects a service that declares neither meetingPoint nor meetingPoints', () => {
    const { meetingPoint: _meetingPoint, ...tourWithoutMeetingPoint } = service;
    const invalid = {
      ...config,
      services: { ...config.services, vintage: tourWithoutMeetingPoint },
    };
    expect(() => validateConfig(invalid)).toThrow(/must declare either meetingPoint or meetingPoints/);
  });

  it('rejects duplicate meeting point ids within a service', () => {
    const { meetingPoint: _meetingPoint, ...tourWithoutMeetingPoint } = service;
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...tourWithoutMeetingPoint,
          meetingPoints: [
            { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
            { id: 'square', label: 'The Other Square', mapsUrl: 'https://maps.google.com/?q=other' },
          ],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/duplicate meeting point id \(square\)/);
  });

  it('rejects an empty meeting point id', () => {
    const { meetingPoint: _meetingPoint, ...tourWithoutMeetingPoint } = service;
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...tourWithoutMeetingPoint,
          meetingPoints: [{ id: '', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' }],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow();
  });

  it('canonicalizes out-of-order pricing tiers for each pickup type', () => {
    const validated = validateConfig({
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          pricing: [
            { maxQuantity: 8, pickup: 'custom', priceMinor: 20000 },
            { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
            { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
            { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
          ],
        },
      },
    });
    const canonicalService = validated.services.vintage;
    if (!canonicalService) throw new Error('expected vintage service');

    expect(canonicalService.pricing).toEqual([
      { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
      { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
      { maxQuantity: 8, pickup: 'custom', priceMinor: 20000 },
      { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
    ]);
    expect(priceFor(canonicalService, 2, 'default')).toBe(10000);
  });

  it('rejects a duplicate breakpoint that would shadow a pricing rule with an actionable diagnostic', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          pricing: [...service.pricing, { maxQuantity: 4, pickup: 'default', priceMinor: 9000 }],
        },
      },
    };

    expect(() => validateConfig(invalid)).toThrow(/service vintage pricing rule 4 \(pickup=default, maxQuantity=4\) duplicates and shadows rule 0; remove or change one breakpoint/);
  });

  it('rejects a missing pickup variant for a supported quantity count', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...config.services.vintage!,
          pricing: config.services.vintage!.pricing.filter((row) => row.pickup !== 'custom' || row.maxQuantity !== 8),
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/missing custom pricing for quantity=5/);
  });

  // Plan 018 (design decision 2): the pricing axis is a plain string now, so validateService is the
  // only thing that can reject a row pointing at an id the service never declared.
  it('rejects a pricing row that references an undeclared pickup option id', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          pickupOptions: [{ id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true }],
          pricing: [
            { maxQuantity: 4, pickup: 'meeting_point', priceMinor: 18000 },
            { maxQuantity: 8, pickup: 'meeting_point', priceMinor: 20000 },
            { maxQuantity: 4, pickup: 'unknown_option', priceMinor: 15000 },
          ],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/references undeclared pickup option unknown_option; valid pickup option ids: meeting_point/);
  });

  // Plan 018 (design decision 2): the coverage loop iterates declared option ids instead of the
  // old literal ['default', 'custom'] pair, so a hole is reported per declared id.
  it('reports a per-id coverage hole for a declared pickup option', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          pickupOptions: [
            { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true },
            { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
          ],
          pricing: [
            { maxQuantity: 4, pickup: 'meeting_point', priceMinor: 18000 },
            { maxQuantity: 8, pickup: 'meeting_point', priceMinor: 20000 },
            { maxQuantity: 4, pickup: 'custom_dropoff', priceMinor: 20000 },
          ],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/missing custom_dropoff pricing for quantity=5/);
  });

  it('rejects duplicate pickup option ids', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          pickupOptions: [
            { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true },
            { id: 'meeting_point', requiresAddress: true, usesMeetingPoint: false },
          ],
          pricing: [
            { maxQuantity: 4, pickup: 'meeting_point', priceMinor: 10000 },
            { maxQuantity: 8, pickup: 'meeting_point', priceMinor: 18000 },
          ],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/duplicate pickup option id \(meeting_point\)/);
  });

  it('rejects a malformed pickup option id (uppercase or whitespace)', () => {
    for (const id of ['MeetingPoint', 'meeting point']) {
      const invalid = {
        ...config,
        services: {
          ...config.services,
          vintage: {
            ...service,
            pickupOptions: [{ id, requiresAddress: false, usesMeetingPoint: true }],
            pricing: [
              { maxQuantity: 4, pickup: id, priceMinor: 10000 },
              { maxQuantity: 8, pickup: id, priceMinor: 18000 },
            ],
          },
        },
      };
      expect(() => validateConfig(invalid)).toThrow();
    }
  });

  it('defaults calendar outage grace to 15 minutes and rejects a shorter-than-freshness window', () => {
    const { calendarMaxStaleSeconds: _calendarMaxStaleSeconds, ...bookingWithoutGrace } = config.booking;
    expect(validateConfig({ ...config, booking: bookingWithoutGrace }).booking.calendarMaxStaleSeconds).toBe(15 * 60);
    expect(() => validateConfig({ ...config, booking: { ...config.booking, calendarMaxStaleSeconds: 59 } })).toThrow();
  });

  it('rejects a hold below the Stripe expiry safety margin', () => {
    expect(() => validateConfig({ ...config, booking: { ...config.booking, holdMinutes: 34 } })).toThrow(/at least 35/);
  });

  // Plan 022 (design decision 7): the 24h checkout-session cap and Stripe's locale list are the
  // Stripe adapter's limits, checked by its validateConfig (tests/providers-stripe.test.ts).
  // Core only keeps the vendor-neutral rules: a hold long enough to outlive its payment session,
  // and locale tags a formatter can actually use.
  it('accepts any hold at or above the safety floor, with no vendor-imposed ceiling', () => {
    expect(() => validateConfig({ ...config, booking: { ...config.booking, holdMinutes: 4320 } })).not.toThrow();
  });

  it('rejects a locale tag no formatter can parse', () => {
    expect(() => validateConfig({ ...config, locales: { supported: ['pt-PT'], default: 'pt-PT' } })).not.toThrow();
    expect(() => validateConfig({ ...config, locales: { supported: ['en', 'not a tag'], default: 'en' } })).toThrow(/not a valid BCP 47 locale tag/);
  });

  it('allows the operator locale to differ from customer and Stripe locales', () => {
    const validated = validateConfig({
      ...config,
      admin: { ...config.admin, locale: 'pt-PT' },
      locales: { supported: ['en'], default: 'en' },
    });
    expect(validated.admin.locale).toBe('pt-PT');
    expect(() => validateConfig({ ...config, admin: { ...config.admin, locale: '' } })).toThrow();
    expect(() => validateConfig({ ...config, admin: { ...config.admin, locale: 'not_a_locale' } })).toThrow(/valid BCP 47 locale/);
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
      services: {
        vintage: {
          ...service,
          schedule: [{ ...service.schedule[0]!, from: '06-15', to: '06-15' }],
        },
      },
    };
    expect(() => validateConfig(oneDay)).not.toThrow();
  });

  it('surfaces a throwing occupancy resolver as a path-specific validation issue', () => {
    const invalid = {
      ...config,
      services: {
        vintage: {
          ...service,
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
      expect(issues[0]?.path).toEqual(['services', 'vintage', 'occupancyFor']);
      expect(issues[0]?.message).toContain('resolver failed');
    }
  });

  it('allows a season range that wraps across year-end', () => {
    const wrapped = {
      ...config,
      services: {
        vintage: {
          ...service,
          schedule: [{ ...service.schedule[0], from: '11-01', to: '02-28' }],
        },
      },
    };
    expect(() => validateConfig(wrapped)).not.toThrow();
  });
});

describe('resolveMeetingPoint', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const { meetingPoint: _meetingPoint, ...tourBase } = service;
  const multiPointTour: ServiceConfig = { ...tourBase, meetingPoints: points };

  it('returns the point matching the given id', () => {
    expect(resolveMeetingPoint(multiPointTour, 'station')).toEqual(points[1]);
  });

  it('falls back to the first declared point for an unknown id', () => {
    expect(resolveMeetingPoint(multiPointTour, 'unknown')).toEqual(points[0]);
  });

  it('falls back to the first declared point when no id is given', () => {
    expect(resolveMeetingPoint(multiPointTour)).toEqual(points[0]);
  });

  // Plan 017 STOP condition 2: examples/smoke-site imports config directly for the widget,
  // never through validateConfig — resolveMeetingPoint must still work off the raw shorthand.
  it('derives the single point from the meetingPoint shorthand on a raw, un-normalized service', () => {
    const expected = { id: 'default', ...service.meetingPoint };
    expect(resolveMeetingPoint(service)).toEqual(expected);
    expect(resolveMeetingPoint(service, 'anything')).toEqual(expected);
  });
});

describe('meetingPointForBooking', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const { meetingPoint: _meetingPoint, ...tourBase } = service;
  const multiPointTour: ServiceConfig = { ...tourBase, meetingPoints: points };

  it('resolves a declared id to its live label and maps link', () => {
    expect(meetingPointForBooking(multiPointTour, 'station', 'stale stored label')).toEqual({
      label: 'The Station',
      mapsUrl: 'https://maps.google.com/?q=station',
    });
  });

  // Plan 017 (design decision 3): a stored id no longer declared falls back to the booking's own
  // label snapshot with no maps link — validateConfig can't cross-check the DB, and an operator
  // may remove a point that existing bookings still reference.
  it('falls back to the stored label snapshot, with no maps link, for a since-removed id', () => {
    expect(meetingPointForBooking(multiPointTour, 'no-longer-declared', 'The Old Dock')).toEqual({
      label: 'The Old Dock',
      mapsUrl: null,
    });
  });

  it('falls back to the id itself when a removed id has no stored label snapshot', () => {
    expect(meetingPointForBooking(multiPointTour, 'no-longer-declared', null)).toEqual({
      label: 'no-longer-declared',
      mapsUrl: null,
    });
  });

  // A NULL id is a pre-0014 row (before the meeting-point columns existed) and keeps today's
  // first/only-declared-point behavior.
  it('resolves a null id to the first declared point', () => {
    expect(meetingPointForBooking(multiPointTour, null, null)).toEqual({
      label: 'The Square',
      mapsUrl: 'https://maps.google.com/?q=square',
    });
  });
});

describe('pickupOptionFor', () => {
  it('returns the declared option matching a given id', () => {
    const validated = validateConfig(config);
    const vintage = validated.services.vintage!;
    expect(pickupOptionFor(vintage, 'custom')).toEqual({ id: 'custom', requiresAddress: true, usesMeetingPoint: false });
    expect(pickupOptionFor(vintage, 'default')).toEqual({ id: 'default', requiresAddress: false, usesMeetingPoint: true });
  });

  it('returns undefined for an id the service has not declared', () => {
    const validated = validateConfig(config);
    const vintage = validated.services.vintage!;
    expect(pickupOptionFor(vintage, 'unknown')).toBeUndefined();
  });

  // Plan 018 (design decision 1): tolerant of a raw (never-validated) service, same precedent as
  // resolveMeetingPoint (plan 017 STOP condition 2) — examples/smoke-site imports config directly
  // for the widget, never through validateConfig.
  it('derives the default pair on a raw service without pickupOptions', () => {
    expect(pickupOptionFor(service, 'default')).toEqual({ id: 'default', requiresAddress: false, usesMeetingPoint: true });
    expect(pickupOptionFor(service, 'custom')).toEqual({ id: 'custom', requiresAddress: true, usesMeetingPoint: false });
    expect(pickupOptionFor(service, 'unknown')).toBeUndefined();
  });
});
