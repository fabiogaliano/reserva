import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { runReconciliation, sideEffectIncidentSourceKey } from '../src/reconciliation';
import { booking, config } from './fixtures';
import type { SideEffectOperationIdentity, SideEffectOperationRecord } from '../src/repo';
import { fakeRepository, providers, seedSideEffectOperation, sideEffectOperation, type FakeRepository } from './fakes';

const clock = () => new Date('2026-08-14T10:00:00.000Z');

// A few tests need to simulate a later cron pass (the scheduled-side backoff gate,
// isDueForScheduledRetry in src/reconciliation.ts, is computed from real elapsed time).
function advanceableClock(startIso: string): { clock: () => Date; advance: (isoTime: string) => void } {
  let now = startIso;
  return { clock: () => new Date(now), advance: (isoTime) => { now = isoTime; } };
}

function seedSideEffect(repo: FakeRepository, bookingId: string, identity: SideEffectOperationIdentity, patch: Partial<{
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'abandoned';
  attemptCount: number;
  failureStartedAt: string | null;
  nextAttemptAt: string | null;
  attemptedAt: string | null;
}>): SideEffectOperationRecord {
  return seedSideEffectOperation(repo, bookingId, identity, {
    status: patch.status ?? 'pending', attemptCount: patch.attemptCount ?? 0,
    attemptedAt: patch.attemptedAt ?? null, createdAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z',
    failureStartedAt: patch.failureStartedAt ?? null, nextAttemptAt: patch.nextAttemptAt ?? null,
  });
}

// Addresses the incident through its stored outbox row and the production key helper, so the test
// can't encode a key shape the reconciliation sweep doesn't produce.
async function sideEffectIncident(repo: FakeRepository, bookingId: string, identity: SideEffectOperationIdentity) {
  const operation = sideEffectOperation(repo, bookingId, identity);
  if (!operation) throw new Error(`no ${identity.family} row for ${bookingId}`);
  return repo.getIncidentBySource('side_effect', sideEffectIncidentSourceKey(operation));
}

