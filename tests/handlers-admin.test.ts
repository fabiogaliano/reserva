import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { ADMIN_CSRF_TOKEN_TTL_MS, mintAdminCsrfToken } from '../src/admin-csrf';
import { createReservaContext } from '../src/context';
import type { ResolvedClientConfig, ResolvedServiceConfig } from '../src/core/config';
import { handleAdminGet, handleAdminPost } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');
const CSRF_NOW = clock().getTime();
const ADMIN_URL = 'https://example.test/api/booking/admin';
const ADMIN_ORIGIN = 'https://example.test';
// A real RESERVA_CSRF_SECRET keeps CSRF layer 2 active (src/admin-csrf.ts no-ops without one) —
// otherwise the "invalid/expired/foreign token -> 403" assertions below would pass for the wrong reason.
const CSRF_TEST_SECRET = 'handlers-admin-test-secret';
const csrfSecrets = async (name: string) => (name === 'RESERVA_CSRF_SECRET' ? CSRF_TEST_SECRET : undefined);

// mintAdminCsrfToken returns undefined only when no secret is configured (see above); this fixture
// always supplies one, so the throw below is unreachable in practice and only guards the return type.
async function mintTestCsrfToken(sub: string, at: number): Promise<string> {
  const token = await mintAdminCsrfToken({ config, secrets: csrfSecrets }, sub, at);
  if (token === undefined) throw new Error('test setup: expected a CSRF token — is CSRF_TEST_SECRET wired up?');
  return token;
}

const DEFAULT_CSRF_TOKEN = await mintTestCsrfToken('', CSRF_NOW);

function adminGetRequest(): Request {
  return new Request(ADMIN_URL);
}

interface AdminPostOptions {
  // Defaults to same-origin Fetch-Metadata headers; pass {} or foreign values to exercise the
  // origin guard.
  headers?: HeadersInit;
  // Defaults to a valid token bound to sub=''; pass null to omit the field entirely (the CSRF
  // token layer's "missing token" case).
  csrfToken?: string | null;
}

function adminPostRequest(fields: Record<string, string> | Array<[string, string]>, options: AdminPostOptions = {}): Request {
  const body = new URLSearchParams(fields);
  const token = options.csrfToken === null ? null : options.csrfToken ?? DEFAULT_CSRF_TOKEN;
  if (token !== null) body.set('csrf_token', token);
  return new Request(ADMIN_URL, {
    method: 'POST',
    body,
    headers: options.headers ?? { origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin' },
  });
}

// Proves the real handler wiring rejects an oversized declared Content-Length with 413, ahead of
// the CSRF check — the body must be read before csrf_token can be extracted from the form.
describe('request body size limit (audit finding #10)', () => {
  it('rejects an admin POST whose declared Content-Length exceeds the 256 KB form limit with 413', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const request = new Request(ADMIN_URL, {
      method: 'POST',
      headers: {
        origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded', 'content-length': String(256 * 1024 + 1),
      },
      body: 'action=clear&date=2026-06-20',
    });
    const response = await handleAdminPost(request, context);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'payload_too_large' } });
  });
});

describe('access control (spec §11: admin requires Cloudflare Access)', () => {
  it('rejects GET and POST when adminAuth is absent, resolves null, or throws', async () => {
    const variants: Array<{ label: string; adminAuth?: () => Promise<{ subject: string } | null> }> = [
      { label: 'absent' },
      { label: 'resolves null', adminAuth: async () => null },
      { label: 'throws', adminAuth: () => { throw new Error('access check exploded'); } },
    ];
    for (const variant of variants) {
      const context = createReservaContext({
        config,
        db: {} as D1Database,
        repo: fakeRepository(),
        clock,
        providers: providers(),
        ...(variant.adminAuth ? { adminAuth: variant.adminAuth } : {}),
      });
      const getResponse = await handleAdminGet(adminGetRequest(), context);
      expect(getResponse.status, `GET with adminAuth ${variant.label}`).toBe(403);
      const postResponse = await handleAdminPost(adminPostRequest({ action: 'clear', date: '2026-06-20' }), context);
      expect(postResponse.status, `POST with adminAuth ${variant.label}`).toBe(403);
    }
  });
});

