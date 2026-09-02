import type { D1Database, D1Result } from '@cloudflare/workers-types';
import type { ApiErrorCode } from './core/api.js';
import type { Booking, BookingStatus, CancellationActor } from './core/booking.js';
import type { PickupType } from './core/config.js';
import type { EmailRecipientRole } from './core/events.js';
import { sha256Base64Url } from './http.js';
import type { CapacityDefault, DayCapacityOverride } from './core/occupancy.js';

export interface BookingInsert {
  id: string;
  reference: string;
  serviceSlug: string;
  quantity: number;
  pickupType: PickupType | null;
  startsAt: string;
  endsAt: string;
  locale: string;
  priceMinor: number;
  // Captured on the row so a later config change can't re-denominate money already taken.
  currency: string;
  holdExpiresAt: string;
  cancelToken: string;
  operatorToken: string;
  tokensExpireAt?: string | null;
  holdIp?: string | null;
  maxActiveHoldsForIp?: number;
  meetingPointId?: string | null;
  meetingPointLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// One section save = one atomic D1 batch: a mid-save failure never leaves a mixed revision.
export type SettingsBatchOperation =
  | { type: 'upsert'; key: string; value: string }
  | { type: 'delete'; key: string };

// Recorded atomically in the same D1 batch as the change itself, never a separate write.
// actor is null when the auth port exposes no identity (e.g. an anonymous verifier).
export interface AdminChangeAudit {
  actor: string | null;
  changedAt: string;
}

export type AdminChangeDomain = 'setting' | 'day_override' | 'capacity_default';
export type AdminChangeAction = 'upsert' | 'delete';

export interface AdminChangeHistoryEntry {
  id: number;
  domain: AdminChangeDomain;
  itemKey: string;
  action: AdminChangeAction;
  value: string | null;
  actor: string | null;
  changedAt: string;
}

export class HoldLimitExceededError extends Error {
  constructor() {
    super('Too many active holds from this IP');
    this.name = 'HoldLimitExceededError';
  }
}

// errorResponse turns any Error & {status, code} into a JSON response, so no handler-level
// catch is needed to translate this into a 409.
export class DuplicatePaymentRefError extends Error {
  readonly status = 409;
  // Typed against the closed catalog since errorResponse turns this into the API envelope verbatim.
  readonly code: ApiErrorCode = 'duplicate_payment_ref';
  constructor(paymentRef: string) {
    super(`payment_ref ${paymentRef} already confirmed a different booking`);
    this.name = 'DuplicatePaymentRefError';
  }
}

// DB CHECK constraints only guard rows written after they existed; an old row, or a write that
// bypasses this repo, could still violate them. mapBooking throws here instead of handing a
// corrupt row downstream, so bad data surfaces at the one place every row becomes a Booking.
export class InvalidBookingRowError extends Error {
  constructor(bookingId: string, reason: string) {
    super(`booking ${bookingId} violates a domain invariant: ${reason}`);
    this.name = 'InvalidBookingRowError';
  }
}

// SQLite's UNIQUE-violation message is identical for a partial or plain index, so no need to
// special-case the partial WHERE clause here.
function isPaymentRefUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed:.*\bpayment_ref\b/i.test(error.message);
}

// Reclassifies a payment_ref UNIQUE violation into DuplicatePaymentRefError; every other error
// (a different constraint, a transient D1 failure) passes through untouched.
async function guardDuplicatePaymentRef<T>(paymentRef: string | null | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Explicit non-null check, not truthiness: '' is a valid payment_ref under the partial
    // index's WHERE clause, so truthiness would wrongly skip reclassifying it.
    if (paymentRef !== null && paymentRef !== undefined && isPaymentRefUniqueViolation(error)) {
      throw new DuplicatePaymentRefError(paymentRef);
    }
    throw error;
  }
}

// Inputs for the atomic capacity guard shared by insertHoldWithCapacity and
// rescheduleWithCapacity. Mirrors core/occupancy.ts's capacity math in SQL — keep both in sync.
export interface CapacityGuardInput {
  occupancyUnits: number;
  occupancyEndsAt: string;
  localDate: string;
  defaultCapacity: number;
}

// A durable record of a refund decision + its Stripe outcome. One row per booking, so exactly
// one request can claim a booking's refund decision.
export type RefundChoice = 'full' | 'none';
// 'in_flight': execution claim held, Stripe call may be in progress.
// 'abandoned': terminal — a permanent failure or exhausted retries, like side_effect_operations.
export type RefundOperationStatus = 'requested' | 'in_flight' | 'succeeded' | 'failed' | 'abandoned';

export interface RefundOperationRecord {
  id: string;
  bookingId: string;
  paymentIntent: string | null;
  choice: RefundChoice;
  status: RefundOperationStatus;
  stripeRefundId: string | null;
  amountCents: number | null;
  requestedAt: string;
  resolvedAt: string | null;
  error: string | null;
  // The scheduled reconciler's execution claim; both null when nothing holds it.
  executionClaimToken: string | null;
  executionClaimUntil: string | null;
  attemptCount: number;
  attemptedAt: string | null;
  failureStartedAt: string | null;
  nextAttemptAt: string | null;
}

// Must match the operational_incidents table's CHECK constraints exactly.
export type OperationalIncidentSourceType = 'side_effect' | 'refund' | 'oversell';
export type OperationalIncidentAction = 'confirmation_email' | 'customer_notification' | 'calendar' | 'operations_sync' | 'refund' | 'oversell';
export type OperationalIncidentStatus = 'open' | 'resolved';
export type OperationalIncidentSeverity = 'delayed' | 'action_required';
export type OperationalIncidentResolutionKind = 'automatic' | 'manual';

