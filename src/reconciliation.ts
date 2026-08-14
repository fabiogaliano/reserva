// The scheduled reconciler keeps D1 authoritative and separates three bounded workloads:
// executable rows that are eligible now, incident-worthy rows not yet reported, and existing
// incidents whose source changed. Row-level execution preserves sibling backoff and failure
// isolation; terminal history can never occupy the executable page. Side-effect backoff is derived
// in the repository query because HTTP recovery deliberately remains immediate, while refund rows
// use their persisted next_attempt_at. Both paths still claim through the same operation-specific
// primitives used by ordinary request recovery.
import { classifyAttemptOutcome, runScheduledSideEffectOperation } from './confirmation';
import type { Booking } from './core/booking';
import type { OperationalAlert } from './core/events';
import type { BookkitContext } from './context';
import { nowIso } from './context';
import { resumeClaimedOperatorCancellation } from './operator-cancellation';
import { attemptRefund } from './refund-executor';
import {
  actionForSideEffectKind,
  buildOperationalAlert,
  computeNextAttemptAt,
  INCIDENT_DELAY_THRESHOLD_MS,
  isDelayIncidentDue,
  projectIncident,
  type ExistingIncidentSignal,
  type IncidentProjection,
  type IncidentSourceSignal,
} from './reconciliation-helpers';
import {
  MUTATION_SIDE_EFFECT_LEASE_MS,
  type OperationalIncidentAction,
  type OperationalIncidentRecord,
  type OperationalIncidentSourceType,
  type RefundOperationRecord,
  type SideEffectOperationRecord,
} from './repo';

// Plan 020 (design decision 4): default/hard-capped bounded page sizes for one invocation.
const DEFAULT_SOURCE_LIMIT = 10;
const HARD_SOURCE_LIMIT = 50;
const DEFAULT_ALERT_LIMIT = 25;
const HARD_ALERT_LIMIT = 50;
// Mirrors MUTATION_SIDE_EFFECT_LEASE_MS (src/repo.ts) — the alert claim's own lease window, so a
// killed alert-delivery attempt is reclaimable by the next scan rather than stuck forever.
const ALERT_CLAIM_LEASE_MS = 5 * 60_000;

export interface ReconciliationOptions {
  sourceLimit?: number;
  alertLimit?: number;
  requireAlertSink?: boolean;
}

export interface ReconciliationSummary {
  expiredHoldsSwept: number;
  sideEffectBookingsProcessed: number;
  refundBookingsProcessed: number;
  incidentsOpened: number;
  incidentsUpdated: number;
  incidentsResolved: number;
  alertsSent: number;
  alertsFailed: number;
}

function clampLimit(requested: number | undefined, fallback: number, hardCap: number): number {
  return Math.max(1, Math.min(requested ?? fallback, hardCap));
}

function toExistingIncidentSignal(incident: OperationalIncidentRecord | null): ExistingIncidentSignal | null {
  if (!incident) return null;
  return { status: incident.status, severity: incident.severity, sourceUpdatedAt: incident.sourceUpdatedAt, resolutionKind: incident.resolutionKind };
}

interface IncidentTally { opened: number; updated: number; resolved: number }

function addTally(target: IncidentTally, projection: IncidentProjection): void {
  if (projection.action === 'open') target.opened += 1;
  else if (projection.action === 'update') target.updated += 1;
  else if (projection.action === 'resolve-automatic') target.resolved += 1;
}

// Applies one signal/existing-row pair's projection to the incident ledger and tallies the result.
// Shared by every source kind (side-effect, refund, oversell) below.
async function applyIncidentProjection(
  context: BookkitContext,
  tally: IncidentTally,
  bookingId: string,
  sourceType: OperationalIncidentSourceType,
  sourceKey: string,
  action: OperationalIncidentAction,
  signal: IncidentSourceSignal,
): Promise<void> {
  const existing = await context.repo.getIncidentBySource(sourceType, sourceKey);
  const projection = projectIncident(signal, toExistingIncidentSignal(existing));
  addTally(tally, projection);
  const now = nowIso(context);
  if (projection.action === 'open' || projection.action === 'update') {
    const incidentId = existing?.id ?? crypto.randomUUID();
    await context.repo.upsertOpenIncident({
      id: incidentId,
      bookingId,
      sourceType,
      sourceKey,
      action,
      severity: signal.severity,
      attemptCount: signal.attemptCount,
      sourceUpdatedAt: signal.sourceUpdatedAt,
      now,
      escalate: projection.escalate,
    });
    context.logger.info?.('bookkit reconciliation incident projected', {
      incidentId, sourceType, action, severity: signal.severity,
      lifecycle: projection.action, escalated: projection.escalate,
    });
  } else if (projection.action === 'resolve-automatic') {
    await context.repo.resolveIncidentAutomatic(sourceType, sourceKey, now);
    context.logger.info?.('bookkit reconciliation incident resolved', {
      incidentId: existing?.id, sourceType, action, lifecycle: 'resolved_automatic',
    });
  }
}