describe('GET /admin listing (spec §11 + repo.ts:260-267 filter)', () => {
  it('lists only upcoming confirmed and unexpired-hold bookings, excluding swept-expired holds, cancelled, and past rows', async () => {
    const futureConfirmed = booking({ id: 'b-admin-future-confirmed', reference: 'LVT-2026-100', status: 'confirmed', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z', operatorToken: 'op-future-confirmed', cancelToken: 'cancel-future-confirmed' });
    const futureUnexpiredHold = booking({ id: 'b-admin-future-hold', reference: 'LVT-2026-101', status: 'hold', holdExpiresAt: '2026-06-14T09:00:00.000Z', startsAt: '2026-06-21T09:00:00.000Z', endsAt: '2026-06-21T10:00:00.000Z', operatorToken: 'op-future-hold', cancelToken: 'cancel-future-hold' });
    const futureExpiredHold = booking({ id: 'b-admin-expired-hold', reference: 'LVT-2026-102', status: 'hold', holdExpiresAt: '2026-06-14T07:00:00.000Z', startsAt: '2026-06-22T09:00:00.000Z', endsAt: '2026-06-22T10:00:00.000Z', operatorToken: 'op-expired-hold', cancelToken: 'cancel-expired-hold' });
    const cancelledFuture = booking({ id: 'b-admin-cancelled', reference: 'LVT-2026-103', status: 'cancelled', cancelledAt: '2026-06-13T08:00:00.000Z', cancelledBy: 'customer', startsAt: '2026-06-23T09:00:00.000Z', endsAt: '2026-06-23T10:00:00.000Z', operatorToken: 'op-cancelled', cancelToken: 'cancel-cancelled' });
    const pastConfirmed = booking({ id: 'b-admin-past', reference: 'LVT-2026-104', status: 'confirmed', startsAt: '2026-06-10T09:00:00.000Z', endsAt: '2026-06-10T10:00:00.000Z', operatorToken: 'op-past', cancelToken: 'cancel-past' });
    const repo = fakeRepository([futureConfirmed, futureUnexpiredHold, futureExpiredHold, cancelledFuture, pastConfirmed]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminGet(adminGetRequest(), context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(futureConfirmed.reference);
    expect(body).toContain(futureUnexpiredHold.reference);
    expect(body).not.toContain(futureExpiredHold.reference);
    expect(body).not.toContain(cancelledFuture.reference);
    expect(body).not.toContain(pastConfirmed.reference);
    // The sweep (called inside handleAdminGet) must have flipped the time-expired hold.
    expect(repo.rows.get(futureExpiredHold.id)?.status).toBe('expired');
  });

  // An active search/status filter widens the table's source (repo.listAllFrom) — the default
  // upcoming-only view can never contain the cancelled/past rows those filters exist to find.
  it('surfaces cancelled and past rows when a status or search filter is active', async () => {
    const cancelledFuture = booking({ id: 'b-admin-filter-cancelled', reference: 'LVT-2026-110', status: 'cancelled', cancelledAt: '2026-06-13T08:00:00.000Z', cancelledBy: 'customer', startsAt: '2026-06-23T09:00:00.000Z', endsAt: '2026-06-23T10:00:00.000Z', operatorToken: 'op-filter-cancelled', cancelToken: 'cancel-filter-cancelled' });
    const pastConfirmed = booking({ id: 'b-admin-filter-past', reference: 'LVT-2026-111', status: 'confirmed', startsAt: '2026-06-10T09:00:00.000Z', endsAt: '2026-06-10T10:00:00.000Z', operatorToken: 'op-filter-past', cancelToken: 'cancel-filter-past' });
    const repo = fakeRepository([cancelledFuture, pastConfirmed]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const byStatus = await (await handleAdminGet(new Request(`${ADMIN_URL}?status=cancelled`), context)).text();
    expect(byStatus).toContain(cancelledFuture.reference);
    expect(byStatus).not.toContain(pastConfirmed.reference);
    // Terminal rows carry no manage link — the operator page would have no actions to offer.
    expect(byStatus).not.toContain('op-filter-cancelled');

    const bySearch = await (await handleAdminGet(new Request(`${ADMIN_URL}?q=LVT-2026-111`), context)).text();
    expect(bySearch).toContain(pastConfirmed.reference);
  });

  it('separates page destinations from the dashboard’s in-page section menu', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();

    expect(body).toContain('data-reserva-section-nav');
    expect(body).toContain('<p class="bk-section-nav-title">On this page</p>');
    expect(body).toContain('href="#bk-bookings" data-reserva-section-link');
    expect(body).toContain('href="#bk-days" data-reserva-section-link');
    expect(body).not.toContain('/booking/admin#bk-bookings');
    expect(body).not.toContain('/booking/admin#bk-days');
    expect(body).toContain('href="/booking/admin" class="bk-active" aria-current="page"');
    expect(body).toContain('href="/booking/admin?view=settings"');
  });

  it('uses an operator locale without changing the customer default', async () => {
    const localizedConfig: ResolvedClientConfig = {
      ...config,
      admin: { ...config.admin, locale: 'pt-PT' },
      locales: { supported: ['en'], default: 'en' },
    };
    const localizedBooking = booking({ startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z' });
    const context = createReservaContext({ config: localizedConfig, db: {} as D1Database, repo: fakeRepository([localizedBooking]), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const dashboard = await handleAdminGet(adminGetRequest(), context);
    const dashboardBody = await dashboard.text();
    expect(dashboardBody).toContain('<html lang="pt-PT">');
    expect(dashboardBody).toContain('<title>Administração de reservas — Example City Tours</title>');
    expect(dashboardBody).toContain('<p class="bk-section-nav-title">Nesta página</p>');
    expect(dashboardBody).toContain('data-label="Cliente"');

    const settings = await handleAdminGet(new Request(`${ADMIN_URL}?view=settings`), context);
    const settingsBody = await settings.text();
    expect(settingsBody).toContain('<html lang="pt-PT">');
    expect(settingsBody).toContain('<title>Definições — Example City Tours</title>');
    expect(localizedConfig.locales.default).toBe('en');
  });

  it('manage links carry each row\'s operator token (URL-encoded) and never leak a cancel_token', async () => {
    const first = booking({ id: 'b-admin-links-1', reference: 'LVT-2026-200', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z', operatorToken: 'operator+token/one', cancelToken: 'cancel-token-one-secret' });
    const second = booking({ id: 'b-admin-links-2', reference: 'LVT-2026-201', startsAt: '2026-06-21T09:00:00.000Z', endsAt: '2026-06-21T10:00:00.000Z', operatorToken: 'operator-token-two', cancelToken: 'cancel-token-two-secret' });
    const repo = fakeRepository([first, second], { tokenEncryptionKey: 'handlers-admin-token-key' });
    const secrets = async (name: string) => {
      if (name === 'RESERVA_TOKEN_ENC_KEY') return 'handlers-admin-token-key';
      return csrfSecrets(name);
    };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets });

    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(first.operatorToken)}`);
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(second.operatorToken)}`);
    expect(body).not.toContain(first.cancelToken);
    expect(body).not.toContain(second.cancelToken);
  });

  // A `nohash:`-prefixed operatorToken (src/repo.ts placeholderToken) means no decryptable blob
  // exists to rebuild its link — rendering one would 403 the instant an operator clicked it.
  it('omits the manage link (never a dead href) for a booking whose operator token is not presentable', async () => {
    const seeded = booking({
      id: 'b-admin-nohash', reference: 'LVT-2026-210', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      operatorToken: 'nohash:11111111-1111-1111-1111-111111111111', cancelToken: 'cancel-token-nohash-secret',
    });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    expect(body).not.toContain(`token=${encodeURIComponent(seeded.operatorToken)}`);
    expect(body).not.toContain(seeded.operatorToken); // not even unencoded, e.g. inside the JSON island
    expect(body).toContain('Manage link unavailable');
  });

  // `same-origin`, not `no-referrer`: the admin forms POST back to this same page, and
  // `no-referrer` would null the browser's Origin header on that same-origin POST, tripping
  // Astro's checkOrigin default (see the WHY comment at the response site in src/handlers/index.ts).
  it('sets cache-control: no-store and referrer-policy: same-origin', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminGet(adminGetRequest(), context);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
  });

  // The day calendar must show capacity units consumed, not a raw booking-row count — a single
  // 5-person booking on the fixture service (occupancyFor: quantity > 4 ? 2 : 1) needs two vehicles,
  // so a day with just this one booking is already at the fixture's default capacity (2).
  it('renders the day cell in capacity units, not booking count, for a multi-unit booking', async () => {
    const multiUnit = booking({
      id: 'b-admin-multiunit', reference: 'LVT-2026-300', quantity: 5,
      startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      operatorToken: 'op-multiunit', cancelToken: 'cancel-multiunit',
    });
    const repo = fakeRepository([multiUnit]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers() });
    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    // One booking, two capacity units, capacity 2 (fixture's capacity.defaultCapacity) — the label must
    // read the unit count against capacity, not "1/2" (which is what a raw booking count would show).
    expect(body).toContain('units 2/2');
    expect(body).not.toMatch(/bk-day-load">1\/2</);
  });

  // The meeting-point sub-line only renders for a default pickup on a service that actually
  // declares more than one point — mirrors the existing pickupAddress sub-line pattern, and search
  // must match what the row displays.
  describe('meeting-point sub-line + search', () => {
    const points = [
      { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
      { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
    ];
    const multiPointConfig: ResolvedClientConfig = { ...config, services: { ...config.services, vintage: { ...config.services.vintage!, location: { ...config.services.vintage!.location!, meetingPoints: points } } } };

    it('renders the resolved meeting-point label as a sub-line for a multi-point service, and is absent for a single-point service', async () => {
      const chosen = booking({
        id: 'b-admin-meeting-point', reference: 'LVT-2026-400', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
        operatorToken: 'op-meeting-point', cancelToken: 'cancel-meeting-point',
        meetingPointId: 'station', meetingPointLabel: 'The Station',
      });
      const multiRepo = fakeRepository([chosen]);
      const multiContext = createReservaContext({ config: multiPointConfig, db: {} as D1Database, repo: multiRepo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
      const multiResponse = await handleAdminGet(adminGetRequest(), multiContext);
      const multiBody = await multiResponse.text();
      expect(multiBody).toContain('<span class="bk-sub">The Station</span>');

      const singleRepo = fakeRepository([booking({
        id: 'b-admin-single-point', reference: 'LVT-2026-401', startsAt: '2026-06-21T09:00:00.000Z', endsAt: '2026-06-21T10:00:00.000Z',
        operatorToken: 'op-single-point', cancelToken: 'cancel-single-point',
      })]);
      const singleContext = createReservaContext({ config, db: {} as D1Database, repo: singleRepo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
      const singleResponse = await handleAdminGet(adminGetRequest(), singleContext);
      const singleBody = await singleResponse.text();
      expect(singleBody).not.toContain('bk-sub">The Station');
    });

    it('finds a booking by its resolved meeting-point label via the search filter', async () => {
      const chosen = booking({
        id: 'b-admin-meeting-point-search', reference: 'LVT-2026-402', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
        operatorToken: 'op-meeting-point-search', cancelToken: 'cancel-meeting-point-search',
        meetingPointId: 'station', meetingPointLabel: 'The Station',
      });
      const repo = fakeRepository([chosen]);
      const context = createReservaContext({ config: multiPointConfig, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
      const response = await handleAdminGet(new Request(`${ADMIN_URL}?q=station`), context);
      const body = await response.text();
      expect(body).toContain(chosen.reference);
    });
  });
});

// The pickup-cell label falls back through option?.label -> the message-catalog key for
// 'default'/'custom' -> the raw id; sub-line gates mirror checkout's meeting-point requirement.
describe('pickup option label + sub-lines', () => {
  const points = [
    { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
    { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
  ];
  const mazeTour: ResolvedServiceConfig = {
    ...config.services.vintage!,
    location: {
      meetingPoints: points,
      pickupOptions: [
        { id: 'default', requiresAddress: false, usesMeetingPoint: true },
        { id: 'custom_dropoff', label: 'Custom pickup & drop-off', requiresAddress: true, usesMeetingPoint: true },
        { id: 'meet_elsewhere', requiresAddress: false, usesMeetingPoint: true },
      ],
    },
    pricing: [
      { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
      { maxQuantity: 8, pickup: 'custom_dropoff', priceMinor: 21000 },
      { maxQuantity: 8, pickup: 'meet_elsewhere', priceMinor: 19000 },
    ],
  };
  const mazeConfig: ResolvedClientConfig = { ...config, services: { ...config.services, vintage: mazeTour } };

  it('renders a declared option\'s own label', async () => {
    const seeded = booking({
      id: 'b-admin-option-label', reference: 'LVT-2026-500', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      operatorToken: 'op-option-label', cancelToken: 'cancel-option-label',
      pickupType: 'custom_dropoff', pickupAddress: 'Hotel Avenida', meetingPointId: 'station', meetingPointLabel: 'The Station',
    });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config: mazeConfig, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    expect(body).toContain('Custom pickup &amp; drop-off');
    // Both flags declared: the address AND the resolved meeting-point sub-line both render.
    expect(body).toContain('<span class="bk-sub">Hotel Avenida</span>');
    expect(body).toContain('<span class="bk-sub">The Station</span>');
  });

  it('falls back to the message-catalog labels for the default/custom ids when a config declares no pickupOptions', async () => {
    const defaultSeeded = booking({
      id: 'b-admin-catalog-default', reference: 'LVT-2026-501', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      operatorToken: 'op-catalog-default', cancelToken: 'cancel-catalog-default', pickupType: 'default',
    });
    const customSeeded = booking({
      id: 'b-admin-catalog-custom', reference: 'LVT-2026-502', startsAt: '2026-06-21T09:00:00.000Z', endsAt: '2026-06-21T10:00:00.000Z',
      operatorToken: 'op-catalog-custom', cancelToken: 'cancel-catalog-custom', pickupType: 'custom', pickupAddress: 'Hotel Avenida',
    });
    const repo = fakeRepository([defaultSeeded, customSeeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    expect(body).toContain('Meeting point');
    expect(body).toContain('Custom pickup');
  });

  it('falls back to the raw id for a declared option with no label', async () => {
    const seeded = booking({
      id: 'b-admin-raw-id', reference: 'LVT-2026-503', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      operatorToken: 'op-raw-id', cancelToken: 'cancel-raw-id',
      pickupType: 'meet_elsewhere', meetingPointId: 'square', meetingPointLabel: 'The Square',
    });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config: mazeConfig, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    expect(body).toContain('>meet_elsewhere<');
    // usesMeetingPoint: true, requiresAddress: false — meeting-point sub-line, no address sub-line.
    expect(body).toContain('<span class="bk-sub">The Square</span>');
  });

  it('search cannot match a meeting-point label the row does not display (usesMeetingPoint: false)', async () => {
    const noMeetTour: ResolvedServiceConfig = {
      ...mazeTour,
      location: {
        meetingPoints: mazeTour.location!.meetingPoints!,
        pickupOptions: [
          { id: 'default', requiresAddress: false, usesMeetingPoint: true },
          { id: 'hotel_pickup', requiresAddress: true, usesMeetingPoint: false },
        ],
      },
      pricing: [
        { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
        { maxQuantity: 8, pickup: 'hotel_pickup', priceMinor: 20000 },
      ],
    };
    const noMeetConfig: ResolvedClientConfig = { ...config, services: { ...config.services, vintage: noMeetTour } };
    const seeded = booking({
      id: 'b-admin-hidden-point', reference: 'LVT-2026-504', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      operatorToken: 'op-hidden-point', cancelToken: 'cancel-hidden-point',
      pickupType: 'hotel_pickup', pickupAddress: 'Hotel Avenida', meetingPointId: 'station', meetingPointLabel: 'The Station',
    });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config: noMeetConfig, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    // The row hides the meeting point for this option, so the stored label must be invisible to
    // search too — the haystack and the renderer share adminMeetingPointSubLabel.
    const unfiltered = await (await handleAdminGet(adminGetRequest(), context)).text();
    expect(unfiltered).toContain(seeded.reference);
    expect(unfiltered).not.toContain('The Station');
    const searched = await (await handleAdminGet(new Request(`${ADMIN_URL}?q=station`), context)).text();
    expect(searched).not.toContain(seeded.reference);
  });
});

describe('POST /admin day overrides (spec §11)', () => {
  it('action=set calls upsertDayOverrides once with a trimmed reason and redirects (303) back with a saved confirmation', async () => {
    const repo = fakeRepository();
    const calls: Array<[string[], number, string | null]> = [];
    repo.upsertDayOverrides = async (dates, capacity, reason) => { calls.push([dates, capacity, reason]); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const request = adminPostRequest({ date: '2026-06-20', capacity: '3', reason: '  closed for maintenance  ', action: 'set' });
    const response = await handleAdminPost(request, context);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${request.url}?saved=day&date=2026-06-20#bk-override`);
    expect(calls).toEqual([[['2026-06-20'], 3, 'closed for maintenance']]);
  });

  it('action=close writes capacity 0 for every submitted date in a single batched call (repeated date fields)', async () => {
    const repo = fakeRepository();
    const calls: Array<[string[], number, string | null]> = [];
    repo.upsertDayOverrides = async (dates, capacity, reason) => { calls.push([dates, capacity, reason]); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest([
      ['date', '2026-06-22'], ['date', '2026-06-20'], ['date', '2026-06-20'], ['reason', 'holiday'], ['action', 'close'],
    ]), context);
    expect(response.status).toBe(303);
    // Deduplicated, sorted, and the redirect pins ?date= to the earliest edited day.
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('date')).toBe('2026-06-20');
    // One call carrying the full deduplicated/sorted date set, not one call per date.
    expect(calls).toEqual([[['2026-06-20', '2026-06-22'], 0, 'holiday']]);
  });

  it('toDate expands date into a contiguous range for set/close/clear, batched into a single plural call', async () => {
    const repo = fakeRepository();
    const upserts: Array<[string[], number]> = [];
    const deletes: string[][] = [];
    repo.upsertDayOverrides = async (dates, capacity) => { upserts.push([dates, capacity]); };
    repo.deleteDayOverrides = async (dates) => { deletes.push(dates); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-22', capacity: '1', action: 'set' }), context);
    expect(upserts).toEqual([[['2026-06-20', '2026-06-21', '2026-06-22'], 1]]);
    await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-21', action: 'clear' }), context);
    expect(deletes).toEqual([['2026-06-20', '2026-06-21']]);
  });

  it('rejects toDate before date with 400 validation_failed', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-19', capacity: '1', action: 'set' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('action=set with a blank reason passes null', async () => {
    const repo = fakeRepository();
    const calls: Array<[string[], number, string | null]> = [];
    repo.upsertDayOverrides = async (dates, capacity, reason) => { calls.push([dates, capacity, reason]); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', capacity: '0', reason: '   ', action: 'set' }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual([[['2026-06-20'], 0, null]]);
  });

  it('action=clear calls deleteDayOverrides with the full date array in one call', async () => {
    const repo = fakeRepository();
    const calls: string[][] = [];
    repo.deleteDayOverrides = async (dates) => { calls.push(dates); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual([['2026-06-20']]);
  });

  it('rejects an unknown action with 400 validation_failed', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'delete-everything' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('rejects an invalid date with 400', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: 'not-a-date', action: 'clear' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });
});

describe('admin settings (?view=settings + settings-save/settings-reset actions)', () => {
  function settingsGetRequest(): Request {
    return new Request('https://example.test/api/booking/admin?view=settings');
  }

  it('renders the settings page with editable fields and marks overridden settings', async () => {
    const repo = fakeRepository();
    repo.settings.set('booking.minNoticeHours', '2');
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminGet(settingsGetRequest(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain('name="booking.minNoticeHours"');
    expect(body).toContain('Modified');
    expect(body).toContain('Default: 24');
    // The overridden field offers a per-field reset action.
    expect(body).toContain('value="settings-reset:booking.minNoticeHours"');
    // Capacity size is a normal setting; only genuinely structural values remain deploy-time.
    expect(body).toContain('data-reserva-tab="capacity"');
    expect(body).toContain('name="capacity.default"');
    expect(body).toContain('value="2" min="0" step="1" required');
    expect(body).toContain(config.business.timezone);
    expect(body).toContain('These cannot be changed here.');
  });

  it('saves, resets, and validates the normal number of capacity vehicles', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const save = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'capacity', 'capacity.default': '4' }), context);
    expect(save.status).toBe(303);
    expect(repo.settings.get('capacity.default')).toBe('4');

    const resetToFileValue = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'capacity', 'capacity.default': '2' }), context);
    expect(resetToFileValue.status).toBe(303);
    expect(repo.settings.has('capacity.default')).toBe(false);

    const invalid = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'capacity', 'capacity.default': '-1' }), context);
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('capacity.default') } });
  });

  // The holdMinutes kind declares max: 1440 (core/settings.ts); the rendered input must carry it
  // as an HTML max= constraint, mirroring min=, so a value like 1441 is rejected client-side too —
  // not just at parseSettingForm/mergeAndValidateSettings.
  it('renders min and max attributes on the holdMinutes number input', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminGet(settingsGetRequest(), context);
    const body = await response.text();
    const holdMinutesInput = /<input[^>]*name="booking\.holdMinutes"[^>]*>/.exec(body)?.[0] ?? '';
    expect(holdMinutesInput).toContain('min="35"');
    expect(holdMinutesInput).toContain('max="1440"');
  });

  it('shows a saved confirmation after the post-save redirect and resets a single field', async () => {
    const repo = fakeRepository();
    repo.settings.set('booking.minNoticeHours', '2');
    repo.settings.set('booking.maxHorizonDays', '120');
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const reset = await handleAdminPost(adminPostRequest({ action: 'settings-reset:booking.minNoticeHours' }), context);
    expect(reset.status).toBe(303);
    expect(reset.headers.get('location')).toContain('saved=1');
    expect(repo.settings.has('booking.minNoticeHours')).toBe(false);
    // Only the named field resets; the rest of the section keeps its overrides.
    expect(repo.settings.has('booking.maxHorizonDays')).toBe(true);

    const confirmation = await handleAdminGet(new Request('https://example.test/api/booking/admin?view=settings&saved=1'), context);
    expect(await confirmation.text()).toContain('role="status"');
  });

  it('settings-save stores only values that differ from the file config and deletes ones equal to it', async () => {
    const repo = fakeRepository();
    // Pre-existing override that the save sets back to the config value (24) — must be deleted.
    repo.settings.set('booking.minNoticeHours', '2');
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const request = adminPostRequest({
      action: 'settings-save',
      section: 'policy',
      'booking.minNoticeHours': '24',
      'booking.maxHorizonDays': '90',
      'booking.holdMinutes': String(config.booking.holdMinutes),
      'booking.cancelCutoffHours': String(config.booking.cancelCutoffHours),
      'booking.reschedule.cutoffHours': String(config.booking.reschedule.cutoffHours),
      'booking.limitedThreshold': String(config.booking.limitedThreshold),
      'booking.maxHoldsPerIp': '',
      // reschedule.enabled checkbox absent => false
    });
    const response = await handleAdminPost(request, context);
    expect(response.status).toBe(303);
    expect(repo.settings.has('booking.minNoticeHours')).toBe(false);
    expect(repo.settings.get('booking.maxHorizonDays')).toBe('90');
    // Fixture config has reschedule.enabled: true; the absent checkbox stores an explicit false.
    expect(repo.settings.get('booking.reschedule.enabled')).toBe('false');
    expect(repo.settings.has('booking.holdMinutes')).toBe(false);
  });

  it('settings-reset deletes every key in the section', async () => {
    const repo = fakeRepository();
    repo.settings.set('booking.minNoticeHours', '2');
    repo.settings.set('booking.maxHorizonDays', '120');
    repo.settings.set('legal.termsUrl', '"https://elsewhere.test/terms"');
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ action: 'settings-reset', section: 'policy' }), context);
    expect(response.status).toBe(303);
    expect(repo.settings.has('booking.minNoticeHours')).toBe(false);
    expect(repo.settings.has('booking.maxHorizonDays')).toBe(false);
    // Other sections are untouched.
    expect(repo.settings.has('legal.termsUrl')).toBe(true);
  });

  it('rejects invalid values and unknown sections with 400 validation_failed', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const bad = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'legal', 'legal.termsUrl': 'not a url' }), context);
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
    expect(repo.settings.size).toBe(0);
    const unknown = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'nope' }), context);
    expect(unknown.status).toBe(400);
  });

  // holdMinutes outside [35, 1440] must be unsaveable, not just clamped elsewhere (a value below 35
  // lets the Stripe hold outlive the D1 hold; above 1440 breaks checkout entirely).
  function policyFields(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      action: 'settings-save',
      section: 'policy',
      'booking.minNoticeHours': String(config.booking.minNoticeHours),
      'booking.maxHorizonDays': String(config.booking.maxHorizonDays),
      'booking.holdMinutes': String(config.booking.holdMinutes),
      'booking.cancelCutoffHours': String(config.booking.cancelCutoffHours),
      'booking.reschedule.cutoffHours': String(config.booking.reschedule.cutoffHours),
      'booking.limitedThreshold': String(config.booking.limitedThreshold),
      'booking.maxHoldsPerIp': '',
      ...overrides,
    };
  }

  it('rejects settings-save with holdMinutes=0 (400, no row written) and accepts a valid holdMinutes', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const bad = await handleAdminPost(adminPostRequest(policyFields({ 'booking.holdMinutes': '0' })), context);
    expect(bad.status).toBe(400);
    // The message names the offending field (parseSettingForm's `${key}: ...` shape) — see the
    // field-attribution test below for the mergeAndValidateSettings/SettingsMergeError case.
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('booking.holdMinutes') } });
    expect(repo.settings.size).toBe(0);

    const good = await handleAdminPost(adminPostRequest(policyFields({ 'booking.holdMinutes': '40' })), context);
    expect(good.status).toBe(303);
    expect(repo.settings.get('booking.holdMinutes')).toBe('40');
  });

  // Every admin action throws HttpError on failure (never an HTML re-render), so mapping
  // SettingsMergeError to HttpError(400, ...) must still name which field failed — exercised via a
  // genuinely cross-field validateConfig rejection reaching mergeAndValidateSettings.
  it('field-attributes a mergeAndValidateSettings cross-field rejection in the HttpError message', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    // `config` is validated by createReservaContext, but `baseConfig` (the pristine file config the
    // handler merges over) isn't — setting it directly is the most direct way to exercise the
    // handler's SettingsMergeError branch.
    const brokenLocalesConfig: ResolvedClientConfig = { ...config, locales: { supported: ['pt-BR'], default: 'en' } };
    context.baseConfig = brokenLocalesConfig;

    const response = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'legal', 'legal.termsUrl': 'https://example.test/terms' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('locales.default') } });
    expect(repo.settings.size).toBe(0);
  });

  // Proves handleAdminPost surfaces an applySettingsBatch failure as a 500 and never redirects to a
  // saved state. The atomicity guarantee itself is proven at the repo unit level in tests/repo.test.ts.
  it('propagates an applySettingsBatch failure as a 500 without redirecting to a saved state', async () => {
    const repo = fakeRepository();
    repo.applySettingsBatch = async () => { throw new Error('D1 batch failed'); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest(policyFields({ 'booking.minNoticeHours': '2', 'booking.maxHorizonDays': '90' })), context);
    expect(response.status).toBe(500);
    expect(repo.settings.size).toBe(0);
  });
});

