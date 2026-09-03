// The catalog endpoint is the deployment describing itself: the shape is always-present-nullable
// (no branching on key presence), and it never leaks facts that belong to quote/availability.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext, type ReservaContext } from '../src/context';
import type { ResolvedClientConfig, ResolvedServiceConfig } from '../src/core/config';
import { handleCatalog } from '../src/handlers';
import { config, service } from './fixtures';
import { fakeRepository, providers } from './fakes';

// Location-less, with consumer-declared metadata fields carrying per-locale labels.
const cruise: ResolvedServiceConfig = {
  title: 'River Cruise',
  durationMin: 90,
  turnaroundMin: 15,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '10:00', lastStart: '16:00', intervalMin: 60 }],
  pricing: [{ maxQuantity: 6, priceMinor: 4200 }],
  metadataFields: [
    { key: 'dietary_notes', label: { en: 'Dietary notes', 'pt-BR': 'Restrições alimentares' }, type: 'text', required: true, maxLength: 200 },
    {
      key: 'seat_pref',
      label: 'Seat preference',
      type: 'select',
      options: [
        { value: 'window', label: { en: 'Window seat', 'pt-BR': 'Janela' } },
        { value: 'aisle', label: 'Aisle seat' },
      ],
    },
  ],
};

const catalogConfig: ResolvedClientConfig = {
  ...config,
  services: { vintage: { ...service, title: 'Vintage Tour' }, cruise },
};

function context(overrides: Partial<ResolvedClientConfig> = {}): ReservaContext {
  return createReservaContext({
    config: { ...catalogConfig, ...overrides },
    db: {} as D1Database,
    repo: fakeRepository(),
    clock: () => new Date('2026-06-14T08:00:00.000Z'),
    providers: providers(),
  });
}

async function catalog(url = 'https://example.test/api/booking/catalog', ctx = context()): Promise<{ response: Response; payload: any }> {
  const response = await handleCatalog(new Request(url), ctx);
  return { response, payload: await response.json() };
}

function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, into);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      allKeys(entry, into);
    }
  }
  return into;
}

describe('GET /api/booking/catalog', () => {
  it('projects a location-ful service with its resolved pickup copy and an empty metadata collection', async () => {
    const { payload } = await catalog();
    expect(payload.services.find((entry: any) => entry.slug === 'vintage')).toEqual({
      slug: 'vintage',
      title: 'Vintage Tour',
      durationMin: 60,
      location: {
        meetingPoints: [{ id: 'default', label: 'Praça do Comércio', mapsUrl: 'https://maps.google.com/?q=Praca+do+Comercio' }],
        pickupOptions: [
          // Labels/hints unset in config fall back to the message catalog for the historical
          // default/custom ids — resolved here, once, instead of in every consumer.
          { id: 'default', label: 'Meeting point', hint: 'Meet us at the starting point', requiresAddress: false, usesMeetingPoint: true },
          { id: 'custom', label: 'Custom pickup', hint: 'We pick you up at your address', requiresAddress: true, usesMeetingPoint: false },
        ],
      },
      metadataFields: [],
    });
  });

  it('projects a location-less service as location: null, with its declared metadata fields', async () => {
    const { payload } = await catalog();
    expect(payload.services.find((entry: any) => entry.slug === 'cruise')).toEqual({
      slug: 'cruise',
      title: 'River Cruise',
      durationMin: 90,
      // The always-present-nullable convention: an absent optional module is null, never a
      // missing key.
      location: null,
      metadataFields: [
        { key: 'dietary_notes', label: 'Dietary notes', type: 'text', options: [], required: true, maxLength: 200 },
        {
          key: 'seat_pref',
          label: 'Seat preference',
          type: 'select',
          options: [{ value: 'window', label: 'Window seat' }, { value: 'aisle', label: 'Aisle seat' }],
          required: false,
          maxLength: null,
        },
      ],
    });
  });

  it('resolves declared labels into the negotiated locale', async () => {
    const { payload } = await catalog('https://example.test/api/booking/catalog?locale=pt');
    const cruiseEntry = payload.services.find((entry: any) => entry.slug === 'cruise');
    // 'pt' negotiates onto the supported 'pt-BR'.
    expect(cruiseEntry.metadataFields[0].label).toBe('Restrições alimentares');
    expect(cruiseEntry.metadataFields[1].options[0].label).toBe('Janela');
    // A label declared as a plain string is locale-independent by construction.
    expect(cruiseEntry.metadataFields[1].label).toBe('Seat preference');
  });

  it('publishes the deployment-level rendering facts a consumer would otherwise hardcode', async () => {
    const { payload } = await catalog();
    expect(payload.locales).toEqual({ supported: ['en', 'pt-BR'], default: 'en' });
    expect(payload.currency).toBe('eur');
    expect(payload.maxHorizonDays).toBe(180);
  });

  it('never exposes turnaround, schedule, pricing, capacity, or occupancy', async () => {
    const { response, payload } = await catalog();
    const keys = allKeys(payload);
    for (const forbidden of [
      'turnaroundMin', 'schedule', 'pricing', 'priceMinor', 'maxQuantity', 'occupancyFor',
      'capacity', 'occupancy', 'remaining', 'limitedThreshold', 'minNoticeHours', 'holdMinutes',
    ]) {
      expect(keys, `catalog leaked ${forbidden}`).not.toContain(forbidden);
    }
    // Values, not just keys: the fixture's prices, schedule times, and turnaround must not appear
    // anywhere in the serialized payload under any other name.
    const serialized = JSON.stringify(payload);
    for (const value of ['10000', '12000', '4200', '09:00', '10:00', '16:00']) {
      expect(serialized, `catalog leaked the value ${value}`).not.toContain(value);
    }
    expect(response.status).toBe(200);
  });

  it('is cacheable over HTTP only, with a short TTL that bounds staleness after a settings edit', async () => {
    const { response } = await catalog();
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('projects the merged config, so an operator settings override is visible on the next read', async () => {
    // createRouteContext merges DB-backed overrides into context.config before any handler runs;
    // this stands in for that by handing the handler an already-merged config.
    const merged = context({ booking: { ...catalogConfig.booking, maxHorizonDays: 45 } });
    const { payload } = await catalog('https://example.test/api/booking/catalog', merged);
    expect(payload.maxHorizonDays).toBe(45);
  });

  it('is GET-only', async () => {
    const response = await handleCatalog(new Request('https://example.test/api/booking/catalog', { method: 'POST' }), context());
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'method_not_allowed' } });
  });
});
