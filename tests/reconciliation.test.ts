import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { runReconciliation } from '../src/reconciliation';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-08-14T10:00:00.000Z');

// A few tests need to simulate a later cron pass (the scheduled-side backoff gate,
// isDueForScheduledRetry in src/reconciliation.ts, is computed from real elapsed time).
function advanceableClock(startIso: string): { clock: () => Date; advance: (isoTime: string) => void } {
  let now = startIso;
  return { clock: () => new Date(now), advance: (isoTime) => { now = isoTime; } };
}

function seedSideEffect(repo: ReturnType<typeof fakeRepository>, bookingId: string, kind: string, patch: Partial<{
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'abandoned';
  attemptCount: number;
  failureStartedAt: string | null;
  nextAttemptAt: string | null;
  attemptedAt: string | null;
}>): void {
  repo.sideEffectOperations.set(`${bookingId}:${kind}`, {
    bookingId, kind: kind as never, status: patch.status ?? 'pending', providerResultId: null,
    attemptCount: patch.attemptCount ?? 0, attemptedAt: patch.attemptedAt ?? null, resolvedAt: null,
    error: null, createdAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z',
    failureStartedAt: patch.failureStartedAt ?? null, nextAttemptAt: patch.nextAttemptAt ?? null,
  });
}

describe('runReconciliation', () => {
  it('sweeps expired holds and reports the count', async () => {
    const seeded = booking({ id: 'recon-expired-hold', status: 'hold', holdExpiresAt: '2026-08-14T09:00:00.000Z' });
    const repo = fakeRepository([seeded]);
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const summary = await runReconciliation(context);
    expect(summary.expiredHoldsSwept).toBe(1);
    expect(repo.rows.get(seeded.id)?.status).toBe('expired');
  });

  it('opens a delayed incident once a failed side-effect row has been failing for ten uninterrupted minutes, and resolves it automatically once a later drain succeeds', async () => {
    const seeded = booking({ id: 'recon-delayed-incident', status: 'confirmed', calendarSynced: false, emailSynced: true });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'calendar_create', {
      status: 'failed', attemptCount: 2, failureStartedAt: '2026-08-14T09:49:00.000Z',
      attemptedAt: '2026-08-14T09:59:00.000Z', nextAttemptAt: null,
    });
    let shouldFail = true;
    let calendarCalls = 0;
    const { clock: scanClock, advance } = advanceableClock('2026-08-14T10:00:00.000Z');
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock: scanClock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { calendarCalls += 1; if (shouldFail) throw new Error('calendar still down'); return 'cal_recon'; }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    // First pass: incident PROJECTION isn't gated by the retry backoff — failure_started_at
    // (09:49) is already eleven minutes old at 10:00, past the ten-minute threshold, so an
    // incident opens even though attempt 2's own 10-minute backoff window (09:59 -> 10:09) means
    // the scheduled-side retry gate correctly skips a re-attempt this pass (calendarCalls stays 0).
    const first = await runReconciliation(context);
    expect(first.incidentsOpened).toBe(1);
    expect(calendarCalls).toBe(0);
    const opened = await repo.getIncidentBySource('side_effect', `${seeded.id}:calendar_create`);
    expect(opened).toMatchObject({ status: 'open', severity: 'delayed', action: 'calendar' });

    // Second pass: ten minutes later, the row is due — the retry gate now lets the drain attempt
    // run (and it still fails), 'update'-ing the same open incident rather than opening a new one.
    advance('2026-08-14T10:10:00.000Z');
    const retried = await runReconciliation(context);
    expect(calendarCalls).toBe(1);
    expect(retried.incidentsUpdated).toBe(1);

    // Third pass: advance past attempt 3's 20-minute backoff window and let the drain succeed —
    // the incident auto-resolves.
    advance('2026-08-14T10:31:00.000Z');
    shouldFail = false;
    const second = await runReconciliation(context);
    expect(second.incidentsResolved).toBe(1);
    const resolved = await repo.getIncidentBySource('side_effect', `${seeded.id}:calendar_create`);
    expect(resolved).toMatchObject({ status: 'resolved', resolutionKind: 'automatic', action: 'calendar' });
  });

  it('does not open an incident for a failed side-effect row still inside the ten-minute window', async () => {
    const seeded = booking({ id: 'recon-too-soon', status: 'confirmed', calendarSynced: false, emailSynced: true });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'calendar_create', {
      status: 'failed', attemptCount: 1, failureStartedAt: '2026-08-14T09:55:00.000Z',
    });
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { throw new Error('calendar still down'); }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    const summary = await runReconciliation(context);
    expect(summary.incidentsOpened).toBe(0);
    expect(await repo.getIncidentBySource('side_effect', `${seeded.id}:calendar_create`)).toBeNull();
  });

  it('opens an action_required incident immediately for an abandoned side-effect row', async () => {
    const seeded = booking({ id: 'recon-abandoned', status: 'confirmed', calendarSynced: true, emailSynced: false });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'email_confirmation', {
      status: 'abandoned', attemptCount: 10, failureStartedAt: '2026-08-14T09:59:59.000Z',
    });
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const summary = await runReconciliation(context);
    expect(summary.incidentsOpened).toBe(1);
    const incident = await repo.getIncidentBySource('side_effect', `${seeded.id}:email_confirmation`);
    expect(incident).toMatchObject({ severity: 'action_required', status: 'open' });
  });

  it('resumes and completes a stuck cancelled-booking refund via the shared executor, opening no incident on success', async () => {
    const seeded = booking({ id: 'recon-refund-resume', status: 'cancelled', stripePaymentIntent: 'pi_recon_resume' });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({ id: 'op-recon', bookingId: seeded.id, paymentIntent: seeded.stripePaymentIntent, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });
    let refunds = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionId: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundId: 're_recon_resume', amountCents: seeded.priceCents }; } } }),
    });

    const summary = await runReconciliation(context);
    expect(refunds).toBe(1);
    expect(repo.refundOperations.get(seeded.id)).toMatchObject({ status: 'succeeded', stripeRefundId: 're_recon_resume' });
    expect(summary.refundBookingsProcessed).toBe(1);
    expect(summary.incidentsOpened).toBe(0);
  });

  it('never calls Stripe for a refund operation whose booking is not yet durably cancelled', async () => {
    const seeded = booking({ id: 'recon-refund-not-cancelled', status: 'confirmed', stripePaymentIntent: 'pi_recon_not_cancelled' });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({ id: 'op-not-cancelled', bookingId: seeded.id, paymentIntent: seeded.stripePaymentIntent, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });
    let refunds = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionId: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundId: 're_should_not_run', amountCents: seeded.priceCents }; } } }),
    });

    // The candidate list only surfaces requested/failed/in_flight rows; a 'confirmed' booking's
    // still-requested row is a candidate, but processRefundCandidate must skip Stripe entirely.
    await runReconciliation(context);
    expect(refunds).toBe(0);
    expect(repo.refundOperations.get(seeded.id)?.status).toBe('requested');
  });

  it('opens an action_required refund incident on failure and resolves it once a later attempt succeeds', async () => {
    const seeded = booking({ id: 'recon-refund-incident', status: 'cancelled', stripePaymentIntent: 'pi_recon_incident' });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({ id: 'op-incident', bookingId: seeded.id, paymentIntent: seeded.stripePaymentIntent, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });
    let shouldFail = true;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionId: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { if (shouldFail) throw new Error('stripe down'); return { refundId: 're_incident_recovered', amountCents: seeded.priceCents }; } } }),
    });

    const first = await runReconciliation(context);
    expect(first.incidentsOpened).toBe(1);
    const opened = await repo.getIncidentBySource('refund', seeded.id);
    expect(opened).toMatchObject({ status: 'open', severity: 'action_required', action: 'refund' });

    // Clear the backoff window and let the next attempt succeed.
    const stuck = repo.refundOperations.get(seeded.id);
    if (stuck) repo.refundOperations.set(seeded.id, { ...stuck, nextAttemptAt: null });
    shouldFail = false;
    const second = await runReconciliation(context);
    expect(second.incidentsResolved).toBe(1);
    expect(repo.refundOperations.get(seeded.id)?.status).toBe('succeeded');
    const resolved = await repo.getIncidentBySource('refund', seeded.id);
    expect(resolved).toMatchObject({ status: 'resolved', resolutionKind: 'automatic' });
  });

  it('reports an unreported oversell marker as an action_required incident exactly once', async () => {
    const seeded = booking({ id: 'recon-oversell', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'oversell', { status: 'succeeded' });
    const context = createBookkitContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const first = await runReconciliation(context);
    expect(first.incidentsOpened).toBe(1);
    const incident = await repo.getIncidentBySource('oversell', seeded.id);
    expect(incident).toMatchObject({ status: 'open', severity: 'action_required', action: 'oversell' });

    const second = await runReconciliation(context);
    expect(second.incidentsOpened).toBe(0);
  });

  it('drains a pending alert through the configured sink and marks it delivered', async () => {
    const seeded = booking({ id: 'recon-alert-drain', status: 'confirmed', calendarSynced: true, emailSynced: false });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'email_confirmation', { status: 'abandoned', attemptCount: 10, failureStartedAt: '2026-08-14T09:00:00.000Z' });
    const sent: unknown[] = [];
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock, providers: providers({ alerts: { send: async (alert) => { sent.push(alert); } } }),
    });

    const summary = await runReconciliation(context);
    expect(summary.alertsSent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0] as object).sort()).toEqual(
      ['action', 'adminUrl', 'attemptCount', 'firstDetectedAt', 'incidentId', 'reference', 'severity'].sort(),
    );
    expect(sent[0]).toMatchObject({ reference: seeded.reference, action: 'confirmation_email', severity: 'action_required' });

    // A second pass has nothing new to alert on (alertedRevision already caught up to alertRevision).
    const second = await runReconciliation(context);
    expect(second.alertsSent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('schedules a backoff retry for a failing alert sink without crashing the sweep', async () => {
    const seeded = booking({ id: 'recon-alert-fail', status: 'confirmed', calendarSynced: true, emailSynced: false });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, 'email_confirmation', { status: 'abandoned', attemptCount: 10, failureStartedAt: '2026-08-14T09:00:00.000Z' });
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock, providers: providers({ alerts: { send: async () => { throw new Error('slack webhook down'); } } }),
    });

    const summary = await runReconciliation(context);
    expect(summary.alertsFailed).toBe(1);
    const incident = await repo.getIncidentBySource('side_effect', `${seeded.id}:email_confirmation`);
    expect(incident?.alertNextAttemptAt).not.toBeNull();
    expect(incident?.alertError).toContain('slack webhook down');
  });

  it('honors a bounded sourceLimit and remains resumable across invocations', async () => {
    const seeds = Array.from({ length: 3 }, (_, index) => booking({ id: `recon-bounded-${index}`, status: 'confirmed', calendarSynced: false, emailSynced: true }));
    const repo = fakeRepository(seeds);
    for (const seeded of seeds) seedSideEffect(repo, seeded.id, 'calendar_create', { status: 'pending' });
    let calendarCalls = 0;
    const context = createBookkitContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { calendarCalls += 1; return `cal_${calendarCalls}`; }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    const first = await runReconciliation(context, { sourceLimit: 2 });
    expect(first.sideEffectBookingsProcessed).toBe(2);
    expect(calendarCalls).toBe(2);

    const second = await runReconciliation(context, { sourceLimit: 2 });
    expect(second.sideEffectBookingsProcessed).toBe(1);
    expect(calendarCalls).toBe(3);
  });
});