describe('admin mutation origin + CSRF guard (src/admin-csrf.ts)', () => {
  it('rejects a cross-origin POST (foreign Origin, Sec-Fetch-Site: cross-site) even with a valid Access session, and does not mutate', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverrides = async (dates) => { calls.push(...dates); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    }), context);
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects Sec-Fetch-Site: same-site (deliberately not trusted as same-origin — see admin-csrf.ts)', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      headers: { origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-site' },
    }), context);
    expect(response.status).toBe(403);
  });

  it('rejects a POST with neither Sec-Fetch-Site nor Origin present', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { headers: {} }), context);
    expect(response.status).toBe(403);
  });

  it('accepts a same-origin POST (Sec-Fetch-Site: same-origin, no Origin header needed) carrying a valid token', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverrides = async (dates) => { calls.push(...dates); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      headers: { 'sec-fetch-site': 'same-origin' },
    }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual(['2026-06-20']);
  });

  it('rejects a POST with no csrf_token field even with valid same-origin headers and Access', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { csrfToken: null }), context);
    expect(response.status).toBe(403);
  });

  it('rejects an expired csrf_token', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    // Minted far enough in the past that its expiry already fell before CSRF_NOW (the fixed clock
    // every context in this file uses).
    const expired = await mintTestCsrfToken('', CSRF_NOW - ADMIN_CSRF_TOKEN_TTL_MS - 1_000);
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { csrfToken: expired }), context);
    expect(response.status).toBe(403);
  });

  it('rejects a csrf_token minted for a different Access user (foreign subject)', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const foreignUser = await mintTestCsrfToken('someone-else@example.test', CSRF_NOW);
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { csrfToken: foreignUser }), context);
    expect(response.status).toBe(403);
  });

  it('accepts the exact token embedded in a GET-rendered admin form on a subsequent same-origin POST (render -> submit end to end)', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverrides = async (dates) => { calls.push(...dates); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const getResponse = await handleAdminGet(adminGetRequest(), context);
    const body = await getResponse.text();
    const match = /name="csrf_token" value="([^"]+)"/.exec(body);
    expect(match).not.toBeNull();
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { csrfToken: match![1]! }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual(['2026-06-20']);
  });

  it('accepts the exact token embedded in the rendered settings page on a subsequent settings-save POST', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const getResponse = await handleAdminGet(new Request(`${ADMIN_URL}?view=settings`), context);
    const body = await getResponse.text();
    const match = /name="csrf_token" value="([^"]+)"/.exec(body);
    expect(match).not.toBeNull();
    const response = await handleAdminPost(adminPostRequest({
      action: 'settings-save',
      section: 'policy',
      'booking.minNoticeHours': '2',
      'booking.maxHorizonDays': String(config.booking.maxHorizonDays),
      'booking.holdMinutes': String(config.booking.holdMinutes),
      'booking.cancelCutoffHours': String(config.booking.cancelCutoffHours),
      'booking.reschedule.cutoffHours': String(config.booking.reschedule.cutoffHours),
      'booking.limitedThreshold': String(config.booking.limitedThreshold),
      'booking.maxHoldsPerIp': '',
    }, { csrfToken: match![1]! }), context);
    expect(response.status).toBe(303);
    expect(repo.settings.get('booking.minNoticeHours')).toBe('2');
  });

  // Every action dispatched from handleAdminPost must go through the same guard — a cross-origin
  // attempt gets 403, and a same-origin+token attempt is never itself rejected by the guard.
  const mutationActions: Array<[string, Record<string, string>]> = [
    ['set', { action: 'set', date: '2026-06-20', capacity: '2' }],
    ['close', { action: 'close', date: '2026-06-20' }],
    ['clear', { action: 'clear', date: '2026-06-20' }],
    ['default-set', { action: 'default-set', date: '2026-06-20', capacity: '2' }],
    ['default-clear', { action: 'default-clear', date: '2026-06-20' }],
    ['settings-save', { action: 'settings-save', section: 'policy' }],
    ['settings-reset', { action: 'settings-reset', section: 'policy' }],
  ];

  it.each(mutationActions)('action=%s: cross-origin is rejected by the guard; same-origin+token reaches the action (never 403)', async (_label, fields) => {
    const crossOriginContext = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const crossOrigin = await handleAdminPost(adminPostRequest(fields, { headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' } }), crossOriginContext);
    expect(crossOrigin.status).toBe(403);

    const sameOriginContext = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const sameOrigin = await handleAdminPost(adminPostRequest(fields), sameOriginContext);
    expect(sameOrigin.status).not.toBe(403);
  });

  it('sets Cache-Control: no-store on the admin POST redirect response', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }), context);
    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  // Plain errorResponse sets no cache-control header at all, risking a shared cache serving a
  // stale/sensitive admin error page — runAdminPost sets no-store on every admin POST, success or error.
  it('sets Cache-Control: no-store on an admin POST that 403s (cross-origin, no mutation)', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    }), context);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on an admin POST that 400s (validation failure)', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'delete-everything' }), context);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