// Plan 020 (design decision 6): a side-effect row's incident signal — 'abandoned' is immediately
// action_required (a permanent or tenth-attempt failure); a still-retrying 'failed' row only
// signals once its uninterrupted failure_started_at has been due for ten minutes; anything else
// (pending/in_flight/succeeded) reports no current debt.
function sideEffectSignal(operation: SideEffectOperationRecord, nowIsoValue: string): IncidentSourceSignal {
  const action = actionForSideEffectKind(operation.kind);
  if (operation.status === 'abandoned') {
    return { detected: true, severity: 'action_required', action, attemptCount: operation.attemptCount, sourceUpdatedAt: operation.updatedAt };
  }
  if (operation.status === 'failed' && operation.failureStartedAt && isDelayIncidentDue(operation.failureStartedAt, nowIsoValue)) {
    return { detected: true, severity: 'delayed', action, attemptCount: operation.attemptCount, sourceUpdatedAt: operation.updatedAt };
  }
  return { detected: false, severity: 'delayed', action, attemptCount: operation.attemptCount, sourceUpdatedAt: operation.updatedAt };
}

async function projectSideEffectIncidentsForBooking(context: BookkitContext, tally: IncidentTally, bookingId: string): Promise<void> {
  const operations = await context.repo.listSideEffectOperations(bookingId);
  const now = nowIso(context);
  for (const operation of operations) {
    const sourceKey = `${bookingId}:${operation.kind}`;
    const signal = sideEffectSignal(operation, now);
    await applyIncidentProjection(context, tally, bookingId, 'side_effect', sourceKey, signal.action, signal);
  }
}

// Plan 020 (design decision 6): "refund failures ... open an action-required incident
// immediately" — no ten-minute delay gate, unlike side-effect delivery failures.
function refundSignal(operation: RefundOperationRecord, booking: Booking | null): IncidentSourceSignal {
  const detected = operation.status === 'failed' || operation.status === 'abandoned'
    || (operation.status !== 'succeeded' && booking?.status !== 'cancelled');
  return { detected, severity: 'action_required', action: 'refund', attemptCount: operation.attemptCount, sourceUpdatedAt: operation.resolvedAt ?? operation.requestedAt };
}

async function projectRefundIncidentForBooking(context: BookkitContext, tally: IncidentTally, bookingId: string): Promise<void> {
  const [operation, booking] = await Promise.all([
    context.repo.getRefundOperationByBookingId(bookingId),
    context.repo.getBookingById(bookingId),
  ]);
  if (!operation) {
    const existing = await context.repo.getIncidentBySource('refund', bookingId);
    if (existing?.status === 'open') {
      await context.repo.resolveIncidentAutomatic('refund', bookingId, nowIso(context));
      tally.resolved += 1;
      context.logger.info?.('bookkit reconciliation incident resolved', {
        incidentId: existing.id, sourceType: 'refund', action: 'refund', lifecycle: 'resolved_automatic',
      });
    }
    return;
  }
  const signal = refundSignal(operation, booking);
  await applyIncidentProjection(context, tally, bookingId, 'refund', bookingId, 'refund', signal);
}

// Admin retries reproject synchronously so the card disappears in the same response flow. Cron's
// independent source-change page now provides the equivalent safety net for ordinary status,
// manage, and webhook recovery that happens outside reconciliation.
export async function reprojectIncidentAfterAdminRetry(
  context: BookkitContext,
  sourceType: 'side_effect' | 'refund',
  bookingId: string,
): Promise<void> {
  const tally: IncidentTally = { opened: 0, updated: 0, resolved: 0 };
  if (sourceType === 'side_effect') await projectSideEffectIncidentsForBooking(context, tally, bookingId);
  else await projectRefundIncidentForBooking(context, tally, bookingId);
}

// Plan 020 (design decision 3/6): oversell markers are permanent (never retried) and always
// action_required the first time they're observed unreported — listUnreportedOversellMarkers
// already excludes markers with an existing incident row, so this is always a fresh 'open'.
async function reportUnreportedOversellMarkers(context: BookkitContext, tally: IncidentTally, limit: number): Promise<void> {
  const markers = await context.repo.listUnreportedOversellMarkers(limit);
  const now = nowIso(context);
  for (const marker of markers) {
    const incidentId = crypto.randomUUID();
    await context.repo.upsertOpenIncident({
      id: incidentId,
      bookingId: marker.bookingId,
      sourceType: 'oversell',
      sourceKey: marker.bookingId,
      action: 'oversell',
      severity: 'action_required',
      attemptCount: marker.attemptCount,
      sourceUpdatedAt: marker.updatedAt,
      now,
      escalate: false,
    });
    tally.opened += 1;
    context.logger.info?.('bookkit reconciliation incident projected', {
      incidentId, sourceType: 'oversell', action: 'oversell', severity: 'action_required', lifecycle: 'open', escalated: false,
    });
  }
}

