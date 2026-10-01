// The scheduled reconciler keeps D1 authoritative and separates three bounded workloads: executable
// rows eligible now, incident-worthy rows not yet reported, and incidents whose source changed.
// Row-level execution preserves sibling backoff and failure isolation. Side-effect backoff is
// derived in the repository query because HTTP recovery remains immediate, while refund rows use
// their persisted next_attempt_at.
import virtualConfig from 'virtual:reserva/config';
import {
  cancellationSideEffectSeeds,
  classifyAttemptOutcome,
  reminderSideEffectSeeds,
  runOwedMutationSideEffects,
  runScheduledSideEffectOperation,
} from './confirmation.js';
import { dispatchNonDurableBookingEvent } from './booking-events.js';
import type { Booking } from './core/booking.js';
import type { ReconciliationSummary } from './core/api.js';
import type { OperationalAlert } from './core/events.js';
import type { ReservaContext } from './context.js';
import { nowIso, withStoredSettings } from './context.js';
import { resumeClaimedOperatorCancellation } from './operator-cancellation.js';
import { attemptRefund } from './refund-executor.js';
import {
  actionForSideEffectOperation,
  buildOperationalAlert,
  computeNextAttemptAt,
  INCIDENT_DELAY_THRESHOLD_MS,
  isDelayIncidentDue,
  projectIncident,
  type ExistingIncidentSignal,
  type IncidentProjection,
  type IncidentSourceSignal,
} from './reconciliation-helpers.js';
import {
  MUTATION_SIDE_EFFECT_LEASE_MS,
  sideEffectOperationKey,
  type OperationalIncidentAction,
  type OperationalIncidentRecord,
  type OperationalIncidentSourceType,
  type RefundOperationRecord,
  type SideEffectOperationRecord,
} from './repo.js';
import { SCHEMA_CHECK_QUERIES } from './schema-check.js';

// Default/hard-capped bounded page sizes for one invocation.
const DEFAULT_SOURCE_LIMIT = 10;
const HARD_SOURCE_LIMIT = 50;
const DEFAULT_ALERT_LIMIT = 25;
const HARD_ALERT_LIMIT = 50;
// The alert claim's own lease window, so a killed alert-delivery attempt is reclaimable by the
// next scan rather than stuck forever.
const ALERT_CLAIM_LEASE_MS = 5 * 60_000;

export interface ReconciliationOptions {
  sourceLimit?: number;
  alertLimit?: number;
  requireAlertSink?: boolean;
  // The most D1 queries one sweep may issue. Defaults to what fits the Workers Free plan; a Paid
  // deployment can raise it toward 1,000.
  queryBudget?: number;
}

// Re-exported from its original home so every existing importer keeps working now that the shape
// is part of the ops wire contract.
export type { ReconciliationSummary };

// The sweep runs every 5 minutes. A constant, not prose in the docs: ops health derives its
// staleness threshold from it, and the shipped wrangler `triggers.crons` must match.
export const RECONCILIATION_CADENCE_MINUTES = 5;
// The batch loop's own budget. Comfortably inside the lease and the cron cadence, so a large
// backlog is drained over several ticks instead of one invocation overrunning both.
const RECONCILIATION_MAX_WALL_CLOCK_MS = 20_000;
// One minute under the cadence, so a lease left behind by a killed invocation frees itself before
// the next tick rather than skipping one.
const RECONCILIATION_LEASE_MS = 4 * 60_000;

// D1 refuses every query past its per-invocation cap, 50 on the Workers Free plan. Before the sweep
// starts, the same invocation may already have run a cold isolate's schema check, the admin
// settings read and the lease acquisition.
const D1_FREE_PLAN_QUERIES_PER_INVOCATION = 50;
const QUERIES_BEFORE_SWEEP = SCHEMA_CHECK_QUERIES + 2;
export const DEFAULT_RECONCILIATION_QUERY_BUDGET = D1_FREE_PLAN_QUERIES_PER_INVOCATION - QUERIES_BEFORE_SWEEP;

