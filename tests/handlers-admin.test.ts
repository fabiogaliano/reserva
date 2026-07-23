import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { ADMIN_CSRF_TOKEN_TTL_MS, mintAdminCsrfToken } from '../src/admin-csrf';
import { createBookkitContext } from '../src/context';
import type { ClientConfig } from '../src/core/config';
import { handleAdminGet, handleAdminPost } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');
const CSRF_NOW = clock().getTime();
const ADMIN_URL = 'https://example.test/api/booking/admin';
const ADMIN_ORIGIN = 'https://example.test';
// Every admin context built in this file configures a BOOKKIT_CSRF_SECRET via `secrets`, so CSRF
// layer 2 is active (src/admin-csrf.ts requires a real secret to sign/verify a token at all — see
// BK-SEC-001 finding 1 — otherwise mint returns undefined and verify no-ops). Without this fixture,
// every "invalid/expired/foreign token -> 403" assertion below would trivially pass for the wrong
// reason (layer 2 disabled), not because the guard actually rejected the token.
const CSRF_TEST_SECRET = 'handlers-admin-test-secret';
const csrfSecrets = async (name: string) => (name === 'BOOKKIT_CSRF_SECRET' ? CSRF_TEST_SECRET : undefined);

// mintAdminCsrfToken returns undefined only when no secret is configured (see above); this fixture
// always supplies one, so the throw below is unreachable in practice and only guards the return type.
async function mintTestCsrfToken(sub: string, at: number): Promise<string> {
  const token = await mintAdminCsrfToken({ config, secrets: csrfSecrets }, sub, at);
  if (token === undefined) throw new Error('test setup: expected a CSRF token — is CSRF_TEST_SECRET wired up?');
  return token;
}

// Mint the default valid same-origin token once.
const DEFAULT_CSRF_TOKEN = await mintTestCsrfToken('', CSRF_NOW);

function adminGetRequest(): Request {
  return new Request(ADMIN_URL);
}

