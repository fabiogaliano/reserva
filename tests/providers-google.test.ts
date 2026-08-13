import { describe, expect, it, vi } from 'vitest';
import type { ClientConfig, TourConfig } from '../src/core/config';
import { booking, config, tour } from './fixtures';
import { ProviderFailure } from '../src/provider-failure';
import { clearGoogleTokenCache, GoogleServiceAccountAuth } from '../src/providers/calendar-google/auth';
import { GoogleCalendarProvider, mapGoogleCalendarEvent } from '../src/providers/calendar-google/calendar';

// Plan 017 (design decision 4): canonical (post-validateConfig-shaped) multi-point tour, built
// inline — fixtures.ts stays a single-point `meetingPoint` shorthand tour for other suites.
const { meetingPoint: _meetingPoint, ...tourWithoutShorthand } = tour;
const multiPointTour: TourConfig = {
  ...tourWithoutShorthand,
  meetingPoints: [
    { id: 'default', label: 'Praça do Comércio', mapsUrl: 'https://maps.google.com/?q=Praca+do+Comercio' },
    { id: 'belem', label: 'Belém Tower', mapsUrl: 'https://maps.google.com/?q=Belem+Tower' },
  ],
};
const multiPointConfig: ClientConfig = { ...config, tours: { vintage: multiPointTour } };