// Worst-case queries per step, measured against real D1 and pinned by
// tests/workers/reconciliation-query-budget.test.ts. A step is admitted only when its worst case
// fits: hitting the cap between a claim and its resolve would re-run the provider call on the
// next tick, and the customer would get the email twice.
// Load the booking, take the lease, claim, resolve (two statements), release.
const SIDE_EFFECT_STEP_QUERIES = 6;
const REFUND_LOAD_QUERIES = 2;
// Claim the execution, record the refunded amount, resolve the operation.
const REFUND_ATTEMPT_QUERIES = 3;
// The cancellation CAS (two statements) and the booking it returns, then listing the outbox rows
// it created; each row then costs a claim and a resolve.
const REFUND_CANCELLATION_QUERIES = 4;
const OUTBOX_ROW_QUERIES = 2;
// Read the incident, then open, update or resolve it.
const INCIDENT_PROJECTION_QUERIES = 2;
// Claim, look up the booking reference, resolve.
const ALERT_STEP_QUERIES = 3;
// Releasing the reconciliation lease, plus listing and sending one alert, so a backlog that eats
// every tick's budget can never starve the operator's alerts.
const CLOSING_QUERIES = 1;
const ALERT_FLOOR_QUERIES = 1 + ALERT_STEP_QUERIES;

interface QueryBudget {
  fits(queries: number): boolean;
  // The alert phase may spend what the earlier phases had to keep back for it.
  releaseAlertReserve(): void;
  readonly exhausted: boolean;
}

// Counted from the sweep's own start, so a context that outlives one invocation (a test, a long-lived
// caller) gets a fresh budget per sweep. Without a count (a context built on a supplied repo) every
// step fits, as before the budget existed.
function queryBudget(context: ReservaContext, limit: number): QueryBudget {
  const issued = context.d1QueriesIssued;
  const start = issued?.() ?? 0;
  let reserve = CLOSING_QUERIES + ALERT_FLOOR_QUERIES;
  let exhausted = false;
  return {
    fits(queries) {
      if (!issued || issued() - start + queries + reserve <= limit) return true;
      exhausted = true;
      return false;
    },
    releaseAlertReserve() { reserve = CLOSING_QUERIES; },
    get exhausted() { return exhausted; },
  };
}

const UNBOUNDED_BUDGET: QueryBudget = { fits: () => true, releaseAlertReserve: () => undefined, exhausted: false };

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
  context: ReservaContext,
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
    context.logger.info?.('reserva reconciliation incident projected', {
      incidentId, sourceType, action, severity: signal.severity,
      lifecycle: projection.action, escalated: projection.escalate,
    });
  } else if (projection.action === 'resolve-automatic') {
    await context.repo.resolveIncidentAutomatic(sourceType, sourceKey, now);
    context.logger.info?.('reserva reconciliation incident resolved', {
      incidentId: existing?.id, sourceType, action, lifecycle: 'resolved_automatic',
    });
  }
}

// The ledger key for a side-effect row, built from its identity columns — the TypeScript twin of
// the repository's own SQL key expression.
export function sideEffectIncidentSourceKey(operation: SideEffectOperationRecord): string {
  return `${operation.bookingId}:${sideEffectOperationKey(operation)}`;
}

// A side-effect row's incident signal — 'abandoned' is immediately
// action_required (a permanent or tenth-attempt failure); a still-retrying 'failed' row only
// signals once its uninterrupted failure_started_at has been due for ten minutes; anything else
// (pending/in_flight/succeeded) reports no current debt.
function sideEffectSignal(operation: SideEffectOperationRecord, nowIsoValue: string): IncidentSourceSignal {
  const action = actionForSideEffectOperation(operation);
  if (operation.status === 'abandoned') {
    return { detected: true, severity: 'action_required', action, attemptCount: operation.attemptCount, sourceUpdatedAt: operation.updatedAt };
  }
  if (operation.status === 'failed' && operation.failureStartedAt && isDelayIncidentDue(operation.failureStartedAt, nowIsoValue)) {
    return { detected: true, severity: 'delayed', action, attemptCount: operation.attemptCount, sourceUpdatedAt: operation.updatedAt };
  }
  return { detected: false, severity: 'delayed', action, attemptCount: operation.attemptCount, sourceUpdatedAt: operation.updatedAt };
}