interface AdminPostOptions {
  // Defaults to same-origin Fetch-Metadata headers; pass {} or foreign values to exercise the
  // origin guard (BK-SEC-001 layer 1).
  headers?: HeadersInit;
  // Defaults to a valid token bound to sub=''; pass null to omit the field entirely (BK-SEC-001
  // layer 2's "missing token" case).
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

describe('access control (spec §11: admin requires Cloudflare Access)', () => {
  it('rejects GET and POST when verifyAccess is absent, returns false, or throws', async () => {
    const variants: Array<{ label: string; verifyAccess?: () => boolean | Promise<boolean> }> = [
      { label: 'absent' },
      { label: 'returns false', verifyAccess: () => false },
      { label: 'throws', verifyAccess: () => { throw new Error('access check exploded'); } },
    ];
    for (const variant of variants) {
      const context = createBookkitContext({
        config,
        db: {} as D1Database,
        repo: fakeRepository(),
        clock,
        providers: providers(),
        ...(variant.verifyAccess ? { verifyAccess: variant.verifyAccess } : {}),
      });
      const getResponse = await handleAdminGet(adminGetRequest(), context);
      expect(getResponse.status, `GET with verifyAccess ${variant.label}`).toBe(403);
      const postResponse = await handleAdminPost(adminPostRequest({ action: 'clear', date: '2026-06-20' }), context);
      expect(postResponse.status, `POST with verifyAccess ${variant.label}`).toBe(403);
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
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

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

  it('manage links carry each row\'s operator token (URL-encoded) and never leak a cancel_token', async () => {
    const first = booking({ id: 'b-admin-links-1', reference: 'LVT-2026-200', startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z', operatorToken: 'operator+token/one', cancelToken: 'cancel-token-one-secret' });
    const second = booking({ id: 'b-admin-links-2', reference: 'LVT-2026-201', startsAt: '2026-06-21T09:00:00.000Z', endsAt: '2026-06-21T10:00:00.000Z', operatorToken: 'operator-token-two', cancelToken: 'cancel-token-two-secret' });
    const repo = fakeRepository([first, second]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(first.operatorToken)}`);
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(second.operatorToken)}`);
    expect(body).not.toContain(first.cancelToken);
    expect(body).not.toContain(second.cancelToken);
  });

  it('sets cache-control: no-store and referrer-policy: no-referrer', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminGet(adminGetRequest(), context);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  // BK-CAP-002: the day calendar must show fleet units consumed, not a raw booking-row count — a
  // single 5-person booking on the fixture tour (occupancyFor: people > 4 ? 2 : 1) needs two
  // vehicles, so a day with just this one booking is already at the fixture's default capacity (2).
  it('renders the day cell in fleet units, not booking count, for a multi-unit booking', async () => {
    const multiUnit = booking({
      id: 'b-admin-multiunit', reference: 'LVT-2026-300', people: 5,
      startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      operatorToken: 'op-multiunit', cancelToken: 'cancel-multiunit',
    });
    const repo = fakeRepository([multiUnit]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminGet(adminGetRequest(), context);
    const body = await response.text();
    // One booking, two fleet units, capacity 2 (fixture's fleet.defaultCapacity) — the label must
    // read the unit count against capacity, not "1/2" (which is what a raw booking count would show).
    expect(body).toContain('units 2/2');
    expect(body).not.toMatch(/bk-day-load">1\/2</);
  });
});

describe('POST /admin day overrides (spec §11)', () => {
  it('action=set calls upsertDayOverride with a trimmed reason and redirects (303) back with a saved confirmation', async () => {
    const repo = fakeRepository();
    const calls: Array<[string, number, string | null]> = [];
    repo.upsertDayOverride = async (date, capacity, reason) => { calls.push([date, capacity, reason]); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const request = adminPostRequest({ date: '2026-06-20', capacity: '3', reason: '  closed for maintenance  ', action: 'set' });
    const response = await handleAdminPost(request, context);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${request.url}?saved=day&date=2026-06-20#bk-override`);
    expect(calls).toEqual([['2026-06-20', 3, 'closed for maintenance']]);
  });

  it('action=close writes capacity 0 to every submitted date (repeated date fields)', async () => {
    const repo = fakeRepository();
    const calls: Array<[string, number, string | null]> = [];
    repo.upsertDayOverride = async (date, capacity, reason) => { calls.push([date, capacity, reason]); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest([
      ['date', '2026-06-22'], ['date', '2026-06-20'], ['date', '2026-06-20'], ['reason', 'holiday'], ['action', 'close'],
    ]), context);
    expect(response.status).toBe(303);
    // Deduplicated, sorted, and the redirect pins ?date= to the earliest edited day.
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('date')).toBe('2026-06-20');
    expect(calls).toEqual([['2026-06-20', 0, 'holiday'], ['2026-06-22', 0, 'holiday']]);
  });

  it('toDate expands date into a contiguous range for set/close/clear', async () => {
    const repo = fakeRepository();
    const upserts: Array<[string, number]> = [];
    const deletes: string[] = [];
    repo.upsertDayOverride = async (date, capacity) => { upserts.push([date, capacity]); };
    repo.deleteDayOverride = async (date) => { deletes.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-22', capacity: '1', action: 'set' }), context);
    expect(upserts).toEqual([['2026-06-20', 1], ['2026-06-21', 1], ['2026-06-22', 1]]);
    await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-21', action: 'clear' }), context);
    expect(deletes).toEqual(['2026-06-20', '2026-06-21']);
  });

  it('rejects toDate before date with 400 validation_failed', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', toDate: '2026-06-19', capacity: '1', action: 'set' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('action=set with a blank reason passes null', async () => {
    const repo = fakeRepository();
    const calls: Array<[string, number, string | null]> = [];
    repo.upsertDayOverride = async (date, capacity, reason) => { calls.push([date, capacity, reason]); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', capacity: '0', reason: '   ', action: 'set' }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual([['2026-06-20', 0, null]]);
  });

  it('action=clear calls deleteDayOverride', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverride = async (date) => { calls.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual(['2026-06-20']);
  });

  it('rejects an unknown action with 400 validation_failed', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'delete-everything' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('rejects an invalid date with 400', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
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
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminGet(settingsGetRequest(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain('name="booking.minNoticeHours"');
    expect(body).toContain('name="payments.methods"');
    expect(body).toContain('Modified');
    expect(body).toContain('Default: 24');
    // The overridden field offers a per-field reset action.
    expect(body).toContain('value="settings-reset:booking.minNoticeHours"');
    // The deploy-time card lists file-only values.
    expect(body).toContain(config.business.timezone);
  });

  // BK-CONFIG-001: the holdMinutes kind declares max: 1440 (core/settings.ts); the rendered input
  // must carry it as an HTML max= constraint, mirroring min=, so a value like 1441 is rejected
  // client-side too — not just at parseSettingForm/mergeAndValidateSettings.
  it('renders min and max attributes on the holdMinutes number input', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
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
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

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
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
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
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ action: 'settings-reset', section: 'policy' }), context);
    expect(response.status).toBe(303);
    expect(repo.settings.has('booking.minNoticeHours')).toBe(false);
    expect(repo.settings.has('booking.maxHorizonDays')).toBe(false);
    // Other sections are untouched.
    expect(repo.settings.has('legal.termsUrl')).toBe(true);
  });

  it('rejects invalid values and unknown sections with 400 validation_failed', async () => {
    const repo = fakeRepository();
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const bad = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'legal', 'legal.termsUrl': 'not a url' }), context);
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
    expect(repo.settings.size).toBe(0);
    const unknown = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'nope' }), context);
    expect(unknown.status).toBe(400);
  });

  // BK-CONFIG-001: holdMinutes outside [35, 1440] must be unsaveable, not just clamped elsewhere
  // (a value below 35 lets the Stripe hold outlive the D1 hold; above 1440 breaks checkout entirely).
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
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const bad = await handleAdminPost(adminPostRequest(policyFields({ 'booking.holdMinutes': '0' })), context);
    expect(bad.status).toBe(400);
    // The message names the offending field (parseSettingForm's `${key}: ...` shape) — see the
    // field-attribution finding below for the mergeAndValidateSettings/SettingsMergeError case.
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('booking.holdMinutes') } });
    expect(repo.settings.size).toBe(0);

    const good = await handleAdminPost(adminPostRequest(policyFields({ 'booking.holdMinutes': '40' })), context);
    expect(good.status).toBe(303);
    expect(repo.settings.get('booking.holdMinutes')).toBe('40');
  });

  // [P2 finding 1] handleAdminPost has no "re-render the page with field errors" convention for
  // ANY admin action (day overrides, capacity defaults, settings) — every action uniformly throws
  // HttpError and the client gets a JSON error body, never an HTML re-render. That's the
  // established convention this repo uses, so mapping SettingsMergeError to HttpError(400, ...) is
  // consistent with it; the bar to clear is that the message names which field(s) failed.
  // SettingsMergeError's constructor already formats `path.join('.'): message` per issue, so the
  // HttpError message an operator sees is field-attributed. This exercises that via a genuinely
  // cross-field validateConfig rejection (see core-settings.test.ts for why locales is the only
  // reachable one), reaching mergeAndValidateSettings — not just a single field's SettingKind bound.
  it('field-attributes a mergeAndValidateSettings cross-field rejection in the HttpError message', async () => {
    const repo = fakeRepository();
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    // createBookkitContext runs `config` through validateConfig, so it can't hold a broken value —
    // but `baseConfig` (the pristine file config the handler merges over, src/handlers/index.ts
    // `base = context.baseConfig ?? context.config`) isn't re-validated there. Setting it directly
    // is the most direct way to exercise the handler's SettingsMergeError branch (see
    // core-settings.test.ts for why locales is the only reachable cross-field rule).
    const brokenLocalesConfig: ClientConfig = { ...config, locales: { supported: ['pt-BR'], default: 'en' } };
    context.baseConfig = brokenLocalesConfig;

    const response = await handleAdminPost(adminPostRequest({ action: 'settings-save', section: 'legal', 'legal.termsUrl': 'https://example.test/terms' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed', message: expect.stringContaining('locales.default') } });
    expect(repo.settings.size).toBe(0);
  });

  // Handler-level error-path test: proves handleAdminPost surfaces an applySettingsBatch failure
  // as a 500 and never redirects to a saved state. This does NOT by itself prove atomicity — a
  // fake repo that throws before touching `settings` trivially "applies nothing" either way. The
  // real atomicity guarantee (every key of a section travels in exactly one db.batch() call, so
  // D1's single-transaction batch semantics make the write all-or-nothing) is proven at the unit
  // level in tests/repo.test.ts, which exercises the actual createBookingRepository implementation.
  it('propagates an applySettingsBatch failure as a 500 without redirecting to a saved state', async () => {
    const repo = fakeRepository();
    repo.applySettingsBatch = async () => { throw new Error('D1 batch failed'); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminPost(adminPostRequest(policyFields({ 'booking.minNoticeHours': '2', 'booking.maxHorizonDays': '90' })), context);
    expect(response.status).toBe(500);
    expect(repo.settings.size).toBe(0);
  });
});

describe('BK-SEC-001: admin mutation origin + CSRF guard (src/admin-csrf.ts)', () => {
  it('rejects a cross-origin POST (foreign Origin, Sec-Fetch-Site: cross-site) even with a valid Access session, and does not mutate', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverride = async (date) => { calls.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    }), context);
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects Sec-Fetch-Site: same-site (deliberately not trusted as same-origin — see admin-csrf.ts)', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      headers: { origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-site' },
    }), context);
    expect(response.status).toBe(403);
  });

  it('rejects a POST with neither Sec-Fetch-Site nor Origin present', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { headers: {} }), context);
    expect(response.status).toBe(403);
  });

  it('accepts a same-origin POST (Sec-Fetch-Site: same-origin, no Origin header needed) carrying a valid token', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverride = async (date) => { calls.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      headers: { 'sec-fetch-site': 'same-origin' },
    }), context);
    expect(response.status).toBe(303);
    expect(calls).toEqual(['2026-06-20']);
  });

  it('rejects a POST with no csrf_token field even with valid same-origin headers and Access', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { csrfToken: null }), context);
    expect(response.status).toBe(403);
  });

  it('rejects an expired csrf_token', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    // Minted far enough in the past that its expiry already fell before CSRF_NOW (the fixed clock
    // every context in this file uses).
    const expired = await mintTestCsrfToken('', CSRF_NOW - ADMIN_CSRF_TOKEN_TTL_MS - 1_000);
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { csrfToken: expired }), context);
    expect(response.status).toBe(403);
  });

  it('rejects a csrf_token minted for a different Access user (foreign subject)', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const foreignUser = await mintTestCsrfToken('someone-else@example.test', CSRF_NOW);
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, { csrfToken: foreignUser }), context);
    expect(response.status).toBe(403);
  });

  it('accepts the exact token embedded in a GET-rendered admin form on a subsequent same-origin POST (render -> submit end to end)', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverride = async (date) => { calls.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
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
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
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

  // Every action dispatched from handleAdminPost (spec: settings-save, settings-reset, set, close,
  // clear, default-set, default-clear) must go through the same guard — proven by asserting the
  // guard's 403 for a cross-origin attempt, and that a same-origin+token attempt is never itself
  // rejected by the guard (its status is then whatever the action's own field validation decides).
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
    const crossOriginContext = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const crossOrigin = await handleAdminPost(adminPostRequest(fields, { headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' } }), crossOriginContext);
    expect(crossOrigin.status).toBe(403);

    const sameOriginContext = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const sameOrigin = await handleAdminPost(adminPostRequest(fields), sameOriginContext);
    expect(sameOrigin.status).not.toBe(403);
  });

  it('sets Cache-Control: no-store on the admin POST redirect response', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }), context);
    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  // [P2 finding 3] Only the successful 303 redirects set no-store; a 4xx/5xx admin POST response
  // went through plain errorResponse (src/http.ts), which sets no cache-control header at all, so a
  // shared cache could serve a stale/sensitive admin error page. runAdminPost (src/handlers/index.ts)
  // now sets no-store on every admin POST response, success or error. Covers the guard's own 403 as
  // the concrete example, but the fix is applied to the whole error path, not this one status code.
  it('sets Cache-Control: no-store on an admin POST that 403s (cross-origin, no mutation)', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    }), context);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on an admin POST that 400s (validation failure)', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'delete-everything' }), context);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

