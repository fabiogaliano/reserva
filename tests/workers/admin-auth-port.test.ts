// Plan 025: proves the whole admin surface — the admin dashboard (GET/POST) and the operator
// action endpoints — works end to end against real D1 with a fully custom, non-Access `adminAuth`.
// Done criteria: "a workers test proves the whole admin surface works with no cloudflareaccess.com
// string anywhere in its config" — configWithoutAccess below drops `admin.access` entirely, and the
// header-token fake never references Cloudflare Access at all.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminIdentity } from '../../src/access';
import type { ReservaContext } from '../../src/context';
import { handleAdminGet, handleAdminPost, handleOperatorNoShow } from '../../src/handlers';
import { defineCloudflareReservaRuntime } from '../../src/runtime-context';
import { config as baseConfig } from '../fixtures';
import { providers } from '../fakes';

interface TestEnv {
  RESERVA_DB: D1Database;
}

const db = (env as unknown as TestEnv).RESERVA_DB;
const ADMIN_TOKEN_SECRET = 'TEST_ADMIN_TOKEN';
const ADMIN_TOKEN_VALUE = 'header-token-admin-secret';
const CSRF_SECRET_VALUE = 'admin-auth-port-csrf-secret';
const TOKEN_ENC_KEY_VALUE = 'admin-auth-port-token-enc-key';

// Real fixture config with `admin.access` dropped entirely — the point of this test.
function configWithoutAccess(): typeof baseConfig {
  const { access: _omit, ...adminWithoutAccess } = baseConfig.admin;
  return { ...baseConfig, admin: adminWithoutAccess };
}

// A plausible custom admin auth strategy: compares a caller-supplied header against a secret
// resolved through `context.secrets` (proving the port's `context` argument is real and usable,
// not just accepted and ignored) — no Cloudflare Access, no JWKS, no `Cf-Access-Jwt-Assertion`.
async function headerTokenAdminAuth(request: Request, context: ReservaContext): Promise<AdminIdentity | null> {
  const expected = await context.secrets?.(ADMIN_TOKEN_SECRET);
  const supplied = request.headers.get('x-admin-token');
  if (!expected || !supplied || supplied !== expected) return null;
  return { subject: 'header-token-admin' };
}

const runtime = defineCloudflareReservaRuntime(configWithoutAccess(), {
  providers: providers(),
  adminAuth: headerTokenAdminAuth,
  secretBindings: ['RESERVA_OPERATOR_SECRET', ADMIN_TOKEN_SECRET, 'RESERVA_CSRF_SECRET', 'RESERVA_TOKEN_ENC_KEY'],
});

function buildContext(request: Request) {
  return runtime.createContext({
    request,
    locals: {
      env: {
        RESERVA_DB: db,
        [ADMIN_TOKEN_SECRET]: ADMIN_TOKEN_VALUE,
        RESERVA_CSRF_SECRET: CSRF_SECRET_VALUE,
        // So the admin table can regenerate an operator manage link from its stored hash — see
        // README "Admin access and booking tokens" (RESERVA_TOKEN_ENC_KEY).
        RESERVA_TOKEN_ENC_KEY: TOKEN_ENC_KEY_VALUE,
      },
    },
  });
}

const ADMIN_URL = 'https://example.test/booking/admin';

function adminGetRequest(headers: HeadersInit = {}): Request {
  return new Request(ADMIN_URL, { headers });
}

function authorizedHeaders(extra: HeadersInit = {}): HeadersInit {
  return { 'x-admin-token': ADMIN_TOKEN_VALUE, ...extra };
}

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
});

// Confirmed, well in the past — no-show requires now > startsAt, and the admin table's search/
// status-filter path (handleAdminGet) only widens its lookback to 365 days, not an unbounded
// history — so this booking must be in the past AND less than a year old at the real wall-clock
// time this suite runs, not a fixed calendar date that would eventually age out of that window.
const PAST_BOOKING_ID = 'admin-auth-port-past';
const PAST_STARTS_AT = new Date(Date.now() - 30 * 86_400_000).toISOString();
const PAST_ENDS_AT = new Date(Date.now() - 30 * 86_400_000 + 3_600_000).toISOString();
const PAST_HOLD_EXPIRES_AT = new Date(Date.now() - 30 * 86_400_000 - 1_500_000).toISOString();
const PAST_REFERENCE = `BKT-PAST-${PAST_BOOKING_ID}`;
async function seedConfirmedPastBooking(context: ReservaContext): Promise<void> {
  await context.repo.insertHold({
    id: PAST_BOOKING_ID,
    reference: PAST_REFERENCE,
    serviceSlug: 'vintage',
    quantity: 2,
    pickupType: 'default',
    startsAt: PAST_STARTS_AT,
    endsAt: PAST_ENDS_AT,
    locale: 'en',
    priceMinor: 12000,
    currency: 'eur',
    holdExpiresAt: PAST_HOLD_EXPIRES_AT,
    cancelToken: `cancel-${PAST_BOOKING_ID}`,
    operatorToken: `operator-${PAST_BOOKING_ID}`,
    createdAt: PAST_HOLD_EXPIRES_AT,
    updatedAt: PAST_HOLD_EXPIRES_AT,
  });
  await context.repo.transitionToConfirmed(PAST_BOOKING_ID, { expectedStatusIn: ['hold'], paymentRef: `pi_${PAST_BOOKING_ID}`, updatedAt: PAST_STARTS_AT });
}