async function projectSideEffectIncidentsForBooking(context: ReservaContext, tally: IncidentTally, bookingId: string, budget: QueryBudget): Promise<void> {
  if (!budget.fits(1)) return;
  const operations = await context.repo.listSideEffectOperations(bookingId);
  const now = nowIso(context);
  for (const operation of operations) {
    if (!budget.fits(INCIDENT_PROJECTION_QUERIES)) return;
    const sourceKey = sideEffectIncidentSourceKey(operation);
    const signal = sideEffectSignal(operation, now);
    await applyIncidentProjection(context, tally, bookingId, 'side_effect', sourceKey, signal.action, signal);
  }
}

// Refund failures open an action-required incident
// immediately — no ten-minute delay gate, unlike side-effect delivery failures.
function refundSignal(operation: RefundOperationRecord, booking: Booking | null): IncidentSourceSignal {
  const detected = operation.status === 'failed' || operation.status === 'abandoned'
    || (operation.status !== 'succeeded' && booking?.status !== 'cancelled');
  return { detected, severity: 'action_required', action: 'refund', attemptCount: operation.attemptCount, sourceUpdatedAt: operation.resolvedAt ?? operation.requestedAt };
}

async function projectRefundIncidentForBooking(context: ReservaContext, tally: IncidentTally, bookingId: string, budget: QueryBudget): Promise<void> {
  if (!budget.fits(2 + INCIDENT_PROJECTION_QUERIES)) return;
  const [operation, booking] = await Promise.all([
    context.repo.getRefundOperationByBookingId(bookingId),
    context.repo.getBookingById(bookingId),
  ]);
  if (!operation) {
    const existing = await context.repo.getIncidentBySource('refund', bookingId);
    if (existing?.status === 'open') {
      await context.repo.resolveIncidentAutomatic('refund', bookingId, nowIso(context));
      tally.resolved += 1;
      context.logger.info?.('reserva reconciliation incident resolved', {
        incidentId: existing.id, sourceType: 'refund', action: 'refund', lifecycle: 'resolved_automatic',
      });
    }
    return;
  }
  const signal = refundSignal(operation, booking);
  await applyIncidentProjection(context, tally, bookingId, 'refund', bookingId, 'refund', signal);
}

// What the operator is told after pressing Retry: the projection below already knows whether the
// incident cleared, so the dashboard reports the outcome instead of "we tried, refresh to see".
export type AdminRetryOutcome = 'resolved' | 'still_open' | 'not_retryable';

// Admin retries reproject synchronously so the card disappears in the same response flow. Cron's
// independent source-change page provides the equivalent safety net for ordinary status, manage,
// and webhook recovery that happens outside reconciliation.
export async function reprojectIncidentAfterAdminRetry(
  context: ReservaContext,
  sourceType: OperationalIncidentSourceType,
  sourceKey: string,
  bookingId: string | null,
): Promise<AdminRetryOutcome> {
  // Oversell, payment_verification and reconciliation have no operation to re-run, and a
  // booking-less incident has nothing to project against.
  if (bookingId === null || (sourceType !== 'side_effect' && sourceType !== 'refund')) return 'not_retryable';
  const tally: IncidentTally = { opened: 0, updated: 0, resolved: 0 };
  if (sourceType === 'side_effect') await projectSideEffectIncidentsForBooking(context, tally, bookingId, UNBOUNDED_BUDGET);
  else await projectRefundIncidentForBooking(context, tally, bookingId, UNBOUNDED_BUDGET);
  const incident = await context.repo.getIncidentBySource(sourceType, sourceKey);
  return !incident || incident.status !== 'open' ? 'resolved' : 'still_open';
}

// Oversell markers are permanent (never retried) and always
// action_required the first time they're observed unreported — listUnreportedOversellMarkers
// already excludes markers with an existing incident row, so this is always a fresh 'open'.
async function reportUnreportedOversellMarkers(context: ReservaContext, tally: IncidentTally, limit: number, budget: QueryBudget): Promise<void> {
  if (!budget.fits(1)) return;
  const markers = await context.repo.listUnreportedOversellMarkers(limit);
  const now = nowIso(context);
  for (const marker of markers) {
    if (!budget.fits(1)) return;
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
    context.logger.info?.('reserva reconciliation incident projected', {
      incidentId, sourceType: 'oversell', action: 'oversell', severity: 'action_required', lifecycle: 'open', escalated: false,
    });
  }
}

