import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { mintAdminCsrfToken } from '../src/admin-csrf';
import { createBookkitContext } from '../src/context';
import { handleAdminGet, handleAdminPost } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');
const CSRF_NOW = clock().getTime();
const ADMIN_URL = 'https://example.test/api/booking/admin';
const ADMIN_ORIGIN = 'https://example.test';
// Same fixture pattern as tests/handlers-admin.test.ts: a real CSRF secret so layer 2 is actually
// exercised (mintAdminCsrfToken/verifyAdminCsrfToken are deliberate no-ops without one).
const CSRF_TEST_SECRET = 'handlers-admin-incidents-test-secret';
const csrfSecrets = async (name: string) => (name === 'BOOKKIT_CSRF_SECRET' ? CSRF_TEST_SECRET : undefined);

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

function seedSideEffect(repo: ReturnType<typeof fakeRepository>, bookingId: string, kind: string): void {
  repo.sideEffectOperations.set(`${bookingId}:${kind}`, {
    bookingId, kind: kind as never, status: 'abandoned', providerResultId: null,
    attemptCount: 10, attemptedAt: '2026-06-14T07:00:00.000Z', resolvedAt: null,
    error: 'provider down', createdAt: '2026-06-14T06:00:00.000Z', updatedAt: '2026-06-14T07:00:00.000Z',
    failureStartedAt: '2026-06-14T06:00:00.000Z', nextAttemptAt: null,
  });
}

