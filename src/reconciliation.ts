// Plan 020 (design decisions 1-6, 9-11): the scheduled reconciler — a Cron Trigger (every five
// minutes, wired by the consumer's own custom Worker entrypoint, step 7) calls runReconciliation
// once per invocation. D1 remains authoritative (decision 2): this module re-drains bookings
// through the SAME per-row claim/execute paths an HTTP request already uses
// (confirmBookingFromPayment/runOwedMutationSideEffects/attemptRefund) rather than duplicating any
// claim or Stripe-call logic, then projects/persists incident state and drains pending alerts.
//
// Deviation from decision 5's literal "all ordinary HTTP and scheduled claim predicates honor
// next_attempt_at" for SIDE-EFFECT operations specifically (recorded here since it's easy to miss):
// confirmBookingFromPayment/runOwedMutationSideEffects are the exact same functions an HTTP request
// already calls opportunistically on every request that touches a booking, and several pinned
// tests (tests/confirmation-outbox.test.ts, tests/handlers-customer-actions.test.ts,
// tests/handlers-webhook-redelivery.test.ts, tests/confirmation-tourflow-outbox.test.ts, and
// friends) require an immediate same-tick HTTP-driven retry to recover a failed row. Because both
// callers claim through the identical claimSideEffectOperation/claimMutationSideEffectOperation
// methods, src/confirmation.ts's three resolve call sites deliberately never write next_attempt_at
// on that shared column — a real backoff window there would block the legitimate HTTP retry exactly
// as long as it blocks this reconciler.
//
// That does NOT mean side-effect operations get no backoff at all: without one, this reconciler's
// flat five-minute cron cadence burns SIDE_EFFECT_MAX_ATTEMPTS (10) attempts in ~45 minutes, far
// short of the outage-survival runway design decision 5's 5/10/20/40/60 schedule intends (~4.7
// hours). Since the schedule can't live on the shared next_attempt_at column, this module computes
// it at scan time instead, scoped to the scheduled path only: isDueForScheduledRetry below derives
// the same schedule from a row's own attempt_count/attempted_at (computeNextAttemptAt), and
// processSideEffectCandidate only calls each drain entry point when it has at least one row
// actually due — HTTP callers never consult this function, so their immediate retry is untouched.
// (failure_started_at, the ten-minute delayed-incident threshold's input, was already a correct
// uninterrupted-failure timestamp independent of this — src/repo.ts's resolveSideEffectOperation
// COALESCEs it across repeated failures and only clears it on success, regardless of whether
// next_attempt_at is supplied — so no separate fix was needed there.)
//
// Refund operations don't have this conflict at all: the HTTP path (src/refund-executor.ts's
// attemptRefund with no claim) and this reconciler (attemptRefund WITH a claimRefundExecution
// claim) are structurally separate call sites, so refund backoff is real on the shared column and
// gates only the scheduled path.
import {
  classifyAttemptOutcome,
  confirmBookingFromPayment,
  isActionableSideEffectStatus,
  isConfirmationSideEffectOperation,
  runOwedMutationSideEffects,
} from './confirmation';
import type { Booking } from './core/booking';
import type { OperationalAlert } from './core/events';
import type { BookkitContext } from './context';
import { nowIso } from './context';
import { attemptRefund } from './refund-executor';
import {
  actionForSideEffectKind,
  buildOperationalAlert,
  computeNextAttemptAt,
  isDelayIncidentDue,
  isMutationEmailOrTourflowKind,
  projectIncident,
  type ExistingIncidentSignal,
  type IncidentProjection,
  type IncidentSourceSignal,
} from './reconciliation-helpers';
import {
  CONFIRMATION_TOURFLOW_KIND,
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
    await context.repo.upsertOpenIncident({
      id: existing?.id ?? crypto.randomUUID(),
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
  } else if (projection.action === 'resolve-automatic') {
    await context.repo.resolveIncidentAutomatic(sourceType, sourceKey, now);
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
function refundSignal(operation: RefundOperationRecord): IncidentSourceSignal {
  const detected = operation.status === 'failed' || operation.status === 'abandoned';
  return { detected, severity: 'action_required', action: 'refund', attemptCount: operation.attemptCount, sourceUpdatedAt: operation.resolvedAt ?? operation.requestedAt };
}

async function projectRefundIncidentForBooking(context: BookkitContext, tally: IncidentTally, bookingId: string): Promise<void> {
  const operation = await context.repo.getRefundOperationByBookingId(bookingId);
  if (!operation) return;
  const signal = refundSignal(operation);
  await applyIncidentProjection(context, tally, bookingId, 'refund', bookingId, 'refund', signal);
}

// Plan 020 (design decision 9/13): once a booking's *only* actionable row is fixed (by any path —
// an admin "Try again", or an ordinary HTTP-driven opportunistic retry), it drops out of
// listSideEffectCandidateBookingIds/listRefundCandidateBookingIds' WHERE clauses (there is nothing
// left for a scheduled drain to do), so the next reconciliation pass would never look at that
// booking again and its now-stale open incident would never auto-resolve. An ordinary reconciler
// pass never hits this: it gathers candidate ids once, drains them, and reprojects incidents
// against that SAME pre-drain id list — a row that fails then succeeds within one pass is still
// reprojected. An admin retry (src/handlers/index.ts's `incident-retry` action) happens entirely
// outside any reconciliation pass, so it must reproject its own incident directly rather than
// waiting for a scan that will never include this booking again. Exported for that one caller;
// every other reconciliation caller still goes through the normal candidate-list pass above.
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
    await context.repo.upsertOpenIncident({
      id: crypto.randomUUID(),
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
  }
}

// Plan 020 (design decision 5), scheduled-side only — see this file's header comment. A row is due
// for an ORDINARY scheduled retry when it has never failed (pending/in_flight: the claim itself
// gates a live in_flight lease) or its 5/10/20/40/60-minute backoff window — computed from the
// row's own last attempt, not a stored column — has elapsed. A terminal row (succeeded/abandoned)
// is never due; abandoned rows still get their one incident-projection pass via the candidate list,
// just not a re-attempt here.
function isDueForScheduledRetry(operation: SideEffectOperationRecord, nowIsoValue: string): boolean {
  if (!isActionableSideEffectStatus(operation.status)) return false;
  if (operation.status !== 'failed') return true;
  if (!operation.attemptedAt) return true; // defensive: no timestamp to compute a window from
  return computeNextAttemptAt(new Date(operation.attemptedAt), operation.attemptCount) <= nowIsoValue;
}

// Re-drains one candidate booking's owed confirmation/mutation side effects through the exact same
// paths an HTTP request already uses (src/confirmation.ts) — no new claim logic here, only a
// booking-level "is anything in this bucket actually due yet" gate in front of each entry point
// (see isDueForScheduledRetry above). A booking that no longer exists (should not happen; ids come
// from a live FK-backed table) is skipped. Each of the three kind-buckets below is checked against
// the SAME already-fetched operations list, matching confirmBookingFromPayment/
// runOwedMutationSideEffects/runConfirmationTourflowSideEffect's own row-kind partition — a due row
// in one bucket does not force-drain another still-backed-off bucket's rows for this booking, since
// each bucket has its own gated entry point.
async function processSideEffectCandidate(context: BookkitContext, bookingId: string): Promise<void> {
  const booking = await context.repo.getBookingById(bookingId);
  if (!booking) return;
  const now = nowIso(context);
  const operations = await context.repo.listSideEffectOperations(bookingId);

  const confirmationDue = operations.some((operation) => isConfirmationSideEffectOperation(operation) && isDueForScheduledRetry(operation, now));
  if (booking.status === 'confirmed' && confirmationDue) {
    try {
      await confirmBookingFromPayment(context, booking);
    } catch (error) {
      context.logger.warn?.('bookkit reconciliation: confirmation drain failed', { bookingId, error: String(error) });
    }
  }

  // runOwedMutationSideEffects bundles the mutation-kind loop and the confirmation-path Tourflow
  // row (CONFIRMATION_TOURFLOW_KIND, claimed via claimMutationSideEffectOperation but resolved
  // through resolveConfirmationTourflowOperation — see src/confirmation.ts) into one call; either
  // bucket having a due row is enough to invoke it.
  const mutationDue = operations.some((operation) => operation.kind !== CONFIRMATION_TOURFLOW_KIND && isMutationEmailOrTourflowKind(operation.kind) && isDueForScheduledRetry(operation, now));
  const tourflowConfirmationDue = operations.some((operation) => operation.kind === CONFIRMATION_TOURFLOW_KIND && isDueForScheduledRetry(operation, now));
  if (mutationDue || tourflowConfirmationDue) {
    try {
      await runOwedMutationSideEffects(context, booking);
    } catch (error) {
      context.logger.warn?.('bookkit reconciliation: mutation drain failed', { bookingId, error: String(error) });
    }
  }
}

// Plan 020 (design decision 7): claims this booking's refund execution slot before ever calling
// Stripe, and — mirroring "a claimed cancellation left before its booking CAS is resumed through
// the same existing cancellation gate; Stripe is never called while the booking is still
// non-cancelled" — only proceeds once the booking is durably cancelled. A non-cancelled booking
// with a claimed-but-unresolved refund operation is left for the operator's own retry (which
// re-enters the CAS gate directly), not redriven here.
async function processRefundCandidate(context: BookkitContext, bookingId: string): Promise<void> {
  const [booking, operation] = await Promise.all([
    context.repo.getBookingById(bookingId),
    context.repo.getRefundOperationByBookingId(bookingId),
  ]);
  if (!booking || !operation || booking.status !== 'cancelled') return;
  if (operation.status === 'succeeded' || operation.status === 'abandoned') return;
  const now = nowIso(context);
  const attemptNumber = await context.repo.claimRefundExecution(operation.id, now);
  if (attemptNumber === null) return;
  try {
    await attemptRefund(context, booking, operation.id, operation.choice, operation.paymentIntent, { attemptNumber });
  } catch (error) {
    context.logger.warn?.('bookkit reconciliation: refund attempt failed', { bookingId, error: String(error) });
  }
}

async function projectIncidents(context: BookkitContext, sideEffectBookingIds: string[], refundBookingIds: string[], limit: number): Promise<IncidentTally> {
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

// Plan 020 (design decision 11): alert delivery's own claim/attempt/backoff, independent of the
// incident's own open/resolved state — an incident that resolved after being alerted still needed
// (and keeps) its delivered alertedRevision; one that reopens gets a fresh, undelivered revision.
async function drainAlerts(context: BookkitContext, limit: number): Promise<{ sent: number; failed: number }> {
  const sink = context.providers.alerts;
  const ids = await context.repo.listAlertCandidateIds(limit);
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    const now = nowIso(context);
    const token = crypto.randomUUID();
    const leaseUntil = new Date(Date.parse(now) + ALERT_CLAIM_LEASE_MS).toISOString();
    const claimed = await context.repo.claimIncidentAlert(id, token, now, leaseUntil);
    if (!claimed) continue;
    if (!sink) {
      // No alert sink configured — there is no technical operator to notify, so mark this
      // revision delivered rather than retrying forever against a provider that doesn't exist.
      await context.repo.resolveIncidentAlertSuccess(id, token, claimed.alertRevision);
      continue;
    }
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
      await sink.send(alert);
      await context.repo.resolveIncidentAlertSuccess(id, token, claimed.alertRevision);
      sent += 1;
    } catch (error) {
      const outcome = classifyAttemptOutcome(claimed.alertAttemptCount, error);
      const message = outcome.error;
      const nextAttemptAt = computeNextAttemptAt(new Date(now), claimed.alertAttemptCount);
      await context.repo.resolveIncidentAlertFailure(id, token, message, nextAttemptAt);
      failed += 1;
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

  const expiredHoldsSwept = await context.repo.sweepExpiredHolds(nowIso(context));

  const sideEffectBookingIds = await context.repo.listSideEffectCandidateBookingIds(sourceLimit);
  for (const bookingId of sideEffectBookingIds) await processSideEffectCandidate(context, bookingId);

  const refundBookingIds = await context.repo.listRefundCandidateBookingIds(sourceLimit);
  for (const bookingId of refundBookingIds) await processRefundCandidate(context, bookingId);

  const incidentTally = await projectIncidents(context, sideEffectBookingIds, refundBookingIds, sourceLimit);
  const alertResult = await drainAlerts(context, alertLimit);

  return {
    expiredHoldsSwept,
    sideEffectBookingsProcessed: sideEffectBookingIds.length,
    refundBookingsProcessed: refundBookingIds.length,
    incidentsOpened: incidentTally.opened,
    incidentsUpdated: incidentTally.updated,
    incidentsResolved: incidentTally.resolved,
    alertsSent: alertResult.sent,
    alertsFailed: alertResult.failed,
  };
}