export interface OperationalIncidentRecord {
  id: string;
  bookingId: string;
  sourceType: OperationalIncidentSourceType;
  sourceKey: string;
  action: OperationalIncidentAction;
  status: OperationalIncidentStatus;
  severity: OperationalIncidentSeverity;
  attemptCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  sourceUpdatedAt: string;
  alertRevision: number;
  alertedRevision: number;
  alertAttemptCount: number;
  alertClaimToken: string | null;
  alertClaimUntil: string | null;
  alertNextAttemptAt: string | null;
  alertError: string | null;
  resolvedAt: string | null;
  resolutionKind: OperationalIncidentResolutionKind | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

// Closed set mirrored by a DB CHECK. The first four are one-shot rows identified solely by
// family; the last three carry a name/event (and, for repeatable events, a discriminator) too.
export const SIDE_EFFECT_FAMILIES = [
  'calendar_create', 'calendar_delete', 'email_confirmation', 'oversell',
  'email', 'hook', 'webhook',
] as const;
export type SideEffectFamily = (typeof SIDE_EFFECT_FAMILIES)[number];

// The row key: every claim/resolve/routing decision reads these columns directly, never
// reconstructed from a string. Optional fields let a one-shot family be just { family }.
export interface SideEffectOperationIdentity {
  family: SideEffectFamily;
  // Hook/webhook subscriber name, or the email recipient role for a per-recipient send.
  name?: string | null;
  event?: string | null;
  // Per-occurrence uniqueness for events that can repeat per booking, assigned atomically from
  // the reschedule transition version.
  discriminator?: string | null;
}

// The one place an operation identity becomes text: log lines, incident source keys, and the
// webhook envelope id are all *built* from the columns here and never parsed back.
export function sideEffectOperationKey(identity: SideEffectOperationIdentity): string {
  return [identity.family, identity.name, identity.event, identity.discriminator]
    .filter((part): part is string => Boolean(part))
    .join(':');
}

export function sameSideEffectOperation(a: SideEffectOperationIdentity, b: SideEffectOperationIdentity): boolean {
  return a.family === b.family
    && (a.name ?? null) === (b.name ?? null)
    && (a.event ?? null) === (b.event ?? null)
    && (a.discriminator ?? null) === (b.discriminator ?? null);
}

// A row this transition owes, recorded atomically with the transition itself.
export interface SideEffectOperationSeed extends SideEffectOperationIdentity {
  // Required for hook/webhook rows, re-sent unchanged on every retry; null for every other
  // family, which reconstructs its work from the live booking instead.
  eventPayloadJson: string | null;
  // Envelope id without its discriminator: the reschedule version is only known inside the
  // winning batch, so the repo appends it there. Complete the moment the row exists, never
  // patched afterwards.
  eventIdPrefix: string | null;
}
// 'abandoned' is terminal, distinct from 'failed': a permanent provider failure or a retryable
// failure's tenth attempt lands here so the claim predicates below stop matching it forever.
export type SideEffectOperationStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'abandoned';

// A claimant that dies between claiming and resolving would leave the row stuck forever, since
// claiming only matches pending/failed. This lease window lets an in_flight row past its
// attempted_at be reclaimed too — same 5-minute judgment call as the confirmation lease.
export const MUTATION_SIDE_EFFECT_LEASE_MS = 5 * 60_000;

// Attempt count means executions started. The resolve side already turns a retryable failure's
// 10th attempt into 'abandoned', but claim predicates enforce this cap too, as a second line
// of defense rather than relying on resolve alone.
export const SIDE_EFFECT_MAX_ATTEMPTS = 10;

export interface CancellationTransitionInput {
  expectedStatusIn: BookingStatus[];
  // Prevents a cancellation decision calculated against a stale pre-reschedule start from landing.
  expectedStartsAt?: string;
  cancelledAt: string;
  cancelledBy: CancellationActor;
  updatedAt: string;
  // Recorded atomically only when this transition's CAS wins.
  mutationSideEffects?: SideEffectOperationSeed[];
}

export interface RefundOperationUpsertInput {
  id: string;
  bookingId: string;
  paymentIntent: string | null;
  choice: RefundChoice;
  status: RefundOperationStatus;
  stripeRefundId: string | null;
  amountCents: number | null;
  requestedAt: string;
  resolvedAt: string | null;
  error?: string | null;
}

// Outbox debt per operation family. `pending` counts pending, in-flight, and failed-but-retryable
// rows together, since all three are undelivered work an operator needs to see as one number.
export interface SideEffectDebtByFamily {
  family: SideEffectFamily;
  pending: number;
  abandoned: number;
  oldestPendingAt: string | null;
}

export interface SideEffectOperationRecord extends SideEffectOperationIdentity {
  bookingId: string;
  name: string | null;
  event: string | null;
  discriminator: string | null;
  eventPayloadJson: string | null;
  status: SideEffectOperationStatus;
  providerResultId: string | null;
  attemptCount: number;
  attemptedAt: string | null;
  resolvedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  failureStartedAt: string | null;
  nextAttemptAt: string | null;
}

export interface BookingUpdate {
  pickupAddress?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  startsAt?: string;
  endsAt?: string;
  holdExpiresAt?: string | null;
  paymentSessionRef?: string | null;
  paymentRef?: string | null;
  calendarEventId?: string | null;
  cancelledAt?: string | null;
  cancelledBy?: CancellationActor | null;
  rescheduledFrom?: string | null;
  updatedAt: string;
}

export interface BookingRepository {
  sweepExpiredHolds(now: string): Promise<number>;
  expireHold(id: string, now: string): Promise<Booking | null>;
  acquireConfirmationLease(id: string, token: string, now: string, leaseUntil: string): Promise<boolean>;
  renewConfirmationLease(id: string, token: string, now: string, leaseUntil: string): Promise<boolean>;
  releaseConfirmationLease(id: string, token: string): Promise<void>;
  getBookingById(id: string): Promise<Booking | null>;
  getBookingByReference(reference: string): Promise<Booking | null>;
  getBookingBySessionRef(sessionRef: string): Promise<Booking | null>;
  getBookingByPaymentRef?(paymentRef: string): Promise<Booking | null>;
  // `now` gates expiry in the same query as the lookup, so an expired token is denied
  // identically to an unknown one — no timing oracle distinguishing the two cases.
  getBookingByCancelToken(token: string, now: string): Promise<Booking | null>;
  getBookingByOperatorToken(token: string, now: string): Promise<Booking | null>;
  getBookingByOperatorTokenForRefundRecovery(token: string, now: string): Promise<Booking | null>;
  countReferencesForYear(prefix: string): Promise<number>;
  insertHold(input: BookingInsert): Promise<Booking>;
  // Same per-IP hold-cap guard as insertHold, plus a single-statement capacity guard. Returns
  // null when the capacity guard loses the race, distinct from HoldLimitExceededError (still
  // thrown for the per-IP cap), so the caller can surface the existing slot_unavailable 409.
  insertHoldWithCapacity(input: BookingInsert & CapacityGuardInput): Promise<Booking | null>;
  updateBooking(id: string, patch: BookingUpdate): Promise<Booking>;
  // Compare-and-set: a single conditional UPDATE scoped to expectedStatusIn (or, for reschedule,
  // status + starts_at) returns null when the predicate misses, so a stale read can never
  // overwrite a row that already moved to a different state.
  transitionToCancelled(id: string, input: CancellationTransitionInput): Promise<Booking | null>;
  // The refund outcome and cancellation share a D1 batch so a failed webhook delivery cannot
  // leave a paid booking occupying capacity after its authoritative Stripe refund was recorded.
  upsertRefundOperationAndTransitionToCancelled(
    refund: RefundOperationUpsertInput,
    id: string,
    input: CancellationTransitionInput,
  ): Promise<Booking | null>;
  transitionToNoShow(id: string, input: {
    expectedStatusIn: BookingStatus[];
    updatedAt: string;
    mutationSideEffects?: SideEffectOperationSeed[];
  }): Promise<Booking | null>;
  transitionToConfirmed(id: string, input: {
    expectedStatusIn: BookingStatus[];
    paymentRef?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
    updatedAt: string;
  }): Promise<Booking | null>;
  confirmWithSideEffectOperations(id: string, input: {
    expectedStatusIn: BookingStatus[];
    paymentRef?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
    leaseToken: string;
    oversold: boolean;
    updatedAt: string;
    // One row per durable hook/webhook subscribed to booking.confirmed, sharing the transition's
    // D1 batch so delivery debt can never exist without the confirmation that owes it, nor vice versa.
    eventSeeds?: SideEffectOperationSeed[];
    // Only when the email provider implements the split send methods: one row per recipient
    // instead of the single combined email_confirmation row, in the same D1 batch so the shape
    // and the transition can never diverge.
    emailRecipients?: EmailRecipientRole[];
  }): Promise<Booking | null>;
  applyConfirmedPaymentDetails(id: string, patch: {
    paymentRef?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
  }, leaseToken: string, updatedAt: string): Promise<boolean>;
  // Lazy repair for a confirmed booking whose confirmation rows are missing (a subscriber or a
  // split-capable email provider configured after confirmation). A split email row is only
  // inserted when no combined email_confirmation row already exists.
  ensureConfirmationSideEffectOperations(id: string, leaseToken: string, now: string, eventSeeds?: SideEffectOperationSeed[], emailRecipients?: EmailRecipientRole[]): Promise<void>;
  listSideEffectOperations(bookingId: string): Promise<SideEffectOperationRecord[]>;
  // Returns the authoritative attempt number assigned by the atomic claim, or null when the row
  // was not claimable. Callers must classify failures against this value rather than a prior read.
  // Additionally requires next_attempt_at to be NULL or <= attemptedAt
  // ("now") — a row still inside its backoff window is not claimable by this ordinary path.
  claimSideEffectOperation(bookingId: string, identity: SideEffectOperationIdentity, leaseToken: string, attemptedAt: string): Promise<number | null>;
  // The admin "Try again" bypass — same lease-ownership gate as
  // claimSideEffectOperation, but ignores next_attempt_at AND the attempt-count cap (so a terminal
  // 'abandoned' row can be retried once), while still incrementing the lifetime attempt count.
  claimSideEffectOperationForRetry(bookingId: string, identity: SideEffectOperationIdentity, leaseToken: string, attemptedAt: string): Promise<number | null>;
  resolveSideEffectOperation(input: {
    bookingId: string;
    identity: SideEffectOperationIdentity;
    leaseToken: string;
    // 'abandoned': a permanent failure, or a retryable failure's 10th attempt.
    status: 'succeeded' | 'failed' | 'abandoned';
    providerResultId?: string | null;
    error?: string | null;
    resolvedAt: string;
    // Set only when status is 'failed'. A 'succeeded'/'abandoned' resolve always clears both
    // next_attempt_at and failure_started_at regardless of what's passed here.
    nextAttemptAt?: string | null;
  }): Promise<boolean>;
  // Not lease-gated like the confirmation-path pair above: cancel/reschedule/no-show already run
  // their own CAS, so this is a plain claim/resolve with attempted_at as the lease token. Returns
  // the claimed attempt number or null, closing the list-to-claim race between concurrent drains.
  claimMutationSideEffectOperation(bookingId: string, identity: SideEffectOperationIdentity, attemptedAt: string): Promise<number | null>;
  // The admin "Try again" bypass — same staleness/ownership shape as
  // claimMutationSideEffectOperation, but ignores next_attempt_at AND the attempt-count cap.
  claimMutationSideEffectOperationForRetry(bookingId: string, identity: SideEffectOperationIdentity, attemptedAt: string): Promise<number | null>;
  resolveMutationSideEffectOperation(input: {
    bookingId: string;
    identity: SideEffectOperationIdentity;
    status: 'succeeded' | 'failed' | 'abandoned';
    providerResultId?: string | null;
    error?: string | null;
    resolvedAt: string;
    // The attempted_at this claimant set at claim time; resolve requires it still match, so a
    // slow original claimant waking up after a reclaimer took the row (bumping attempted_at)
    // fails to match here instead of clobbering the reclaimer's outcome.
    claimedAt: string;
    nextAttemptAt?: string | null;
  }): Promise<boolean>;
  // For an event that isn't a booking transition (today only payment.dispute_created). Every
  // other seed rides the transition batch that owes it; this one has none, so the row itself is
  // the record and a plain conflict-free insert is enough.
  recordBookingEventOperations(bookingId: string, seeds: SideEffectOperationSeed[], now: string): Promise<void>;
  transitionReschedule(id: string, input: {
    expectedStatus: BookingStatus;
    expectedStartsAt: string;
    startsAt: string;
    endsAt: string;
    rescheduledFrom: string;
    updatedAt: string;
    // Recomputed from the new endsAt so a booking moved later doesn't have its manage link
    // expire before the rescheduled service happens (and one moved earlier doesn't keep an
    // over-long window). Optional: omitting it leaves tokens_expire_at untouched via COALESCE.
    tokensExpireAt?: string | null;
    mutationSideEffects?: SideEffectOperationSeed[];
  }): Promise<Booking | null>;
  // Extends transitionReschedule's CAS with the same capacity guard as insertHoldWithCapacity,
  // excluding this booking's own current occupancy so moving into a window it already partly
  // occupies isn't double-counted. Returns null on either a CAS loss or a capacity loss.
  rescheduleWithCapacity(id: string, input: {
    expectedStatus: BookingStatus;
    expectedStartsAt: string;
    startsAt: string;
    endsAt: string;
    rescheduledFrom: string;
    updatedAt: string;
    now: string;
    tokensExpireAt?: string | null;
    // Reschedule rows receive the incremented per-booking transition version in the same batch,
    // so a repeated A→B hop cannot collide with an earlier one.
    mutationSideEffects?: SideEffectOperationSeed[];
  } & CapacityGuardInput): Promise<Booking | null>;
  listOccupancyBookings(from: string, to: string): Promise<Booking[]>;
  listUpcoming(now: string): Promise<Booking[]>;
  // Every booking regardless of status from a starts_at lower bound — the admin's search/status
  // filters need cancelled/expired/past rows that listUpcoming (live upcoming only) never returns.
  listAllFrom(startsAtFrom: string): Promise<Booking[]>;
  getDayOverride(date: string): Promise<DayCapacityOverride | null>;
  listDayOverrides(from: string, to: string): Promise<DayCapacityOverride[]>;
  upsertDayOverride(date: string, capacity: number, reason: string | null): Promise<void>;
  deleteDayOverride(date: string): Promise<void>;
  // Batched siblings of upsertDayOverride/deleteDayOverride so a range submit is one D1 round
  // trip instead of many. `audit` is required, not optional: an admin write with no history
  // entry is a bug. One admin_change_history row per date rides the same batch as the change.
  upsertDayOverrides(dates: string[], capacity: number, reason: string | null, audit: AdminChangeAudit): Promise<void>;
  deleteDayOverrides(dates: string[], audit: AdminChangeAudit): Promise<void>;
  listCapacityDefaults(): Promise<CapacityDefault[]>;
  upsertCapacityDefault(fromDate: string, capacity: number, reason: string | null, audit: AdminChangeAudit): Promise<void>;
  deleteCapacityDefault(fromDate: string, audit: AdminChangeAudit): Promise<void>;
  // Operator-editable config overrides: key -> JSON-encoded value.
  listSettings(): Promise<Record<string, string>>;
  upsertSetting(key: string, value: string): Promise<void>;
  // Single-key write path; required audit param for the same reason as above.
  deleteSetting(key: string, audit: AdminChangeAudit): Promise<void>;
  // Applies every key of a settings section in one D1 batch, all-or-nothing. One history row
  // per operation rides the same batch.
  applySettingsBatch(operations: SettingsBatchOperation[], audit: AdminChangeAudit): Promise<void>;
  listAdminChangeHistory(limit: number): Promise<AdminChangeHistoryEntry[]>;
  // Compare-and-set: succeeds only when no operation row exists yet for this booking_id, so a
  // refund=full and refund=none request racing on the same booking can never both call Stripe.
  // The loser reads getRefundOperationByBookingId to see which decision won.
  claimRefundOperation(input: {
    id: string;
    bookingId: string;
    paymentIntent: string | null;
    choice: RefundChoice;
    requestedAt: string;
  }): Promise<boolean>;
  getRefundOperationByBookingId(bookingId: string): Promise<RefundOperationRecord | null>;
  // A conditional UPDATE (WHERE status != 'succeeded'), not a plain write: status only ever
  // advances, so a stale retry racing the charge.refunded webhook can never downgrade an
  // already-succeeded row or clear its recorded refund id/amount.
  resolveRefundOperation(id: string, input: {
    status: 'succeeded' | 'failed' | 'abandoned';
    stripeRefundId?: string | null;
    amountCents?: number | null;
    error?: string | null;
    resolvedAt: string;
    nextAttemptAt?: string | null;
  }): Promise<void>;
  // Removes this request's still-pending claim after its own CAS cancel loses to a non-cancelled
  // winner, so it can't block a later legitimate cancellation. A succeeded row is retained: it's
  // the durable record that Stripe moved the money.
  deleteRefundOperation(id: string): Promise<void>;
  // A non-authoritative upsert preserves any terminal outcome, so stale caller data cannot
  // regress a recorded Stripe refund. Does not overwrite requested_at on an existing row.
  upsertRefundOperation(input: RefundOperationUpsertInput): Promise<void>;
  // Only a verified charge.refunded webhook may correct an earlier none/succeeded audit row.
  reconcileStripeRefundOperation(input: RefundOperationUpsertInput): Promise<void>;

  // ---- Autonomous reconciliation ----------------------------------------------------

  // A single atomic UPDATE with attempted_at doubling as the lease/staleness reference, since a
  // refund operation is one row per booking. Claimable from 'requested'/'failed' or a stale
  // 'in_flight' row; returns the attempt number, or null when not claimable.
  claimRefundExecution(id: string, attemptedAt: string): Promise<number | null>;
  // Admin "Try again" bypass: ignores next_attempt_at and the attempt-count cap so an
  // 'abandoned' refund can be retried, but still refuses a live 'in_flight' claim.
  claimRefundExecutionForRetry(id: string, attemptedAt: string): Promise<number | null>;

  // Execution, incident projection, and incident maintenance each use separate bounded pages, so
  // terminal rows never consume the page reserved for executable debt.
  listSideEffectExecutionCandidates(now: string, staleBefore: string, limit: number): Promise<SideEffectOperationRecord[]>;
  listRefundExecutionCandidateBookingIds(now: string, staleBefore: string, limit: number): Promise<string[]>;
  listSideEffectIncidentCandidateBookingIds(failureDueBefore: string, limit: number): Promise<string[]>;
  listRefundIncidentCandidateBookingIds(limit: number): Promise<string[]>;
  listIncidentReprojectionCandidates(limit: number): Promise<OperationalIncidentRecord[]>;
  // 'oversell' rows are permanent markers, never retried, so the candidate set is simply "no
  // incident has been opened for this marker yet" rather than a claim/backoff query.
  listUnreportedOversellMarkers(limit: number): Promise<SideEffectOperationRecord[]>;

  // Both inserts a new row and reopens/updates an existing one (ON CONFLICT). `escalate` bumps
  // alert_revision; a plain update only refreshes last_detected_at/attempt_count/severity/
  // source_updated_at. Reopening a resolved row always clears its resolution fields.
  upsertOpenIncident(input: {
    id: string;
    bookingId: string;
    sourceType: OperationalIncidentSourceType;
    sourceKey: string;
    action: OperationalIncidentAction;
    severity: OperationalIncidentSeverity;
    attemptCount: number;
    sourceUpdatedAt: string;
    now: string;
    escalate: boolean;
  }): Promise<void>;
  // Any status (open or resolved): the caller needs a resolved row's own state
  // (resolutionKind/sourceUpdatedAt) to decide whether a manual resolution should stay resolved.
  getIncidentBySource(sourceType: OperationalIncidentSourceType, sourceKey: string): Promise<OperationalIncidentRecord | null>;
  // The one row a manual "I handled this manually" action or an automatic-success scan resolves —
  // by (source_type, source_key), not id, so the caller never has to look the id up first.
  resolveIncidentAutomatic(sourceType: OperationalIncidentSourceType, sourceKey: string, resolvedAt: string): Promise<void>;
  resolveIncidentManual(input: {
    sourceType: OperationalIncidentSourceType;
    sourceKey: string;
    resolvedAt: string;
    resolvedBy: string;
    resolutionNote: string;
  }): Promise<boolean>;
  // Sorts action-required before delayed, then oldest first.
  listOpenIncidents(limit: number): Promise<OperationalIncidentRecord[]>;
  listRecentResolvedIncidents(since: string, limit: number): Promise<OperationalIncidentRecord[]>;
  countIncidentsSince(since: string): Promise<{ opened: number; resolved: number }>;
  // Pure aggregates, no booking data and no parameters, so a health endpoint can answer without
  // exposing rows.
  countOpenIncidents(): Promise<number>;
  countSideEffectDebtByFamily(): Promise<SideEffectDebtByFamily[]>;

