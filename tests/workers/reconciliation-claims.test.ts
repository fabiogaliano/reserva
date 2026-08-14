import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository } from '../../src/repo';

interface TestEnv {
  BOOKKIT_DB: D1Database;
}

const db = (env as unknown as TestEnv).BOOKKIT_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM operational_incidents').run();
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
});

async function seedConfirmed(id: string): Promise<void> {
  await repo.insertHold({
    id,
    reference: `BKT-2026-${id}`,
    tourSlug: 'vintage',
    people: 2,
    pickupType: 'default',
    startsAt: '2026-08-01T09:00:00.000Z',
    endsAt: '2026-08-01T10:00:00.000Z',
    locale: 'en',
    priceCents: 12000,
    holdExpiresAt: '2026-07-21T10:35:00.000Z',
    cancelToken: `cancel-${id}`,
    operatorToken: `operator-${id}`,
    createdAt: '2026-07-21T10:00:00.000Z',
    updatedAt: '2026-07-21T10:00:00.000Z',
  });
  const confirmed = await repo.transitionToConfirmed(id, {
    expectedStatusIn: ['hold'],
    stripePaymentIntent: `pi_${id}`,
    updatedAt: '2026-07-21T10:01:00.000Z',
  });
  expect(confirmed).toMatchObject({ status: 'confirmed' });
}