// Plan 018 (design decision 8): a declared option with BOTH requiresAddress and usesMeetingPoint
// (Maze's combined custom pickup+drop-off) — built inline per the same "don't touch fixtures.ts" rule.
const bothFlagsTour: TourConfig = {
  ...multiPointTour,
  pickupOptions: [
    { id: 'default', requiresAddress: false, usesMeetingPoint: true },
    { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
    { id: 'custom_pickup', requiresAddress: true, usesMeetingPoint: false },
  ],
  pricing: [
    { maxPeople: 8, pickup: 'default', priceCents: 18000 },
    { maxPeople: 8, pickup: 'custom_dropoff', priceCents: 21000 },
    { maxPeople: 8, pickup: 'custom_pickup', priceCents: 20000 },
  ],
};
const bothFlagsConfig: ClientConfig = { ...config, tours: { vintage: bothFlagsTour } };

const fakePem = '-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----';
const fakeCrypto = {
  subtle: {
    importKey: vi.fn(async () => ({}) as CryptoKey),
    sign: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  },
} as unknown as Pick<Crypto, 'subtle'>;

describe('Google Calendar provider', () => {
  it('creates and caches a service-account access token', async () => {
    clearGoogleTokenCache();
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ access_token: 'token-1', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } }));
    const auth = new GoogleServiceAccountAuth({ serviceAccountEmail: 'sa@example.test', privateKey: fakePem, impersonateEmail: 'owner@example.test', fetch: request, crypto: fakeCrypto, now: () => Date.parse('2026-07-21T12:00:00Z') });
    await expect(auth.getAccessToken()).resolves.toBe('token-1');
    await expect(auth.getAccessToken()).resolves.toBe('token-1');
    expect(request).toHaveBeenCalledTimes(1);
    const body = String(request.mock.calls[0]?.[1]?.body);
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(body).toContain('assertion=');
    const assertion = new URLSearchParams(body).get('assertion');
    expect(assertion).toBeTruthy();
    const [header, claims] = assertion!.split('.');
    expect(JSON.parse(atob(header!.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(header!.length / 4) * 4, '=')))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(atob(claims!.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(claims!.length / 4) * 4, '=')))).toMatchObject({ iss: 'sa@example.test', sub: 'owner@example.test', scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: 1784635200, exp: 1784638800 });
  });

  it('single-flights concurrent cache-miss token requests into one POST', async () => {
    let posts = 0;
    const request = vi.fn<typeof fetch>(async () => {
      posts += 1;
      await Promise.resolve(); // yield a microtask so both concurrent callers are mid-flight together
      return new Response(JSON.stringify({ access_token: 'token-shared', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
    });
    // Unique cacheKey so this test's in-flight/cache state can never leak into (or be leaked into
    // by) another test sharing the module-level tokenCache/tokenRequestsInFlight maps.
    const auth = new GoogleServiceAccountAuth({
      serviceAccountEmail: 'sa@example.test', privateKey: fakePem, impersonateEmail: 'owner@example.test',
      fetch: request, crypto: fakeCrypto, now: () => Date.parse('2026-07-21T12:00:00Z'),
      cacheKey: 'single-flight-test',
    });

    const [first, second] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);

    expect(first).toBe('token-shared');
    expect(second).toBe('token-shared');
    expect(posts).toBe(1);
  });

  it('maps timed and all-day Calendar events while preserving Bookkit ownership metadata', () => {
    expect(mapGoogleCalendarEvent({ id: 'event-1', start: { dateTime: '2026-07-21T09:00:00Z' }, end: { dateTime: '2026-07-21T10:00:00Z' }, extendedProperties: { private: { bookkitBookingId: 'booking-1' } } })).toEqual(expect.objectContaining({ id: 'event-1', start: '2026-07-21T09:00:00Z', end: '2026-07-21T10:00:00Z', bookkitBookingId: 'booking-1' }));
    expect(mapGoogleCalendarEvent({ id: 'day-1', start: { date: '2026-07-21' }, end: { date: '2026-07-22' } })).toEqual(expect.objectContaining({ allDay: true, start: '2026-07-21', end: '2026-07-22' }));
  });

  it('lists only valid event records and sends Calendar REST requests with bearer auth', async () => {
    const auth = { getAccessToken: vi.fn(async () => 'token') } as unknown as GoogleServiceAccountAuth;
    const request = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/events?') && init?.method === undefined) return new Response(JSON.stringify({ items: [{ id: 'e1', start: { dateTime: '2026-07-21T09:00:00Z' }, end: { dateTime: '2026-07-21T10:00:00Z' } }, { id: 'bad' }] }));
      return new Response(JSON.stringify({ id: 'created' }), { headers: { 'content-type': 'application/json' } });
    });
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request, timezone: 'Europe/Lisbon' });
    await expect(provider.listEvents('2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z')).resolves.toHaveLength(1);
    await expect(provider.createEvent(booking(), config)).resolves.toBe('created');
    expect(request).toHaveBeenCalledWith(expect.stringContaining('singleEvents=true'), expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer token' }) }));
    const createCall = request.mock.calls[1];
    expect(String(createCall?.[0])).toContain('sendUpdates=all');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual(expect.objectContaining({
      id: 'booking1',
      extendedProperties: { private: expect.objectContaining({ bookkitBookingId: 'booking-1' }) },
    }));
    await provider.patchEvent('created', booking({ startsAt: '2026-07-21T11:00:00.000Z', endsAt: '2026-07-21T12:00:00.000Z' }), config);
    await provider.deleteEvent('created');
    expect(request.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'PATCH' }));
    expect(String(request.mock.calls[2]?.[0])).toContain('/created?sendUpdates=all');
    // Plan 017: TourConfig.meetingPoint is now optional shorthand — the fixture tour still uses it
    // (single-point, unvalidated), so the non-null assertion carries the "this fixture declares it" fact.
    expect(String(request.mock.calls[2]?.[1]?.body)).toContain(config.tours.vintage!.meetingPoint!.mapsUrl);
    expect(request.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  // Plan 017 (design decision 4): the event description's Pickup/maps-URL lines resolve per
  // booking (chosen meeting point id) instead of always reading the tour's single `meetingPoint`.
  it('describes the meeting point the booking chose on a multi-point tour', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'created' }), { headers: { 'content-type': 'application/json' } }));
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await provider.createEvent(booking({ meetingPointId: 'belem', meetingPointLabel: 'Belém Tower' }), multiPointConfig);

    const body = String(request.mock.calls[0]?.[1]?.body);
    expect(body).toContain('Pickup: Belém Tower');
    expect(body).toContain('https://maps.google.com/?q=Belem+Tower');
    expect(body).not.toContain('Praça do Comércio');
  });

  it('falls back to the stored label snapshot with no maps line when the booked meeting point id is no longer declared', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'created' }), { headers: { 'content-type': 'application/json' } }));
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await provider.createEvent(booking({ meetingPointId: 'removed-point', meetingPointLabel: 'Old Fountain Square' }), multiPointConfig);

    const body = String(request.mock.calls[0]?.[1]?.body);
    expect(body).toContain('Pickup: Old Fountain Square');
    expect(body).not.toContain('maps.google.com');
  });

  // Plan 018 (design decision 8): a non-default declared option that only collects an address
  // (requiresAddress: true, usesMeetingPoint: false) — the Pickup line is the address, no maps line.
  it('describes the collected address for a non-default option id with requiresAddress and no maps line', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'created' }), { headers: { 'content-type': 'application/json' } }));
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await provider.createEvent(booking({ pickupType: 'custom_pickup', pickupAddress: 'Hotel Avenida' }), bothFlagsConfig);

    const body = String(request.mock.calls[0]?.[1]?.body);
    expect(body).toContain('Pickup: Hotel Avenida');
    expect(body).not.toContain('maps.google.com');
  });

  // Plan 018 (design decision 8): an option with BOTH flags (Maze's combined custom pickup +
  // drop-off) shows both — the address on the Pickup line AND the meeting-point maps URL line.
  it('describes both the collected address and the meeting-point maps URL for an option with both flags', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'created' }), { headers: { 'content-type': 'application/json' } }));
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await provider.createEvent(booking({
      pickupType: 'custom_dropoff', pickupAddress: 'Hotel Avenida',
      meetingPointId: 'belem', meetingPointLabel: 'Belém Tower',
    }), bothFlagsConfig);

    const body = String(request.mock.calls[0]?.[1]?.body);
    expect(body).toContain('Pickup: Hotel Avenida');
    expect(body).toContain('https://maps.google.com/?q=Belem+Tower');
  });

  it('treats a deterministic event-id conflict as an already-created event', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    const request = async (): Promise<Response> => new Response('', { status: 409 });
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await expect(provider.createEvent(booking({ id: '0a1b2c3d-4e5f-6789-a0b1-c2d3e4f5a6b7' }), config))
      .resolves.toBe('0a1b2c3d4e5f6789a0b1c2d3e4f5a6b7');
  });

  it('carries a structured status/retryable classification on a failed Calendar request (plan 016)', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    let caught: unknown;
    const requestServerError = async (): Promise<Response> => new Response('', { status: 503 });
    const providerRetryable = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: requestServerError });
    try {
      await providerRetryable.deleteEvent('missing-not-404-or-410');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderFailure);
    if (!(caught instanceof ProviderFailure)) throw new Error('Google Calendar request unexpectedly succeeded');
    expect(caught.status).toBe(503);
    expect(caught.retryable).toBe(true);

    const requestForbidden = async (): Promise<Response> => new Response('', { status: 403 });
    const providerPermanent = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: requestForbidden });
    let caughtPermanent: unknown;
    try {
      await providerPermanent.createEvent(booking(), config);
    } catch (error) {
      caughtPermanent = error;
    }
    expect(caughtPermanent).toBeInstanceOf(ProviderFailure);
    if (!(caughtPermanent instanceof ProviderFailure)) throw new Error('Google Calendar request unexpectedly succeeded');
    expect(caughtPermanent.status).toBe(403);
    expect(caughtPermanent.retryable).toBe(false);
  });

  it('carries a structured status/retryable classification on a failed Google token request (plan 016)', async () => {
    clearGoogleTokenCache();
    const request = vi.fn<typeof fetch>(async () => new Response('invalid_grant', { status: 401 }));
    const auth = new GoogleServiceAccountAuth({
      serviceAccountEmail: 'sa@example.test', privateKey: fakePem, impersonateEmail: 'owner@example.test',
      fetch: request, crypto: fakeCrypto, now: () => Date.parse('2026-07-21T12:00:00Z'), cacheKey: 'plan-016-auth-failure',
    });
    let caught: unknown;
    try {
      await auth.getAccessToken();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderFailure);
    if (!(caught instanceof ProviderFailure)) throw new Error('Google token request unexpectedly succeeded');
    expect(caught.status).toBe(401);
    expect(caught.retryable).toBe(false);
    expect(caught.message).toContain('invalid_grant');
  });

  it('follows Calendar pagination tokens', async () => {
    const auth = { getAccessToken: vi.fn(async () => 'token') } as unknown as GoogleServiceAccountAuth;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const pageToken = url.searchParams.get('pageToken');
      const body = pageToken
        ? { items: [{ id: 'e2', start: { dateTime: '2026-07-21T11:00:00Z' }, end: { dateTime: '2026-07-21T12:00:00Z' } }] }
        : { items: [{ id: 'e1', start: { dateTime: '2026-07-21T09:00:00Z' }, end: { dateTime: '2026-07-21T10:00:00Z' } }], nextPageToken: 'page-2' };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await expect(provider.listEvents('2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z')).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]?.[0])).toContain('pageToken=page-2');
  });

  it('stops an endlessly paginated Calendar response at the page cap', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items: [], nextPageToken: 'next-page' }), {
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await expect(provider.listEvents('2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z')).rejects.toThrow('pagination exceeded 10 pages');
    expect(request).toHaveBeenCalledTimes(10);
  });

  it('retries one rate-limited Calendar page before failing', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    const request = vi.fn<typeof fetch>(async () => {
      if (request.mock.calls.length === 1) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } });
    });
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await expect(provider.listEvents('2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z')).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