// With no RESERVA_CSRF_SECRET, admin-csrf.ts takes the token layer offline rather than fall back to
// a forgeable key — the origin guard alone must still fully gate the route in this mode.
describe('admin CSRF layer 2 without RESERVA_CSRF_SECRET (layer 1 alone still blocks the attack)', () => {
  it('a same-origin admin POST succeeds with no csrf_token at all when no secret is configured', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverrides = async (dates) => { calls.push(...dates); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers() });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      csrfToken: null,
      headers: { 'sec-fetch-site': 'same-origin' },
    }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual(['2026-06-20']);
  });

  it('a cross-origin admin POST is still rejected 403 by the origin guard when no secret is configured', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverrides = async (dates) => { calls.push(...dates); };
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers() });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      csrfToken: null,
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    }), context);
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('the rendered admin form carries an empty csrf_token field rather than throwing', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, adminAuth: async () => ({ subject: '' }), providers: providers() });
    const response = await handleAdminGet(adminGetRequest(), context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('name="csrf_token" value=""');
  });
});

// Every settings/capacity write records who changed it, atomically with the change itself. These
// tests exercise the actor-threading in handleAdminPost; the atomicity guarantee itself is proven
// at the repo unit level in tests/repo.test.ts.
describe('admin_change_history (actor-attributed, batch-atomic settings/capacity audit)', () => {
  it('settings-save records one history row per changed key with the Access subject as actor and the serialized value', async () => {
    const repo = fakeRepository();
    const subject = 'ops@example.test';
    const csrfToken = await mintTestCsrfToken(subject, CSRF_NOW);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest({
      action: 'settings-save',
      section: 'legal',
      'legal.termsUrl': 'https://example.test/new-terms',
    }, { csrfToken }), context);
    expect(response.status).toBe(303);

    expect(repo.adminChangeHistory).toHaveLength(1);
    const entry = repo.adminChangeHistory[0];
    expect(entry).toMatchObject({ domain: 'setting', itemKey: 'legal.termsUrl', action: 'upsert', actor: subject, changedAt: clock().toISOString() });
    // The recorded value is exactly what landed in `settings` — the same serialized string, not a
    // second independent encoding of it.
    expect(entry?.value).toBe(repo.settings.get('legal.termsUrl'));
  });

  it('an anonymous admin identity (empty-string subject) records actor: null, never the empty string', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest({
      action: 'settings-save',
      section: 'legal',
      'legal.termsUrl': 'https://example.test/new-terms',
    }), context);
    expect(response.status).toBe(303);

    expect(repo.adminChangeHistory).toHaveLength(1);
    expect(repo.adminChangeHistory[0]?.actor).toBeNull();
  });

  it('a day-range close action records one day_override/upsert history row per date, not one row for the whole range', async () => {
    const repo = fakeRepository();
    const subject = 'ops@example.test';
    const csrfToken = await mintTestCsrfToken(subject, CSRF_NOW);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest([
      ['date', '2026-06-20'], ['toDate', '2026-06-22'], ['reason', 'holiday'], ['action', 'close'],
    ], { csrfToken }), context);
    expect(response.status).toBe(303);

    expect(repo.adminChangeHistory).toHaveLength(3);
    expect(repo.adminChangeHistory.map((entry) => entry.itemKey)).toEqual(['2026-06-20', '2026-06-21', '2026-06-22']);
    for (const entry of repo.adminChangeHistory) {
      expect(entry).toMatchObject({ domain: 'day_override', action: 'upsert', actor: subject, value: JSON.stringify({ capacity: 0, reason: 'holiday' }) });
    }
  });

  it('default-set records exactly one capacity_default/upsert history row', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', capacity: '4', reason: 'fleet expansion', action: 'default-set' }), context);
    expect(response.status).toBe(303);

    expect(repo.adminChangeHistory).toEqual([
      expect.objectContaining({ domain: 'capacity_default', itemKey: '2026-06-20', action: 'upsert', actor: null, value: JSON.stringify({ capacity: 4, reason: 'fleet expansion' }) }),
    ]);
  });

  it('listAdminChangeHistory (via the repo) returns rows most-recent-first', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    await handleAdminPost(adminPostRequest({ date: '2026-06-20', capacity: '4', action: 'default-set' }), context);
    await handleAdminPost(adminPostRequest({ date: '2026-06-21', capacity: '5', action: 'default-set' }), context);

    const history = await repo.listAdminChangeHistory(10);
    expect(history.map((entry) => entry.itemKey)).toEqual(['2026-06-21', '2026-06-20']);
  });
});
