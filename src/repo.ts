import type { D1Database, D1Result } from '@cloudflare/workers-types';
import type { Booking, BookingStatus, CancellationActor } from './core/booking';
import { sha256Base64Url } from './http';
import type { CapacityDefault, DayCapacityOverride } from './core/occupancy';

export interface BookingInsert {
  id: string;
  reference: string;
  tourSlug: string;
  people: number;
  pickupType: 'default' | 'custom';
  startsAt: string;
  endsAt: string;
  locale: string;
  priceCents: number;
  holdExpiresAt: string;
  cancelToken: string;
  operatorToken: string;
  // BK-SEC-002: shared expiry for both tokens (see ClientConfig.booking.tokenExpiryDays).
  // Optional/nullable so every pre-existing caller of insertHold/insertHoldWithCapacity (tests,
  // mainly) that doesn't pass one keeps compiling and simply gets an unexpiring token, matching
  // pre-migration behavior.
  tokensExpireAt?: string | null;
  holdIp?: string | null;
  maxActiveHoldsForIp?: number;
  createdAt: string;
  updatedAt: string;
}

// One section save = one atomic D1 batch, so a mid-save failure never leaves a mixed revision
// (BK-CONFIG-001 task 4). `value` is already the JSON-encoded SettingValue (serializeSettingValue).
export type SettingsBatchOperation =
  | { type: 'upsert'; key: string; value: string }
  | { type: 'delete'; key: string };

export class HoldLimitExceededError extends Error {
  constructor() {
    super('Too many active holds from this IP');
    this.name = 'HoldLimitExceededError';
  }
}

// BK-SCHEMA-001 (task 12): thrown wherever a write would set stripe_payment_intent to a value
// already claimed by a different booking, translating the D1 UNIQUE-violation on the new partial
// index (migrations/0011_schema_constraints.sql idx_bookings_payment_intent) into a typed error
// instead of an opaque D1 error bubbling up as an unhandled 500. status/code follow the same
// self-describing-error convention as ConfirmationInProgressError (src/confirmation.ts) and
// AccessVerificationError (src/access.ts) -- src/http.ts's errorResponse already knows how to turn
// any `Error & {status, code}` into a clean JSON response, so no handler-level catch is needed.
export class DuplicatePaymentIntentError extends Error {
  readonly status = 409;
  readonly code = 'duplicate_payment_intent';
  constructor(paymentIntent: string) {
    super(`stripe_payment_intent ${paymentIntent} already confirmed a different booking`);
    this.name = 'DuplicatePaymentIntentError';
  }
}

// BK-SCHEMA-001 (task 12): migrations/0011_schema_constraints.sql adds CHECK constraints for the
// domain invariants below, but they only guard rows written (or rewritten) after that migration
// ran -- a pre-rebuild row already sitting in D1, or a future write that bypasses this repository
// (a manual UPDATE, a restored backup), could still violate them. mapBooking throws this rather
// than silently handing a corrupt row to callers that assume it's valid (pricing, capacity,
// calendar-window math), so the bad data surfaces immediately at the one place every row becomes a
// Booking, instead of producing a confusing failure two layers downstream.
export class InvalidBookingRowError extends Error {
  constructor(bookingId: string, reason: string) {
    super(`booking ${bookingId} violates a domain invariant: ${reason}`);
    this.name = 'InvalidBookingRowError';
  }
}

// SQLite reports a UNIQUE-index violation the same way regardless of whether the index is partial
// or a plain column UNIQUE -- "UNIQUE constraint failed: <table>.<column>" -- so this doesn't need
// to special-case the partial WHERE clause on idx_bookings_payment_intent.
function isPaymentIntentUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed:.*\bstripe_payment_intent\b/i.test(error.message);
}

// Shared by every repo method that can write stripe_payment_intent (updateBooking,
// transitionToConfirmed, confirmWithSideEffectOperations, applyConfirmedPaymentDetails): runs the
// D1 write and reclassifies a UNIQUE-violation on the new partial index into DuplicatePaymentIntentError,
// leaving every other error (a different column's constraint, a transient D1 failure) untouched.
async function guardDuplicatePaymentIntent<T>(paymentIntent: string | null | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Non-null (NOT falsy): the partial index's WHERE stripe_payment_intent IS NOT NULL clause
    // covers '' just like any other non-null value, so a truthiness check here would wrongly skip
    // reclassifying a collision on the empty string, letting it surface as an unhandled 500.
    if (paymentIntent !== null && paymentIntent !== undefined && isPaymentIntentUniqueViolation(error)) {
      throw new DuplicatePaymentIntentError(paymentIntent);
    }
    throw error;
  }
}

// BK-CAP-001 / AR-001 (handoff 05): shared inputs for the atomic capacity guard used by both
// insertHoldWithCapacity and rescheduleWithCapacity. occupancyUnits/occupancyEndsAt describe the
// interval the *requesting* write needs (occupancyFor(tour, people) units, and endsAt + that
// tour's turnaroundMin — the same window src/core/occupancy.ts uses for overlap); localDate is
// the resolved local-date key (see core/time.ts localDateKey) the capacity lookup runs against;
// fleetDefaultCapacity is the fallback when neither a day override nor a capacity default apply
// (see core/occupancy.ts capacityForDate/defaultCapacityForDate, which this mirrors in SQL).
export interface CapacityGuardInput {
  occupancyUnits: number;
  occupancyEndsAt: string;
  localDate: string;
  fleetDefaultCapacity: number;
}

// BK-REFUND-001: a durable record of a refund decision + its Stripe outcome, replacing the
// in-memory refundedPayments Set. One row per booking (UNIQUE booking_id — see migrations/
// 0006_refund_operations.sql) so exactly one request can claim a booking's refund decision.
export type RefundChoice = 'full' | 'none';
export type RefundOperationStatus = 'requested' | 'succeeded' | 'failed';

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
}

// BK-SIDE-001 (handoff 13): the mutation-path outbox (record/claim/resolveMutationSideEffectOperation
// below) reuses this same table/type rather than a second mechanism, so `kind` widens beyond the
// confirmation path's fixed three literals to calendar deletion and the dynamic
// 'email:...'/'tourflow:...' strings src/confirmation.ts builds (kept as template-literal patterns, not a
// bare `string`, so the fixed literals below still get meaningful autocomplete/typo protection).
export type ConfirmationSideEffectKind = 'calendar_create' | 'email_confirmation' | 'oversell';
export type MutationSideEffectOperationKind = 'calendar_delete' | `email:${string}` | `tourflow:${string}`;
export type SideEffectOperationKind = ConfirmationSideEffectKind | MutationSideEffectOperationKind;
// Plan 011: the durable booking.confirmed Tourflow row. Shaped like a MutationSideEffectOperationKind
// (claimed/resolved via the ungated row lease, not the confirmation lease — see src/confirmation.ts)
// but represents confirmation debt, not mutation debt, so the generic mutation drain explicitly
// excludes it (src/confirmation.ts isMutationSideEffectKind) and a dedicated resolver
// (resolveConfirmationTourflowOperation below) is the only thing allowed to flip tourflow_synced.
export const CONFIRMATION_TOURFLOW_KIND = 'tourflow:booking.confirmed' as const satisfies MutationSideEffectOperationKind;
export type ConfirmationTourflowKind = typeof CONFIRMATION_TOURFLOW_KIND;
export type SideEffectOperationStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed';