async function processSideEffectCandidate(
  context: BookkitContext,
  operation: SideEffectOperationRecord,
): Promise<void> {
  const booking = await context.repo.getBookingById(operation.bookingId);
  if (!booking) return;
  try {
    await runScheduledSideEffectOperation(context, booking, operation);
  } catch (error) {
    context.logger.warn?.('bookkit reconciliation side effect attempt failed', {
      bookingId: operation.bookingId, kind: operation.kind, error: String(error),
    });
  }
}

// The same cancellation CAS used by HTTP recovery is resumed before an execution claim. A crash
// after claimRefundOperation therefore cannot strand a confirmed booking, and Stripe remains
// unreachable until the returned booking is durably cancelled.
async function processRefundCandidate(context: BookkitContext, bookingId: string): Promise<void> {
  const [initialBooking, operation] = await Promise.all([
    context.repo.getBookingById(bookingId),
    context.repo.getRefundOperationByBookingId(bookingId),
  ]);
  if (!initialBooking || !operation || operation.status === 'succeeded' || operation.status === 'abandoned') return;

  let booking = initialBooking;
  if (booking.status !== 'cancelled') {
    if (operation.status !== 'requested' || booking.status !== 'confirmed') return;
    const cancellation = await resumeClaimedOperatorCancellation(context, booking, operation.id);
    if (cancellation.kind !== 'cancelled') return;
    booking = cancellation.booking;
  }

  const now = nowIso(context);
  const attemptNumber = await context.repo.claimRefundExecution(operation.id, now);
  if (attemptNumber === null) return;
  try {
    await attemptRefund(context, booking, operation.id, operation.choice, operation.paymentIntent, { attemptNumber });
  } catch (error) {
    context.logger.warn?.('bookkit reconciliation refund attempt failed', { bookingId, error: String(error) });
  }
}

async function projectIncidents(
  context: BookkitContext,
  sideEffectBookingIds: Iterable<string>,
  refundBookingIds: Iterable<string>,
  limit: number,
): Promise<IncidentTally> {
  const tally: IncidentTally = { opened: 0, updated: 0, resolved: 0 };
  for (const bookingId of sideEffectBookingIds) await projectSideEffectIncidentsForBooking(context, tally, bookingId);
  for (const bookingId of refundBookingIds) await projectRefundIncidentForBooking(context, tally, bookingId);
  await reportUnreportedOversellMarkers(context, tally, limit);
  return tally;
}

function adminUrlForIncident(context: BookkitContext, incidentId: string): string {
  const adminPage = context.routeConfig.paths.adminPage;
  return new URL(`${adminPage}?view=incidents#incident-${incidentId}`, context.config.business.url).toString();
}

// Alert delivery has its own claim/attempt/backoff. Only open incidents are eligible: a revision
// that auto-resolves before delivery is obsolete, while a later reopen increments alert_revision
// and becomes independently deliverable.
async function drainAlerts(context: BookkitContext, limit: number): Promise<{ sent: number; failed: number }> {
  const sink = context.providers.alerts;
  const ids = await context.repo.listAlertCandidateIds(nowIso(context), limit);
  if (!sink && ids.length > 0) {
    context.logger.error?.('bookkit reconciliation alert sink missing', {
      lifecycle: 'configuration_error', pendingAlerts: ids.length,
    });
    return { sent: 0, failed: ids.length };
  }
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    const now = nowIso(context);
    const token = crypto.randomUUID();
    const leaseUntil = new Date(Date.parse(now) + ALERT_CLAIM_LEASE_MS).toISOString();
    const claimed = await context.repo.claimIncidentAlert(id, token, now, leaseUntil);
    if (!claimed) continue;
    if (!sink) continue;
    const alert: OperationalAlert = buildOperationalAlert({
      incidentId: claimed.id,
      reference: await referenceForBooking(context, claimed.bookingId),
      action: claimed.action,
      severity: claimed.severity,
      attemptCount: claimed.attemptCount,
      firstDetectedAt: claimed.firstDetectedAt,
      adminUrl: adminUrlForIncident(context, claimed.id),
    });
    try {
      context.logger.info?.('bookkit reconciliation alert delivery started', {
        incidentId: claimed.id, alertRevision: claimed.alertRevision, lifecycle: 'started',
      });
      await sink.send(alert);
      await context.repo.resolveIncidentAlertSuccess(id, token, claimed.alertRevision);
      sent += 1;
      context.logger.info?.('bookkit reconciliation alert delivered', {
        incidentId: claimed.id, alertRevision: claimed.alertRevision, lifecycle: 'succeeded',
      });
    } catch (error) {
      const outcome = classifyAttemptOutcome(claimed.alertAttemptCount, error);
      const message = outcome.error;
      const nextAttemptAt = computeNextAttemptAt(new Date(now), claimed.alertAttemptCount);
      await context.repo.resolveIncidentAlertFailure(id, token, message, nextAttemptAt);
      failed += 1;
      context.logger.warn?.('bookkit reconciliation alert delivery failed', {
        incidentId: claimed.id, alertRevision: claimed.alertRevision,
        lifecycle: 'failed', nextAttemptAt, error: message,
      });
    }
  }
  return { sent, failed };
}