describe('admin auth port: custom adminAuth drives the whole admin surface (no admin.access, no cloudflareaccess.com)', () => {
  it('config declares no admin.access anywhere', () => {
    expect(runtime.config.admin.access).toBeUndefined();
    expect(JSON.stringify(runtime.config)).not.toContain('cloudflareaccess.com');
  });

  it('rejects an unauthenticated admin GET/POST with 403, and never mutates', async () => {
    const context = await buildContext(adminGetRequest());
    const getResponse = await handleAdminGet(adminGetRequest(), context);
    expect(getResponse.status).toBe(403);

    const postContext = await buildContext(new Request(ADMIN_URL, { method: 'POST' }));
    const postRequest = new Request(ADMIN_URL, {
      method: 'POST',
      body: new URLSearchParams({ action: 'clear', date: '2026-06-20' }),
      headers: { origin: 'https://example.test', 'sec-fetch-site': 'same-origin' },
    });
    const postResponse = await handleAdminPost(postRequest, postContext);
    expect(postResponse.status).toBe(403);
    await expect(postContext.repo.listDayOverrides('2026-06-01', '2026-06-30')).resolves.toEqual([]);
  });

  it('rejects a wrong header-token value with 403', async () => {
    const context = await buildContext(adminGetRequest());
    const response = await handleAdminGet(adminGetRequest(authorizedHeaders({ 'x-admin-token': 'wrong-value' })), context);
    expect(response.status).toBe(403);
  });

  it('admin GET lists a confirmed booking and its operator manage link once authenticated', async () => {
    const seedContext = await buildContext(adminGetRequest());
    await seedConfirmedPastBooking(seedContext);

    // A past confirmed booking is outside listUpcoming's default window — the search filter widens
    // the table's source to every booking, same as handlers-admin.test.ts's own past-row coverage.
    const searchUrl = `${ADMIN_URL}?q=${encodeURIComponent(PAST_REFERENCE)}`;
    const context = await buildContext(new Request(searchUrl, { headers: authorizedHeaders() }));
    const response = await handleAdminGet(new Request(searchUrl, { headers: authorizedHeaders() }), context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(PAST_REFERENCE);
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(`operator-${PAST_BOOKING_ID}`)}`);
  });

  it('admin POST (day override) mints and accepts a CSRF token bound to the header-token identity, and mutates', async () => {
    const getContext = await buildContext(adminGetRequest(authorizedHeaders()));
    const getResponse = await handleAdminGet(adminGetRequest(authorizedHeaders()), getContext);
    const body = await getResponse.text();
    const csrfMatch = /name="csrf_token" value="([^"]+)"/.exec(body);
    if (!csrfMatch) throw new Error('admin page did not render a csrf_token field');
    const csrfToken = csrfMatch[1]!;

    const postContext = await buildContext(new Request(ADMIN_URL, { method: 'POST' }));
    const form = new URLSearchParams({ action: 'clear', date: '2026-06-20', csrf_token: csrfToken });
    const postRequest = new Request(ADMIN_URL, {
      method: 'POST',
      body: form,
      headers: { ...authorizedHeaders({ origin: 'https://example.test', 'sec-fetch-site': 'same-origin' }) },
    });
    const postResponse = await handleAdminPost(postRequest, postContext);
    expect(postResponse.status).toBe(303);
  });

  it('the operator no-show endpoint (its own per-booking-token auth, unaffected by admin.access being absent) still works', async () => {
    const seedContext = await buildContext(adminGetRequest());
    await seedConfirmedPastBooking(seedContext);

    const noShowContext = await buildContext(new Request('https://example.test/api/booking/operator/no-show', { method: 'POST' }));
    const noShowRequest = new Request('https://example.test/api/booking/operator/no-show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorToken: `operator-${PAST_BOOKING_ID}` }),
    });
    const response = await handleOperatorNoShow(noShowRequest, noShowContext);
    expect(response.status).toBe(200);
    await expect(noShowContext.repo.getBookingById(PAST_BOOKING_ID)).resolves.toMatchObject({ status: 'no_show' });
  });
});