// BK-SIDE-001 (handoff 13) HIGH-2: a claimant that dies between claiming (status -> in_flight)
// and resolving would otherwise leave the row stuck forever — claiming only matches
// pending/failed, so nothing ever reclaims it. claimMutationSideEffectOperation additionally
// matches an in_flight row whose attempted_at is older than this lease window. Reuses the same
// 5-minute figure as the confirmation-lease pattern (src/confirmation.ts
// acquireConfirmationLease/renewConfirmationLease) — both are "how long before we assume the
// original claimant is dead" judgment calls with no reason to differ.
export const MUTATION_SIDE_EFFECT_LEASE_MS = 5 * 60_000;

export interface CancellationTransitionInput {
  expectedStatusIn: BookingStatus[];
  // Prevents a cancellation decision calculated against a stale pre-reschedule start from landing.
  expectedStartsAt?: string;
  cancelledAt: string;
  cancelledBy: CancellationActor;
  updatedAt: string;
  // Recorded atomically only when this transition's CAS wins.
  mutationSideEffectKinds?: MutationSideEffectOperationKind[];
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

export interface SideEffectOperationRecord {
  bookingId: string;
  kind: SideEffectOperationKind;
  status: SideEffectOperationStatus;
  providerResultId: string | null;
  attemptCount: number;
  attemptedAt: string | null;
  resolvedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookingUpdate {
  pickupAddress?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  startsAt?: string;
  endsAt?: string;
  holdExpiresAt?: string | null;
  stripeSessionId?: string | null;
  stripePaymentIntent?: string | null;
  calendarEventId?: string | null;
  calendarSynced?: boolean;
  emailSynced?: boolean;
  tourflowSynced?: boolean;
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
  getBookingBySessionId(sessionId: string): Promise<Booking | null>;
  getBookingByPaymentIntent?(paymentIntent: string): Promise<Booking | null>;
  // BK-SEC-002: `now` gates expiry (tokens_expire_at) in the same query as the hash/fallback
  // lookup, so an expired token is denied identically to an unknown one (no timing/response
  // oracle distinguishing "expired" from "never existed").
  getBookingByCancelToken(token: string, now: string): Promise<Booking | null>;
  getBookingByOperatorToken(token: string, now: string): Promise<Booking | null>;
  getBookingByOperatorTokenForRefundRecovery(token: string, now: string): Promise<Booking | null>;
  countReferencesForYear(prefix: string): Promise<number>;
  insertHold(input: BookingInsert): Promise<Booking>;
  // Atomic checkout write (BK-CAP-001 / AR-001): same per-IP hold-cap guard as insertHold, plus
  // a single-statement capacity guard (occupied units in the target interval + requested <=
  // capacity resolved for localDate). Returns null when the capacity guard loses the race —
  // distinct from HoldLimitExceededError, which is still thrown for the unrelated per-IP cap —
  // so the caller can surface the existing slot_unavailable 409 rather than a new error code.
  insertHoldWithCapacity(input: BookingInsert & CapacityGuardInput): Promise<Booking | null>;
  updateBooking(id: string, patch: BookingUpdate): Promise<Booking>;
  // Compare-and-set status transitions: each issues a single conditional UPDATE scoped to
  // expectedStatusIn (or, for reschedule, status + starts_at) and returns null when the
  // predicate didn't match (the caller lost the race), so a stale in-memory read can never
  // overwrite a row that has already moved to a different state.
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
    // BK-SIDE-001 (handoff 13): see the identical field on transitionToCancelled above.
    mutationSideEffectKinds?: MutationSideEffectOperationKind[];
  }): Promise<Booking | null>;
  transitionToConfirmed(id: string, input: {
    expectedStatusIn: BookingStatus[];
    stripePaymentIntent?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
    updatedAt: string;
  }): Promise<Booking | null>;
  confirmWithSideEffectOperations(id: string, input: {
    expectedStatusIn: BookingStatus[];
    stripePaymentIntent?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
    leaseToken: string;
    oversold: boolean;
    updatedAt: string;
    // Plan 011: passed only when an ops provider is configured (src/confirmation.ts) — a new
    // booking's status transition and its Tourflow outbox row share this one D1 batch, so a
    // provider that's never configured mints no row and a booking never gets stuck polling a
    // default-false tourflow_synced flag it can never resolve.
    tourflowKind?: ConfirmationTourflowKind;
  }): Promise<Booking | null>;
  applyConfirmedPaymentDetails(id: string, patch: {
    stripePaymentIntent?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
  }, leaseToken: string, updatedAt: string): Promise<boolean>;
  // Plan 011: tourflowKind is the same optional provider-derived kind confirmWithSideEffectOperations
  // takes — this is the lazy-repair path for a legacy confirmed booking (row missing entirely,
  // e.g. because ops wasn't configured at original confirmation time), gated on tourflow_synced = 0
  // so an already-synced booking is never replayed a second row.
  ensureConfirmationSideEffectOperations(id: string, leaseToken: string, now: string, tourflowKind?: ConfirmationTourflowKind): Promise<void>;
  listSideEffectOperations(bookingId: string): Promise<SideEffectOperationRecord[]>;
  claimSideEffectOperation(bookingId: string, kind: ConfirmationSideEffectKind, leaseToken: string, attemptedAt: string): Promise<boolean>;
  resolveSideEffectOperation(input: {
    bookingId: string;
    kind: ConfirmationSideEffectKind;
    leaseToken: string;
    status: 'succeeded' | 'failed';
    providerResultId?: string | null;
    error?: string | null;
    resolvedAt: string;
  }): Promise<boolean>;
  // BK-SIDE-001 (handoff 13): mutation-path outbox claim/resolve. Unlike the confirmation-path
  // pair above, these aren't gated by a confirmation lease — cancel/reschedule/no-show already run
  // their own compare-and-set in the transition methods, and the rows themselves are only ever
  // written conditional on that CAS winning (see transitionToCancelled et al) — so this is a plain
  // claim/resolve over (booking_id, kind), with the row's OWN attempted_at doubling as a lease
  // token (HIGH-2) since there's no separate lease concept here to reuse. listSideEffectOperations
  // (above) is reused as-is to read them back — its SQL was never lease-scoped, just filtered by
  // booking_id.
  //
  // Claimable from 'pending'/'failed', OR an 'in_flight' row whose attempted_at is older than
  // MUTATION_SIDE_EFFECT_LEASE_MS (a killed claimant's stale claim) — never from 'succeeded' (never
  // re-sent) or a live 'in_flight' (no double-claim by a concurrent retry).
  claimMutationSideEffectOperation(bookingId: string, kind: MutationSideEffectOperationKind, attemptedAt: string): Promise<boolean>;
  resolveMutationSideEffectOperation(input: {
    bookingId: string;
    kind: MutationSideEffectOperationKind;
    status: 'succeeded' | 'failed';
    providerResultId?: string | null;
    error?: string | null;
    resolvedAt: string;
    // HIGH-2: the attempted_at value THIS claimant set at claim time. Resolve requires it to
    // still match — so a slow original claimant that wakes up after a reclaimer already took the
    // row (bumping attempted_at again) fails to match here (0 rows) instead of clobbering the
    // reclaimer's outcome.
    claimedAt: string;
  }): Promise<boolean>;
  // Plan 011 (design decision 4): the confirmation-path Tourflow row's dedicated resolver. Uses
  // the same claimedAt-gated optimistic concurrency as resolveMutationSideEffectOperation above,
  // but additionally sets bookings.tourflow_synced = 1 in the SAME batch, and only when this call's
  // own row update actually won (never on a lost race, and never on a 'failed' outcome) — so a
  // succeeded-row/false-flag split can never cause either a duplicate send or endless polling.
  resolveConfirmationTourflowOperation(input: {
    bookingId: string;
    status: 'succeeded' | 'failed';
    error?: string | null;
    resolvedAt: string;
    claimedAt: string;
  }): Promise<boolean>;
  transitionReschedule(id: string, input: {
    expectedStatus: BookingStatus;
    expectedStartsAt: string;
    startsAt: string;
    endsAt: string;
    rescheduledFrom: string;
    updatedAt: string;
    // patch-11-r1 MEDIUM 2: recomputed from the NEW endsAt at the call site (src/handlers/
    // index.ts rescheduleWithToken), mirroring the checkout-time computation — otherwise a
    // booking moved later could have its manage link expire before the rescheduled tour even
    // happens, and one moved earlier would keep an over-long window. Optional/nullable so
    // existing callers that don't pass one (older tests, mainly) leave tokens_expire_at
    // untouched rather than clobbering it to NULL — see the COALESCE in the implementation.
    tokensExpireAt?: string | null;
    mutationSideEffectKinds?: MutationSideEffectOperationKind[];
  }): Promise<Booking | null>;
  // Atomic reschedule write (BK-CAP-001): extends transitionReschedule's CAS (status +
  // starts_at, guarding against a stale read racing a concurrent transition) with the same
  // capacity guard as insertHoldWithCapacity, excluding this booking's own current occupancy
  // from the "occupied" side so moving within/into a window it already partly occupies isn't
  // double-counted against itself. Returns null on either the CAS loss or the capacity loss —
  // the caller (rescheduleWithToken) already maps any null here to the existing 409 codes.
  rescheduleWithCapacity(id: string, input: {
    expectedStatus: BookingStatus;
    expectedStartsAt: string;
    startsAt: string;
    endsAt: string;
    rescheduledFrom: string;
    updatedAt: string;
    now: string;
    // patch-11-r1 MEDIUM 2: see the identical field on transitionReschedule above.
    tokensExpireAt?: string | null;
    // Reschedule rows receive the incremented per-booking transition version in the same batch,
    // so a repeated A→B hop cannot collide with an earlier one.
    mutationSideEffectKinds?: MutationSideEffectOperationKind[];
  } & CapacityGuardInput): Promise<Booking | null>;
  listOccupancyBookings(from: string, to: string): Promise<Booking[]>;
  listUpcoming(now: string): Promise<Booking[]>;
  listSince(since: string): Promise<Booking[]>;
  getDayOverride(date: string): Promise<DayCapacityOverride | null>;
  listDayOverrides(from: string, to: string): Promise<DayCapacityOverride[]>;
  upsertDayOverride(date: string, capacity: number, reason: string | null): Promise<void>;
  deleteDayOverride(date: string): Promise<void>;
  // Plural, batched siblings of upsertDayOverride/deleteDayOverride: handleAdminPost's bulk day
  // actions (set/close/clear over a date range) use these instead of looping the singular
  // methods, so a range submit is one D1 round trip instead of up to 366.
  upsertDayOverrides(dates: string[], capacity: number, reason: string | null): Promise<void>;
  deleteDayOverrides(dates: string[]): Promise<void>;
  listCapacityDefaults(): Promise<CapacityDefault[]>;
  upsertCapacityDefault(fromDate: string, capacity: number, reason: string | null): Promise<void>;
  deleteCapacityDefault(fromDate: string): Promise<void>;
  // Operator-editable config overrides (core/settings.ts): key -> JSON-encoded value.
  listSettings(): Promise<Record<string, string>>;
  upsertSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  // Applies every key of a settings section in one D1 batch (all-or-nothing) — see
  // core/settings.ts mergeAndValidateSettings, which the admin save path runs first.
  applySettingsBatch(operations: SettingsBatchOperation[]): Promise<void>;
  // Compare-and-set claim: succeeds (true) only when no operation row exists yet for this
  // booking_id, so a refund=full and refund=none request racing on the same booking can never
  // both proceed to call Stripe (BK-REFUND-001). The loser calls getRefundOperationByBookingId to
  // see which decision won.
  claimRefundOperation(input: {
    id: string;
    bookingId: string;
    paymentIntent: string | null;
    choice: RefundChoice;
    requestedAt: string;
  }): Promise<boolean>;
  getRefundOperationByBookingId(bookingId: string): Promise<RefundOperationRecord | null>;
  // Records the Stripe outcome of a claimed operation. Safe to call more than once (e.g. a
  // resumed/retried operation) — it's a conditional UPDATE by id (WHERE status != 'succeeded'),
  // not a plain write: status only ever advances (requested -> succeeded/failed), so a stale
  // attempt (e.g. an operator retry racing the charge.refunded webhook) can never downgrade an
  // already-succeeded row to 'failed' or clear its recorded refund id/amount (BK-REFUND-001).
  resolveRefundOperation(id: string, input: {
    status: 'succeeded' | 'failed';
    stripeRefundId?: string | null;
    amountCents?: number | null;
    error?: string | null;
    resolvedAt: string;
  }): Promise<void>;
  // Removes this request's still-pending claim after its own CAS cancel loses to a non-cancelled
  // winner (e.g. a reschedule), so it cannot block a later legitimate cancellation. A succeeded
  // row is deliberately retained because it is the durable record that Stripe moved the money.
  deleteRefundOperation(id: string): Promise<void>;
  // A non-authoritative upsert preserves any terminal outcome, so stale caller data cannot
  // regress a recorded Stripe refund. Does not overwrite requested_at on an existing row.
  upsertRefundOperation(input: RefundOperationUpsertInput): Promise<void>;
  // Only a verified charge.refunded webhook may correct an earlier none/succeeded audit row.
  reconcileStripeRefundOperation(input: RefundOperationUpsertInput): Promise<void>;
}