// Plan 020 (design decision 7): claimRefundExecution is the shared refund executor's own atomic
// claim, mirroring claimRefundOperation's real-D1 concurrency proof — exactly one of several
// concurrent scheduled-reconciler passes (or an HTTP request racing the cron) may claim a given
// refund_operations row's execution slot at a time.
describe('claimRefundExecution / claimRefundExecutionForRetry concurrent claim uniqueness on real D1', () => {
  it('exactly one of five concurrent execution claims for the same requested refund wins', async () => {
    const id = 'refund-exec-claim-race';
    await seedConfirmed(id);
    const claimed = await repo.claimRefundOperation({ id: 'op-exec', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    expect(claimed).toBe(true);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, index) => repo.claimRefundExecution('op-exec', `2026-07-21T11:00:0${index}.000Z`)),
    );

    // Exactly one caller wins the execution slot; every loser gets null (the row is already
    // 'in_flight' the instant the first claim commits, so it fails every other claim's WHERE).
    expect(attempts.filter((attempt) => attempt !== null)).toHaveLength(1);
  });

  it('a stale in_flight row (a killed claimant) is reclaimable by claimRefundExecution', async () => {
    const id = 'refund-exec-stale-reclaim';
    await seedConfirmed(id);
    await repo.claimRefundOperation({ id: 'op-stale', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    const firstAttempt = await repo.claimRefundExecution('op-stale', '2026-07-21T11:00:00.000Z');
    expect(firstAttempt).toBe(1);

    // A claim while the lease is still live must fail.
    const stillLive = await repo.claimRefundExecution('op-stale', '2026-07-21T11:00:05.000Z');
    expect(stillLive).toBeNull();

    // Once the lease window (MUTATION_SIDE_EFFECT_LEASE_MS) has elapsed, a fresh claim succeeds
    // and bumps the attempt count again — the killed claimant's work is presumed lost.
    const reclaimed = await repo.claimRefundExecution('op-stale', '2026-07-21T11:20:00.000Z');
    expect(reclaimed).toBe(2);
  });

  it('claimRefundExecution refuses a row gated by a future next_attempt_at, but claimRefundExecutionForRetry bypasses it', async () => {
    const id = 'refund-exec-backoff-bypass';
    await seedConfirmed(id);
    await repo.claimRefundOperation({ id: 'op-backoff', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    await repo.claimRefundExecution('op-backoff', '2026-07-21T11:00:00.000Z');
    await repo.resolveRefundOperation('op-backoff', { status: 'failed', error: 'stripe unavailable', resolvedAt: '2026-07-21T11:00:05.000Z', nextAttemptAt: '2026-07-21T11:05:00.000Z' });

    const tooSoon = await repo.claimRefundExecution('op-backoff', '2026-07-21T11:01:00.000Z');
    expect(tooSoon).toBeNull();

    // The admin "Try again" bypass ignores next_attempt_at entirely.
    const bypassed = await repo.claimRefundExecutionForRetry('op-backoff', '2026-07-21T11:01:00.000Z');
    expect(bypassed).toBe(2);
  });

  it('resolveRefundOperation writing status abandoned is claimable again only via the retry bypass', async () => {
    const id = 'refund-exec-abandoned';
    await seedConfirmed(id);
    await repo.claimRefundOperation({ id: 'op-abandoned', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    await repo.claimRefundExecution('op-abandoned', '2026-07-21T11:00:00.000Z');
    await repo.resolveRefundOperation('op-abandoned', { status: 'abandoned', error: 'permanent failure', resolvedAt: '2026-07-21T11:00:05.000Z' });

    const ordinary = await repo.claimRefundExecution('op-abandoned', '2026-07-21T11:10:00.000Z');
    expect(ordinary).toBeNull();

    const retried = await repo.claimRefundExecutionForRetry('op-abandoned', '2026-07-21T11:10:00.000Z');
    expect(retried).toBe(2);
  });
});

// Plan 020 (design decision 5): claimSideEffectOperationForRetry / claimMutationSideEffectOperationForRetry
// are the admin bypass for side-effect outbox rows — this proves the bypass and the ordinary
// next_attempt_at gate against real D1, not just the in-memory fake.
describe('side-effect operation backoff gating and retry bypass on real D1', () => {
  it('claimMutationSideEffectOperation refuses a row before next_attempt_at; the retry bypass does not', async () => {
    const id = 'sideeffect-backoff-bypass';
    await seedConfirmed(id);
    await repo.transitionToCancelled(id, {
      expectedStatusIn: ['confirmed'], cancelledAt: '2026-07-21T11:00:00.000Z', cancelledBy: 'operator',
      updatedAt: '2026-07-21T11:00:00.000Z', mutationSideEffectKinds: ['calendar_delete'],
    });

    const firstClaim = await repo.claimMutationSideEffectOperation(id, 'calendar_delete', '2026-07-21T11:00:01.000Z');
    expect(firstClaim).toBe(1);
    await repo.resolveMutationSideEffectOperation({
      bookingId: id, kind: 'calendar_delete', claimedAt: '2026-07-21T11:00:01.000Z', status: 'failed',
      error: 'calendar unavailable', resolvedAt: '2026-07-21T11:00:02.000Z', nextAttemptAt: '2026-07-21T11:05:00.000Z',
    });

    const tooSoon = await repo.claimMutationSideEffectOperation(id, 'calendar_delete', '2026-07-21T11:01:00.000Z');
    expect(tooSoon).toBeNull();

    const bypassed = await repo.claimMutationSideEffectOperationForRetry(id, 'calendar_delete', '2026-07-21T11:01:00.000Z');
    expect(bypassed).toBe(2);
  });
});

// Plan 020 (design decision 11): claimIncidentAlert is the alert-delivery lease for an open,
// undelivered revision, with its own claim/backoff window. Resolved revisions are obsolete and a
// later reopen increments alert_revision before becoming eligible again.
describe('operational_incidents alert claim concurrency and lifecycle on real D1', () => {
  it('exactly one of several concurrent alert claims for the same undelivered revision wins', async () => {
    const id = 'incident-alert-claim-race';
    await seedConfirmed(id);
    await repo.upsertOpenIncident({
      id: 'inc-1', bookingId: id, sourceType: 'side_effect', sourceKey: `${id}:calendar_create`,
      action: 'calendar', severity: 'delayed', attemptCount: 1, sourceUpdatedAt: '2026-07-21T11:00:00.000Z',
      now: '2026-07-21T11:00:00.000Z', escalate: false,
    });

    const attempts = await Promise.all(
      Array.from({ length: 4 }, (_, index) => repo.claimIncidentAlert('inc-1', `token-${index}`, '2026-07-21T11:00:00.000Z', '2026-07-21T11:05:00.000Z')),
    );
    expect(attempts.filter((attempt) => attempt !== null)).toHaveLength(1);
  });

  it('resolveIncidentAlertSuccess only resolves the claim it actually holds (a stale token is a no-op)', async () => {
    const id = 'incident-alert-stale-token';
    await seedConfirmed(id);
    await repo.upsertOpenIncident({
      id: 'inc-2', bookingId: id, sourceType: 'side_effect', sourceKey: `${id}:calendar_create`,
      action: 'calendar', severity: 'delayed', attemptCount: 1, sourceUpdatedAt: '2026-07-21T11:00:00.000Z',
      now: '2026-07-21T11:00:00.000Z', escalate: false,
    });
    const claimed = await repo.claimIncidentAlert('inc-2', 'token-real', '2026-07-21T11:00:00.000Z', '2026-07-21T11:05:00.000Z');
    expect(claimed).not.toBeNull();

    // A stale caller holding a token from a previous (already-superseded) claim cannot resolve.
    await repo.resolveIncidentAlertSuccess('inc-2', 'token-stale', 1);
    const stillClaimed = await repo.getIncidentBySource('side_effect', `${id}:calendar_create`);
    expect(stillClaimed?.alertClaimToken).toBe('token-real');

    await repo.resolveIncidentAlertSuccess('inc-2', 'token-real', 1);
    const resolved = await repo.getIncidentBySource('side_effect', `${id}:calendar_create`);
    expect(resolved).toMatchObject({ alertedRevision: 1, alertClaimToken: null, alertClaimUntil: null });
  });

  it('upsertOpenIncident reopens a manually resolved incident and resolveIncidentManual/resolveIncidentAutomatic only affect open rows', async () => {
    const id = 'incident-lifecycle';
    await seedConfirmed(id);
    await repo.upsertOpenIncident({
      id: 'inc-3', bookingId: id, sourceType: 'side_effect', sourceKey: `${id}:email_confirmation`,
      action: 'confirmation_email', severity: 'delayed', attemptCount: 3, sourceUpdatedAt: '2026-07-21T11:00:00.000Z',
      now: '2026-07-21T11:00:00.000Z', escalate: false,
    });

    const manuallyResolved = await repo.resolveIncidentManual({
      sourceType: 'side_effect', sourceKey: `${id}:email_confirmation`,
      resolvedAt: '2026-07-21T12:00:00.000Z', resolvedBy: 'operator-1', resolutionNote: 'Emailed customer directly',
    });
    expect(manuallyResolved).toBe(true);

    // A second manual resolve call against an already-resolved row is a no-op (false), not an error.
    const secondManual = await repo.resolveIncidentManual({
      sourceType: 'side_effect', sourceKey: `${id}:email_confirmation`,
      resolvedAt: '2026-07-21T12:01:00.000Z', resolvedBy: 'operator-1', resolutionNote: 'duplicate',
    });
    expect(secondManual).toBe(false);

    // resolveIncidentAutomatic never touches an already-resolved row either.
    await repo.resolveIncidentAutomatic('side_effect', `${id}:email_confirmation`, '2026-07-21T12:02:00.000Z');
    let stored = await repo.getIncidentBySource('side_effect', `${id}:email_confirmation`);
    expect(stored).toMatchObject({ status: 'resolved', resolutionKind: 'manual', resolvedBy: 'operator-1' });

    // A fresh detection with the SAME source_updated_at leaves it resolved via projectIncident's
    // 'skip' branch (exercised in reconciliation-helpers unit tests) — this D1-level test proves
    // the reopen path itself: an upsert with escalate=true (a changed fingerprint) does reopen it.
    await repo.upsertOpenIncident({
      id: 'inc-3', bookingId: id, sourceType: 'side_effect', sourceKey: `${id}:email_confirmation`,
      action: 'confirmation_email', severity: 'delayed', attemptCount: 4, sourceUpdatedAt: '2026-07-21T13:00:00.000Z',
      now: '2026-07-21T13:00:00.000Z', escalate: false,
    });
    stored = await repo.getIncidentBySource('side_effect', `${id}:email_confirmation`);
    expect(stored).toMatchObject({ status: 'open', resolvedAt: null, resolutionKind: null, attemptCount: 4 });

    await repo.resolveIncidentAutomatic('side_effect', `${id}:email_confirmation`, '2026-07-21T14:00:00.000Z');
    stored = await repo.getIncidentBySource('side_effect', `${id}:email_confirmation`);
    expect(stored).toMatchObject({ status: 'resolved', resolutionKind: 'automatic' });
  });

  it('listOpenIncidents sorts action_required before delayed, then oldest first, and countIncidentsSince matches listOpenIncidents/listRecentResolvedIncidents', async () => {
    const idA = 'incident-sort-a';
    const idB = 'incident-sort-b';
    const idC = 'incident-sort-c';
    await seedConfirmed(idA);
    await seedConfirmed(idB);
    await seedConfirmed(idC);
    await repo.upsertOpenIncident({
      id: 'inc-a', bookingId: idA, sourceType: 'side_effect', sourceKey: `${idA}:calendar_create`,
      action: 'calendar', severity: 'delayed', attemptCount: 1, sourceUpdatedAt: '2026-07-21T09:00:00.000Z',
      now: '2026-07-21T09:00:00.000Z', escalate: false,
    });
    await repo.upsertOpenIncident({
      id: 'inc-b', bookingId: idB, sourceType: 'refund', sourceKey: idB,
      action: 'refund', severity: 'action_required', attemptCount: 10, sourceUpdatedAt: '2026-07-21T10:00:00.000Z',
      now: '2026-07-21T10:00:00.000Z', escalate: false,
    });
    await repo.upsertOpenIncident({
      id: 'inc-c', bookingId: idC, sourceType: 'oversell', sourceKey: idC,
      action: 'oversell', severity: 'action_required', attemptCount: 0, sourceUpdatedAt: '2026-07-21T08:00:00.000Z',
      now: '2026-07-21T08:00:00.000Z', escalate: false,
    });

    const open = await repo.listOpenIncidents(10);
    expect(open.map((incident) => incident.id)).toEqual(['inc-c', 'inc-b', 'inc-a']);

    const counts = await repo.countIncidentsSince('2026-07-21T00:00:00.000Z');
    expect(counts).toEqual({ opened: 3, resolved: 0 });

    await repo.resolveIncidentAutomatic('side_effect', `${idA}:calendar_create`, '2026-07-21T11:00:00.000Z');
    const afterResolve = await repo.countIncidentsSince('2026-07-21T00:00:00.000Z');
    expect(afterResolve).toEqual({ opened: 3, resolved: 1 });
    const recent = await repo.listRecentResolvedIncidents('2026-07-21T00:00:00.000Z', 10);
    expect(recent.map((incident) => incident.id)).toEqual(['inc-a']);
  });
});