async function processSideEffectCandidate(
  context: ReservaContext,
  operation: SideEffectOperationRecord,
): Promise<void> {
  const booking = await context.repo.getBookingById(operation.bookingId);
  if (!booking) return;
  try {
    await runScheduledSideEffectOperation(context, booking, operation);
  } catch (error) {
    context.logger.warn?.('reserva reconciliation side effect attempt failed', {
      bookingId: operation.bookingId, operation: sideEffectOperationKey(operation), error: String(error),
    });
  }
}

// The same cancellation CAS used by HTTP recovery is resumed before an execution claim. A crash
// after claimRefundOperation therefore cannot strand a confirmed booking, and Stripe remains
// unreachable until the returned booking is durably cancelled.
async function processRefundCandidate(context: ReservaContext, bookingId: string, budget: QueryBudget): Promise<boolean> {
  if (!budget.fits(REFUND_LOAD_QUERIES)) return false;
  const [initialBooking, operation] = await Promise.all([
    context.repo.getBookingById(bookingId),
    context.repo.getRefundOperationByBookingId(bookingId),
  ]);
  if (!initialBooking || !operation || operation.status === 'succeeded' || operation.status === 'abandoned') return true;

  let booking = initialBooking;
  if (booking.status !== 'cancelled') {
    if (operation.status !== 'requested' || booking.status !== 'confirmed') return true;
    const outboxRows = cancellationSideEffectSeeds(context, booking, 'booking.cancelled_by_operator', nowIso(context)).length;
    if (!budget.fits(REFUND_CANCELLATION_QUERIES + outboxRows * OUTBOX_ROW_QUERIES + REFUND_ATTEMPT_QUERIES)) return false;
    const cancellation = await resumeClaimedOperatorCancellation(context, booking, operation.id);
    if (cancellation.kind !== 'cancelled') return true;
    booking = cancellation.booking;
  } else if (!budget.fits(REFUND_ATTEMPT_QUERIES)) {
    return false;
  }

  const now = nowIso(context);
  const attemptNumber = await context.repo.claimRefundExecution(operation.id, now);
  if (attemptNumber === null) return true;
  try {
    await attemptRefund(context, booking, {
      operationId: operation.id,
      choice: operation.choice,
      requestedAmountCents: operation.requestedAmountCents,
      paymentRef: operation.paymentIntent,
    }, { attemptNumber });
  } catch (error) {
    context.logger.warn?.('reserva reconciliation refund attempt failed', { bookingId, error: String(error) });
  }
  return true;
}

// Arms the reminder email for every confirmed booking that just entered the reminder window.
// Bounded by the same `sourceLimit` as the other sweeps; a backlog drains over consecutive runs.
// The row is the record — a second sweep finds nothing because the row already exists.
async function sweepReminders(context: ReservaContext, now: string, limit: number, budget: QueryBudget): Promise<number> {
  const reminderHours = context.config.booking.reminderHoursBefore;
  if (reminderHours <= 0 || !budget.fits(1)) return 0;
  const until = new Date(Date.parse(now) + reminderHours * 3_600_000).toISOString();
  const candidates = await context.repo.listReminderCandidates(now, until, reminderHours, limit);
  let armed = 0;
  for (const booking of candidates) {
    const seeds = reminderSideEffectSeeds(context, booking, now);
    // No email provider and no durable subscriber: nothing to deliver, so nothing to record.
    if (seeds.length === 0) continue;
    // Recording the rows (one statement each) and listing them back, then a claim and a resolve per row.
    if (!budget.fits(seeds.length + 1 + seeds.length * OUTBOX_ROW_QUERIES)) break;
    await context.repo.recordBookingEventOperations(booking.id, seeds, now);
    armed += 1;
    // Same outbox drain every other mutation uses: retries, abandonment and incidents come free.
    await runOwedMutationSideEffects(context, booking);
    dispatchNonDurableBookingEvent(context, 'booking.reminder', booking, now);
  }
  return armed;
}

