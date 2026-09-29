import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { mintAdminCsrfToken } from '../src/admin-csrf';
import { createReservaContext } from '../src/context';
import { handleAdminGet, handleAdminPost } from '../src/handlers';
import { booking, config } from './fixtures';
import type { SideEffectOperationIdentity } from '../src/repo';
import { fakeRepository, providers, seedSideEffectOperation, type FakeRepository } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');
const CSRF_NOW = clock().getTime();
const ADMIN_URL = 'https://example.test/api/booking/admin';
const ADMIN_ORIGIN = 'https://example.test';
// Same fixture pattern as tests/handlers-admin.test.ts: a real CSRF secret so layer 2 is actually
// exercised (mintAdminCsrfToken/verifyAdminCsrfToken are deliberate no-ops without one).
const CSRF_TEST_SECRET = 'handlers-admin-incidents-test-secret';
const csrfSecrets = async (name: string) => (name === 'RESERVA_CSRF_SECRET' ? CSRF_TEST_SECRET : undefined);

async function mintTestCsrfToken(sub: string, at: number): Promise<string> {
  const token = await mintAdminCsrfToken({ config, secrets: csrfSecrets }, sub, at);
  if (token === undefined) throw new Error('test setup: expected a CSRF token — is CSRF_TEST_SECRET wired up?');
  return token;
}

const DEFAULT_CSRF_TOKEN = await mintTestCsrfToken('', CSRF_NOW);

function adminPostRequest(fields: Record<string, string>, csrfToken: string | null = DEFAULT_CSRF_TOKEN): Request {
  const body = new URLSearchParams(fields);
  if (csrfToken !== null) body.set('csrf_token', csrfToken);
  return new Request(ADMIN_URL, {
    method: 'POST',
    body,
    headers: { origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin' },
  });
}

// A rejected action redirects back to the dashboard with ?error= (see adminErrorRedirect).
function adminErrorOf(response: Response): { code: string | null; field: string | null; tab: string | null } {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '');
  return { code: location.searchParams.get('error'), field: location.searchParams.get('field'), tab: location.searchParams.get('tab') };
}

function seedSideEffect(repo: FakeRepository, bookingId: string, identity: SideEffectOperationIdentity): void {
  seedSideEffectOperation(repo, bookingId, identity, {
    status: 'abandoned', attemptCount: 10, attemptedAt: '2026-06-14T07:00:00.000Z',
    error: 'provider down', createdAt: '2026-06-14T06:00:00.000Z', updatedAt: '2026-06-14T07:00:00.000Z',
    failureStartedAt: '2026-06-14T06:00:00.000Z',
  });
}