async function referenceForBooking(context: BookkitContext, bookingId: string): Promise<string> {
  const booking: Booking | null = await context.repo.getBookingById(bookingId);
  return booking?.reference ?? bookingId;
}

// Plan 020 (design decision 4): the one entry point a scheduled event (or a manual admin-triggered
// sweep) calls. Bounded and resumable — a partial run (hitting a page limit, or one candidate
// erroring) is safe; the next invocation picks up remaining debt via the same candidate queries.
export async function runReconciliation(context: BookkitContext, options: ReconciliationOptions = {}): Promise<ReconciliationSummary> {
  const sourceLimit = clampLimit(options.sourceLimit, DEFAULT_SOURCE_LIMIT, HARD_SOURCE_LIMIT);
  const alertLimit = clampLimit(options.alertLimit, DEFAULT_ALERT_LIMIT, HARD_ALERT_LIMIT);
  if (options.requireAlertSink && !context.providers.alerts) {
    context.logger.error?.('bookkit reconciliation alert sink missing', { lifecycle: 'configuration_error' });
    throw new Error('Bookkit reconciliation requires an operational alert sink');
  }

  const startedAt = nowIso(context);
  const staleBefore = new Date(Date.parse(startedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
  const failureDueBefore = new Date(Date.parse(startedAt) - INCIDENT_DELAY_THRESHOLD_MS).toISOString();
  context.logger.info?.('bookkit reconciliation started', {
    lifecycle: 'started', sourceLimit, alertLimit,
  });

  const expiredHoldsSwept = await context.repo.sweepExpiredHolds(startedAt);

  const sideEffectCandidates = await context.repo.listSideEffectExecutionCandidates(startedAt, staleBefore, sourceLimit);
  for (const operation of sideEffectCandidates) await processSideEffectCandidate(context, operation);

  const refundBookingIds = await context.repo.listRefundExecutionCandidateBookingIds(startedAt, staleBefore, sourceLimit);
  for (const bookingId of refundBookingIds) await processRefundCandidate(context, bookingId);

  const [sideEffectIncidentIds, refundIncidentIds, reprojectionCandidates] = await Promise.all([
    context.repo.listSideEffectIncidentCandidateBookingIds(failureDueBefore, sourceLimit),
    context.repo.listRefundIncidentCandidateBookingIds(sourceLimit),
    context.repo.listIncidentReprojectionCandidates(sourceLimit),
  ]);
  const sideEffectProjectionIds = new Set(sideEffectCandidates.map((operation) => operation.bookingId));
  const refundProjectionIds = new Set(refundBookingIds);
  for (const bookingId of sideEffectIncidentIds) sideEffectProjectionIds.add(bookingId);
  for (const bookingId of refundIncidentIds) refundProjectionIds.add(bookingId);
  for (const incident of reprojectionCandidates) {
    if (incident.sourceType === 'side_effect') sideEffectProjectionIds.add(incident.bookingId);
    else if (incident.sourceType === 'refund') refundProjectionIds.add(incident.bookingId);
  }

  const incidentTally = await projectIncidents(context, sideEffectProjectionIds, refundProjectionIds, sourceLimit);
  const alertResult = await drainAlerts(context, alertLimit);
  const summary: ReconciliationSummary = {
    expiredHoldsSwept,
    sideEffectBookingsProcessed: new Set(sideEffectCandidates.map((operation) => operation.bookingId)).size,
    refundBookingsProcessed: refundBookingIds.length,
    incidentsOpened: incidentTally.opened,
    incidentsUpdated: incidentTally.updated,
    incidentsResolved: incidentTally.resolved,
    alertsSent: alertResult.sent,
    alertsFailed: alertResult.failed,
  };
  context.logger.info?.('bookkit reconciliation completed', { lifecycle: 'completed', ...summary });
  return summary;
}