async function projectIncidents(
  context: ReservaContext,
  sideEffectBookingIds: Iterable<string>,
  refundBookingIds: Iterable<string>,
  limit: number,
  budget: QueryBudget,
): Promise<IncidentTally> {
  const tally: IncidentTally = { opened: 0, updated: 0, resolved: 0 };
  for (const bookingId of sideEffectBookingIds) await projectSideEffectIncidentsForBooking(context, tally, bookingId, budget);
  for (const bookingId of refundBookingIds) await projectRefundIncidentForBooking(context, tally, bookingId, budget);
  await reportUnreportedOversellMarkers(context, tally, limit, budget);
  return tally;
}

function adminUrlForIncident(context: ReservaContext, incidentId: string): string {
  const adminPage = context.routeConfig.paths.adminPage;
  return new URL(`${adminPage}?view=incidents#incident-${incidentId}`, context.config.business.url).toString();
}

// Alert delivery has its own claim/attempt/backoff. Only open incidents are eligible: a revision
// that auto-resolves before delivery is obsolete, while a later reopen increments alert_revision
// and becomes independently deliverable.
async function drainAlerts(context: ReservaContext, limit: number, budget: QueryBudget): Promise<{ sent: number; failed: number }> {
  const sink = context.providers.alerts;
  budget.releaseAlertReserve();
  if (!budget.fits(1)) return { sent: 0, failed: 0 };
  const ids = await context.repo.listAlertCandidateIds(nowIso(context), limit);
  if (!sink && ids.length > 0) {
    context.logger.error?.('reserva reconciliation alert sink missing', {
      lifecycle: 'configuration_error', pendingAlerts: ids.length,
    });
    return { sent: 0, failed: ids.length };
  }
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    if (!budget.fits(ALERT_STEP_QUERIES)) break;
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
      context.logger.info?.('reserva reconciliation alert delivery started', {
        incidentId: claimed.id, alertRevision: claimed.alertRevision, lifecycle: 'started',
      });
      await sink.send(alert, context.config);
      await context.repo.resolveIncidentAlertSuccess(id, token, claimed.alertRevision);
      sent += 1;
      context.logger.info?.('reserva reconciliation alert delivered', {
        incidentId: claimed.id, alertRevision: claimed.alertRevision, lifecycle: 'succeeded',
      });
    } catch (error) {
      const outcome = classifyAttemptOutcome(claimed.alertAttemptCount, error);
      const message = outcome.error;
      const nextAttemptAt = computeNextAttemptAt(new Date(now), claimed.alertAttemptCount);
      await context.repo.resolveIncidentAlertFailure(id, token, message, nextAttemptAt);
      failed += 1;
      context.logger.warn?.('reserva reconciliation alert delivery failed', {
        incidentId: claimed.id, alertRevision: claimed.alertRevision,
        lifecycle: 'failed', nextAttemptAt, error: message,
      });
    }
  }
  return { sent, failed };
}

async function referenceForBooking(context: ReservaContext, bookingId: string | null): Promise<string> {
  // A deployment-wide incident has no booking; the alert still needs something to name it by.
  if (bookingId === null) return 'deployment';
  const booking: Booking | null = await context.repo.getBookingById(bookingId);
  return booking?.reference ?? bookingId;
}

