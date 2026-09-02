import { describe, expect, it } from 'vitest';
import type { MetadataField, ServiceConfig } from '../src/core/config';
import { meetingPointForBooking, metadataRowsForBooking, quantityValuesForService, pickupOptionFor, pickupPresentationFor, resolveMeetingPoint, resolveMetadataFieldLabel, validateConfig } from '../src/core/config';
import { priceFor } from '../src/core/pricing';
import { config, service } from './fixtures';

describe('core config and pricing validation', () => {
  it('accepts a valid config unchanged (location already canonical: pickupOptions + meetingPoints under `location`)', () => {
    expect(validateConfig(config)).toEqual(config);
    expect(quantityValuesForService(service)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(priceFor(service, 5, 'custom')).toBe(20000);
  });

  it('stays idempotent when re-validated (defineReservaRuntime/defineCloudflareReservaRuntime validate once at definition and createReservaContext validates again on every request)', () => {
    const validated = validateConfig(config);
    expect(() => validateConfig(validated)).not.toThrow();
    expect(validateConfig(validated)).toEqual(validated);
  });

  // Absent `location` is a fully valid, ordinary service — no pickup dimension anywhere. This
  // is the tiers-only case core-pricing.test.ts prices.
  it('accepts a service with no location module at all', () => {
    const noLocation = {
      ...config,
      services: {
        vintage: {
          durationMin: service.durationMin,
          turnaroundMin: service.turnaroundMin,
          schedule: service.schedule,
          pricing: [
            { maxQuantity: 4, priceMinor: 10000 },
            { maxQuantity: 8, priceMinor: 18000 },
          ],
        },
      },
    };
    const validated = validateConfig(noLocation);
    expect(validated.services.vintage?.location).toBeUndefined();
    expect(priceFor(validated.services.vintage!, 2, null)).toBe(10000);
  });

  it('rejects a location-less service pricing rule that declares pickup (mixed config)', () => {
    const invalid = {
      ...config,
      services: {
        vintage: {
          durationMin: service.durationMin,
          turnaroundMin: service.turnaroundMin,
          schedule: service.schedule,
          pricing: [{ maxQuantity: 4, pickup: 'default', priceMinor: 10000 }],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/has no location module.*pricing rule 0 must not declare 'pickup'/);
  });

  it('rejects a location-ful service pricing rule that omits pickup (mixed config)', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: { ...service, pricing: [...service.pricing, { maxQuantity: 8, priceMinor: 15000 }] },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/declares a location module.*pricing rule 4 must declare 'pickup'/);
  });

  it('rejects a pickup option with usesMeetingPoint: true when location declares no meeting points', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          location: {
            pickupOptions: [{ id: 'meet_here', requiresAddress: false, usesMeetingPoint: true }],
          },
          pricing: [
            { maxQuantity: 4, pickup: 'meet_here', priceMinor: 10000 },
            { maxQuantity: 8, pickup: 'meet_here', priceMinor: 18000 },
          ],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/usesMeetingPoint: true, so location\.meetingPoints must declare at least one point/);
  });

  it('accepts a location-ful service with pickup options but no meeting points at all (every option usesMeetingPoint: false)', () => {
    const valid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          location: {
            pickupOptions: [{ id: 'hotel_pickup', requiresAddress: true, usesMeetingPoint: false }],
          },
          pricing: [
            { maxQuantity: 4, pickup: 'hotel_pickup', priceMinor: 10000 },
            { maxQuantity: 8, pickup: 'hotel_pickup', priceMinor: 18000 },
          ],
        },
      },
    };
    expect(() => validateConfig(valid)).not.toThrow();
  });

  it('rejects duplicate meeting point ids within a service', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          location: {
            ...service.location,
            meetingPoints: [
              { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
              { id: 'square', label: 'The Other Square', mapsUrl: 'https://maps.google.com/?q=other' },
            ],
          },
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/duplicate meeting point id \(square\)/);
  });

  it('rejects an empty meeting point id', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          location: {
            ...service.location,
            meetingPoints: [{ id: '', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' }],
          },
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

  // The pricing axis is a plain string, so validateService is the only thing that can reject a
  // row pointing at an id the service never declared.
  it('rejects a pricing row that references an undeclared pickup option id', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          location: { pickupOptions: [{ id: 'meeting_point', requiresAddress: false, usesMeetingPoint: false }] },
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

  // The coverage loop iterates declared option ids instead of a fixed ['default', 'custom']
  // pair, so a hole is reported per declared id.
  it('reports a per-id coverage hole for a declared pickup option', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          location: {
            pickupOptions: [
              { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: false },
              { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: false },
            ],
          },
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
          location: {
            pickupOptions: [
              { id: 'meeting_point', requiresAddress: false, usesMeetingPoint: false },
              { id: 'meeting_point', requiresAddress: true, usesMeetingPoint: false },
            ],
          },
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
            location: { pickupOptions: [{ id, requiresAddress: false, usesMeetingPoint: false }] },
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

  // The 24h checkout-session cap and Stripe's locale list are Stripe adapter limits. Core only
  // keeps the vendor-neutral rules: a hold long enough to outlive its payment session, and locale
  // tags a formatter can actually use.
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
    for (const teamDomain of [
      'http://team.cloudflareaccess.com',
      'https://team.cloudflareaccess.com/admin',
      'https://team.cloudflareaccess.com?next=/admin',
      'https://team.example.com',
    ]) {
      expect(() => validateConfig({ ...config, admin: { ...config.admin, access: { ...config.admin.access, teamDomain } } })).toThrow();
    }
    expect(() => validateConfig(config)).not.toThrow();
  });

  // admin.access is optional as a pair — declaring one field without the other is a config
  // error, but omitting it entirely (a custom-adminAuth deployment) is valid at the schema layer.
  it('accepts admin.access absent entirely (custom-adminAuth deployment)', () => {
    const { access: _omit, ...adminWithoutAccess } = config.admin;
    expect(() => validateConfig({ ...config, admin: adminWithoutAccess })).not.toThrow();
  });

  it('rejects admin.access declared as a partial pair', () => {
    expect(() => validateConfig({ ...config, admin: { ...config.admin, access: { teamDomain: config.admin.access!.teamDomain } } })).toThrow();
    expect(() => validateConfig({ ...config, admin: { ...config.admin, access: { aud: config.admin.access!.aud } } })).toThrow();
  });

  // routes.admin/routes.ops moved here from the Astro-only ReservaIntegrationOptions.routes —
  // both are optional booleans, defaulted (`?? true`) by whoever reads them (the integration and
  // the runtime factory), not by this schema.
  it('accepts routes.admin/routes.ops as optional booleans, and rejects a non-boolean value', () => {
    expect(validateConfig({ ...config, routes: { admin: false, ops: false } }).routes).toEqual({ admin: false, ops: false });
    expect(validateConfig(config).routes).toBeUndefined();
    expect(() => validateConfig({ ...config, routes: { admin: 'nope' } })).toThrow();
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
  const multiPointTour: ServiceConfig = { ...service, location: { ...service.location!, meetingPoints: points } };

  it('returns the point matching the given id', () => {
    expect(resolveMeetingPoint(multiPointTour, 'station')).toEqual(points[1]);
  });

  it('falls back to the first declared point for an unknown id', () => {
    expect(resolveMeetingPoint(multiPointTour, 'unknown')).toEqual(points[0]);
  });

  it('falls back to the first declared point when no id is given', () => {
    expect(resolveMeetingPoint(multiPointTour)).toEqual(points[0]);
  });

  it('throws for a service that declares no meeting points at all', () => {
    const noPoints: ServiceConfig = { ...service, location: { pickupOptions: [{ id: 'hotel', requiresAddress: true, usesMeetingPoint: false }] } };
    expect(() => resolveMeetingPoint(noPoints)).toThrow(/declares no meeting points/);
  });
});

describe('meetingPointForBooking', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const multiPointTour: ServiceConfig = { ...service, location: { ...service.location!, meetingPoints: points } };

  it('resolves a declared id to its live label and maps link', () => {
    expect(meetingPointForBooking(multiPointTour, 'station', 'stale stored label')).toEqual({
      label: 'The Station',
      mapsUrl: 'https://maps.google.com/?q=station',
    });
  });

  // A stored id no longer declared falls back to the booking's own label snapshot with no maps
  // link — validateConfig can't cross-check the DB, and an operator may remove a point that
  // existing bookings still reference.
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

  // A service that has since dropped its location module entirely must still degrade gracefully
  // (never throw) for a pre-v2 row that still references one.
  it('degrades gracefully, never throwing, for a service that no longer declares any location at all', () => {
    const { location: _location, ...noLocation }: ServiceConfig = service;
    expect(meetingPointForBooking(noLocation, null, null)).toEqual({ label: '', mapsUrl: null });
    expect(meetingPointForBooking(noLocation, 'square', 'Stored Label')).toEqual({ label: 'Stored Label', mapsUrl: null });
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

  it('returns undefined for a null id (the location-less booking) even on a location-ful service', () => {
    expect(pickupOptionFor(service, null)).toBeUndefined();
  });

  it('returns undefined for any id on a service with no location module', () => {
    const { location: _location, ...noLocation }: ServiceConfig = service;
    expect(pickupOptionFor(noLocation, 'default')).toBeUndefined();
  });
});

describe('pickupPresentationFor', () => {
  it('returns null for a location-less booking (pickupType null)', () => {
    expect(pickupPresentationFor(service, { pickupType: null, pickupAddress: null, meetingPointId: null })).toBeNull();
  });

  it('resolves a declared option\'s own flags', () => {
    expect(pickupPresentationFor(service, { pickupType: 'custom', pickupAddress: 'Hotel Mundial', meetingPointId: null }))
      .toEqual({ requiresAddress: true, usesMeetingPoint: false });
  });

  // A stale/removed id falls back to what the row itself proves was collected, not a guess
  // pinned to the retired default/custom pair.
  it('falls back to the row\'s own evidence for a since-removed pickup option id', () => {
    expect(pickupPresentationFor(service, { pickupType: 'no-longer-declared', pickupAddress: 'Hotel Mundial', meetingPointId: null }))
      .toEqual({ requiresAddress: true, usesMeetingPoint: false });
    expect(pickupPresentationFor(service, { pickupType: 'no-longer-declared', pickupAddress: null, meetingPointId: 'square' }))
      .toEqual({ requiresAddress: false, usesMeetingPoint: true });
  });
});

// The declaration DSL (four types, three modifiers), its config validation, and the
// read-surface label/value resolution — checkout's own coercion is covered by
// tests/handlers-checkout-metadata.test.ts (a request-body concern, not a config-shape one).
describe('metadata fields', () => {
  const dietaryField: MetadataField = { key: 'dietary_notes', label: 'Dietary notes', type: 'text', required: true, maxLength: 100 };
  const seatField: MetadataField = {
    key: 'seat_pref',
    label: { en: 'Seat preference', 'pt-PT': 'Preferência de lugar' },
    type: 'select',
    options: [
      { value: 'window', label: { en: 'Window', 'pt-PT': 'Janela' } },
      { value: 'aisle', label: 'Aisle' },
    ],
  };
  const configWithMetadata: typeof config = {
    ...config,
    services: { ...config.services, vintage: { ...service, metadataFields: [dietaryField, seatField] } },
  };

  it('accepts a service declaring all four field types with their modifiers', () => {
    const wheelchairField: MetadataField = { key: 'wheelchair', label: 'Wheelchair access needed', type: 'boolean' };
    const partySizeField: MetadataField = { key: 'kids_count', label: 'Number of kids', type: 'number' };
    const validated = validateConfig({
      ...config,
      services: { ...config.services, vintage: { ...service, metadataFields: [dietaryField, seatField, wheelchairField, partySizeField] } },
    });
    expect(validated.services.vintage!.metadataFields).toHaveLength(4);
  });

  it('accepts a service with no metadataFields at all (unchanged, absent)', () => {
    const validated = validateConfig(config);
    expect(validated.services.vintage!.metadataFields).toBeUndefined();
  });

  it.each([
    ['UpperCase', 'Dietary'],
    ['starts with a digit', '1field'],
    ['contains a hyphen', 'seat-pref'],
    ['too long (33 chars)', 'a'.repeat(33)],
    ['empty', ''],
  ])('rejects a bad metadata field key: %s', (_label, key) => {
    const invalid = {
      ...config,
      services: { ...config.services, vintage: { ...service, metadataFields: [{ key, label: 'X', type: 'text' as const }] } },
    };
    expect(() => validateConfig(invalid)).toThrow();
  });

  it('rejects duplicate metadata field keys within a service', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: { ...service, metadataFields: [dietaryField, { ...dietaryField, label: 'Dupe' }] },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/duplicate metadata field key \(dietary_notes\)/);
  });

  it('rejects a select field with no options', () => {
    const invalid = {
      ...config,
      services: { ...config.services, vintage: { ...service, metadataFields: [{ key: 'pref', label: 'Pref', type: 'select' as const }] } },
    };
    expect(() => validateConfig(invalid)).toThrow(/declares type 'select' and must declare at least one option/);
  });

  it('rejects a select field with duplicate option values', () => {
    const invalid = {
      ...config,
      services: {
        ...config.services,
        vintage: {
          ...service,
          metadataFields: [{
            key: 'pref', label: 'Pref', type: 'select' as const,
            options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'A again' }],
          }],
        },
      },
    };
    expect(() => validateConfig(invalid)).toThrow(/duplicate option value \(a\)/);
  });

  describe('resolveMetadataFieldLabel', () => {
    it('returns a plain string unchanged', () => {
      expect(resolveMetadataFieldLabel('Dietary notes', 'pt-PT', 'en')).toBe('Dietary notes');
    });

    it('resolves an exact locale match', () => {
      expect(resolveMetadataFieldLabel(seatField.label, 'pt-PT', 'en')).toBe('Preferência de lugar');
    });

    it('falls back through the base language, then the default locale, then the first declared value', () => {
      expect(resolveMetadataFieldLabel({ pt: 'Preferência (PT)', en: 'Preference (EN)' }, 'pt-BR', 'en')).toBe('Preferência (PT)');
      expect(resolveMetadataFieldLabel({ en: 'Seat preference', 'pt-PT': 'Preferência de lugar' }, 'fr', 'en')).toBe('Seat preference');
      expect(resolveMetadataFieldLabel({ de: 'Sitzplatz' }, 'fr', 'en')).toBe('Sitzplatz');
    });
  });

  describe('metadataRowsForBooking', () => {
    const vintageWithMetadata = configWithMetadata.services.vintage!;

    it('returns an empty array for null metadata', () => {
      expect(metadataRowsForBooking(vintageWithMetadata, null, 'en', 'en')).toEqual([]);
    });

    it('resolves a select value to its option label, per locale, alongside a plain text value', () => {
      expect(metadataRowsForBooking(vintageWithMetadata, { dietary_notes: 'Vegan', seat_pref: 'window' }, 'pt-PT', 'en')).toEqual([
        { key: 'dietary_notes', label: 'Dietary notes', value: 'Vegan' },
        { key: 'seat_pref', label: 'Preferência de lugar', value: 'Janela' },
      ]);
    });

    it('omits a stored key the service no longer declares', () => {
      expect(metadataRowsForBooking(vintageWithMetadata, { dietary_notes: 'Vegan', retired_field: 'x' }, 'en', 'en')).toEqual([
        { key: 'dietary_notes', label: 'Dietary notes', value: 'Vegan' },
      ]);
    });

    it('falls back to the raw stored value for a select whose option is no longer declared', () => {
      expect(metadataRowsForBooking(vintageWithMetadata, { seat_pref: 'no_longer_declared' }, 'en', 'en')).toEqual([
        { key: 'seat_pref', label: 'Seat preference', value: 'no_longer_declared' },
      ]);
    });
  });
});