  // Alert delivery's own claim/attempt/backoff, independent of the incident's detection state.
  // Claimable only when alerted_revision < alert_revision and the claim/backoff windows allow it.
  listAlertCandidateIds(now: string, limit: number): Promise<string[]>;
  claimIncidentAlert(id: string, token: string, now: string, leaseUntil: string): Promise<OperationalIncidentRecord | null>;
  resolveIncidentAlertSuccess(id: string, token: string, alertedRevision: number): Promise<void>;
  resolveIncidentAlertFailure(id: string, token: string, error: string, nextAttemptAt: string): Promise<void>;
}

interface BookingRow {
  id: string;
  reference: string;
  service_slug: string;
  quantity: number;
  // The DB can't see the pickup-option domain (that's app config), so assertValidBookingRow
  // below only enforces that a present id is a non-empty string. NULL means no location module.
  pickup_type: PickupType | null;
  pickup_address: string | null;
  meeting_point_id: string | null;
  meeting_point_label: string | null;
  starts_at: string;
  ends_at: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  locale: string;
  price_minor: number;
  currency: string;
  status: BookingStatus;
  hold_expires_at: string | null;
  payment_session_ref: string | null;
  payment_ref: string | null;
  calendar_event_id: string | null;
  metadata: string | null;
  cancel_token: string;
  operator_token: string;
  cancel_token_hash: string | null;
  operator_token_hash: string | null;
  cancel_token_enc: string | null;
  operator_token_enc: string | null;
  tokens_expire_at: string | null;
  cancel_token_revoked_at: string | null;
  cancelled_at: string | null;
  cancelled_by: CancellationActor | null;
  rescheduled_from: string | null;
  created_at: string;
  updated_at: string;
}

// Re-checks at read time the same invariants the DB's CHECK constraints enforce at write time.
// The ends_at > starts_at string comparison mirrors the SQL CHECK exactly: both columns are
// ISO 8601 UTC instants, so lexical order matches chronological order.
function assertValidBookingRow(row: BookingRow): void {
  if (row.quantity <= 0) throw new InvalidBookingRowError(row.id, `quantity must be > 0, got ${row.quantity}`);
  if (row.price_minor < 0) throw new InvalidBookingRowError(row.id, `price_minor must be >= 0, got ${row.price_minor}`);
  if (!(row.ends_at > row.starts_at)) {
    throw new InvalidBookingRowError(row.id, `ends_at (${row.ends_at}) must be after starts_at (${row.starts_at})`);
  }
  // The DB has no CHECK for pickup_type since the id domain is per-service config it can't
  // enumerate, but an empty id is invalid under every config, so that floor is enforced here.
  // NULL is legitimate (no location module); empty string is not (a nameless option).
  if (row.pickup_type !== null && (typeof row.pickup_type !== 'string' || row.pickup_type === '')) {
    throw new InvalidBookingRowError(row.id, 'pickup_type must be a non-empty string or NULL');
  }
}

// Opaque consumer JSON. Unparseable text degrades to null rather than failing the whole read:
// the booking's own invariants don't depend on it, and an operator must still be able to see,
// cancel, and refund that booking.
function parseBookingMetadata(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// An empty/absent record stores as SQL NULL rather than the string '{}', keeping "no metadata"
// one representation, not two.
function serializeBookingMetadata(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function mapBooking(row: BookingRow): Booking {
  assertValidBookingRow(row);
  return {
    id: row.id,
    reference: row.reference,
    serviceSlug: row.service_slug,
    quantity: Number(row.quantity),
    pickupType: row.pickup_type,
    pickupAddress: row.pickup_address,
    meetingPointId: row.meeting_point_id ?? null,
    meetingPointLabel: row.meeting_point_label ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    locale: row.locale,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    status: row.status,
    holdExpiresAt: row.hold_expires_at,
    paymentSessionRef: row.payment_session_ref,
    paymentRef: row.payment_ref,
    calendarEventId: row.calendar_event_id,
    metadata: parseBookingMetadata(row.metadata),
    cancelToken: row.cancel_token,
    operatorToken: row.operator_token,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    rescheduledFrom: row.rescheduled_from,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const bookingColumns = `id, reference, service_slug, quantity, pickup_type, pickup_address, meeting_point_id,
  meeting_point_label, starts_at, ends_at,
  customer_name, customer_email, customer_phone, locale, price_minor, currency, status, hold_expires_at,
  payment_session_ref, payment_ref, calendar_event_id, metadata, cancel_token, operator_token,
  cancel_token_hash, operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at,
  cancel_token_revoked_at, cancelled_at, cancelled_by, rescheduled_from, created_at, updated_at`;

async function first<T>(result: Promise<D1Result<T>>): Promise<T | null> {
  return (await result).results[0] ?? null;
}

interface RefundOperationRow {
  id: string;
  booking_id: string;
  payment_intent: string | null;
  choice: RefundChoice;
  status: RefundOperationStatus;
  stripe_refund_id: string | null;
  amount_cents: number | null;
  requested_at: string;
  resolved_at: string | null;
  error: string | null;
  execution_claim_token: string | null;
  execution_claim_until: string | null;
  attempt_count: number;
  attempted_at: string | null;
  failure_started_at: string | null;
  next_attempt_at: string | null;
}

function mapRefundOperation(row: RefundOperationRow): RefundOperationRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    paymentIntent: row.payment_intent,
    choice: row.choice,
    status: row.status,
    stripeRefundId: row.stripe_refund_id,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    error: row.error,
    executionClaimToken: row.execution_claim_token,
    executionClaimUntil: row.execution_claim_until,
    attemptCount: Number(row.attempt_count),
    attemptedAt: row.attempted_at,
    failureStartedAt: row.failure_started_at,
    nextAttemptAt: row.next_attempt_at,
  };
}

const refundOperationColumns = `id, booking_id, payment_intent, choice, status, stripe_refund_id,
  amount_cents, requested_at, resolved_at, error, execution_claim_token, execution_claim_until,
  attempt_count, attempted_at, failure_started_at, next_attempt_at`;

interface OperationalIncidentRow {
  id: string;
  booking_id: string;
  source_type: OperationalIncidentSourceType;
  source_key: string;
  action: OperationalIncidentAction;
  status: OperationalIncidentStatus;
  severity: OperationalIncidentSeverity;
  attempt_count: number;
  first_detected_at: string;
  last_detected_at: string;
  source_updated_at: string;
  alert_revision: number;
  alerted_revision: number;
  alert_attempt_count: number;
  alert_claim_token: string | null;
  alert_claim_until: string | null;
  alert_next_attempt_at: string | null;
  alert_error: string | null;
  resolved_at: string | null;
  resolution_kind: OperationalIncidentResolutionKind | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

const operationalIncidentColumns = `id, booking_id, source_type, source_key, action, status, severity,
  attempt_count, first_detected_at, last_detected_at, source_updated_at, alert_revision,
  alerted_revision, alert_attempt_count, alert_claim_token, alert_claim_until, alert_next_attempt_at,
  alert_error, resolved_at, resolution_kind, resolved_by, resolution_note`;

function mapOperationalIncident(row: OperationalIncidentRow): OperationalIncidentRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    action: row.action,
    status: row.status,
    severity: row.severity,
    attemptCount: Number(row.attempt_count),
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    sourceUpdatedAt: row.source_updated_at,
    alertRevision: Number(row.alert_revision),
    alertedRevision: Number(row.alerted_revision),
    alertAttemptCount: Number(row.alert_attempt_count),
    alertClaimToken: row.alert_claim_token,
    alertClaimUntil: row.alert_claim_until,
    alertNextAttemptAt: row.alert_next_attempt_at,
    alertError: row.alert_error,
    resolvedAt: row.resolved_at,
    resolutionKind: row.resolution_kind,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

interface SideEffectOperationRow {
  booking_id: string;
  family: SideEffectFamily;
  name: string | null;
  event: string | null;
  discriminator: string | null;
  event_payload_json: string | null;
  status: SideEffectOperationStatus;
  provider_result_id: string | null;
  attempt_count: number;
  attempted_at: string | null;
  resolved_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  failure_started_at: string | null;
  next_attempt_at: string | null;
}

const sideEffectOperationColumns = `booking_id, family, name, event, discriminator, event_payload_json,
  status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at,
  failure_started_at, next_attempt_at`;

// Ordered so a list read is stable regardless of insert order.
const sideEffectIdentityOrder = 'family, name, event, discriminator';

// The identity's SQL predicate. `IS` (not `=`) so a NULL name/event/discriminator matches the row
// that genuinely has none, instead of silently matching nothing.
const sideEffectIdentityMatch = 'family = ? AND name IS ? AND event IS ? AND discriminator IS ?';

function sideEffectIdentityParams(identity: SideEffectOperationIdentity): unknown[] {
  return [identity.family, identity.name ?? null, identity.event ?? null, identity.discriminator ?? null];
}

// The incident ledger's source key for a side-effect row, built (never parsed) from the identity
// columns — the SQL twin of sideEffectOperationKey above.
const sideEffectSourceKeySql = `side_effect_operations.booking_id || ':' || side_effect_operations.family
  || COALESCE(':' || side_effect_operations.name, '')
  || COALESCE(':' || side_effect_operations.event, '')
  || COALESCE(':' || side_effect_operations.discriminator, '')`;

function mapSideEffectOperation(row: SideEffectOperationRow): SideEffectOperationRecord {
  return {
    bookingId: row.booking_id,
    family: row.family,
    name: row.name,
    event: row.event,
    discriminator: row.discriminator,
    eventPayloadJson: row.event_payload_json,
    status: row.status,
    providerResultId: row.provider_result_id,
    attemptCount: Number(row.attempt_count),
    attemptedAt: row.attempted_at,
    resolvedAt: row.resolved_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureStartedAt: row.failure_started_at,
    nextAttemptAt: row.next_attempt_at,
  };
}

// Optional Worker secret to decrypt cancel_token_enc/operator_token_enc into a usable link. Not
// added to the default secretBindings: a deployment must opt in explicitly, same as
// RESERVA_CSRF_SECRET.
const TOKEN_ENC_SECRET_NAME = 'RESERVA_TOKEN_ENC_KEY';

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecodeBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

// Normalizes an arbitrary-length secret into the exact 32 bytes AES-256-GCM needs by hashing it,
// rather than requiring the operator to provision exactly 32 bytes themselves.
async function importTokenKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptToken(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return base64UrlEncodeBytes(combined);
}

// Fails closed (null, not throw) on a corrupt/tampered blob so one bad row can never crash an
// otherwise-successful list/read; callers fall back to whatever mapBooking put there.
async function decryptToken(key: CryptoKey, blob: string): Promise<string | null> {
  try {
    const combined = base64UrlDecodeBytes(blob);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

// Satisfies the legacy cancel_token/operator_token columns' NOT NULL UNIQUE constraint without
// those columns ever holding a usable credential. Safe even if it leaks in a dump: lookups only
// consult this column when `..._hash IS NULL`, and new rows always have their hash set.
function placeholderToken(): string {
  return `nohash:${crypto.randomUUID()}`;
}

// A booking whose token still carries the `nohash:` prefix is one hydrateBooking couldn't
// restore to plaintext — either the encryption secret isn't configured, or the row predates it.
// A link built from such a token would 403 instantly, so render sites check this and omit it.
export function isManageableToken(token: string): boolean { return !token.startsWith('nohash:'); }

export function createBookingRepository(
  db: D1Database,
  // Duplicated inline rather than imported from context.ts, to avoid a circular import
  // (context.ts already imports createBookingRepository).
  secrets?: (name: string) => string | undefined | Promise<string | undefined>,
): BookingRepository {
  // Resolved at most once per repository instance, not once per token: the secret cannot change
  // mid-request.
  let tokenKeyPromise: Promise<CryptoKey | null> | undefined;
  const resolveTokenKey = (): Promise<CryptoKey | null> => {
    if (!tokenKeyPromise) {
      tokenKeyPromise = (async () => {
        const secret = secrets ? await secrets(TOKEN_ENC_SECRET_NAME) : undefined;
        return secret ? importTokenKey(secret) : null;
      })();
    }
    return tokenKeyPromise;
  };

  // Reconstitutes cancelToken/operatorToken into presentable plaintext for every DB-loaded
  // booking. mapBooking already defaults these to the legacy plaintext column (correct for a
  // not-yet-backfilled row); this only overrides them when a decryptable blob exists.
  async function hydrateBooking(row: BookingRow, key: CryptoKey | null): Promise<Booking> {
    const mapped = mapBooking(row);
    if (!key) return mapped;
    if (row.cancel_token_enc) {
      const decrypted = await decryptToken(key, row.cancel_token_enc);
      if (decrypted !== null) mapped.cancelToken = decrypted;
    }
    if (row.operator_token_enc) {
      const decrypted = await decryptToken(key, row.operator_token_enc);
      if (decrypted !== null) mapped.operatorToken = decrypted;
    }
    return mapped;
  }

  // Shared by insertHold/insertHoldWithCapacity: computes every column a new row needs
  // to write, so both insert paths stay in sync instead of duplicating this logic.
  async function newTokenColumns(input: BookingInsert): Promise<{
    cancelTokenPlaceholder: string; operatorTokenPlaceholder: string;
    cancelTokenHash: string; operatorTokenHash: string;
    cancelTokenEnc: string | null; operatorTokenEnc: string | null;
    tokensExpireAt: string | null;
  }> {
    const key = await resolveTokenKey();
    const [cancelTokenHash, operatorTokenHash] = await Promise.all([
      sha256Base64Url(input.cancelToken),
      sha256Base64Url(input.operatorToken),
    ]);
    const [cancelTokenEnc, operatorTokenEnc] = key
      ? await Promise.all([encryptToken(key, input.cancelToken), encryptToken(key, input.operatorToken)])
      : [null, null];
    return {
      cancelTokenPlaceholder: placeholderToken(),
      operatorTokenPlaceholder: placeholderToken(),
      cancelTokenHash, operatorTokenHash, cancelTokenEnc, operatorTokenEnc,
      tokensExpireAt: input.tokensExpireAt ?? null,
    };
  }

  const oneBooking = async (sql: string, ...params: unknown[]): Promise<Booking | null> => {
    const row = await first(db.prepare(sql).bind(...params).all<BookingRow>());
    if (!row) return null;
    return hydrateBooking(row, await resolveTokenKey());
  };

  // Runs in the same batch as, and before, the transition's own CAS UPDATE, using the identical
  // predicate wrapped in WHERE EXISTS against the pre-batch snapshot. Since db.batch() is atomic,
  // the INSERT and UPDATE always agree — both fire or neither does — so a losing CAS attempt can
  // never record side effects for a mutation that didn't happen. Reads
  // reschedule_transition_version before the paired UPDATE increments it, keeping the
  // discriminator and the transition version inseparable.
  const mutationSideEffectInsert = (
    bookingId: string,
    seeds: SideEffectOperationSeed[],
    now: string,
    casPredicate: string,
    casParams: unknown[],
    appendRescheduleVersion = false,
  ) => {
    const version = `(SELECT reschedule_transition_version + 1 FROM bookings WHERE ${casPredicate})`;
    const discriminator = appendRescheduleVersion ? version : 'NULL';
    // The stored envelope must carry the id a receiver dedupes on, ending in this same
    // discriminator. Completing it here, in the one atomic write that assigns the version, keeps
    // row and payload consistent without a second, racy write. Payload-less seeds pass through.
    const payload = appendRescheduleVersion
      ? `CASE WHEN k.column4 IS NULL THEN NULL ELSE json_set(k.column4, '$.id', k.column5 || ':' || ${version}) END`
      : 'k.column4';
    return db.prepare(
      `INSERT INTO side_effect_operations (
         booking_id, family, name, event, discriminator, event_payload_json,
         status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
       )
       SELECT ?, k.column1, k.column2, k.column3, ${discriminator}, ${payload}, 'pending', NULL, 0, NULL, NULL, NULL, ?, ?
       FROM (VALUES ${seeds.map(() => '(?, ?, ?, ?, ?)').join(', ')}) AS k
       WHERE EXISTS (SELECT 1 FROM bookings WHERE ${casPredicate})
       ON CONFLICT DO NOTHING`,
    ).bind(
      bookingId,
      ...(appendRescheduleVersion ? [...casParams, ...casParams] : []),
      now, now,
      ...seeds.flatMap((seed) => [seed.family, seed.name ?? null, seed.event ?? null, seed.eventPayloadJson, seed.eventIdPrefix]),
      ...casParams,
    );
  };

  const cancellationUpdate = (id: string, input: CancellationTransitionInput) => {
    const placeholders = input.expectedStatusIn.map(() => '?').join(', ');
    const startsAtClause = input.expectedStartsAt !== undefined ? ' AND starts_at = ?' : '';
    const casPredicate = `id = ? AND status IN (${placeholders})${startsAtClause}`;
    const casParams = [id, ...input.expectedStatusIn, ...(input.expectedStartsAt !== undefined ? [input.expectedStartsAt] : [])];
    const updateStmt = db.prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, updated_at = ?,
         cancel_token_revoked_at = COALESCE(cancel_token_revoked_at, ?)
       WHERE ${casPredicate}`,
    ).bind(input.cancelledAt, input.cancelledBy, input.updatedAt, input.cancelledAt, ...casParams);
    return { casPredicate, casParams, updateStmt };
  };

  const refundOperationUpsertStmt = (input: RefundOperationUpsertInput) => db.prepare(
    `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, stripe_refund_id, amount_cents, requested_at, resolved_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(booking_id) DO UPDATE SET
       payment_intent = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.payment_intent ELSE excluded.payment_intent END,
       choice = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.choice ELSE excluded.choice END,
       status = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.status ELSE excluded.status END,
       stripe_refund_id = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.stripe_refund_id ELSE excluded.stripe_refund_id END,
       amount_cents = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.amount_cents ELSE excluded.amount_cents END,
       resolved_at = excluded.resolved_at,
       error = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.error ELSE excluded.error END`,
  ).bind(
    input.id, input.bookingId, input.paymentIntent, input.choice, input.status,
    input.stripeRefundId, input.amountCents, input.requestedAt, input.resolvedAt, input.error ?? null,
  );

  const stripeRefundReconciliationStmt = (input: RefundOperationUpsertInput) => db.prepare(
    `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, stripe_refund_id, amount_cents, requested_at, resolved_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(booking_id) DO UPDATE SET
       payment_intent = CASE WHEN refund_operations.status = 'succeeded' AND refund_operations.choice = 'full' THEN refund_operations.payment_intent ELSE excluded.payment_intent END,
       choice = CASE WHEN refund_operations.status = 'succeeded' AND refund_operations.choice = 'full' THEN refund_operations.choice ELSE excluded.choice END,
       status = CASE WHEN refund_operations.status = 'succeeded' AND refund_operations.choice = 'full' THEN refund_operations.status ELSE excluded.status END,
       stripe_refund_id = CASE WHEN refund_operations.status = 'succeeded' AND refund_operations.choice = 'full' THEN refund_operations.stripe_refund_id ELSE excluded.stripe_refund_id END,
       amount_cents = CASE WHEN refund_operations.status = 'succeeded' AND refund_operations.choice = 'full' THEN refund_operations.amount_cents ELSE excluded.amount_cents END,
       resolved_at = excluded.resolved_at,
       error = CASE WHEN refund_operations.status = 'succeeded' AND refund_operations.choice = 'full' THEN refund_operations.error ELSE excluded.error END`,
  ).bind(
    input.id, input.bookingId, input.paymentIntent, input.choice, input.status,
    input.stripeRefundId, input.amountCents, input.requestedAt, input.resolvedAt, input.error ?? null,
  );

  // One bound statement per admin_change_history row, for the caller to fold into the same
  // db.batch() as the change it records — never a second, separate write.
  const adminHistoryInsert = (
    domain: AdminChangeDomain,
    itemKey: string,
    action: AdminChangeAction,
    value: string | null,
    audit: AdminChangeAudit,
  ) => db.prepare(
    'INSERT INTO admin_change_history (domain, item_key, action, value, actor, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(domain, itemKey, action, value, audit.actor, audit.changedAt);

  return {
    async sweepExpiredHolds(now) {
      const result = await db.prepare(
        `UPDATE bookings SET status = 'expired', hold_expires_at = NULL, updated_at = ?
         WHERE status = 'hold' AND hold_expires_at IS NOT NULL AND hold_expires_at < ?`,
      ).bind(now, now).run();
      return result.meta.changes;
    },
    async expireHold(id, now) {
      const result = await db.prepare(
        `UPDATE bookings SET status = 'expired', hold_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'hold'`,
      ).bind(now, id).run();
      if (result.meta.changes === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async acquireConfirmationLease(id, token, now, leaseUntil) {
      const result = await db.prepare(
        `UPDATE bookings SET confirmation_lease_token = ?, confirmation_lease_until = ?
         WHERE id = ? AND (confirmation_lease_until IS NULL OR confirmation_lease_until < ?)`,
      ).bind(token, leaseUntil, id, now).run();
      return result.meta.changes > 0;
    },
    async renewConfirmationLease(id, token, now, leaseUntil) {
      const result = await db.prepare(
        `UPDATE bookings SET confirmation_lease_until = ?
         WHERE id = ? AND confirmation_lease_token = ? AND confirmation_lease_until >= ?`,
      ).bind(leaseUntil, id, token, now).run();
      return result.meta.changes > 0;
    },
    async releaseConfirmationLease(id, token) {
      await db.prepare(
        `UPDATE bookings SET confirmation_lease_token = NULL, confirmation_lease_until = NULL
         WHERE id = ? AND confirmation_lease_token = ?`,
      ).bind(id, token).run();
    },
    getBookingById: (id) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id),
    // Not routed through oneBooking's hydration: the only caller checks for a non-null result
    // in a retry loop that can run many times per checkout and never reads the tokens, so
    // hydrating here would be a real per-attempt AES-GCM cost for a value nothing uses.
    getBookingByReference: async (reference) => {
      const row = await first(db.prepare(`SELECT ${bookingColumns} FROM bookings WHERE reference = ?`).bind(reference).all<BookingRow>());
      return row ? mapBooking(row) : null;
    },
    getBookingBySessionRef: (sessionRef) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE payment_session_ref = ?`, sessionRef),
    getBookingByPaymentRef: (paymentRef) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE payment_ref = ?`, paymentRef),
    // Hash-first lookup with a guarded legacy-plaintext fallback and lazy backfill. `now` gates
    // tokens_expire_at in the same query as the match, and additionally requires
    // cancel_token_revoked_at IS NULL — an expired and a revoked token both fail exactly like an
    // unknown one, so no oracle distinguishes them. Operator tokens are never revoked, so they
    // carry no revocation check.
    async getBookingByCancelToken(token, now) {
      const key = await resolveTokenKey();
      const hash = await sha256Base64Url(token);
      const hashRow = await first(db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE cancel_token_hash = ? AND cancel_token_revoked_at IS NULL
           AND (tokens_expire_at IS NULL OR tokens_expire_at > ?)`,
      ).bind(hash, now).all<BookingRow>());
      if (hashRow) return hydrateBooking(hashRow, key);
      // Fallback for a row with cancel_token_hash IS NULL. Guarding on that column, not just
      // cancel_token = ?, closes a "present the leaked hash as a token" oracle: once a row has a
      // hash, this branch can never match it again, so a hash in a dump is never itself accepted.
      const legacyRow = await first(db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE cancel_token = ? AND cancel_token_hash IS NULL AND cancel_token_revoked_at IS NULL
           AND (tokens_expire_at IS NULL OR tokens_expire_at > ?)`,
      ).bind(token, now).all<BookingRow>());
      if (!legacyRow) return null;
      const enc = key ? await encryptToken(key, token) : null;
      // Re-guarded by cancel_token_hash IS NULL: a concurrent request racing this backfill just
      // no-ops here instead of clobbering whichever hash won.
      await db.prepare(
        `UPDATE bookings SET cancel_token_hash = ?, cancel_token_enc = ?, cancel_token = ?
         WHERE id = ? AND cancel_token_hash IS NULL`,
      ).bind(hash, enc, placeholderToken(), legacyRow.id).run();
      // legacyRow.cancel_token is the presented token, and cancel_token_enc was still NULL at
      // read time, so hydrateBooking's default already yields the right plaintext.
      return hydrateBooking(legacyRow, key);
    },
    async getBookingByOperatorToken(token, now) {
      const key = await resolveTokenKey();
      const hash = await sha256Base64Url(token);
      const hashRow = await first(db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE operator_token_hash = ? AND (tokens_expire_at IS NULL OR tokens_expire_at > ?)`,
      ).bind(hash, now).all<BookingRow>());
      if (hashRow) return hydrateBooking(hashRow, key);
      const legacyRow = await first(db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE operator_token = ? AND operator_token_hash IS NULL
           AND (tokens_expire_at IS NULL OR tokens_expire_at > ?)`,
      ).bind(token, now).all<BookingRow>());
      if (!legacyRow) return null;
      const enc = key ? await encryptToken(key, token) : null;
      await db.prepare(
        `UPDATE bookings SET operator_token_hash = ?, operator_token_enc = ?, operator_token = ?
         WHERE id = ? AND operator_token_hash IS NULL`,
      ).bind(hash, enc, placeholderToken(), legacyRow.id).run();
      return hydrateBooking(legacyRow, key);
    },
    async getBookingByOperatorTokenForRefundRecovery(token, now) {
      const key = await resolveTokenKey();
      const hash = await sha256Base64Url(token);
      const expiry = `(tokens_expire_at IS NULL OR tokens_expire_at > ?
        OR EXISTS (SELECT 1 FROM refund_operations
                   WHERE refund_operations.booking_id = bookings.id
                     AND refund_operations.status IN ('requested', 'failed')))`;
      const hashRow = await first(db.prepare(
        `SELECT ${bookingColumns} FROM bookings WHERE operator_token_hash = ? AND ${expiry}`,
      ).bind(hash, now).all<BookingRow>());
      if (hashRow) return hydrateBooking(hashRow, key);
      const legacyRow = await first(db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE operator_token = ? AND operator_token_hash IS NULL AND ${expiry}`,
      ).bind(token, now).all<BookingRow>());
      if (!legacyRow) return null;
      const enc = key ? await encryptToken(key, token) : null;
      await db.prepare(
        `UPDATE bookings SET operator_token_hash = ?, operator_token_enc = ?, operator_token = ?
         WHERE id = ? AND operator_token_hash IS NULL`,
      ).bind(hash, enc, placeholderToken(), legacyRow.id).run();
      return hydrateBooking(legacyRow, key);
    },
    async countReferencesForYear(prefix) {
      const row = await first(db.prepare(
        'SELECT COUNT(*) AS count FROM bookings WHERE reference LIKE ?',
      ).bind(`${prefix}%`).all<{ count: number }>());
      return Number(row?.count ?? 0);
    },
    async insertHold(input) {
      const holdIp = input.holdIp ?? null;
      const holdLimit = input.maxActiveHoldsForIp ?? null;
      // Every row written from here on gets only a hash (+ encrypted blob, if a key is
      // configured), never real plaintext in cancel_token/operator_token.
      const tokenColumns = await newTokenColumns(input);
      const result = await db.prepare(
        `INSERT INTO bookings (
          id, reference, service_slug, quantity, pickup_type, starts_at, ends_at, locale, price_minor,
          currency, status, hold_expires_at, cancel_token, operator_token, cancel_token_hash,
          operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at, hold_ip,
          meeting_point_id, meeting_point_label, metadata, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL OR (
          SELECT COUNT(*) FROM bookings
          WHERE hold_ip = ? AND status = 'hold' AND hold_expires_at >= ?
        ) < ?`,
      ).bind(
        input.id, input.reference, input.serviceSlug, input.quantity, input.pickupType,
        input.startsAt, input.endsAt, input.locale, input.priceMinor, input.currency, input.holdExpiresAt,
        tokenColumns.cancelTokenPlaceholder, tokenColumns.operatorTokenPlaceholder,
        tokenColumns.cancelTokenHash, tokenColumns.operatorTokenHash,
        tokenColumns.cancelTokenEnc, tokenColumns.operatorTokenEnc, tokenColumns.tokensExpireAt,
        holdIp, input.meetingPointId ?? null, input.meetingPointLabel ?? null,
        serializeBookingMetadata(input.metadata),
        input.createdAt, input.updatedAt,
        holdLimit, holdIp, input.createdAt, holdLimit,
      ).run();
      if (result.meta.changes === 0) throw new HoldLimitExceededError();
      const created = await oneBooking('SELECT ' + bookingColumns + ' FROM bookings WHERE id = ?', input.id);
      if (!created) throw new Error('Booking insert did not return a row');
      return created;
    },
    // Same per-IP hold-cap guard as insertHold, plus a capacity guard, both in one INSERT ...
    // SELECT's WHERE clause, so D1 makes check-then-insert atomic. Tests max concurrency at each
    // booking's start point, not a SUM over overlaps (mirrors core/occupancy.ts, avoiding false 409s).
    //
    // Only sees the bookings table: external Google Calendar events are folded in by checkSlot's
    // non-atomic pre-check, not by this statement.
    async insertHoldWithCapacity(input) {
      const holdIp = input.holdIp ?? null;
      const holdLimit = input.maxActiveHoldsForIp ?? null;
      const tokenColumns = await newTokenColumns(input);
      const result = await db.prepare(
        `INSERT INTO bookings (
          id, reference, service_slug, quantity, pickup_type, starts_at, ends_at, locale, price_minor,
          currency, status, hold_expires_at, cancel_token, operator_token, cancel_token_hash,
          operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at, hold_ip,
          occupancy_units, occupancy_ends_at, meeting_point_id, meeting_point_label, metadata, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (? IS NULL OR (
            SELECT COUNT(*) FROM bookings WHERE hold_ip = ? AND status = 'hold' AND hold_expires_at >= ?
          ) < ?)
          AND NOT EXISTS (
            SELECT 1 FROM (
              SELECT ? AS p
              UNION
              SELECT b1.starts_at AS p FROM bookings b1
                WHERE b1.status IN ('hold', 'confirmed')
                  AND (b1.status != 'hold' OR b1.hold_expires_at >= ?)
                  AND b1.starts_at >= ?
                  AND b1.starts_at < ?
                  AND COALESCE(b1.occupancy_ends_at, b1.ends_at) > ?
            ) pts
            WHERE (
              SELECT COALESCE(SUM(COALESCE(b2.occupancy_units, 1)), 0) FROM bookings b2
                WHERE b2.status IN ('hold', 'confirmed')
                  AND (b2.status != 'hold' OR b2.hold_expires_at >= ?)
                  AND b2.starts_at <= pts.p
                  AND COALESCE(b2.occupancy_ends_at, b2.ends_at) > pts.p
            ) + ? > MAX(0, COALESCE(
              (SELECT capacity FROM day_overrides WHERE date = ?),
              (SELECT capacity FROM capacity_defaults WHERE from_date <= ? ORDER BY from_date DESC LIMIT 1),
              ?
            ))
          )`,
      ).bind(
        input.id, input.reference, input.serviceSlug, input.quantity, input.pickupType,
        input.startsAt, input.endsAt, input.locale, input.priceMinor, input.currency, input.holdExpiresAt,
        tokenColumns.cancelTokenPlaceholder, tokenColumns.operatorTokenPlaceholder,
        tokenColumns.cancelTokenHash, tokenColumns.operatorTokenHash,
        tokenColumns.cancelTokenEnc, tokenColumns.operatorTokenEnc, tokenColumns.tokensExpireAt,
        holdIp, input.occupancyUnits, input.occupancyEndsAt,
        input.meetingPointId ?? null, input.meetingPointLabel ?? null,
        serializeBookingMetadata(input.metadata),
        input.createdAt, input.updatedAt,
        holdLimit, holdIp, input.createdAt, holdLimit,
        // Candidate points: the request's own start, then each active overlapping booking's own start.
        input.startsAt,
        input.createdAt, input.startsAt, input.occupancyEndsAt, input.startsAt,
        // sum-at-point (b2) + requestedUnits > capacity resolution.
        input.createdAt,
        input.occupancyUnits,
        input.localDate, input.localDate, input.defaultCapacity,
      ).run();
      if (result.meta.changes === 0) {
        // Reclassify a losing write: the hold-ip cap throws (matching insertHold's contract),
        // anything else is a capacity loss reported as null. This re-check is for error
        // classification only — the atomic WHERE clause already made the authoritative decision.
        if (holdLimit !== null) {
          const row = await first(db.prepare(
            `SELECT COUNT(*) AS count FROM bookings WHERE hold_ip = ? AND status = 'hold' AND hold_expires_at >= ?`,
          ).bind(holdIp, input.createdAt).all<{ count: number }>());
          if (Number(row?.count ?? 0) >= holdLimit) throw new HoldLimitExceededError();
        }
        return null;
      }
      const created = await oneBooking('SELECT ' + bookingColumns + ' FROM bookings WHERE id = ?', input.id);
      if (!created) throw new Error('Booking insert did not return a row');
      return created;
    },
    async updateBooking(id, patch) {
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) {
        const unchanged = await oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
        if (!unchanged) throw new Error('Booking not found');
        return unchanged;
      }
      const columnMap: Record<string, string> = {
        pickupAddress: 'pickup_address', customerName: 'customer_name',
        customerEmail: 'customer_email', customerPhone: 'customer_phone', startsAt: 'starts_at',
        endsAt: 'ends_at', holdExpiresAt: 'hold_expires_at', paymentSessionRef: 'payment_session_ref',
        paymentRef: 'payment_ref', calendarEventId: 'calendar_event_id',
        cancelledAt: 'cancelled_at', cancelledBy: 'cancelled_by', rescheduledFrom: 'rescheduled_from',
        updatedAt: 'updated_at',
      };
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported booking update field');
      const values = entries.map(([, value]) => value);
      await guardDuplicatePaymentRef(patch.paymentRef, () =>
        db.prepare(`UPDATE bookings SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
          .bind(...values, id).run());
      const updated = await oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      if (!updated) throw new Error('Booking not found');
      return updated;
    },
    async transitionToCancelled(id, input) {
      const { casPredicate, casParams, updateStmt } = cancellationUpdate(id, input);
      const seeds = input.mutationSideEffects ?? [];
      if (seeds.length === 0) {
        const result = await updateStmt.run();
        if (result.meta.changes === 0) return null;
        return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      }
      const results = await db.batch([mutationSideEffectInsert(id, seeds, input.updatedAt, casPredicate, casParams), updateStmt]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async upsertRefundOperationAndTransitionToCancelled(refund, id, input) {
      const { casPredicate, casParams, updateStmt } = cancellationUpdate(id, input);
      const seeds = input.mutationSideEffects ?? [];
      const statements = [stripeRefundReconciliationStmt(refund)];
      if (seeds.length > 0) statements.push(mutationSideEffectInsert(id, seeds, input.updatedAt, casPredicate, casParams));
      statements.push(updateStmt);
      const results = await db.batch(statements);
      if ((results[results.length - 1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async transitionToNoShow(id, input) {
      const placeholders = input.expectedStatusIn.map(() => '?').join(', ');
      const casPredicate = `id = ? AND status IN (${placeholders})`;
      const casParams = [id, ...input.expectedStatusIn];
      const updateStmt = db.prepare(
        `UPDATE bookings SET status = 'no_show', updated_at = ?,
           cancel_token_revoked_at = COALESCE(cancel_token_revoked_at, ?)
         WHERE ${casPredicate}`,
      ).bind(input.updatedAt, input.updatedAt, ...casParams);
      const seeds = input.mutationSideEffects ?? [];
      if (seeds.length === 0) {
        const result = await updateStmt.run();
        if (result.meta.changes === 0) return null;
        return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      }
      const results = await db.batch([mutationSideEffectInsert(id, seeds, input.updatedAt, casPredicate, casParams), updateStmt]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async transitionToConfirmed(id, input) {
      const { expectedStatusIn, updatedAt, ...patch } = input;
      const columnMap: Record<string, string> = {
        paymentRef: 'payment_ref', customerName: 'customer_name',
        customerEmail: 'customer_email', customerPhone: 'customer_phone', pickupAddress: 'pickup_address',
      };
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported confirmation field');
      const placeholders = expectedStatusIn.map(() => '?').join(', ');
      const setClauses = [`status = 'confirmed'`, 'hold_expires_at = NULL', ...columns.map((column) => `${column} = ?`), 'updated_at = ?'];
      const result = await guardDuplicatePaymentRef(patch.paymentRef, () =>
        db.prepare(
          `UPDATE bookings SET ${setClauses.join(', ')} WHERE id = ? AND status IN (${placeholders})`,
        ).bind(...entries.map(([, value]) => value), updatedAt, id, ...expectedStatusIn).run());
      if (result.meta.changes === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async confirmWithSideEffectOperations(id, input) {
      const { expectedStatusIn, updatedAt, leaseToken, oversold, eventSeeds, emailRecipients, ...patch } = input;
      const columnMap: Record<string, string> = {
        paymentRef: 'payment_ref', customerName: 'customer_name',
        customerEmail: 'customer_email', customerPhone: 'customer_phone', pickupAddress: 'pickup_address',
      };
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported confirmation field');
      const placeholders = expectedStatusIn.map(() => '?').join(', ');
      const setClauses = [`status = 'confirmed'`, 'hold_expires_at = NULL', ...columns.map((column) => `${column} = ?`), 'updated_at = ?'];
      const operation = (
        identity: SideEffectOperationIdentity,
        eventPayloadJson: string | null,
        status: SideEffectOperationStatus,
        providerResultId: string | null,
        resolvedAt: string | null,
      ) => db.prepare(
        `INSERT INTO side_effect_operations (
           booking_id, family, name, event, discriminator, event_payload_json,
           status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM bookings
           WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(id, ...sideEffectIdentityParams(identity), eventPayloadJson, status, providerResultId, resolvedAt, updatedAt, updatedAt, id, leaseToken);
      // Each subscriber's row shares this exact batch, so it can
      // never exist without the confirmation it's owed by, nor vice versa.
      const eventOperations = (eventSeeds ?? []).map((seed) => operation(seed, seed.eventPayloadJson, 'pending', null, null));
      // Split rows (one per recipient) for a split-capable provider, otherwise the single legacy
      // combined row. This is a brand-new confirmation, so no row of either shape already exists
      // here — the "legacy row wins" guard only matters in the repair path below.
      const emailOperations = emailRecipients && emailRecipients.length > 0
        ? emailRecipients.map((recipient) => operation({ family: 'email', name: recipient, event: 'booking.confirmed' }, null, 'pending', null, null))
        : [operation({ family: 'email_confirmation' }, null, 'pending', null, null)];
      const results = await guardDuplicatePaymentRef(patch.paymentRef, () =>
        db.batch([
          db.prepare(
            `UPDATE bookings SET ${setClauses.join(', ')}
             WHERE id = ? AND status IN (${placeholders}) AND confirmation_lease_token = ?`,
          ).bind(...entries.map(([, value]) => value), updatedAt, id, ...expectedStatusIn, leaseToken),
          operation({ family: 'calendar_create' }, null, 'pending', null, null),
          ...emailOperations,
          ...(oversold ? [operation({ family: 'oversell' }, null, 'succeeded', 'capacity_exceeded', updatedAt)] : []),
          ...eventOperations,
        ]));
      if ((results[0]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async applyConfirmedPaymentDetails(id, patch, leaseToken, updatedAt) {
      const columnMap: Record<string, string> = {
        paymentRef: 'payment_ref', customerName: 'customer_name',
        customerEmail: 'customer_email', customerPhone: 'customer_phone', pickupAddress: 'pickup_address',
      };
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return false;
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported confirmation field');
      const result = await guardDuplicatePaymentRef(patch.paymentRef, () =>
        db.prepare(
          `UPDATE bookings SET ${columns.map((column) => `${column} = COALESCE(${column}, ?)`).join(', ')}, updated_at = ?
           WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ?`,
        ).bind(...entries.map(([, value]) => value), updatedAt, id, leaseToken).run());
      return result.meta.changes > 0;
    },
    async ensureConfirmationSideEffectOperations(id, leaseToken, now, eventSeeds, emailRecipients) {
      const calendarOperation = db.prepare(
        `INSERT INTO side_effect_operations (
           booking_id, family, name, event, discriminator, event_payload_json,
           status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
         )
         SELECT ?, 'calendar_create', NULL, NULL, NULL, NULL,
           CASE WHEN calendar_event_id IS NOT NULL THEN 'succeeded' ELSE 'pending' END,
           calendar_event_id,
           0, NULL, CASE WHEN calendar_event_id IS NOT NULL THEN ? ELSE NULL END, NULL, ?, ?
         FROM bookings
         WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ?
         ON CONFLICT DO NOTHING`,
      ).bind(id, now, now, now, id, leaseToken);
      // Always 'pending'; ON CONFLICT DO NOTHING leaves an already-succeeded legacy row alone.
      //
      // Same split-vs-combined choice as confirmWithSideEffectOperations, for legacy repair. A
      // split row is only inserted when no legacy combined email_confirmation row already exists
      // (the NOT EXISTS guard below) — otherwise an upgrade to a split-capable provider could
      // resend a message the combined attempt already delivered.
      const emailIdentities: SideEffectOperationIdentity[] = emailRecipients && emailRecipients.length > 0
        ? emailRecipients.map((recipient) => ({ family: 'email', name: recipient, event: 'booking.confirmed' }))
        : [{ family: 'email_confirmation' }];
      const emailGuard = emailRecipients && emailRecipients.length > 0
        ? `AND NOT EXISTS (SELECT 1 FROM side_effect_operations WHERE booking_id = ? AND family = 'email_confirmation')`
        : '';
      const emailOperations = emailIdentities.map((identity) => db.prepare(
        `INSERT INTO side_effect_operations (
           booking_id, family, name, event, discriminator, event_payload_json,
           status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, NULL, 'pending', NULL, 0, NULL, NULL, NULL, ?, ?
         FROM bookings
         WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ? ${emailGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(id, ...sideEffectIdentityParams(identity), now, now, id, leaseToken, ...(emailGuard ? [id] : [])));
      // A legacy confirmed booking's subscriber rows, created lazily when a hook/webhook was
      // registered after confirmation. Always inserted 'pending' (unlike the calendar row above,
      // which reads its outcome off calendar_event_id), and no-ops once the row exists.
      const eventOperations = (eventSeeds ?? []).map((seed) => db.prepare(
        `INSERT INTO side_effect_operations (
           booking_id, family, name, event, discriminator, event_payload_json,
           status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, NULL, NULL, NULL, ?, ?
         FROM bookings
         WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ?
         ON CONFLICT DO NOTHING`,
      ).bind(id, ...sideEffectIdentityParams(seed), seed.eventPayloadJson, now, now, id, leaseToken));
      await db.batch([
        calendarOperation,
        ...emailOperations,
        ...eventOperations,
      ]);
    },
    async recordBookingEventOperations(bookingId, seeds, now) {
      if (seeds.length === 0) return;
      await db.batch(seeds.map((seed) => db.prepare(
        `INSERT INTO side_effect_operations (
           booking_id, family, name, event, discriminator, event_payload_json,
           status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, 0, NULL, NULL, NULL, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(bookingId, ...sideEffectIdentityParams(seed), seed.eventPayloadJson, now, now)));
    },
    async listSideEffectOperations(bookingId) {
      const result = await db.prepare(
        `SELECT ${sideEffectOperationColumns} FROM side_effect_operations WHERE booking_id = ? ORDER BY ${sideEffectIdentityOrder}`,
      ).bind(bookingId).all<SideEffectOperationRow>();
      return result.results.map(mapSideEffectOperation);
    },
    // Returning attempt_count from the UPDATE keeps failure classification tied to the claim that
    // actually won, even if another drain changed the row after the caller's earlier list read.
    async claimSideEffectOperation(bookingId, identity, leaseToken, attemptedAt) {
      const result = await db.prepare(
        `UPDATE side_effect_operations
         SET status = 'in_flight', attempt_count = attempt_count + 1, attempted_at = ?, error = NULL, updated_at = ?
         WHERE booking_id = ? AND ${sideEffectIdentityMatch} AND status NOT IN ('succeeded', 'abandoned') AND attempt_count < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND EXISTS (
             SELECT 1 FROM bookings WHERE id = ? AND confirmation_lease_token = ?
           )
         RETURNING attempt_count`,
      ).bind(attemptedAt, attemptedAt, bookingId, ...sideEffectIdentityParams(identity), SIDE_EFFECT_MAX_ATTEMPTS, attemptedAt, bookingId, leaseToken)
        .all<{ attempt_count: number }>();
      return result.results[0]?.attempt_count ?? null;
    },
    // Admin retry bypass: same lease-ownership predicate, no next_attempt_at gate, no
    // attempt-count cap (an 'abandoned' row is claimable). A live in_flight claim is still
    // refused, but since only the current lease holder can reach this call, an in_flight row
    // here can only be this same request's own earlier claim.
    async claimSideEffectOperationForRetry(bookingId, identity, leaseToken, attemptedAt) {
      const result = await db.prepare(
        `UPDATE side_effect_operations
         SET status = 'in_flight', attempt_count = attempt_count + 1, attempted_at = ?, error = NULL, updated_at = ?
         WHERE booking_id = ? AND ${sideEffectIdentityMatch} AND status != 'succeeded'
           AND EXISTS (
             SELECT 1 FROM bookings WHERE id = ? AND confirmation_lease_token = ?
           )
         RETURNING attempt_count`,
      ).bind(attemptedAt, attemptedAt, bookingId, ...sideEffectIdentityParams(identity), bookingId, leaseToken)
        .all<{ attempt_count: number }>();
      return result.results[0]?.attempt_count ?? null;
    },
    // Delivery state lives on the operation row, not the booking row. Only calendar_event_id is
    // written back, needed to patch or delete the event after the outbox row is pruned.
    async resolveSideEffectOperation(input) {
      const rowUpdate = db.prepare(
        `UPDATE side_effect_operations
         SET status = ?, provider_result_id = ?, error = ?, resolved_at = ?, updated_at = ?,
             failure_started_at = CASE WHEN ? = 'failed' THEN COALESCE(failure_started_at, ?) ELSE NULL END,
             next_attempt_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
         WHERE booking_id = ? AND ${sideEffectIdentityMatch} AND status NOT IN ('succeeded', 'abandoned')
           AND EXISTS (
             SELECT 1 FROM bookings WHERE id = ? AND confirmation_lease_token = ?
           )`,
      ).bind(
        input.status, input.providerResultId ?? null, input.error ?? null, input.resolvedAt, input.resolvedAt,
        input.status, input.resolvedAt,
        input.status, input.nextAttemptAt ?? null,
        input.bookingId, ...sideEffectIdentityParams(input.identity), input.bookingId, input.leaseToken,
      );
      const bookingUpdate = db.prepare(
        `UPDATE bookings SET
           calendar_event_id = CASE WHEN ? = 'calendar_create' THEN ? ELSE calendar_event_id END,
           updated_at = ?
         WHERE id = ? AND confirmation_lease_token = ?`,
      ).bind(
        input.identity.family, input.identity.family === 'calendar_create' ? (input.providerResultId ?? null) : null,
        input.resolvedAt,
        input.bookingId, input.leaseToken,
      );
      const result = await db.batch([rowUpdate, bookingUpdate]);
      return (result[0]?.meta.changes ?? 0) > 0;
    },
    // staleBefore is computed from the caller's own attemptedAt, not a fresh clock read, keeping
    // this a pure function of its inputs. The returned count comes from the winning UPDATE, not
    // a stale list snapshot, so the tenth execution can never be resolved as an earlier attempt.
    async claimMutationSideEffectOperation(bookingId, identity, attemptedAt) {
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const result = await db.prepare(
        `UPDATE side_effect_operations
         SET status = 'in_flight', attempt_count = attempt_count + 1, attempted_at = ?, error = NULL, updated_at = ?
         WHERE booking_id = ? AND ${sideEffectIdentityMatch} AND attempt_count < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (status IN ('pending', 'failed') OR (status = 'in_flight' AND attempted_at < ?))
         RETURNING attempt_count`,
      ).bind(attemptedAt, attemptedAt, bookingId, ...sideEffectIdentityParams(identity), SIDE_EFFECT_MAX_ATTEMPTS, attemptedAt, staleBefore)
        .all<{ attempt_count: number }>();
      return result.results[0]?.attempt_count ?? null;
    },
    // Admin retry bypass: no next_attempt_at gate, no attempt-count cap, but a live in_flight
    // lease (attempted_at not yet stale) is still refused.
    async claimMutationSideEffectOperationForRetry(bookingId, identity, attemptedAt) {
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const result = await db.prepare(
        `UPDATE side_effect_operations
         SET status = 'in_flight', attempt_count = attempt_count + 1, attempted_at = ?, error = NULL, updated_at = ?
         WHERE booking_id = ? AND ${sideEffectIdentityMatch}
           AND (status IN ('pending', 'failed', 'abandoned') OR (status = 'in_flight' AND attempted_at < ?))
         RETURNING attempt_count`,
      ).bind(attemptedAt, attemptedAt, bookingId, ...sideEffectIdentityParams(identity), staleBefore)
        .all<{ attempt_count: number }>();
      return result.results[0]?.attempt_count ?? null;
    },
    async resolveMutationSideEffectOperation(input) {
      const result = await db.prepare(
        `UPDATE side_effect_operations
         SET status = ?, provider_result_id = ?, error = ?, resolved_at = ?, updated_at = ?,
             failure_started_at = CASE WHEN ? = 'failed' THEN COALESCE(failure_started_at, ?) ELSE NULL END,
             next_attempt_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
         WHERE booking_id = ? AND ${sideEffectIdentityMatch} AND status = 'in_flight' AND attempted_at = ?`,
      ).bind(
        input.status, input.providerResultId ?? null, input.error ?? null, input.resolvedAt, input.resolvedAt,
        input.status, input.resolvedAt,
        input.status, input.nextAttemptAt ?? null,
        input.bookingId, ...sideEffectIdentityParams(input.identity), input.claimedAt,
      ).run();
      return result.meta.changes > 0;
    },
    async transitionReschedule(id, input) {
      const casPredicate = 'id = ? AND status = ? AND starts_at = ?';
      const casParams = [id, input.expectedStatus, input.expectedStartsAt];
      // The version increment and its outbox suffix must share the CAS batch, so a loser cannot
      // consume a version or leave delivery debt for a move that did not occur.
      const updateStmt = db.prepare(
        `UPDATE bookings SET starts_at = ?, ends_at = ?, rescheduled_from = ?, updated_at = ?,
           tokens_expire_at = COALESCE(?, tokens_expire_at),
           reschedule_transition_version = reschedule_transition_version + 1
         WHERE ${casPredicate}`,
      ).bind(
        input.startsAt, input.endsAt, input.rescheduledFrom, input.updatedAt, input.tokensExpireAt ?? null,
        ...casParams,
      );
      const seeds = input.mutationSideEffects ?? [];
      if (seeds.length === 0) {
        const result = await updateStmt.run();
        if (result.meta.changes === 0) return null;
        return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      }
      const results = await db.batch([
        mutationSideEffectInsert(id, seeds, input.updatedAt, casPredicate, casParams, true),
        updateStmt,
      ]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    // transitionReschedule's CAS plus the same max-concurrency capacity guard as
    // insertHoldWithCapacity, with `id != ?` excluding this booking's own current row from both
    // the candidate points and the covering-sum subqueries — otherwise a move into a window this
    // booking already occupies would count itself against its own request.
    //
    // occupancy_units is re-asserted on every reschedule, opportunistically self-healing a
    // legacy NULL row the first time it's moved instead of leaving it undercounted as 1 unit.
    async rescheduleWithCapacity(id, input) {
      // Factored out so the batched outbox INSERT can re-check this exact condition (capacity
      // guard included, not just status/starts_at) via WHERE EXISTS before the UPDATE runs.
      // One source of truth for both the WHERE text and its params.
      const casPredicate = `id = ? AND status = ? AND starts_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM (
               SELECT ? AS p
               UNION
               SELECT b1.starts_at AS p FROM bookings b1
                 WHERE b1.id != ?
                   AND b1.status IN ('hold', 'confirmed')
                   AND (b1.status != 'hold' OR b1.hold_expires_at >= ?)
                   AND b1.starts_at >= ?
                   AND b1.starts_at < ?
                   AND COALESCE(b1.occupancy_ends_at, b1.ends_at) > ?
             ) pts
             WHERE (
               SELECT COALESCE(SUM(COALESCE(b2.occupancy_units, 1)), 0) FROM bookings b2
                 WHERE b2.id != ?
                   AND b2.status IN ('hold', 'confirmed')
                   AND (b2.status != 'hold' OR b2.hold_expires_at >= ?)
                   AND b2.starts_at <= pts.p
                   AND COALESCE(b2.occupancy_ends_at, b2.ends_at) > pts.p
             ) + ? > MAX(0, COALESCE(
               (SELECT capacity FROM day_overrides WHERE date = ?),
               (SELECT capacity FROM capacity_defaults WHERE from_date <= ? ORDER BY from_date DESC LIMIT 1),
               ?
             ))
           )`;
      const casParams = [
        id, input.expectedStatus, input.expectedStartsAt,
        // Candidate points, self-excluded: the request's own start plus each other active
        // overlapping booking's start.
        input.startsAt,
        id, input.now, input.startsAt, input.occupancyEndsAt, input.startsAt,
        // sum-at-point (b2, self-excluded) + requestedUnits > capacity resolution.
        id, input.now,
        input.occupancyUnits,
        input.localDate, input.localDate, input.defaultCapacity,
      ];
      const updateStmt = db.prepare(
        `UPDATE bookings
         SET starts_at = ?, ends_at = ?, rescheduled_from = ?, occupancy_units = ?, occupancy_ends_at = ?, updated_at = ?,
             tokens_expire_at = COALESCE(?, tokens_expire_at),
             reschedule_transition_version = reschedule_transition_version + 1
         WHERE ${casPredicate}`,
      ).bind(
        input.startsAt, input.endsAt, input.rescheduledFrom, input.occupancyUnits, input.occupancyEndsAt, input.updatedAt,
        input.tokensExpireAt ?? null,
        ...casParams,
      );
      const seeds = input.mutationSideEffects ?? [];
      if (seeds.length === 0) {
        const result = await updateStmt.run();
        if (result.meta.changes === 0) return null;
        return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      }
      const results = await db.batch([mutationSideEffectInsert(id, seeds, input.updatedAt, casPredicate, casParams, true), updateStmt]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    // Not hydrated (plain mapBooking): internal occupancy math that can span many rows and never
    // renders/emails a token — hydrating would cost a per-row AES-GCM decrypt for nothing.
    async listOccupancyBookings(from, to) {
      const result = await db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE starts_at < ? AND starts_at >= ? AND status IN ('hold', 'confirmed')
         ORDER BY starts_at`,
      ).bind(to, from).all<BookingRow>();
      return result.results.map(mapBooking);
    },
    // Hydrated: the admin dashboard renders each row's operatorToken as a manage-link href.
    async listUpcoming(now) {
      const result = await db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE starts_at >= ? AND (status = 'confirmed' OR (status = 'hold' AND hold_expires_at > ?))
         ORDER BY starts_at`,
      ).bind(now, now).all<BookingRow>();
      const key = await resolveTokenKey();
      return Promise.all(result.results.map((row) => hydrateBooking(row, key)));
    },
    // Hydrated: the admin dashboard renders each row's operatorToken as a manage-link href.
    async listAllFrom(startsAtFrom) {
      const result = await db.prepare(`SELECT ${bookingColumns} FROM bookings WHERE starts_at >= ? ORDER BY starts_at`).bind(startsAtFrom).all<BookingRow>();
      const key = await resolveTokenKey();
      return Promise.all(result.results.map((row) => hydrateBooking(row, key)));
    },
    async getDayOverride(date) {
      const row = await first(db.prepare('SELECT date, capacity, reason FROM day_overrides WHERE date = ?').bind(date).all<DayCapacityOverride>());
      return row ? { date: row.date, capacity: Number(row.capacity), reason: row.reason ?? null } : null;
    },
    async listDayOverrides(from, to) {
      const result = await db.prepare(
        'SELECT date, capacity, reason FROM day_overrides WHERE date >= ? AND date <= ? ORDER BY date',
      ).bind(from, to).all<DayCapacityOverride>();
      return result.results.map((row) => ({ date: row.date, capacity: Number(row.capacity), reason: row.reason ?? null }));
    },
    async upsertDayOverride(date, capacity, reason) {
      await db.prepare(
        `INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET capacity = excluded.capacity, reason = excluded.reason`,
      ).bind(date, capacity, reason).run();
    },
    async deleteDayOverride(date) {
      await db.prepare('DELETE FROM day_overrides WHERE date = ?').bind(date).run();
    },
    // Bounded by a 366-day cap so a single db.batch() call never risks exceeding D1's per-batch
    // statement limit. One history row per date rides the same batch as its override write.
    async upsertDayOverrides(dates, capacity, reason, audit) {
      if (dates.length === 0) return;
      const value = JSON.stringify({ capacity, reason });
      const statements = dates.flatMap((date) => [
        db.prepare(
          `INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET capacity = excluded.capacity, reason = excluded.reason`,
        ).bind(date, capacity, reason),
        adminHistoryInsert('day_override', date, 'upsert', value, audit),
      ]);
      await db.batch(statements);
    },
    async deleteDayOverrides(dates, audit) {
      if (dates.length === 0) return;
      const statements = dates.flatMap((date) => [
        db.prepare('DELETE FROM day_overrides WHERE date = ?').bind(date),
        adminHistoryInsert('day_override', date, 'delete', null, audit),
      ]);
      await db.batch(statements);
    },
    async listCapacityDefaults() {
      const result = await db.prepare(
        'SELECT from_date, capacity, reason FROM capacity_defaults ORDER BY from_date',
      ).all<{ from_date: string; capacity: number; reason: string | null }>();
      return result.results.map((row) => ({ fromDate: row.from_date, capacity: Number(row.capacity), reason: row.reason ?? null }));
    },
    async upsertCapacityDefault(fromDate, capacity, reason, audit) {
      const value = JSON.stringify({ capacity, reason });
      await db.batch([
        db.prepare(
          `INSERT INTO capacity_defaults (from_date, capacity, reason) VALUES (?, ?, ?)
           ON CONFLICT(from_date) DO UPDATE SET capacity = excluded.capacity, reason = excluded.reason`,
        ).bind(fromDate, capacity, reason),
        adminHistoryInsert('capacity_default', fromDate, 'upsert', value, audit),
      ]);
    },
    async deleteCapacityDefault(fromDate, audit) {
      await db.batch([
        db.prepare('DELETE FROM capacity_defaults WHERE from_date = ?').bind(fromDate),
        adminHistoryInsert('capacity_default', fromDate, 'delete', null, audit),
      ]);
    },
    async listSettings() {
      const result = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
      return Object.fromEntries(result.results.map((row) => [row.key, row.value]));
    },
    async upsertSetting(key, value) {
      await db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).bind(key, value).run();
    },
    async deleteSetting(key, audit) {
      await db.batch([
        db.prepare('DELETE FROM settings WHERE key = ?').bind(key),
        adminHistoryInsert('setting', key, 'delete', null, audit),
      ]);
    },
    async applySettingsBatch(operations, audit) {
      if (operations.length === 0) return;
      // D1's batch() runs its statements in an implicit transaction — if any fails, none commit.
      const statements = operations.flatMap((operation) => operation.type === 'upsert'
        ? [
          db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(operation.key, operation.value),
          adminHistoryInsert('setting', operation.key, 'upsert', operation.value, audit),
        ]
        : [
          db.prepare('DELETE FROM settings WHERE key = ?').bind(operation.key),
          adminHistoryInsert('setting', operation.key, 'delete', null, audit),
        ]);
      await db.batch(statements);
    },
    async listAdminChangeHistory(limit) {
      const result = await db.prepare(
        'SELECT id, domain, item_key, action, value, actor, changed_at FROM admin_change_history ORDER BY id DESC LIMIT ?',
      ).bind(limit).all<{ id: number; domain: AdminChangeDomain; item_key: string; action: AdminChangeAction; value: string | null; actor: string | null; changed_at: string }>();
      return result.results.map((row) => ({
        id: row.id,
        domain: row.domain,
        itemKey: row.item_key,
        action: row.action,
        value: row.value ?? null,
        actor: row.actor ?? null,
        changedAt: row.changed_at,
      }));
    },
    async claimRefundOperation(input) {
      // WHERE NOT EXISTS makes this a single-statement compare-and-set, backed by the
      // UNIQUE(booking_id) constraint as the real safety net under concurrent writers.
      const result = await db.prepare(
        `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, requested_at)
         SELECT ?, ?, ?, ?, 'requested', ?
         WHERE NOT EXISTS (SELECT 1 FROM refund_operations WHERE booking_id = ?)`,
      ).bind(input.id, input.bookingId, input.paymentIntent, input.choice, input.requestedAt, input.bookingId).run();
      return result.meta.changes > 0;
    },
    async getRefundOperationByBookingId(bookingId) {
      const row = await first(db.prepare(
        `SELECT ${refundOperationColumns} FROM refund_operations WHERE booking_id = ?`,
      ).bind(bookingId).all<RefundOperationRow>());
      return row ? mapRefundOperation(row) : null;
    },
    async resolveRefundOperation(id, input) {
      // WHERE status != 'succeeded' is the CAS guard: once a row succeeds, it's terminal, so no
      // later resolve call can regress its status or overwrite its refund id/amount. Always
      // clears any execution lease, harmless no-op if none was held.
      await db.prepare(
        `UPDATE refund_operations SET status = ?, stripe_refund_id = ?, amount_cents = ?, error = ?, resolved_at = ?,
           execution_claim_token = NULL, execution_claim_until = NULL,
           failure_started_at = CASE WHEN ? = 'failed' THEN COALESCE(failure_started_at, ?) ELSE NULL END,
           next_attempt_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
         WHERE id = ? AND status != 'succeeded'`,
      ).bind(
        input.status, input.stripeRefundId ?? null, input.amountCents ?? null, input.error ?? null, input.resolvedAt,
        input.status, input.resolvedAt,
        input.status, input.nextAttemptAt ?? null,
        id,
      ).run();
    },
    async deleteRefundOperation(id) {
      await db.prepare("DELETE FROM refund_operations WHERE id = ? AND status = 'requested'").bind(id).run();
    },
    async upsertRefundOperation(input) {
      await refundOperationUpsertStmt(input).run();
    },
    async reconcileStripeRefundOperation(input) {
      await stripeRefundReconciliationStmt(input).run();
    },

    // ---- Autonomous reconciliation ----------------------------------------------------

    async claimRefundExecution(id, attemptedAt) {
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const result = await db.prepare(
        `UPDATE refund_operations
         SET status = 'in_flight', attempt_count = attempt_count + 1, attempted_at = ?, error = NULL
         WHERE id = ? AND attempt_count < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (status IN ('requested', 'failed') OR (status = 'in_flight' AND attempted_at < ?))
         RETURNING attempt_count`,
      ).bind(attemptedAt, id, SIDE_EFFECT_MAX_ATTEMPTS, attemptedAt, staleBefore).all<{ attempt_count: number }>();
      return result.results[0]?.attempt_count ?? null;
    },
    async claimRefundExecutionForRetry(id, attemptedAt) {
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const result = await db.prepare(
        `UPDATE refund_operations
         SET status = 'in_flight', attempt_count = attempt_count + 1, attempted_at = ?, error = NULL
         WHERE id = ?
           AND (status IN ('requested', 'failed', 'abandoned') OR (status = 'in_flight' AND attempted_at < ?))
         RETURNING attempt_count`,
      ).bind(attemptedAt, id, staleBefore).all<{ attempt_count: number }>();
      return result.results[0]?.attempt_count ?? null;
    },

    async listSideEffectExecutionCandidates(now, staleBefore, limit) {
      const result = await db.prepare(
        `SELECT ${sideEffectOperationColumns} FROM side_effect_operations
         WHERE family != 'oversell' AND attempt_count < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (
             status = 'pending'
             OR (status = 'in_flight' AND attempted_at < ?)
             OR (status = 'failed' AND (
               attempted_at IS NULL
               OR datetime(attempted_at, '+' || CASE
                 WHEN attempt_count <= 1 THEN 5
                 WHEN attempt_count = 2 THEN 10
                 WHEN attempt_count = 3 THEN 20
                 WHEN attempt_count = 4 THEN 40
                 ELSE 60 END || ' minutes') <= datetime(?)
             ))
           )
         ORDER BY COALESCE(next_attempt_at, attempted_at, created_at), booking_id, ${sideEffectIdentityOrder}
         LIMIT ?`,
      ).bind(SIDE_EFFECT_MAX_ATTEMPTS, now, staleBefore, now, limit).all<SideEffectOperationRow>();
      return result.results.map(mapSideEffectOperation);
    },
    async listRefundExecutionCandidateBookingIds(now, staleBefore, limit) {
      const result = await db.prepare(
        `SELECT booking_id FROM refund_operations
         WHERE attempt_count < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (status IN ('requested', 'failed') OR (status = 'in_flight' AND attempted_at < ?))
         ORDER BY COALESCE(next_attempt_at, attempted_at, requested_at), booking_id
         LIMIT ?`,
      ).bind(SIDE_EFFECT_MAX_ATTEMPTS, now, staleBefore, limit).all<{ booking_id: string }>();
      return result.results.map((row) => row.booking_id);
    },
    async listSideEffectIncidentCandidateBookingIds(failureDueBefore, limit) {
      const result = await db.prepare(
        `SELECT booking_id FROM side_effect_operations
         WHERE (status = 'abandoned' OR (status = 'failed' AND failure_started_at <= ?))
           AND NOT EXISTS (
             SELECT 1 FROM operational_incidents
             WHERE source_type = 'side_effect'
               AND source_key = ${sideEffectSourceKeySql}
           )
         GROUP BY booking_id
         ORDER BY MIN(updated_at), booking_id
         LIMIT ?`,
      ).bind(failureDueBefore, limit).all<{ booking_id: string }>();
      return result.results.map((row) => row.booking_id);
    },
    async listRefundIncidentCandidateBookingIds(limit) {
      const result = await db.prepare(
        `SELECT refund_operations.booking_id FROM refund_operations
         JOIN bookings ON bookings.id = refund_operations.booking_id
         WHERE (refund_operations.status IN ('failed', 'abandoned') OR bookings.status != 'cancelled')
           AND refund_operations.status != 'succeeded'
           AND NOT EXISTS (
             SELECT 1 FROM operational_incidents
             WHERE source_type = 'refund' AND source_key = refund_operations.booking_id
           )
         ORDER BY COALESCE(refund_operations.resolved_at, refund_operations.requested_at), refund_operations.booking_id
         LIMIT ?`,
      ).bind(limit).all<{ booking_id: string }>();
      return result.results.map((row) => row.booking_id);
    },
    async listIncidentReprojectionCandidates(limit) {
      const result = await db.prepare(
        `SELECT ${operationalIncidentColumns} FROM operational_incidents
         WHERE (status = 'open' OR (status = 'resolved' AND resolution_kind = 'manual'))
           AND (
             (source_type = 'side_effect' AND EXISTS (
               SELECT 1 FROM side_effect_operations
               WHERE source_key = ${sideEffectSourceKeySql}
                 AND side_effect_operations.updated_at != operational_incidents.source_updated_at
             ))
             OR (source_type = 'refund' AND (
               NOT EXISTS (SELECT 1 FROM refund_operations WHERE booking_id = operational_incidents.source_key)
               OR EXISTS (
                 SELECT 1 FROM refund_operations
                 WHERE booking_id = operational_incidents.source_key
                   AND COALESCE(resolved_at, requested_at) != operational_incidents.source_updated_at
               )
             ))
           )
         ORDER BY last_detected_at, id
         LIMIT ?`,
      ).bind(limit).all<OperationalIncidentRow>();
      return result.results.map(mapOperationalIncident);
    },
    async listUnreportedOversellMarkers(limit) {
      const result = await db.prepare(
        `SELECT ${sideEffectOperationColumns} FROM side_effect_operations
         WHERE family = 'oversell' AND status = 'succeeded'
           AND NOT EXISTS (
             SELECT 1 FROM operational_incidents
             WHERE source_type = 'oversell' AND source_key = side_effect_operations.booking_id
           )
         ORDER BY updated_at
         LIMIT ?`,
      ).bind(limit).all<SideEffectOperationRow>();
      return result.results.map(mapSideEffectOperation);
    },

    async upsertOpenIncident(input) {
      await db.prepare(
        `INSERT INTO operational_incidents (
           id, booking_id, source_type, source_key, action, status, severity, attempt_count,
           first_detected_at, last_detected_at, source_updated_at, alert_revision, alerted_revision, alert_attempt_count
         ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, 0, 0)
         ON CONFLICT(source_type, source_key) DO UPDATE SET
           status = 'open',
           severity = excluded.severity,
           attempt_count = excluded.attempt_count,
           last_detected_at = excluded.last_detected_at,
           source_updated_at = excluded.source_updated_at,
           -- A reopen or explicit escalation bumps the alert revision so the operator is
           -- re-notified; a repeated detection on an already-open incident does not re-alert.
           alert_revision = CASE WHEN operational_incidents.status = 'resolved' OR ? THEN operational_incidents.alert_revision + 1 ELSE operational_incidents.alert_revision END,
           resolved_at = NULL, resolution_kind = NULL, resolved_by = NULL, resolution_note = NULL`,
      ).bind(
        input.id, input.bookingId, input.sourceType, input.sourceKey, input.action, input.severity, input.attemptCount,
        input.now, input.now, input.sourceUpdatedAt,
        input.escalate ? 1 : 0,
      ).run();
    },
    async getIncidentBySource(sourceType, sourceKey) {
      const row = await first(db.prepare(
        `SELECT ${operationalIncidentColumns} FROM operational_incidents WHERE source_type = ? AND source_key = ?`,
      ).bind(sourceType, sourceKey).all<OperationalIncidentRow>());
      return row ? mapOperationalIncident(row) : null;
    },
    async resolveIncidentAutomatic(sourceType, sourceKey, resolvedAt) {
      await db.prepare(
        `UPDATE operational_incidents SET status = 'resolved', resolved_at = ?, resolution_kind = 'automatic', resolved_by = NULL, resolution_note = NULL
         WHERE source_type = ? AND source_key = ? AND status = 'open'`,
      ).bind(resolvedAt, sourceType, sourceKey).run();
    },
    async resolveIncidentManual(input) {
      const result = await db.prepare(
        `UPDATE operational_incidents SET status = 'resolved', resolved_at = ?, resolution_kind = 'manual', resolved_by = ?, resolution_note = ?
         WHERE source_type = ? AND source_key = ? AND status = 'open'`,
      ).bind(input.resolvedAt, input.resolvedBy, input.resolutionNote, input.sourceType, input.sourceKey).run();
      return result.meta.changes > 0;
    },
    async listOpenIncidents(limit) {
      // Action-required before delayed, then oldest first.
      const result = await db.prepare(
        `SELECT ${operationalIncidentColumns} FROM operational_incidents
         WHERE status = 'open'
         ORDER BY CASE WHEN severity = 'action_required' THEN 0 ELSE 1 END, first_detected_at
         LIMIT ?`,
      ).bind(limit).all<OperationalIncidentRow>();
      return result.results.map(mapOperationalIncident);
    },
    async listRecentResolvedIncidents(since, limit) {
      const result = await db.prepare(
        `SELECT ${operationalIncidentColumns} FROM operational_incidents
         WHERE status = 'resolved' AND resolved_at >= ?
         ORDER BY resolved_at DESC
         LIMIT ?`,
      ).bind(since, limit).all<OperationalIncidentRow>();
      return result.results.map(mapOperationalIncident);
    },
    async countIncidentsSince(since) {
      const [opened, resolved] = await Promise.all([
        first(db.prepare('SELECT COUNT(*) AS count FROM operational_incidents WHERE first_detected_at >= ?').bind(since).all<{ count: number }>()),
        first(db.prepare("SELECT COUNT(*) AS count FROM operational_incidents WHERE status = 'resolved' AND resolved_at >= ?").bind(since).all<{ count: number }>()),
      ]);
      return { opened: Number(opened?.count ?? 0), resolved: Number(resolved?.count ?? 0) };
    },
    async countOpenIncidents() {
      const row = await first(db.prepare("SELECT COUNT(*) AS count FROM operational_incidents WHERE status = 'open'").all<{ count: number }>());
      return Number(row?.count ?? 0);
    },
    async countSideEffectDebtByFamily() {
      // The WHERE drops settled rows so the aggregate only scans debt; families with none
      // simply don't come back.
      const result = await db.prepare(
        `SELECT family,
                SUM(CASE WHEN status = 'abandoned' THEN 0 ELSE 1 END) AS pending,
                SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
                MIN(CASE WHEN status = 'abandoned' THEN NULL ELSE created_at END) AS oldest_pending_at
         FROM side_effect_operations
         WHERE status != 'succeeded'
         GROUP BY family
         ORDER BY family`,
      ).all<{ family: SideEffectFamily; pending: number; abandoned: number; oldest_pending_at: string | null }>();
      return result.results.map((row) => ({
        family: row.family,
        pending: Number(row.pending ?? 0),
        abandoned: Number(row.abandoned ?? 0),
        oldestPendingAt: row.oldest_pending_at,
      }));
    },

    async listAlertCandidateIds(now, limit) {
      const result = await db.prepare(
        `SELECT id FROM operational_incidents
         WHERE status = 'open' AND alerted_revision < alert_revision
           AND (alert_next_attempt_at IS NULL OR alert_next_attempt_at <= ?)
           AND (alert_claim_until IS NULL OR alert_claim_until < ?)
         ORDER BY COALESCE(alert_next_attempt_at, first_detected_at)
         LIMIT ?`,
      ).bind(now, now, limit).all<{ id: string }>();
      return result.results.map((row) => row.id);
    },
    async claimIncidentAlert(id, token, now, leaseUntil) {
      const result = await db.prepare(
        `UPDATE operational_incidents
         SET alert_claim_token = ?, alert_claim_until = ?, alert_attempt_count = alert_attempt_count + 1
         WHERE id = ? AND status = 'open' AND alerted_revision < alert_revision
           AND (alert_next_attempt_at IS NULL OR alert_next_attempt_at <= ?)
           AND (alert_claim_until IS NULL OR alert_claim_until < ?)
         RETURNING ${operationalIncidentColumns}`,
      ).bind(token, leaseUntil, id, now, now).all<OperationalIncidentRow>();
      const row = result.results[0];
      return row ? mapOperationalIncident(row) : null;
    },
    async resolveIncidentAlertSuccess(id, token, alertedRevision) {
      await db.prepare(
        `UPDATE operational_incidents
         SET alerted_revision = ?, alert_claim_token = NULL, alert_claim_until = NULL,
             alert_next_attempt_at = NULL, alert_error = NULL
         WHERE id = ? AND alert_claim_token = ?`,
      ).bind(alertedRevision, id, token).run();
    },
    async resolveIncidentAlertFailure(id, token, error, nextAttemptAt) {
      await db.prepare(
        `UPDATE operational_incidents
         SET alert_claim_token = NULL, alert_claim_until = NULL, alert_next_attempt_at = ?, alert_error = ?
         WHERE id = ? AND alert_claim_token = ?`,
      ).bind(nextAttemptAt, error.slice(0, 200), id, token).run();
    },
  };
}

export { mapBooking };
