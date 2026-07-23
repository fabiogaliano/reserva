import { describe, expect, it, vi } from 'vitest';
import { booking, config } from './fixtures';
import { clearGoogleTokenCache, GoogleServiceAccountAuth } from '../src/providers/calendar-google/auth';
import { GoogleCalendarProvider, mapGoogleCalendarEvent } from '../src/providers/calendar-google/calendar';

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
    expect(String(request.mock.calls[2]?.[1]?.body)).toContain(config.tours.vintage!.meetingPoint.mapsUrl);
    expect(request.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  it('treats a deterministic event-id conflict as an already-created event', async () => {
    const auth = { getAccessToken: async () => 'token' } as GoogleServiceAccountAuth;
    const request = async (): Promise<Response> => new Response('', { status: 409 });
    const provider = new GoogleCalendarProvider({ calendarId: 'primary@example.test', auth, fetch: request });

    await expect(provider.createEvent(booking({ id: '0a1b2c3d-4e5f-6789-a0b1-c2d3e4f5a6b7' }), config))
      .resolves.toBe('0a1b2c3d4e5f6789a0b1c2d3e4f5a6b7');
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