// The one entry point a scheduled event (or a manual admin-triggered sweep) calls. Bounded and
// resumable — a partial run is safe; the next invocation picks up remaining debt via the same candidate queries.
export async function runReconciliation(context: ReservaContext, options: ReconciliationOptions = {}): Promise<ReconciliationSummary> {
  const sourceLimit = clampLimit(options.sourceLimit, DEFAULT_SOURCE_LIMIT, HARD_SOURCE_LIMIT);
  const alertLimit = clampLimit(options.alertLimit, DEFAULT_ALERT_LIMIT, HARD_ALERT_LIMIT);
  if (options.requireAlertSink && !context.providers.alerts) {
    context.logger.error?.('reserva reconciliation alert sink missing', { lifecycle: 'configuration_error' });
    throw new Error('Reserva reconciliation requires an operational alert sink');
  }

  const startedAt = nowIso(context);
  const staleBefore = new Date(Date.parse(startedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
  const failureDueBefore = new Date(Date.parse(startedAt) - INCIDENT_DELAY_THRESHOLD_MS).toISOString();
  context.logger.info?.('reserva reconciliation started', {
    lifecycle: 'started', sourceLimit, alertLimit,
  });

  const queryLimit = options.queryBudget ?? DEFAULT_RECONCILIATION_QUERY_BUDGET;
  const budget = queryBudget(context, queryLimit);
  const expiredHoldsSwept = budget.fits(1) ? await context.repo.sweepExpiredHolds(startedAt) : 0;
  await sweepReminders(context, startedAt, sourceLimit, budget);

  const incidentTally: IncidentTally = { opened: 0, updated: 0, resolved: 0 };
  const sideEffectBookingIds = new Set<string>();
  // A row whose provider is not configured stays 'pending' and comes back in the next page
  // unchanged. Remembering what this run already touched is what stops the loop from re-reading
  // the same page forever when nothing it does can change it.
  const seenSideEffects = new Set<string>();
  const seenRefunds = new Set<string>();
  let refundBookingsProcessed = 0;
  let batches = 0;
  // One page of candidates was never a decision about how much debt exists, only about how much
  // one query returns. Keep pulling pages until a short one says the backlog is drained, or the
  // wall clock or the query budget says this invocation has had its share — the next tick resumes
  // where this stopped.
  const deadline = Date.parse(startedAt) + RECONCILIATION_MAX_WALL_CLOCK_MS;
  for (;;) {
    batches += 1;
    const batchStartedAt = nowIso(context);
    const sideEffectCandidates = budget.fits(1)
      ? await context.repo.listSideEffectExecutionCandidates(batchStartedAt, staleBefore, sourceLimit)
      : [];
    const sideEffectsRun: SideEffectOperationRecord[] = [];
    for (const operation of sideEffectCandidates) {
      if (!budget.fits(SIDE_EFFECT_STEP_QUERIES)) break;
      await processSideEffectCandidate(context, operation);
      sideEffectsRun.push(operation);
    }

    const refundCandidates = budget.fits(1)
      ? await context.repo.listRefundExecutionCandidateBookingIds(batchStartedAt, staleBefore, sourceLimit)
      : [];
    const refundsRun: string[] = [];
    for (const bookingId of refundCandidates) {
      if (!await processRefundCandidate(context, bookingId, budget)) break;
      refundsRun.push(bookingId);
    }
    refundBookingsProcessed += refundsRun.length;

    const [sideEffectIncidentIds, refundIncidentIds, reprojectionCandidates] = budget.fits(3)
      ? await Promise.all([
        context.repo.listSideEffectIncidentCandidateBookingIds(failureDueBefore, sourceLimit),
        context.repo.listRefundIncidentCandidateBookingIds(sourceLimit),
        context.repo.listIncidentReprojectionCandidates(sourceLimit),
      ])
      : [[], [], []];
    const sideEffectProjectionIds = new Set(sideEffectsRun.map((operation) => operation.bookingId));
    const refundProjectionIds = new Set(refundsRun);
    for (const bookingId of sideEffectIncidentIds) sideEffectProjectionIds.add(bookingId);
    for (const bookingId of refundIncidentIds) refundProjectionIds.add(bookingId);
    for (const incident of reprojectionCandidates) {
      // A deployment-wide incident (reconciliation) has no booking to reproject against.
      if (incident.bookingId === null) continue;
      if (incident.sourceType === 'side_effect') sideEffectProjectionIds.add(incident.bookingId);
      else if (incident.sourceType === 'refund') refundProjectionIds.add(incident.bookingId);
    }

    const batchTally = await projectIncidents(context, sideEffectProjectionIds, refundProjectionIds, sourceLimit, budget);
    incidentTally.opened += batchTally.opened;
    incidentTally.updated += batchTally.updated;
    incidentTally.resolved += batchTally.resolved;
    for (const operation of sideEffectsRun) sideEffectBookingIds.add(operation.bookingId);

    const progressed = sideEffectsRun.some((operation) => !seenSideEffects.has(`${operation.bookingId}:${sideEffectOperationKey(operation)}`))
      || refundsRun.some((bookingId) => !seenRefunds.has(bookingId));
    for (const operation of sideEffectsRun) seenSideEffects.add(`${operation.bookingId}:${sideEffectOperationKey(operation)}`);
    for (const bookingId of refundsRun) seenRefunds.add(bookingId);

    const full = sideEffectCandidates.length >= sourceLimit || refundCandidates.length >= sourceLimit;
    if (budget.exhausted || !full || !progressed || context.clock().getTime() >= deadline) break;
  }

  const alertResult = await drainAlerts(context, alertLimit, budget);
  if (budget.exhausted) {
    context.logger.info?.('reserva reconciliation query budget reached', {
      lifecycle: 'budget_reached', queryBudget: queryLimit, queriesIssued: context.d1QueriesIssued?.(),
    });
  }
  const summary: ReconciliationSummary = {
    expiredHoldsSwept,
    sideEffectBookingsProcessed: sideEffectBookingIds.size,
    refundBookingsProcessed,
    incidentsOpened: incidentTally.opened,
    incidentsUpdated: incidentTally.updated,
    incidentsResolved: incidentTally.resolved,
    alertsSent: alertResult.sent,
    alertsFailed: alertResult.failed,
    batches,
  };
  context.logger.info?.('reserva reconciliation completed', { lifecycle: 'completed', ...summary });
  return summary;
}


// Both reconciliation entry points — the cron `scheduled` event and POST /api/booking/ops/reconcile
// — go through here, so two sweeps can never claim the same side-effect and refund rows. `busy` is
// the honest answer for the loser: the work is being done, just not by this caller.
export type LeasedReconciliationResult =
  | { kind: 'ran'; summary: ReconciliationSummary }
  | { kind: 'busy' };

export async function runReconciliationWithLease(
  context: ReservaContext,
  options: ReconciliationOptions = {},
): Promise<LeasedReconciliationResult> {
  const now = nowIso(context);
  const token = crypto.randomUUID();
  const leaseUntil = new Date(Date.parse(now) + RECONCILIATION_LEASE_MS).toISOString();
  const acquired = await context.repo.acquireReconciliationLease(token, now, leaseUntil);
  if (!acquired) return { kind: 'busy' };
  try {
    const summary = await runReconciliation(context, options);
    await context.repo.releaseReconciliationLease(token, {
      lastRunAt: nowIso(context),
      lastSummary: JSON.stringify(summary),
    });
    return { kind: 'ran', summary };
  } catch (error) {
    // Release without a completion: a failed sweep must not advertise itself as the last
    // successful run, or ops health would stop reporting the staleness the failure caused.
    await context.repo.releaseReconciliationLease(token, null);
    throw error;
  }
}

// The `scheduled()` body every cron Worker would otherwise hand-copy. The synthetic request exists
// only because `createContext` is request-shaped; nothing reads its URL. Failures rethrow so the
// platform records a failed cron invocation, which is the detection path independent of the alert sink.
// The cron never passes through createRouteContext, so it applies the same two overlays itself:
// stored admin settings, and the build's route paths so cron-sent links carry the routePrefix.
export function scheduledHandler(
  runtime: { createContext(input: { request: Request }): ReservaContext | Promise<ReservaContext> },
  options: ReconciliationOptions = { requireAlertSink: true },
): (controller: ScheduledController, env: unknown, ctx: ExecutionContext) => Promise<void> {
  return async () => {
    try {
      const base = await runtime.createContext({ request: new Request('https://reserva-scheduled.invalid/') });
      const context: ReservaContext = { ...(await withStoredSettings(base)), routeConfig: virtualConfig.routes };
      const result = await runReconciliationWithLease(context, options);
      if (result.kind === 'busy') {
        // Not a failure: a manual trigger or an overrunning previous tick is already sweeping, and
        // throwing here would record a failed cron invocation for work that is being done.
        context.logger.warn?.('reserva scheduled reconciliation skipped', { lifecycle: 'skipped', reason: 'lease_held' });
        return;
      }
      context.logger.info?.('reserva scheduled reconciliation summary', { ...result.summary });
    } catch (error) {
      console.error('reserva scheduled reconciliation failed', { lifecycle: 'failed', error: String(error) });
      throw error;
    }
  };
}
