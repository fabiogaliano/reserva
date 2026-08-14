import { describe, expect, it } from 'vitest';
import type { TourConfig } from '../src/core/config';
import { DEFAULT_PICKUP_OPTIONS, meetingPointForBooking, peopleValuesForTour, pickupOptionFor, resolveMeetingPoint, validateConfig } from '../src/core/config';
import { priceFor } from '../src/core/pricing';
import { config, tour } from './fixtures';

describe('core config and pricing validation', () => {
  it('accepts a valid config and infers people ranges from pricing breakpoints', () => {
    // Plan 017 (design decision 1): validateConfig normalizes the meetingPoint shorthand into a
    // canonical meetingPoints array (and clears the shorthand — see the idempotency test below),
    // so the validated config is no longer a byte-for-byte copy of the input fixture — the
    // fixture's shorthand is still what the config declares, though.
    // Plan 018 (design decision 1): validateConfig also injects the default pickupOptions pair
    // when a tour declares none, same canonicalize-on-validate move.
    const { meetingPoint: _meetingPoint, ...vintageWithoutShorthand } = tour;
    expect(validateConfig(config)).toEqual({
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...vintageWithoutShorthand,
          meetingPoints: [{ id: 'default', ...tour.meetingPoint }],
          pickupOptions: DEFAULT_PICKUP_OPTIONS,
        },
      },
    });
    expect(peopleValuesForTour(tour)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(priceFor(tour, 5, 'custom')).toBe(20000);
  });

  it('normalizes the meetingPoint shorthand to a canonical meetingPoints array and clears the shorthand', () => {
    const validated = validateConfig(config);
    expect(validated.tours.vintage?.meetingPoints).toEqual([
      { id: 'default', label: tour.meetingPoint!.label, mapsUrl: tour.meetingPoint!.mapsUrl },
    ]);
    expect(validated.tours.vintage?.meetingPoint).toBeUndefined();
  });

  it('stays idempotent when re-validated (defineBookkitRuntime/defineCloudflareBookkitRuntime validate once at definition and createBookkitContext validates again on every request)', () => {
    const validated = validateConfig(config);
    expect(() => validateConfig(validated)).not.toThrow();
    expect(validateConfig(validated)).toEqual(validated);
    // Plan 018 (design decision 1): pickupOptions injection must be idempotent too — a second
    // validateConfig pass over the already-normalized config (the same double-validate path
    // defineBookkitRuntime/createBookkitContext exercise) neither re-injects nor drops it.
    expect(validated.tours.vintage?.pickupOptions).toEqual(DEFAULT_PICKUP_OPTIONS);
    expect(validateConfig(validated).tours.vintage?.pickupOptions).toEqual(DEFAULT_PICKUP_OPTIONS);
  });

  it('rejects a tour that declares both meetingPoint and meetingPoints', () => {
    const invalid = {
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...tour,
          meetingPoints: [{ id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' }],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/declare either meetingPoint or meetingPoints, not both/);
  });

  it('rejects a tour that declares neither meetingPoint nor meetingPoints', () => {
    const { meetingPoint: _meetingPoint, ...tourWithoutMeetingPoint } = tour;
    const invalid = {
      ...config,
      tours: { ...config.tours, vintage: tourWithoutMeetingPoint },
    };
    expect(() => validateConfig(invalid)).toThrow(/must declare either meetingPoint or meetingPoints/);
  });

  it('rejects duplicate meeting point ids within a tour', () => {
    const { meetingPoint: _meetingPoint, ...tourWithoutMeetingPoint } = tour;
    const invalid = {
      ...config,
      tours: {
        ...config.tours,
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
    const { meetingPoint: _meetingPoint, ...tourWithoutMeetingPoint } = tour;
    const invalid = {
      ...config,
      tours: {
        ...config.tours,
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

  // Plan 018 (design decision 2): the pricing axis is a plain string now, so validateTour is the
  // only thing that can reject a row pointing at an id the tour never declared.
  it('rejects a pricing row that references an undeclared pickup option id', () => {
    const invalid = {
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...tour,
          pickupOptions: [{ id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true }],
          pricing: [
            { maxPeople: 4, pickup: 'meeting_point', priceCents: 18000 },
            { maxPeople: 8, pickup: 'meeting_point', priceCents: 20000 },
            { maxPeople: 4, pickup: 'unknown_option', priceCents: 15000 },
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
      tours: {
        ...config.tours,
        vintage: {
          ...tour,
          pickupOptions: [
            { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true },
            { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
          ],
          pricing: [
            { maxPeople: 4, pickup: 'meeting_point', priceCents: 18000 },
            { maxPeople: 8, pickup: 'meeting_point', priceCents: 20000 },
            { maxPeople: 4, pickup: 'custom_dropoff', priceCents: 20000 },
          ],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/missing custom_dropoff pricing for people=5/);
  });

  it('rejects duplicate pickup option ids', () => {
    const invalid = {
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...tour,
          pickupOptions: [
            { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: true },
            { id: 'meeting_point', requiresAddress: true, usesMeetingPoint: false },
          ],
          pricing: [
            { maxPeople: 4, pickup: 'meeting_point', priceCents: 10000 },
            { maxPeople: 8, pickup: 'meeting_point', priceCents: 18000 },
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
        tours: {
          ...config.tours,
          vintage: {
            ...tour,
            pickupOptions: [{ id, requiresAddress: false, usesMeetingPoint: true }],
            pricing: [
              { maxPeople: 4, pickup: id, priceCents: 10000 },
              { maxPeople: 8, pickup: id, priceCents: 18000 },
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

  it('rejects a hold above the Stripe 24h checkout-session cap (BK-CONFIG-001) and accepts the boundary', () => {
    expect(() => validateConfig({ ...config, booking: { ...config.booking, holdMinutes: 1441 } })).toThrow(/at most 1440/);
    expect(() => validateConfig({ ...config, booking: { ...config.booking, holdMinutes: 1440 } })).not.toThrow();
  });

  it('accepts pt-PT through Stripe’s pt locale and rejects unsupported locales', () => {
    expect(() => validateConfig({ ...config, locales: { supported: ['pt-PT'], default: 'pt-PT' } })).not.toThrow();
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

describe('resolveMeetingPoint', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const { meetingPoint: _meetingPoint, ...tourBase } = tour;
  const multiPointTour: TourConfig = { ...tourBase, meetingPoints: points };

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
  it('derives the single point from the meetingPoint shorthand on a raw, un-normalized tour', () => {
    const expected = { id: 'default', ...tour.meetingPoint };
    expect(resolveMeetingPoint(tour)).toEqual(expected);
    expect(resolveMeetingPoint(tour, 'anything')).toEqual(expected);
  });
});

describe('meetingPointForBooking', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const { meetingPoint: _meetingPoint, ...tourBase } = tour;
  const multiPointTour: TourConfig = { ...tourBase, meetingPoints: points };

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
    const vintage = validated.tours.vintage!;
    expect(pickupOptionFor(vintage, 'custom')).toEqual({ id: 'custom', requiresAddress: true, usesMeetingPoint: false });
    expect(pickupOptionFor(vintage, 'default')).toEqual({ id: 'default', requiresAddress: false, usesMeetingPoint: true });
  });

  it('returns undefined for an id the tour has not declared', () => {
    const validated = validateConfig(config);
    const vintage = validated.tours.vintage!;
    expect(pickupOptionFor(vintage, 'unknown')).toBeUndefined();
  });

  // Plan 018 (design decision 1): tolerant of a raw (never-validated) tour, same precedent as
  // resolveMeetingPoint (plan 017 STOP condition 2) — examples/smoke-site imports config directly
  // for the widget, never through validateConfig.
  it('derives the default pair on a raw tour without pickupOptions', () => {
    expect(pickupOptionFor(tour, 'default')).toEqual({ id: 'default', requiresAddress: false, usesMeetingPoint: true });
    expect(pickupOptionFor(tour, 'custom')).toEqual({ id: 'custom', requiresAddress: true, usesMeetingPoint: false });
    expect(pickupOptionFor(tour, 'unknown')).toBeUndefined();
  });
});