// [P1 finding 1 fix] BK-SEC-001: when no BOOKKIT_CSRF_SECRET is configured, src/admin-csrf.ts takes
// the token layer offline rather than fall back to a forgeable key (see admin-csrf.test.ts for the
// unit-level proof). These are the end-to-end equivalents: no context in this block passes `secrets`,
// so mintAdminCsrfToken returns undefined (the rendered form gets an empty token field) and
// verifyAdminCsrfToken is a no-op — the whole scenario the finding describes. Layer 1 (the origin
// guard) is unconditional and must still fully gate the route on its own in this mode.
describe('BK-SEC-001: admin CSRF layer 2 without BOOKKIT_CSRF_SECRET (layer 1 alone still blocks the attack)', () => {
  it('a same-origin admin POST succeeds with no csrf_token at all when no secret is configured', async () => {
    const repo = fakeRepository();
    const calls: string[] = [];
    repo.deleteDayOverride = async (date) => { calls.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });
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
    repo.deleteDayOverride = async (date) => { calls.push(date); };
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminPost(adminPostRequest({ date: '2026-06-20', action: 'clear' }, {
      csrfToken: null,
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    }), context);
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('the rendered admin form carries an empty csrf_token field rather than throwing', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock, verifyAccess: async () => true, providers: providers() });
    const response = await handleAdminGet(adminGetRequest(), context);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('name="csrf_token" value=""');
  });
});
