// Plan 020: pure functions shared by the reconciliation engine (src/reconciliation.ts), the
// confirmation/mutation drains (src/confirmation.ts), and the shared refund executor
// (src/refund-executor.ts). Kept dependency-free (no D1, no context) so every boundary/threshold
// here is unit-testable without a fake repository or real workerd.
import type { OperationalAlert } from './core/events';
import type {
  OperationalIncidentAction,
  OperationalIncidentResolutionKind,
  OperationalIncidentSeverity,
  OperationalIncidentStatus,
  SideEffectOperationIdentity,
} from './repo';

// Plan 020 (design decision 5): "Cron runs every five minutes, but retryable failures set
// next_attempt_at using 5, 10, 20, 40, then 60 minutes capped at 60 for later attempts." Indexed by
// (attemptNumber - 1); attempts past the schedule's length reuse the last (60-minute) value.
export const RETRY_BACKOFF_MINUTES = [5, 10, 20, 40, 60] as const;

// attemptNumber is 1-based (the claim that just ran incremented attempt_count to this value — see
// src/confirmation.ts's classifyAttemptOutcome for the same convention). Returns the ISO instant a
// 'failed' row next becomes eligible for an ordinary (non-admin-retry) claim.
export function computeNextAttemptAt(now: Date, attemptNumber: number): string {
  const index = Math.min(Math.max(attemptNumber, 1) - 1, RETRY_BACKOFF_MINUTES.length - 1);
  const minutes = RETRY_BACKOFF_MINUTES[index] ?? RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length - 1] ?? 60;
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

// Plan 020 (design decision 6): "retryable delivery failures open an incident when their
// uninterrupted failure_started_at is at least ten minutes old, while retries continue."
export const INCIDENT_DELAY_THRESHOLD_MS = 10 * 60_000;

export function isDelayIncidentDue(failureStartedAtIso: string, nowIso: string): boolean {
  return Date.parse(nowIso) - Date.parse(failureStartedAtIso) >= INCIDENT_DELAY_THRESHOLD_MS;
}

// A row is eligible for an ORDINARY (non-admin-retry) automatic claim exactly when it has never
// failed (next_attempt_at NULL — "the first pending execution is immediate", decision 5) or its
// backoff window has elapsed. Admin retry claims bypass this entirely (decision 5) via a distinct,
// separately-gated repository claim method — this helper is never consulted for that path.
export function isEligibleForAutomaticClaim(nextAttemptAtIso: string | null, nowIso: string): boolean {
  return nextAttemptAtIso === null || nextAttemptAtIso <= nowIso;
}

// Plan 020 (design decision 8): maps a side-effect outbox row onto the owner-facing action bucket
// an incident/alert reports. Plan 021: read off the identity COLUMNS, never a parsed kind string.
// 'oversell' rows are scanned separately (they're markers, not retryable debt — see
// src/reconciliation.ts) but still classify here for completeness.
export function actionForSideEffectOperation(operation: SideEffectOperationIdentity): OperationalIncidentAction {
  switch (operation.family) {
    case 'oversell': return 'oversell';
    case 'calendar_create':
    case 'calendar_delete': return 'calendar';
    case 'email_confirmation': return 'confirmation_email';
    case 'hook':
    case 'webhook': return 'operations_sync';
    case 'email': return operation.event === 'booking.confirmed' ? 'confirmation_email' : 'customer_notification';
  }
}

// Plan 020 (design decision 12): the owner-facing card title. Never the internal word "abandoned".
export function ownerFacingIncidentTitle(action: OperationalIncidentAction): string {
  switch (action) {
    case 'confirmation_email': return 'Confirmation email not delivered';
    case 'customer_notification': return 'Customer notification not delivered';
    case 'calendar': return 'Calendar booking not created';
    case 'operations_sync': return 'Operations sync not delivered';
    case 'refund': return 'Refund needs attention';
    case 'oversell': return 'Booking may exceed capacity';
  }
}

// The current state of a debt source (a side-effect kind, a refund operation, or an oversell
// marker), as observed by one reconciliation pass — the input to the pure incident-projection
// decision below. `detected: false` means the source currently has no open debt (succeeded, or a
// retryable failure not yet past the ten-minute threshold).
export interface IncidentSourceSignal {
  detected: boolean;
  severity: OperationalIncidentSeverity;
  action: OperationalIncidentAction;
  attemptCount: number;
  // A fingerprint of the underlying source's current state — changes only when the source itself
  // materially changes (e.g. a fresh failed attempt, a reopened refund). Used to decide whether a
  // manually resolved incident should stay resolved (decision 9).
  sourceUpdatedAt: string;
}

export interface ExistingIncidentSignal {
  status: OperationalIncidentStatus;
  severity: OperationalIncidentSeverity;
  sourceUpdatedAt: string;
  resolutionKind: OperationalIncidentResolutionKind | null;
}

export type IncidentProjection =
  // Insert a brand-new row, or reopen a previously (auto- or source-changed-manually) resolved one.
  | { action: 'open'; escalate: boolean }
  // Row stays open; bump last_detected_at/attempt_count, and escalate the alert revision if
  // severity worsened delayed -> action_required (decision 9).
  | { action: 'update'; escalate: boolean }
  // A manually resolved incident whose source fingerprint hasn't changed — decision 9: "stays
  // resolved while the source fingerprint is unchanged."
  | { action: 'skip' }
  // The source cleared (succeeded) while an incident was open — decision 6/9: automatic resolution.
  | { action: 'resolve-automatic' };

// Plan 020 (design decision 9): "repeated scans update one incident. Escalation from delayed to
// final increments its alert revision... A manually resolved incident stays resolved while the
// source fingerprint is unchanged; a new source transition can reopen it. Automatic source success
// resolves it." Pure decision function — the caller (src/reconciliation.ts) performs the actual
// upsert/resolve against the repository.
export function projectIncident(signal: IncidentSourceSignal, existing: ExistingIncidentSignal | null): IncidentProjection {
  if (!signal.detected) {
    if (existing && existing.status === 'open') return { action: 'resolve-automatic' };
    return { action: 'skip' };
  }
  if (!existing) return { action: 'open', escalate: false };
  if (existing.status === 'resolved') {
    if (existing.resolutionKind === 'manual' && existing.sourceUpdatedAt === signal.sourceUpdatedAt) return { action: 'skip' };
    return { action: 'open', escalate: false };
  }
  const escalate = existing.severity === 'delayed' && signal.severity === 'action_required';
  return { action: 'update', escalate };
}

// Plan 020 (design decision 10): the alert payload is exactly these seven fields — built through
// this one function (never an object spread) so a future caller can't accidentally widen it with a
// PII-bearing field.
export function buildOperationalAlert(input: {
  incidentId: string;
  reference: string;
  action: OperationalIncidentAction;
  severity: OperationalIncidentSeverity;
  attemptCount: number;
  firstDetectedAt: string;
  adminUrl: string;
}): OperationalAlert {
  return {
    incidentId: input.incidentId,
    reference: input.reference,
    action: input.action,
    severity: input.severity,
    attemptCount: input.attemptCount,
    firstDetectedAt: input.firstDetectedAt,
    adminUrl: input.adminUrl,
  };
}