// The admin "Attention required" section: POST actions (Try again / I handled this manually)
// dispatch to the right executor per source type without ever falsifying the underlying row.
describe('admin incidents', () => {
  it('does not render the incident section before any incident activity exists', async () => {
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository(),
      clock,
      adminAuth: async () => ({ subject: '' }),
      providers: providers(),
      secrets: csrfSecrets,
    });

    const response = await handleAdminGet(new Request(ADMIN_URL), context);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('id="bk-incidents"');
    expect(html).not.toContain('Attention required');
    expect(html).not.toContain('Recently resolved');
  });

  it('GET renders an open incident card with its owner-facing title, never the word "abandoned"', async () => {
    const seeded = booking({ id: 'inc-render', status: 'confirmed', calendarEventId: null });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'calendar_create' });
    await repo.upsertOpenIncident({
      id: 'incident-1', bookingId: seeded.id, sourceType: 'side_effect', sourceKey: `${seeded.id}:calendar_create`,
      action: 'calendar', severity: 'action_required', attemptCount: 10, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminGet(new Request(ADMIN_URL), context);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Calendar not updated');
    expect(html).toContain(seeded.reference);
    expect(html).toContain('data-reserva-admin-tab="attention"');
    expect(html).toContain('<span class="bk-tab-count">1</span>');
    expect(html).not.toContain('abandoned');
  });

  it('does not render a Retry button for an oversell incident, and a forged action is told it is unavailable', async () => {
    const seeded = booking({ id: 'inc-oversell', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    await repo.upsertOpenIncident({
      id: 'incident-oversell', bookingId: seeded.id, sourceType: 'oversell', sourceKey: seeded.id,
      action: 'oversell', severity: 'action_required', attemptCount: 1, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const getResponse = await handleAdminGet(new Request(ADMIN_URL), context);
    const html = await getResponse.text();
    expect(html).not.toMatch(/name="action" value="incident-retry"[^]*?oversell/);
    // The disclosure copy explaining why is present instead of a button for this card.
    expect(html).toContain('needs manual handling');

    const postResponse = await handleAdminPost(
      adminPostRequest({ action: 'incident-retry', source_type: 'oversell', source_key: seeded.id }),
      context,
    );
    // Told, not errored: the button is omitted for this source type, so a request that gets here
    // is a stale page rather than an attack, and the incident is left exactly as it was.
    expect(postResponse.status).toBe(303);
    expect(postResponse.headers.get('location')).toContain('saved=incident-retry-unavailable');
    expect(await repo.getIncidentBySource('oversell', seeded.id)).toMatchObject({ status: 'open' });
  });

  it('incident-retry dispatches a side_effect incident to retrySideEffectOperation and redirects with a notice', async () => {
    const seeded = booking({ id: 'inc-retry-se', status: 'confirmed', calendarEventId: null });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'calendar_create' });
    await repo.upsertOpenIncident({
      id: 'incident-se', bookingId: seeded.id, sourceType: 'side_effect', sourceKey: `${seeded.id}:calendar_create`,
      action: 'calendar', severity: 'action_required', attemptCount: 10, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    let calendarCalls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), secrets: csrfSecrets,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { calendarCalls += 1; return 'cal_retry'; }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    const response = await handleAdminPost(
      adminPostRequest({ action: 'incident-retry', source_type: 'side_effect', source_key: `${seeded.id}:calendar_create` }),
      context,
    );
    expect(response.status).toBe(303);
    // The retry outcome is reported, not just the fact that a retry ran: this one succeeded.
    expect(response.headers.get('location')).toContain('saved=incident-resolved');
    expect(response.headers.get('location')).toContain('#bk-incidents');
    expect(calendarCalls).toBe(1);
    // The calendar event id the retry wrote IS the record that the event exists.
    expect(repo.rows.get(seeded.id)?.calendarEventId).toBe('cal_retry');
  });

  it('incident-retry dispatches a refund incident through claimRefundExecutionForRetry + the shared executor', async () => {
    const seeded = booking({ id: 'inc-retry-refund', status: 'cancelled', paymentRef: 'pi_inc_retry' });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({ id: 'op-inc-retry', bookingId: seeded.id, paymentIntent: 'pi_inc_retry', choice: 'full', requestedAt: '2026-06-14T07:00:00.000Z' });
    await repo.resolveRefundOperation('op-inc-retry', { status: 'failed', error: 'stripe down', resolvedAt: '2026-06-14T07:00:00.000Z' });
    await repo.upsertOpenIncident({
      id: 'incident-refund', bookingId: seeded.id, sourceType: 'refund', sourceKey: seeded.id,
      action: 'refund', severity: 'action_required', attemptCount: 1, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    let refundCalls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), secrets: csrfSecrets,
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionRef: '' }),
          parseWebhook: async () => { throw new Error('unused'); },
          getSession: async () => ({ status: 'open' }),
          refund: async () => { refundCalls += 1; return { refundRef: 're_inc_retry', amountMinor: seeded.priceMinor }; },
        },
      }),
    });

    const response = await handleAdminPost(
      adminPostRequest({ action: 'incident-retry', source_type: 'refund', source_key: seeded.id }),
      context,
    );
    expect(response.status).toBe(303);
    expect(refundCalls).toBe(1);
    await expect(repo.getRefundOperationByBookingId(seeded.id)).resolves.toMatchObject({ status: 'succeeded', stripeRefundId: 're_inc_retry' });
  });

  it('incident-resolve requires a trimmed 1-500 char note, records who/when, and only resolves the incident (never the underlying row)', async () => {
    const seeded = booking({ id: 'inc-resolve', status: 'confirmed', calendarEventId: null });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'calendar_create' });
    await repo.upsertOpenIncident({
      id: 'incident-resolve', bookingId: seeded.id, sourceType: 'side_effect', sourceKey: `${seeded.id}:calendar_create`,
      action: 'calendar', severity: 'action_required', attemptCount: 10, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: 'ops@example.test', email: 'ops@example.test' }), providers: providers(), secrets: csrfSecrets });
    const opsToken = await mintTestCsrfToken('ops@example.test', CSRF_NOW);

    const blank = await handleAdminPost(adminPostRequest({ action: 'incident-resolve', source_type: 'side_effect', source_key: `${seeded.id}:calendar_create`, note: '   ' }, opsToken), context);
    expect(adminErrorOf(blank)).toEqual({ code: 'validation_failed', field: 'note', tab: 'attention' });

    const tooLong = await handleAdminPost(adminPostRequest({ action: 'incident-resolve', source_type: 'side_effect', source_key: `${seeded.id}:calendar_create`, note: 'x'.repeat(501) }, opsToken), context);
    expect(adminErrorOf(tooLong)).toEqual({ code: 'validation_failed', field: 'note', tab: 'attention' });
    expect(await repo.getIncidentBySource('side_effect', `${seeded.id}:calendar_create`)).toMatchObject({ status: 'open' });

    const ok = await handleAdminPost(adminPostRequest({ action: 'incident-resolve', source_type: 'side_effect', source_key: `${seeded.id}:calendar_create`, note: '  called the customer directly  ' }, opsToken), context);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toContain('saved=incident-resolved');
    const resolved = await repo.getIncidentBySource('side_effect', `${seeded.id}:calendar_create`);
    expect(resolved).toMatchObject({ status: 'resolved', resolutionKind: 'manual', resolvedBy: 'ops@example.test', resolutionNote: 'called the customer directly' });
    // The underlying row is untouched — still 'abandoned', never rewritten to look succeeded.
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_create`)?.status).toBe('abandoned');
    expect(repo.rows.get(seeded.id)?.calendarEventId).toBeNull();
  });

  it('rejects incident-retry/incident-resolve for an unknown or already-resolved incident, back on the Attention tab', async () => {
    const repo = fakeRepository();
    await repo.upsertOpenIncident({
      id: 'incident-done', bookingId: null, sourceType: 'reconciliation', sourceKey: 'sweep',
      action: 'reconciliation_stale', severity: 'action_required', attemptCount: 1, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    await repo.resolveIncidentManual({ sourceType: 'reconciliation', sourceKey: 'sweep', resolvedAt: '2026-06-14T07:30:00.000Z', resolvedBy: 'first@example.test', resolutionNote: 'first fix' });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const targets = [
      { source_type: 'side_effect', source_key: 'missing:calendar_create' },
      { source_type: 'reconciliation', source_key: 'sweep' },
    ];
    for (const target of targets) {
      for (const fields of [{ action: 'incident-retry' }, { action: 'incident-resolve', note: 'handled again' }]) {
        const response = await handleAdminPost(adminPostRequest({ ...fields, ...target }), context);
        expect(adminErrorOf(response), `${fields.action} on ${target.source_key}`).toEqual({ code: 'validation_failed', field: null, tab: 'attention' });
      }
    }
  });

  // The server refuses a retry for these (nothing to re-run), so the card must not offer one.
  it('hides Retry for payment_verification and reconciliation incidents, as for oversell', async () => {
    const seeded = booking({ id: 'inc-payment', status: 'expired' });
    const repo = fakeRepository([seeded]);
    await repo.upsertOpenIncident({
      id: 'incident-payment', bookingId: seeded.id, sourceType: 'payment_verification', sourceKey: seeded.id,
      action: 'payment_verification_rejected', severity: 'action_required', attemptCount: 1, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    await repo.upsertOpenIncident({
      id: 'incident-reconciliation', bookingId: null, sourceType: 'reconciliation', sourceKey: 'sweep',
      action: 'reconciliation_stale', severity: 'action_required', attemptCount: 1, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });

    const html = await (await handleAdminGet(new Request(ADMIN_URL), context)).text();
    expect(html).toContain('Payment refused after checkout');
    expect(html).toContain('Reconciliation has stopped running');
    expect(html).not.toContain('value="incident-retry"');
    expect(html.match(/needs manual handling/g)).toHaveLength(2);
  });

  // The badge is a real COUNT; only the rendered card list is bounded.
  it('counts every open incident in the badge and says when the card list is truncated', async () => {
    const repo = fakeRepository();
    for (let index = 0; index < 105; index += 1) {
      await repo.upsertOpenIncident({
        id: `incident-many-${index}`, bookingId: null, sourceType: 'reconciliation', sourceKey: `sweep-${index}`,
        action: 'reconciliation_stale', severity: 'delayed', attemptCount: 1, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
        now: '2026-06-14T07:00:00.000Z', escalate: false,
      });
    }
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const html = await (await handleAdminGet(new Request(ADMIN_URL), context)).text();
    expect(html).toContain('<span class="bk-tab-count">105</span>');
    expect(html).toContain('105 issues need attention');
    expect(html).toContain('<span class="bk-topbar-count" aria-hidden="true">105</span>');
    expect(html).toContain('Showing the first 100 of 105 open incidents.');
  });

  it('enforces the same Origin/CSRF guards as every other admin POST action', async () => {
    const repo = fakeRepository();
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, adminAuth: async () => ({ subject: '' }), providers: providers(), secrets: csrfSecrets });
    const badOrigin = await handleAdminPost(new Request(ADMIN_URL, {
      method: 'POST', body: new URLSearchParams({ action: 'incident-retry', source_type: 'refund', source_key: 'x', csrf_token: DEFAULT_CSRF_TOKEN }),
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    }), context);
    expect(badOrigin.status).toBe(403);

    // Past the origin guard a failed token is a stale page: told to retry, and nothing ran.
    const badCsrf = await handleAdminPost(adminPostRequest({ action: 'incident-retry', source_type: 'refund', source_key: 'x' }, 'not-a-real-token'), context);
    expect(adminErrorOf(badCsrf)).toEqual({ code: 'csrf_expired', field: null, tab: 'attention' });
  });
});