describe('runReconciliation', () => {
  it('opens a delayed incident once a failed side-effect row has been failing for ten uninterrupted minutes, and resolves it automatically once a later drain succeeds', async () => {
    const seeded = booking({ id: 'recon-delayed-incident', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, {
      status: 'failed', attemptCount: 2, failureStartedAt: '2026-08-14T09:49:00.000Z',
      attemptedAt: '2026-08-14T09:59:00.000Z', nextAttemptAt: null,
    });
    let shouldFail = true;
    let calendarCalls = 0;
    const { clock: scanClock, advance } = advanceableClock('2026-08-14T10:00:00.000Z');
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock: scanClock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { calendarCalls += 1; if (shouldFail) throw new Error('calendar still down'); return 'cal_recon'; }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    // Incident projection isn't gated by the retry backoff -- failure_started_at is already past
    // the ten-minute threshold, so an incident opens even though the retry gate correctly skips a
    // re-attempt this pass (calendarCalls stays 0).
    const first = await runReconciliation(context);
    expect(first.incidentsOpened).toBe(1);
    expect(calendarCalls).toBe(0);
    const opened = await sideEffectIncident(repo, seeded.id, { family: 'calendar_create' });
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
    const resolved = await sideEffectIncident(repo, seeded.id, { family: 'calendar_create' });
    expect(resolved).toMatchObject({ status: 'resolved', resolutionKind: 'automatic', action: 'calendar' });
  });

  it('does not open an incident for a failed side-effect row still inside the ten-minute window', async () => {
    const seeded = booking({ id: 'recon-too-soon', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, {
      status: 'failed', attemptCount: 1, failureStartedAt: '2026-08-14T09:55:00.000Z',
    });
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { throw new Error('calendar still down'); }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    const summary = await runReconciliation(context);
    expect(summary.incidentsOpened).toBe(0);
    expect(await sideEffectIncident(repo, seeded.id, { family: 'calendar_create' })).toBeNull();
  });

  it('opens an action_required incident immediately for an abandoned side-effect row', async () => {
    const seeded = booking({ id: 'recon-abandoned', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'email_confirmation' }, {
      status: 'abandoned', attemptCount: 10, failureStartedAt: '2026-08-14T09:59:59.000Z',
    });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const summary = await runReconciliation(context);
    expect(summary.incidentsOpened).toBe(1);
    const incident = await sideEffectIncident(repo, seeded.id, { family: 'email_confirmation' });
    expect(incident).toMatchObject({ severity: 'action_required', status: 'open' });
  });

  it('opens an incident and never calls Stripe when a requested refund cannot safely resume cancellation', async () => {
    const seeded = booking({ id: 'recon-refund-blocked', status: 'no_show', paymentRef: 'pi_recon_blocked' });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({ id: 'op-blocked', bookingId: seeded.id, paymentIntent: seeded.paymentRef, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });
    let refunds = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { refunds += 1; return { refundRef: 'never', amountMinor: seeded.priceMinor }; } } }),
    });

    const summary = await runReconciliation(context);
    expect(refunds).toBe(0);
    expect(summary.incidentsOpened).toBe(1);
    expect(await repo.getIncidentBySource('refund', seeded.id)).toMatchObject({ status: 'open', severity: 'action_required' });
  });

  it('opens an action_required refund incident on failure and resolves it once a later attempt succeeds', async () => {
    const seeded = booking({ id: 'recon-refund-incident', status: 'cancelled', paymentRef: 'pi_recon_incident' });
    const repo = fakeRepository([seeded]);
    await repo.claimRefundOperation({ id: 'op-incident', bookingId: seeded.id, paymentIntent: seeded.paymentRef, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });
    let shouldFail = true;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ payments: { createCheckout: async () => ({ url: '', sessionRef: '' }), parseWebhook: async () => { throw new Error('unused'); }, getSession: async () => ({ status: 'open' }), refund: async () => { if (shouldFail) throw new Error('stripe down'); return { refundRef: 're_incident_recovered', amountMinor: seeded.priceMinor }; } } }),
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

  it('drains a pending alert through the configured sink and marks it delivered', async () => {
    const seeded = booking({ id: 'recon-alert-drain', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'email_confirmation' }, { status: 'abandoned', attemptCount: 10, failureStartedAt: '2026-08-14T09:00:00.000Z' });
    const sent: unknown[] = [];
    const context = createReservaContext({
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

  it('does not send an obsolete action alert after the same pass auto-resolves its incident', async () => {
    const seeded = booking({ id: 'recon-no-obsolete-alert', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    const row = seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, {
      status: 'failed', attemptCount: 1, attemptedAt: '2026-08-14T09:00:00.000Z', failureStartedAt: '2026-08-14T09:00:00.000Z',
    });
    await repo.upsertOpenIncident({
      id: 'incident-no-obsolete-alert', bookingId: seeded.id, sourceType: 'side_effect',
      sourceKey: sideEffectIncidentSourceKey(row), action: 'calendar', severity: 'delayed',
      attemptCount: 1, sourceUpdatedAt: '2026-08-14T09:00:00.000Z', now: '2026-08-14T09:10:00.000Z', escalate: false,
    });
    const sent: unknown[] = [];
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ alerts: { send: async (alert) => { sent.push(alert); } } }),
    });

    const summary = await runReconciliation(context);
    expect(summary.incidentsResolved).toBe(1);
    expect(summary.alertsSent).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await sideEffectIncident(repo, seeded.id, { family: 'calendar_create' })).toMatchObject({ status: 'resolved', alertedRevision: 0 });
  });

  it('schedules a backoff retry for a failing alert sink without crashing the sweep', async () => {
    const seeded = booking({ id: 'recon-alert-fail', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'email_confirmation' }, { status: 'abandoned', attemptCount: 10, failureStartedAt: '2026-08-14T09:00:00.000Z' });
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock, providers: providers({ alerts: { send: async () => { throw new Error('slack webhook down'); } } }),
    });

    const summary = await runReconciliation(context);
    expect(summary.alertsFailed).toBe(1);
    const incident = await sideEffectIncident(repo, seeded.id, { family: 'email_confirmation' });
    expect(incident?.alertNextAttemptAt).not.toBeNull();
    expect(incident?.alertError).toContain('slack webhook down');
  });

  it('attempts due side-effect siblings independently and isolates provider failures', async () => {
    const seeded = booking({ id: 'recon-independent-rows', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, { status: 'pending' });
    seedSideEffect(repo, seeded.id, { family: 'email_confirmation' }, { status: 'pending' });
    seedSideEffect(repo, seeded.id, { family: 'email', event: 'booking.cancelled_by_operator' }, {
      status: 'failed', attemptCount: 4, attemptedAt: '2026-08-14T09:30:00.000Z', failureStartedAt: '2026-08-14T09:30:00.000Z',
    });
    let confirmationEmails = 0;
    let mutationEmails = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({
        calendar: { listEvents: async () => [], createEvent: async () => { throw new Error('calendar down'); }, deleteEvent: async () => undefined, patchEvent: async () => undefined },
        email: { send: async (event) => { if (event === 'booking.confirmed') confirmationEmails += 1; else mutationEmails += 1; } },
      }),
    });

    await runReconciliation(context);
    expect(confirmationEmails).toBe(1);
    expect(mutationEmails).toBe(0);
    expect(sideEffectOperation(repo, seeded.id, { family: 'calendar_create' })?.status).toBe('failed');
    expect(sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' })?.status).toBe('succeeded');
    expect(sideEffectOperation(repo, seeded.id, { family: 'email', event: 'booking.cancelled_by_operator' })?.attemptCount).toBe(4);
  });

  it('reprojects an open incident after ordinary HTTP recovery removes the source from execution candidates', async () => {
    const seeded = booking({ id: 'recon-http-reprojection', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'email_confirmation' }, { status: 'abandoned', attemptCount: 10 });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers({ alerts: { send: async () => undefined } }) });
    await runReconciliation(context);

    const operation = sideEffectOperation(repo, seeded.id, { family: 'email_confirmation' });
    if (!operation) throw new Error('missing seeded operation');
    // Re-seeding by identity overwrites the same row, as an HTTP drain resolving it would.
    seedSideEffectOperation(repo, seeded.id, operation, {
      ...operation, status: 'succeeded', updatedAt: '2026-08-14T10:01:00.000Z', resolvedAt: '2026-08-14T10:01:00.000Z',
    });

    const summary = await runReconciliation(context);
    expect(summary.sideEffectBookingsProcessed).toBe(0);
    expect(summary.incidentsResolved).toBe(1);
    expect(await sideEffectIncident(repo, seeded.id, { family: 'email_confirmation' })).toMatchObject({ status: 'resolved', resolutionKind: 'automatic' });
  });

  it('leaves alert revisions undelivered when no sink is configured and supports strict cron preflight', async () => {
    const seeded = booking({ id: 'recon-alert-missing', status: 'confirmed' });
    const repo = fakeRepository([seeded]);
    seedSideEffect(repo, seeded.id, { family: 'email_confirmation' }, { status: 'abandoned', attemptCount: 10 });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const summary = await runReconciliation(context);
    const incident = await sideEffectIncident(repo, seeded.id, { family: 'email_confirmation' });
    expect(summary.alertsFailed).toBe(1);
    expect(incident).toMatchObject({ alertRevision: 1, alertedRevision: 0 });
    await expect(runReconciliation(context, { requireAlertSink: true })).rejects.toThrow('requires an operational alert sink');
    expect((await sideEffectIncident(repo, seeded.id, { family: 'email_confirmation' }))?.alertedRevision).toBe(0);
  });

  it('loops bounded sourceLimit batches until the backlog is drained, and reports the batch count', async () => {
    const seeds = Array.from({ length: 3 }, (_, index) => booking({ id: `recon-bounded-${index}`, status: 'confirmed' }));
    const repo = fakeRepository(seeds);
    for (const seeded of seeds) seedSideEffect(repo, seeded.id, { family: 'calendar_create' }, { status: 'pending' });
    let calendarCalls = 0;
    const context = createReservaContext({
      config, db: {} as D1Database, repo, clock,
      providers: providers({ calendar: { listEvents: async () => [], createEvent: async () => { calendarCalls += 1; return `cal_${calendarCalls}`; }, deleteEvent: async () => undefined, patchEvent: async () => undefined } }),
    });

    // One run now drains the whole backlog: a full batch means more debt may exist, so the sweep
    // takes another one. The bound is per query, not per invocation.
    const first = await runReconciliation(context, { sourceLimit: 2 });
    expect(first.sideEffectBookingsProcessed).toBe(3);
    expect(first.batches).toBe(2);
    expect(calendarCalls).toBe(3);

    const second = await runReconciliation(context, { sourceLimit: 2 });
    expect(second.sideEffectBookingsProcessed).toBe(0);
    expect(second.batches).toBe(1);
    expect(calendarCalls).toBe(3);
  });
});