// Plan 020 (design decision 12/13): the admin "Attention required" section — the GET render pulls
// open/resolved incidents into the page, and the two CSRF-protected POST actions (Try again / I
// handled this manually) dispatch to the right executor per source type without ever falsifying
// the underlying booking/side-effect/refund row.
describe('admin incidents (plan 020 design decisions 12-14)', () => {
  it('GET renders an open incident card with its owner-facing title, never the word "abandoned"', async () => {
    const seeded = booking({ id: 'inc-render', status: 'confirmed', calendarSynced: false });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'calendar_create');
    await repo.upsertOpenIncident({
      id: 'incident-1', bookingId: seeded.id, sourceType: 'side_effect', sourceKey: `${seeded.id}:calendar_create`,
      action: 'calendar', severity: 'action_required', attemptCount: 10, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const response = await handleAdminGet(new Request(ADMIN_URL), context);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Calendar booking not created');
    expect(html).toContain(seeded.reference);
    expect(html).not.toContain('abandoned');
  });

  it('does not render a Retry button for an oversell incident, and the server rejects the action even if forged', async () => {
    const seeded = booking({ id: 'inc-oversell', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    await repo.upsertOpenIncident({
      id: 'incident-oversell', bookingId: seeded.id, sourceType: 'oversell', sourceKey: seeded.id,
      action: 'oversell', severity: 'action_required', attemptCount: 1, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });

    const getResponse = await handleAdminGet(new Request(ADMIN_URL), context);
    const html = await getResponse.text();
    expect(html).not.toMatch(/name="action" value="incident-retry"[^]*?oversell/);
    // The disclosure copy explaining why is present instead of a button for this card.
    expect(html).toContain('needs manual handling');

    const postResponse = await handleAdminPost(
      adminPostRequest({ action: 'incident-retry', source_type: 'oversell', source_key: seeded.id }),
      context,
    );
    expect(postResponse.status).toBe(400);
    await expect(postResponse.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('incident-retry dispatches a side_effect incident to retrySideEffectOperation and redirects with a notice', async () => {
    const seeded = booking({ id: 'inc-retry-se', status: 'confirmed', calendarSynced: false });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'calendar_create');
    await repo.upsertOpenIncident({
      id: 'incident-se', bookingId: seeded.id, sourceType: 'side_effect', sourceKey: `${seeded.id}:calendar_create`,
      action: 'calendar', severity: 'action_required', attemptCount: 10, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    let calendarCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, secrets: csrfSecrets,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { calendarCalls += 1; return 'cal_retry'; }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    const response = await handleAdminPost(
      adminPostRequest({ action: 'incident-retry', source_type: 'side_effect', source_key: `${seeded.id}:calendar_create` }),
      context,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('saved=incident-retried');
    expect(response.headers.get('location')).toContain('#bk-incidents');
    expect(calendarCalls).toBe(1);
    expect(repo.rows.get(seeded.id)?.calendarSynced).toBe(true);
  });

  it('incident-retry dispatches a refund incident through claimRefundExecutionForRetry + the shared executor', async () => {
    const seeded = booking({ id: 'inc-retry-refund', status: 'cancelled', stripePaymentIntent: 'pi_inc_retry' });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({ id: 'op-inc-retry', bookingId: seeded.id, paymentIntent: 'pi_inc_retry', choice: 'full', requestedAt: '2026-06-14T07:00:00.000Z' });
    await repo.resolveRefundOperation('op-inc-retry', { status: 'failed', error: 'stripe down', resolvedAt: '2026-06-14T07:00:00.000Z' });
    await repo.upsertOpenIncident({
      id: 'incident-refund', bookingId: seeded.id, sourceType: 'refund', sourceKey: seeded.id,
      action: 'refund', severity: 'action_required', attemptCount: 1, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    let refundCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, secrets: csrfSecrets,
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => { throw new Error('unused'); },
          getSession: async () => ({ status: 'open' }),
          refund: async () => { refundCalls += 1; return { refundId: 're_inc_retry', amountCents: seeded.priceCents }; },
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
    const seeded = booking({ id: 'inc-resolve', status: 'confirmed', calendarSynced: false });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'calendar_create');
    await repo.upsertOpenIncident({
      id: 'incident-resolve', bookingId: seeded.id, sourceType: 'side_effect', sourceKey: `${seeded.id}:calendar_create`,
      action: 'calendar', severity: 'action_required', attemptCount: 10, sourceUpdatedAt: '2026-06-14T07:00:00.000Z',
      now: '2026-06-14T07:00:00.000Z', escalate: false,
    });
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => ({ iss: 'https://access.test', aud: 'app', email: 'ops@example.test' }), providers: providers(), secrets: csrfSecrets });
    const opsToken = await mintTestCsrfToken('ops@example.test', CSRF_NOW);

    const blank = await handleAdminPost(adminPostRequest({ action: 'incident-resolve', source_type: 'side_effect', source_key: `${seeded.id}:calendar_create`, note: '   ' }, opsToken), context);
    expect(blank.status).toBe(400);

    const tooLong = await handleAdminPost(adminPostRequest({ action: 'incident-resolve', source_type: 'side_effect', source_key: `${seeded.id}:calendar_create`, note: 'x'.repeat(501) }, opsToken), context);
    expect(tooLong.status).toBe(400);

    const ok = await handleAdminPost(adminPostRequest({ action: 'incident-resolve', source_type: 'side_effect', source_key: `${seeded.id}:calendar_create`, note: '  called the customer directly  ' }, opsToken), context);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toContain('saved=incident-resolved');
    const resolved = await repo.getIncidentBySource('side_effect', `${seeded.id}:calendar_create`);
    expect(resolved).toMatchObject({ status: 'resolved', resolutionKind: 'manual', resolvedBy: 'ops@example.test', resolutionNote: 'called the customer directly' });
    // The underlying row is untouched — still 'abandoned', never rewritten to look succeeded.
    expect(repo.sideEffectOperations.get(`${seeded.id}:calendar_create`)?.status).toBe('abandoned');
    expect(repo.rows.get(seeded.id)?.calendarSynced).toBe(false);
  });

  it('rejects incident-retry/incident-resolve for an unknown or already-resolved incident with 400', async () => {
    const repo = fakeRepository();
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const response = await handleAdminPost(adminPostRequest({ action: 'incident-retry', source_type: 'side_effect', source_key: 'missing:calendar_create' }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('enforces the same Origin/CSRF guards as every other admin POST action', async () => {
    const repo = fakeRepository();
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, verifyAccess: async () => true, providers: providers(), secrets: csrfSecrets });
    const badOrigin = await handleAdminPost(new Request(ADMIN_URL, {
      method: 'POST', body: new URLSearchParams({ action: 'incident-retry', source_type: 'refund', source_key: 'x', csrf_token: DEFAULT_CSRF_TOKEN }),
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    }), context);
    expect(badOrigin.status).toBe(403);

    const badCsrf = await handleAdminPost(adminPostRequest({ action: 'incident-retry', source_type: 'refund', source_key: 'x' }, 'not-a-real-token'), context);
    expect(badCsrf.status).toBe(403);
  });
});