interface BookingRow {
  id: string;
  reference: string;
  tour_slug: string;
  people: number;
  pickup_type: 'default' | 'custom';
  pickup_address: string | null;
  starts_at: string;
  ends_at: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  locale: string;
  price_cents: number;
  status: BookingStatus;
  hold_expires_at: string | null;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  calendar_event_id: string | null;
  calendar_synced: number;
  email_synced: number;
  tourflow_synced: number;
  reminded_at: string | null;
  review_requested_at: string | null;
  cancel_token: string;
  operator_token: string;
  // BK-SEC-002: see migrations/0009_token_hashing.sql for what each column means and why.
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

// BK-SCHEMA-001 (task 12): the invariants migrations/0011_schema_constraints.sql's CHECK
// constraints enforce at write time, re-checked here at read time -- see InvalidBookingRowError
// above for why. String comparison of ends_at > starts_at mirrors the SQL CHECK exactly: both
// columns are consistently-formatted ISO 8601 UTC instants (e.g. '2026-08-01T09:00:00.000Z'), so
// lexical order matches chronological order, same as the CHECK constraint's own TEXT comparison.
function assertValidBookingRow(row: BookingRow): void {
  if (row.people <= 0) throw new InvalidBookingRowError(row.id, `people must be > 0, got ${row.people}`);
  if (row.price_cents < 0) throw new InvalidBookingRowError(row.id, `price_cents must be >= 0, got ${row.price_cents}`);
  if (!(row.ends_at > row.starts_at)) {
    throw new InvalidBookingRowError(row.id, `ends_at (${row.ends_at}) must be after starts_at (${row.starts_at})`);
  }
  for (const [column, value] of [
    ['calendar_synced', row.calendar_synced],
    ['email_synced', row.email_synced],
    ['tourflow_synced', row.tourflow_synced],
  ] as const) {
    if (value !== 0 && value !== 1) throw new InvalidBookingRowError(row.id, `${column} must be 0 or 1, got ${value}`);
  }
}

function mapBooking(row: BookingRow): Booking {
  assertValidBookingRow(row);
  return {
    id: row.id,
    reference: row.reference,
    tourSlug: row.tour_slug,
    people: Number(row.people),
    pickupType: row.pickup_type,
    pickupAddress: row.pickup_address,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    locale: row.locale,
    priceCents: Number(row.price_cents),
    status: row.status,
    holdExpiresAt: row.hold_expires_at,
    stripeSessionId: row.stripe_session_id,
    stripePaymentIntent: row.stripe_payment_intent,
    calendarEventId: row.calendar_event_id,
    calendarSynced: Boolean(row.calendar_synced),
    emailSynced: Boolean(row.email_synced),
    tourflowSynced: Boolean(row.tourflow_synced),
    remindedAt: row.reminded_at,
    reviewRequestedAt: row.review_requested_at,
    cancelToken: row.cancel_token,
    operatorToken: row.operator_token,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    rescheduledFrom: row.rescheduled_from,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const bookingColumns = `id, reference, tour_slug, people, pickup_type, pickup_address, starts_at, ends_at,
  customer_name, customer_email, customer_phone, locale, price_cents, status, hold_expires_at,
  stripe_session_id, stripe_payment_intent, calendar_event_id, calendar_synced, email_synced,
  tourflow_synced, reminded_at, review_requested_at, cancel_token, operator_token,
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
  };
}

const refundOperationColumns = `id, booking_id, payment_intent, choice, status, stripe_refund_id,
  amount_cents, requested_at, resolved_at, error`;

interface SideEffectOperationRow {
  booking_id: string;
  kind: SideEffectOperationKind;
  status: SideEffectOperationStatus;
  provider_result_id: string | null;
  attempt_count: number;
  attempted_at: string | null;
  resolved_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const sideEffectOperationColumns = `booking_id, kind, status, provider_result_id, attempt_count,
  attempted_at, resolved_at, error, created_at, updated_at`;

function mapSideEffectOperation(row: SideEffectOperationRow): SideEffectOperationRecord {
  return {
    bookingId: row.booking_id,
    kind: row.kind,
    status: row.status,
    providerResultId: row.provider_result_id,
    attemptCount: Number(row.attempt_count),
    attemptedAt: row.attempted_at,
    resolvedAt: row.resolved_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// BK-SEC-002: name of the optional Worker secret used to decrypt cancel_token_enc/
// operator_token_enc back into a usable link (see migrations/0009_token_hashing.sql for the full
// rationale). Read the same way as BOOKKIT_CSRF_SECRET/TOURFLOW_SHARED_SECRET (src/admin-csrf.ts,
// src/handlers/index.ts) — via the SecretLookup passed in below, never through ClientConfig — and,
// like BOOKKIT_CSRF_SECRET, deliberately NOT added to runtime-context.ts's default
// secretBindings or integration.ts's astro:env schema: a deployment must opt in by adding its name
// to secretBindings (see README "Runtime module" / "Admin access and booking tokens").
const TOKEN_ENC_SECRET_NAME = 'BOOKKIT_TOKEN_ENC_KEY';

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

// Normalizes an arbitrary-length configured secret string into the exact 32 bytes AES-256-GCM
// needs, the same way admin-csrf.ts's hmacSign accepts an arbitrary-length HMAC key — SHA-256 the
// secret rather than requiring the operator to provision exactly 32 bytes themselves.
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

// Fails closed (null, not throw) on a corrupt/tampered/foreign-key blob so one bad row can never
// crash an otherwise-successful list/read — callers already treat "no decrypted value" as "fall
// back to whatever mapBooking put there" (see hydrateBooking).
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

// Satisfies the legacy cancel_token/operator_token columns' NOT NULL UNIQUE constraint for rows
// written after migrations/0009_token_hashing.sql, without those columns ever holding a usable
// credential again. Safe even if it leaks in a dump: getBookingByCancelToken/
// getBookingByOperatorToken below only ever consult this column via a query guarded by
// `..._hash IS NULL`, and every row written after this migration has its hash set from the start.
function placeholderToken(): string {
  return `nohash:${crypto.randomUUID()}`;
}

export function createBookingRepository(
  db: D1Database,
  // Same shape as context.ts's SecretLookup; duplicated inline rather than imported to avoid a
  // repo.ts <-> context.ts circular import (context.ts already imports createBookingRepository).
  secrets?: (name: string) => string | undefined | Promise<string | undefined>,
): BookingRepository {
  // Resolved and imported at most once per repository instance (i.e. per request in the normal
  // Cloudflare adapter — see context.ts), not once per token: the secret cannot change mid-request.
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

  // Reconstitutes booking.cancelToken/operatorToken into their real, presentable plaintext for
  // every DB-loaded booking that might flow into an email's manage link (src/providers/brevo.ts
  // manageUrl) or the admin dashboard's operator manage-link column (src/handlers/index.ts) —
  // both read straight off the Booking object, with no idea whether it came from a fresh insert,
  // a token lookup, or an arbitrary later read. mapBooking already defaults these fields to
  // row.cancel_token/row.operator_token (the legacy plaintext column, correct for a
  // not-yet-backfilled legacy row); this only overrides them when a decryptable blob exists.
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

  // Shared by insertHold/insertHoldWithCapacity: computes every BK-SEC-002 column a new row needs
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

  // BK-SIDE-001 (handoff 13) HIGH-1(a): builds the single INSERT statement transitionToCancelled/
  // transitionToNoShow/transitionReschedule/rescheduleWithCapacity batch ALONGSIDE (before, specifically) their own CAS
  // UPDATE, so the outbox rows land iff the transition actually happens. `casPredicate`/`casParams`
  // are the EXACT SAME compare-and-set condition the UPDATE itself uses (id/status[/starts_at
  // /capacity], whatever the caller's WHERE clause is) — wrapped in WHERE EXISTS and evaluated
  // BEFORE the UPDATE runs, i.e. against the pre-batch snapshot. Because a db.batch() call is
  // atomic relative to any OTHER writer (D1's core guarantee), this INSERT and the UPDATE right
  // after it always agree: either both fire (this call's CAS wins) or neither does (a stale/
  // duplicate call, or someone else already moved the row) — so a losing attempt can never record,
  // and later drain-send, side effects for a mutation that didn't happen. (Placing the INSERT
  // AFTER the UPDATE and checking POST-transition state instead — the way
  // confirmWithSideEffectOperations does — doesn't work here: that method disambiguates "my write
  // won" from "someone else already got here first" via a per-attempt confirmation_lease_token,
  // which these plain CAS transitions have no equivalent of.) All N kinds are inserted by this ONE
  // statement (a VALUES-derived table), not N separate ones, so nothing about statement count
  // affects the guarantee above.
  // Task 12's planned bookings-table REBUILD MUST preserve reschedule_transition_version; this
  // insert reads its next value before the paired CAS update increments it, keeping the row kind
  // and transition version inseparable without relying on wall-clock uniqueness.
  const mutationSideEffectInsert = (
    bookingId: string,
    kinds: MutationSideEffectOperationKind[],
    now: string,
    casPredicate: string,
    casParams: unknown[],
    appendRescheduleVersion = false,
  ) => {
    const kind = appendRescheduleVersion
      ? `k.column1 || ':' || (SELECT reschedule_transition_version + 1 FROM bookings WHERE ${casPredicate})`
      : 'k.column1';
    return db.prepare(
      `INSERT INTO side_effect_operations (
         booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
       )
       SELECT ?, ${kind}, 'pending', NULL, 0, NULL, NULL, NULL, ?, ?
       FROM (VALUES ${kinds.map(() => '(?)').join(', ')}) AS k
       WHERE EXISTS (SELECT 1 FROM bookings WHERE ${casPredicate})
       ON CONFLICT(booking_id, kind) DO NOTHING`,
    ).bind(
      bookingId,
      ...(appendRescheduleVersion ? casParams : []),
      now, now, ...kinds, ...casParams,
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
    // Deliberately NOT routed through oneBooking's hydration: the only caller
    // (handleCheckout's referenceExists, src/handlers/index.ts) only checks for a non-null
    // result inside a reference-collision retry loop that can run up to a dozen times per
    // checkout, and never reads the returned booking's tokens — hydrating here would be a
    // real (if small) per-attempt AES-GCM cost for a value nothing ever uses.
    getBookingByReference: async (reference) => {
      const row = await first(db.prepare(`SELECT ${bookingColumns} FROM bookings WHERE reference = ?`).bind(reference).all<BookingRow>());
      return row ? mapBooking(row) : null;
    },
    getBookingBySessionId: (sessionId) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE stripe_session_id = ?`, sessionId),
    getBookingByPaymentIntent: (paymentIntent) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE stripe_payment_intent = ?`, paymentIntent),
    // BK-SEC-002: hash-first lookup with a guarded legacy-plaintext fallback + lazy backfill (see
    // migrations/0009_token_hashing.sql). `now` gates tokens_expire_at in the SAME query as the
    // hash/plaintext match, and cancel-token lookups additionally require
    // cancel_token_revoked_at IS NULL — both an expired and a revoked token fail exactly like an
    // unknown one (a plain null result), so callers (tokenBooking/handleManage,
    // src/handlers/index.ts) can't distinguish "wrong token" from "right token, denied" and no
    // oracle is exposed. Operator tokens are deliberately never revoked (see the migration's
    // comment on cancel_token_revoked_at) so they carry no revocation check here.
    async getBookingByCancelToken(token, now) {
      const key = await resolveTokenKey();
      const hash = await sha256Base64Url(token);
      const hashRow = await first(db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE cancel_token_hash = ? AND cancel_token_revoked_at IS NULL
           AND (tokens_expire_at IS NULL OR tokens_expire_at > ?)`,
      ).bind(hash, now).all<BookingRow>());
      if (hashRow) return hydrateBooking(hashRow, key);
      // Compatibility fallback for a row written before this migration (cancel_token_hash IS
      // NULL). Guarding on that column, not just cancel_token = ?, closes the "present the
      // leaked hash value itself as a token" oracle: once a row has a hash (true for every row
      // from the moment it's written, whether at insert or right here on first use), this branch
      // can never match it again, so a hash appearing in a dump is never itself accepted.
      const legacyRow = await first(db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE cancel_token = ? AND cancel_token_hash IS NULL AND cancel_token_revoked_at IS NULL
           AND (tokens_expire_at IS NULL OR tokens_expire_at > ?)`,
      ).bind(token, now).all<BookingRow>());
      if (!legacyRow) return null;
      const enc = key ? await encryptToken(key, token) : null;
      // Re-guarded by cancel_token_hash IS NULL: a concurrent request racing this same backfill
      // simply no-ops here (harmless — both already have the authenticated row in hand from the
      // SELECT above) rather than clobbering whichever hash won.
      await db.prepare(
        `UPDATE bookings SET cancel_token_hash = ?, cancel_token_enc = ?, cancel_token = ?
         WHERE id = ? AND cancel_token_hash IS NULL`,
      ).bind(hash, enc, placeholderToken(), legacyRow.id).run();
      // legacyRow.cancel_token IS the presented token (that's how the WHERE above matched it),
      // and cancel_token_enc was still NULL at read time, so hydrateBooking's default (mapBooking
      // falling back to row.cancel_token) already yields the right plaintext without needing a
      // second read of the just-updated row.
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
      // BK-SEC-002: every row written from here on gets only a hash (+ encrypted blob, if a key
      // is configured) — never real plaintext in cancel_token/operator_token (see
      // migrations/0009_token_hashing.sql and newTokenColumns above).
      const tokenColumns = await newTokenColumns(input);
      const result = await db.prepare(
        `INSERT INTO bookings (
          id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents,
          status, hold_expires_at, cancel_token, operator_token, cancel_token_hash,
          operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at, hold_ip,
          created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL OR (
          SELECT COUNT(*) FROM bookings
          WHERE hold_ip = ? AND status = 'hold' AND hold_expires_at >= ?
        ) < ?`,
      ).bind(
        input.id, input.reference, input.tourSlug, input.people, input.pickupType,
        input.startsAt, input.endsAt, input.locale, input.priceCents, input.holdExpiresAt,
        tokenColumns.cancelTokenPlaceholder, tokenColumns.operatorTokenPlaceholder,
        tokenColumns.cancelTokenHash, tokenColumns.operatorTokenHash,
        tokenColumns.cancelTokenEnc, tokenColumns.operatorTokenEnc, tokenColumns.tokensExpireAt,
        holdIp, input.createdAt, input.updatedAt,
        holdLimit, holdIp, input.createdAt, holdLimit,
      ).run();
      if (result.meta.changes === 0) throw new HoldLimitExceededError();
      const created = await oneBooking('SELECT ' + bookingColumns + ' FROM bookings WHERE id = ?', input.id);
      if (!created) throw new Error('Booking insert did not return a row');
      return created;
    },
    // BK-CAP-001 / AR-001: same per-IP hold-cap guard as insertHold, plus a capacity guard —
    // both evaluated in the same WHERE clause of one INSERT ... SELECT, so D1's single-writer,
    // single-statement-transaction semantics make "check occupancy, then insert" atomic (see
    // handoff 05 / the D1 concurrency FAQ cited there). The capacity subexpression mirrors
    // core/occupancy.ts: capacityForDate (day override, else the capacity_defaults row with the
    // latest from_date <= localDate, else fleetDefaultCapacity, each floored at 0 via the
    // 2+-argument MAX).
    //
    // patch-05-r1 Fix 1: the occupancy test is a faithful MAX-CONCURRENCY test, not a SUM of
    // every overlapping booking's units — SUM over-counts bookings that overlap the requested
    // window but never overlap EACH OTHER (e.g. one ending as the other starts) and produces
    // false 409s. This mirrors core/occupancy.ts's maxAtBoundaries exactly: the max is always
    // attained at some point where an active booking starts, so "max-concurrent + requested <=
    // capacity" is equivalent to "no candidate point p has SUM(units covering p) + requested >
    // capacity", where candidate points are the request's own start plus every active
    // overlapping booking's own starts_at (already >= the request start, by construction).
    // "Active" = status IN ('hold','confirmed') AND (not a hold, or its hold hasn't expired).
    // "Covering p" = starts_at <= p AND COALESCE(occupancy_ends_at, ends_at) > p — the same
    // COALESCE fallback as before, so pre-migration NULL rows count as one default-turnaround
    // unit (see migrations/0008).
    //
    // Known limitation (unchanged from before this task, not a regression): this guard only sees
    // the bookings table. External (non-bookkit) Google Calendar events are folded into
    // availability by checkSlot's pre-check (src/handlers/index.ts, via availabilityForDay) but
    // are NOT part of this atomic statement — checkSlot's calendar read was already a
    // non-atomic, best-effort pre-check before BK-CAP-001, so this is not a new gap. Atomic
    // calendar-aware occupancy is out of scope here (see handoff 14); do not mirror calendar
    // events into D1 to close it.
    async insertHoldWithCapacity(input) {
      const holdIp = input.holdIp ?? null;
      const holdLimit = input.maxActiveHoldsForIp ?? null;
      // BK-SEC-002: see the identical comment in insertHold above.
      const tokenColumns = await newTokenColumns(input);
      const result = await db.prepare(
        `INSERT INTO bookings (
          id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents,
          status, hold_expires_at, cancel_token, operator_token, cancel_token_hash,
          operator_token_hash, cancel_token_enc, operator_token_enc, tokens_expire_at, hold_ip,
          occupancy_units, occupancy_ends_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        input.id, input.reference, input.tourSlug, input.people, input.pickupType,
        input.startsAt, input.endsAt, input.locale, input.priceCents, input.holdExpiresAt,
        tokenColumns.cancelTokenPlaceholder, tokenColumns.operatorTokenPlaceholder,
        tokenColumns.cancelTokenHash, tokenColumns.operatorTokenHash,
        tokenColumns.cancelTokenEnc, tokenColumns.operatorTokenEnc, tokenColumns.tokensExpireAt,
        holdIp, input.occupancyUnits, input.occupancyEndsAt,
        input.createdAt, input.updatedAt,
        holdLimit, holdIp, input.createdAt, holdLimit,
        // NOT EXISTS candidate points: the request's own start, then every active overlapping
        // booking's own starts_at (b1.starts_at in [reqStart, reqEnd) that still covers reqStart).
        input.startsAt,
        input.createdAt, input.startsAt, input.occupancyEndsAt, input.startsAt,
        // sum-at-point (b2) + requestedUnits > capacity resolution.
        input.createdAt,
        input.occupancyUnits,
        input.localDate, input.localDate, input.fleetDefaultCapacity,
      ).run();
      if (result.meta.changes === 0) {
        // Reclassify a losing write: the hold-ip cap throws (matching insertHold's contract for
        // existing callers), anything else is a capacity loss reported as null. This re-check is
        // for error *classification* only — the atomic WHERE clause above already made the
        // authoritative accept/reject decision, so a benign staleness here can misreport which
        // guard tripped but can never cause an oversell.
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
        endsAt: 'ends_at', holdExpiresAt: 'hold_expires_at', stripeSessionId: 'stripe_session_id',
        stripePaymentIntent: 'stripe_payment_intent', calendarEventId: 'calendar_event_id',
        calendarSynced: 'calendar_synced', emailSynced: 'email_synced', tourflowSynced: 'tourflow_synced',
        cancelledAt: 'cancelled_at', cancelledBy: 'cancelled_by', rescheduledFrom: 'rescheduled_from',
        updatedAt: 'updated_at',
      };
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported booking update field');
      const values = entries.map(([key, value]) => {
        if (key === 'calendarSynced' || key === 'emailSynced' || key === 'tourflowSynced') return value ? 1 : 0;
        return value;
      });
      await guardDuplicatePaymentIntent(patch.stripePaymentIntent, () =>
        db.prepare(`UPDATE bookings SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
          .bind(...values, id).run());
      const updated = await oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      if (!updated) throw new Error('Booking not found');
      return updated;
    },
    async transitionToCancelled(id, input) {
      const { casPredicate, casParams, updateStmt } = cancellationUpdate(id, input);
      const kinds = input.mutationSideEffectKinds ?? [];
      if (kinds.length === 0) {
        const result = await updateStmt.run();
        if (result.meta.changes === 0) return null;
        return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      }
      const results = await db.batch([mutationSideEffectInsert(id, kinds, input.updatedAt, casPredicate, casParams), updateStmt]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async upsertRefundOperationAndTransitionToCancelled(refund, id, input) {
      const { casPredicate, casParams, updateStmt } = cancellationUpdate(id, input);
      const kinds = input.mutationSideEffectKinds ?? [];
      const statements = [stripeRefundReconciliationStmt(refund)];
      if (kinds.length > 0) statements.push(mutationSideEffectInsert(id, kinds, input.updatedAt, casPredicate, casParams));
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
      const kinds = input.mutationSideEffectKinds ?? [];
      if (kinds.length === 0) {
        const result = await updateStmt.run();
        if (result.meta.changes === 0) return null;
        return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      }
      const results = await db.batch([mutationSideEffectInsert(id, kinds, input.updatedAt, casPredicate, casParams), updateStmt]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async transitionToConfirmed(id, input) {
      const { expectedStatusIn, updatedAt, ...patch } = input;
      const columnMap: Record<string, string> = {
        stripePaymentIntent: 'stripe_payment_intent', customerName: 'customer_name',
        customerEmail: 'customer_email', customerPhone: 'customer_phone', pickupAddress: 'pickup_address',
      };
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported confirmation field');
      const placeholders = expectedStatusIn.map(() => '?').join(', ');
      const setClauses = [`status = 'confirmed'`, 'hold_expires_at = NULL', ...columns.map((column) => `${column} = ?`), 'updated_at = ?'];
      const result = await guardDuplicatePaymentIntent(patch.stripePaymentIntent, () =>
        db.prepare(
          `UPDATE bookings SET ${setClauses.join(', ')} WHERE id = ? AND status IN (${placeholders})`,
        ).bind(...entries.map(([, value]) => value), updatedAt, id, ...expectedStatusIn).run());
      if (result.meta.changes === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async confirmWithSideEffectOperations(id, input) {
      const { expectedStatusIn, updatedAt, leaseToken, oversold, tourflowKind, ...patch } = input;
      const columnMap: Record<string, string> = {
        stripePaymentIntent: 'stripe_payment_intent', customerName: 'customer_name',
        customerEmail: 'customer_email', customerPhone: 'customer_phone', pickupAddress: 'pickup_address',
      };
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported confirmation field');
      const placeholders = expectedStatusIn.map(() => '?').join(', ');
      const setClauses = [`status = 'confirmed'`, 'hold_expires_at = NULL', ...columns.map((column) => `${column} = ?`), 'updated_at = ?'];
      // kind is typed as the wider SideEffectOperationKind (not just ConfirmationSideEffectKind)
      // solely so this one helper can also insert the optional Tourflow row below — the SQL itself
      // is kind-agnostic.
      const operation = (kind: SideEffectOperationKind, status: SideEffectOperationStatus, providerResultId: string | null, resolvedAt: string | null) => db.prepare(
        `INSERT INTO side_effect_operations (
           booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM bookings
           WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ?
         )
         ON CONFLICT(booking_id, kind) DO NOTHING`,
      ).bind(id, kind, status, providerResultId, resolvedAt, updatedAt, updatedAt, id, leaseToken);
      // Plan 011 (design decision 2): the Tourflow row shares this exact batch, so it can never
      // exist without the transition it's owed by, nor vice versa.
      const tourflowOperation = tourflowKind ? operation(tourflowKind, 'pending', null, null) : null;
      const results = await guardDuplicatePaymentIntent(patch.stripePaymentIntent, () =>
        db.batch([
          db.prepare(
            `UPDATE bookings SET ${setClauses.join(', ')}
             WHERE id = ? AND status IN (${placeholders}) AND confirmation_lease_token = ?`,
          ).bind(...entries.map(([, value]) => value), updatedAt, id, ...expectedStatusIn, leaseToken),
          operation('calendar_create', 'pending', null, null),
          operation('email_confirmation', 'pending', null, null),
          ...(oversold ? [operation('oversell', 'succeeded', 'capacity_exceeded', updatedAt)] : []),
          ...(tourflowOperation ? [tourflowOperation] : []),
        ]));
      if ((results[0]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async applyConfirmedPaymentDetails(id, patch, leaseToken, updatedAt) {
      const columnMap: Record<string, string> = {
        stripePaymentIntent: 'stripe_payment_intent', customerName: 'customer_name',
        customerEmail: 'customer_email', customerPhone: 'customer_phone', pickupAddress: 'pickup_address',
      };
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return false;
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported confirmation field');
      const result = await guardDuplicatePaymentIntent(patch.stripePaymentIntent, () =>
        db.prepare(
          `UPDATE bookings SET ${columns.map((column) => `${column} = COALESCE(${column}, ?)`).join(', ')}, updated_at = ?
           WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ?`,
        ).bind(...entries.map(([, value]) => value), updatedAt, id, leaseToken).run());
      return result.meta.changes > 0;
    },
    async ensureConfirmationSideEffectOperations(id, leaseToken, now, tourflowKind) {
      const operation = (kind: ConfirmationSideEffectKind, syncedColumn: 'calendar_synced' | 'email_synced') => db.prepare(
        `INSERT INTO side_effect_operations (
           booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
         )
         SELECT ?, ?,
           CASE WHEN ${syncedColumn} = 1 THEN 'succeeded' ELSE 'pending' END,
           CASE WHEN ? = 'calendar_create' THEN calendar_event_id ELSE NULL END,
           0, NULL, CASE WHEN ${syncedColumn} = 1 THEN ? ELSE NULL END, NULL, ?, ?
         FROM bookings
         WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ?
         ON CONFLICT(booking_id, kind) DO NOTHING`,
      ).bind(id, kind, kind, now, now, now, id, leaseToken);
      // Plan 011 (design decision 2): a legacy confirmed booking's row, created lazily only when
      // tourflow_synced is still 0 — an already-synced legacy booking is never replayed a row (no
      // WHEN branch needed here: the row is always inserted 'pending', unlike calendar/email above,
      // which can already be synced when this repair path first runs for them).
      const tourflowOperation = tourflowKind ? db.prepare(
        `INSERT INTO side_effect_operations (
           booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
         )
         SELECT ?, ?, 'pending', NULL, 0, NULL, NULL, NULL, ?, ?
         FROM bookings
         WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ? AND tourflow_synced = 0
         ON CONFLICT(booking_id, kind) DO NOTHING`,
      ).bind(id, tourflowKind, now, now, id, leaseToken) : null;
      await db.batch([
        operation('calendar_create', 'calendar_synced'),
        operation('email_confirmation', 'email_synced'),
        ...(tourflowOperation ? [tourflowOperation] : []),
      ]);
    },
    async listSideEffectOperations(bookingId) {
      const result = await db.prepare(
        `SELECT ${sideEffectOperationColumns} FROM side_effect_operations WHERE booking_id = ? ORDER BY kind`,
      ).bind(bookingId).all<SideEffectOperationRow>();
      return result.results.map(mapSideEffectOperation);
    },
    async claimSideEffectOperation(bookingId, kind, leaseToken, attemptedAt) {
      const result = await db.prepare(
        `UPDATE side_effect_operations
         SET status = 'in_flight', attempt_count = attempt_count + 1, attempted_at = ?, error = NULL, updated_at = ?
         WHERE booking_id = ? AND kind = ? AND status != 'succeeded'
           AND EXISTS (
             SELECT 1 FROM bookings WHERE id = ? AND confirmation_lease_token = ?
           )`,
      ).bind(attemptedAt, attemptedAt, bookingId, kind, bookingId, leaseToken).run();
      return result.meta.changes > 0;
    },
    async resolveSideEffectOperation(input) {
      const bookingFlag = input.kind === 'calendar_create' ? 'calendar_synced' : 'email_synced';
      const result = await db.batch([
        db.prepare(
          `UPDATE side_effect_operations
           SET status = ?, provider_result_id = ?, error = ?, resolved_at = ?, updated_at = ?
           WHERE booking_id = ? AND kind = ? AND status != 'succeeded'
             AND EXISTS (
               SELECT 1 FROM bookings WHERE id = ? AND confirmation_lease_token = ?
             )`,
        ).bind(
          input.status, input.providerResultId ?? null, input.error ?? null, input.resolvedAt, input.resolvedAt,
          input.bookingId, input.kind, input.bookingId, input.leaseToken,
        ),
        db.prepare(
          `UPDATE bookings SET ${bookingFlag} = ?, calendar_event_id = CASE WHEN ? = 'calendar_create' THEN ? ELSE calendar_event_id END, updated_at = ?
           WHERE id = ? AND confirmation_lease_token = ?`,
        ).bind(input.status === 'succeeded' ? 1 : 0, input.kind, input.providerResultId ?? null, input.resolvedAt, input.bookingId, input.leaseToken),
      ]);
      return (result[0]?.meta.changes ?? 0) > 0;
    },
    // BK-SIDE-001 (handoff 13) HIGH-2: see the BookingRepository interface comment above these two
    // methods for why they're ungated and how attempted_at doubles as a lease token. staleBefore
    // is computed from the CALLER's own attemptedAt (not a fresh clock read) so this stays a pure
    // function of its inputs, consistent with every other repo method here.
    async claimMutationSideEffectOperation(bookingId, kind, attemptedAt) {
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const result = await db.prepare(
        `UPDATE side_effect_operations
         SET status = 'in_flight', attempt_count = attempt_count + 1, attempted_at = ?, error = NULL, updated_at = ?
         WHERE booking_id = ? AND kind = ?
           AND (status IN ('pending', 'failed') OR (status = 'in_flight' AND attempted_at < ?))`,
      ).bind(attemptedAt, attemptedAt, bookingId, kind, staleBefore).run();
      return result.meta.changes > 0;
    },
    async resolveMutationSideEffectOperation(input) {
      const result = await db.prepare(
        `UPDATE side_effect_operations
         SET status = ?, provider_result_id = ?, error = ?, resolved_at = ?, updated_at = ?
         WHERE booking_id = ? AND kind = ? AND status = 'in_flight' AND attempted_at = ?`,
      ).bind(
        input.status, input.providerResultId ?? null, input.error ?? null, input.resolvedAt, input.resolvedAt,
        input.bookingId, input.kind, input.claimedAt,
      ).run();
      return result.meta.changes > 0;
    },
    // Plan 011 (design decision 4): mirrors resolveMutationSideEffectOperation's claimedAt-gated
    // row update, then atomically flips tourflow_synced in the same batch — but only when THIS
    // call's own row update just landed. The second statement checks post-first-statement state
    // (status = 'succeeded' AND resolved_at = this call's resolvedAt, both only true if the first
    // UPDATE's WHERE matched) rather than re-deriving success from input.status directly, so a
    // stale/reclaimed loser's resolve (whose own UPDATE affects 0 rows because a reclaimer's already
    // moved attempted_at) can never flip the flag on someone else's outcome.
    async resolveConfirmationTourflowOperation(input) {
      const result = await db.batch([
        db.prepare(
          `UPDATE side_effect_operations
           SET status = ?, error = ?, resolved_at = ?, updated_at = ?
           WHERE booking_id = ? AND kind = ? AND status = 'in_flight' AND attempted_at = ?`,
        ).bind(input.status, input.error ?? null, input.resolvedAt, input.resolvedAt, input.bookingId, CONFIRMATION_TOURFLOW_KIND, input.claimedAt),
        db.prepare(
          `UPDATE bookings SET tourflow_synced = 1, updated_at = ?
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM side_effect_operations
             WHERE booking_id = ? AND kind = ? AND status = 'succeeded' AND resolved_at = ?
           )`,
        ).bind(input.resolvedAt, input.bookingId, input.bookingId, CONFIRMATION_TOURFLOW_KIND, input.resolvedAt),
      ]);
      return (result[0]?.meta.changes ?? 0) > 0;
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
      const kinds = input.mutationSideEffectKinds ?? [];
      if (kinds.length === 0) {
        const result = await updateStmt.run();
        if (result.meta.changes === 0) return null;
        return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      }
      const results = await db.batch([
        mutationSideEffectInsert(id, kinds, input.updatedAt, casPredicate, casParams, true),
        updateStmt,
      ]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    // BK-CAP-001: transitionReschedule's CAS (status + starts_at) plus the same max-concurrency
    // capacity guard as insertHoldWithCapacity (patch-05-r1 Fix 1 — see the comment there for the
    // NOT EXISTS shape and the retained calendar-occupancy limitation), with `id != ?` excluding
    // this booking's own current row from BOTH the candidate points and the covering-sum
    // subqueries — otherwise a move within/into a window this booking already occupies would
    // count itself against its own request (see the "excludes its own occupancy" test).
    //
    // patch-05-r1 Fix 3: occupancy_units is now re-asserted on every reschedule (computed from
    // occupancyFor(tour, people) at the call site — party size doesn't change on a reschedule).
    // This opportunistically self-heals a legacy NULL row (see migrations/0008) the first time it
    // is ever moved, instead of leaving it undercounted as 1 unit forever.
    async rescheduleWithCapacity(id, input) {
      // BK-SIDE-001 (handoff 13) HIGH-1(a): factored out (not inlined in the UPDATE below) so the
      // batched outbox INSERT can re-check the EXACT SAME condition — including the capacity
      // guard, not just status/starts_at — via WHERE EXISTS, evaluated before the UPDATE runs (see
      // mutationSideEffectInsert's comment). Duplicating just the WHERE text this way (one source
      // of truth for the params too) is cheaper to keep in sync than re-deriving a simplified
      // guard that could silently drift from what actually gates the write.
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
        // NOT EXISTS candidate points (self-excluded): the request's own start, then every other
        // active overlapping booking's own starts_at.
        input.startsAt,
        id, input.now, input.startsAt, input.occupancyEndsAt, input.startsAt,
        // sum-at-point (b2, self-excluded) + requestedUnits > capacity resolution.
        id, input.now,
        input.occupancyUnits,
        input.localDate, input.localDate, input.fleetDefaultCapacity,
      ];
      // patch-11-r1 MEDIUM 2: same COALESCE(?, tokens_expire_at) as transitionReschedule above.
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
      const kinds = input.mutationSideEffectKinds ?? [];
      if (kinds.length === 0) {
        const result = await updateStmt.run();
        if (result.meta.changes === 0) return null;
        return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      }
      const results = await db.batch([mutationSideEffectInsert(id, kinds, input.updatedAt, casPredicate, casParams, true), updateStmt]);
      if ((results[1]?.meta.changes ?? 0) === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    // Deliberately NOT hydrated (plain mapBooking): purely internal occupancy math
    // (src/core/occupancy.ts via availabilityForDay/checkSlot), can return many rows for a wide
    // date range, and never renders/emails a token — hydrating here would be a real per-row
    // AES-GCM cost for values nothing reads.
    async listOccupancyBookings(from, to) {
      const result = await db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE starts_at < ? AND starts_at >= ? AND status IN ('hold', 'confirmed')
         ORDER BY starts_at`,
      ).bind(to, from).all<BookingRow>();
      return result.results.map(mapBooking);
    },
    // Hydrated: the admin dashboard (src/handlers/index.ts handleAdminGet) renders each row's
    // operatorToken as a manage-link href straight off this list.
    async listUpcoming(now) {
      const result = await db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE starts_at >= ? AND (status = 'confirmed' OR (status = 'hold' AND hold_expires_at > ?))
         ORDER BY starts_at`,
      ).bind(now, now).all<BookingRow>();
      const key = await resolveTokenKey();
      return Promise.all(result.results.map((row) => hydrateBooking(row, key)));
    },
    // Hydrated: a custom OpsSink.mapBooking (src/handlers/index.ts handleFeed) may read a
    // booking's tokens, and the default feed mapping doesn't, so hydrating here is the only way
    // to keep that consumer contract honest without knowing which mapper is plugged in.
    async listSince(since) {
      const result = await db.prepare(`SELECT ${bookingColumns} FROM bookings WHERE updated_at > ? ORDER BY updated_at`).bind(since).all<BookingRow>();
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
    // Bounded by handleAdminPost's 366-day cap (a year of daily overrides), so a single
    // db.batch() call here never risks exceeding D1's per-batch statement limit.
    async upsertDayOverrides(dates, capacity, reason) {
      if (dates.length === 0) return;
      await db.batch(dates.map((date) => db.prepare(
        `INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET capacity = excluded.capacity, reason = excluded.reason`,
      ).bind(date, capacity, reason)));
    },
    async deleteDayOverrides(dates) {
      if (dates.length === 0) return;
      await db.batch(dates.map((date) => db.prepare('DELETE FROM day_overrides WHERE date = ?').bind(date)));
    },
    async listCapacityDefaults() {
      const result = await db.prepare(
        'SELECT from_date, capacity, reason FROM capacity_defaults ORDER BY from_date',
      ).all<{ from_date: string; capacity: number; reason: string | null }>();
      return result.results.map((row) => ({ fromDate: row.from_date, capacity: Number(row.capacity), reason: row.reason ?? null }));
    },
    async upsertCapacityDefault(fromDate, capacity, reason) {
      await db.prepare(
        `INSERT INTO capacity_defaults (from_date, capacity, reason) VALUES (?, ?, ?)
         ON CONFLICT(from_date) DO UPDATE SET capacity = excluded.capacity, reason = excluded.reason`,
      ).bind(fromDate, capacity, reason).run();
    },
    async deleteCapacityDefault(fromDate) {
      await db.prepare('DELETE FROM capacity_defaults WHERE from_date = ?').bind(fromDate).run();
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
    async deleteSetting(key) {
      await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
    },
    async applySettingsBatch(operations) {
      if (operations.length === 0) return;
      // D1's batch() runs its statements in an implicit transaction — if any fails, none commit.
      const statements = operations.map((operation) => operation.type === 'upsert'
        ? db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(operation.key, operation.value)
        : db.prepare('DELETE FROM settings WHERE key = ?').bind(operation.key));
      await db.batch(statements);
    },
    async claimRefundOperation(input) {
      // Same conditional-insert idiom as insertHold's per-IP cap: the WHERE NOT EXISTS makes this
      // a single-statement compare-and-set, backed by the UNIQUE(booking_id) constraint as the
      // real safety net under concurrent writers.
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
      // WHERE status != 'succeeded' is the CAS guard: once a row has succeeded (recorded either
      // here or by the charge.refunded webhook's upsert), it is terminal — no later resolve call
      // can regress its status or overwrite its stripe_refund_id/amount_cents.
      await db.prepare(
        `UPDATE refund_operations SET status = ?, stripe_refund_id = ?, amount_cents = ?, error = ?, resolved_at = ?
         WHERE id = ? AND status != 'succeeded'`,
      ).bind(input.status, input.stripeRefundId ?? null, input.amountCents ?? null, input.error ?? null, input.resolvedAt, id).run();
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
  };
}

export { mapBooking };
