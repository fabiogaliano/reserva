import type { D1Database, D1Result } from '@cloudflare/workers-types';
import type { Booking, BookingStatus, CancellationActor } from './core/booking';
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

export type SideEffectOperationKind = 'calendar_create' | 'email_confirmation' | 'oversell';
export type SideEffectOperationStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed';

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
  getBookingByCancelToken(token: string): Promise<Booking | null>;
  getBookingByOperatorToken(token: string): Promise<Booking | null>;
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
  transitionToCancelled(id: string, input: {
    expectedStatusIn: BookingStatus[];
    // Optional guard against a concurrent reschedule: when set, the UPDATE also requires
    // starts_at to still match, so a cancel decision computed against a stale start time
    // (refund/notice windows) can never land after the booking has already moved.
    expectedStartsAt?: string;
    cancelledAt: string;
    cancelledBy: CancellationActor;
    updatedAt: string;
  }): Promise<Booking | null>;
  transitionToNoShow(id: string, input: {
    expectedStatusIn: BookingStatus[];
    updatedAt: string;
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
  }): Promise<Booking | null>;
  applyConfirmedPaymentDetails(id: string, patch: {
    stripePaymentIntent?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    pickupAddress?: string | null;
  }, leaseToken: string, updatedAt: string): Promise<boolean>;
  ensureConfirmationSideEffectOperations(id: string, leaseToken: string, now: string): Promise<void>;
  listSideEffectOperations(bookingId: string): Promise<SideEffectOperationRecord[]>;
  claimSideEffectOperation(bookingId: string, kind: Exclude<SideEffectOperationKind, 'oversell'>, leaseToken: string, attemptedAt: string): Promise<boolean>;
  resolveSideEffectOperation(input: {
    bookingId: string;
    kind: Exclude<SideEffectOperationKind, 'oversell'>;
    leaseToken: string;
    status: 'succeeded' | 'failed';
    providerResultId?: string | null;
    error?: string | null;
    resolvedAt: string;
  }): Promise<boolean>;
  transitionReschedule(id: string, input: {
    expectedStatus: BookingStatus;
    expectedStartsAt: string;
    startsAt: string;
    endsAt: string;
    rescheduledFrom: string;
    updatedAt: string;
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
  } & CapacityGuardInput): Promise<Booking | null>;
  listOccupancyBookings(from: string, to: string): Promise<Booking[]>;
  listUpcoming(now: string): Promise<Booking[]>;
  listSince(since: string): Promise<Booking[]>;
  getDayOverride(date: string): Promise<DayCapacityOverride | null>;
  listDayOverrides(from: string, to: string): Promise<DayCapacityOverride[]>;
  upsertDayOverride(date: string, capacity: number, reason: string | null): Promise<void>;
  deleteDayOverride(date: string): Promise<void>;
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
  // Stripe-initiated refunds (e.g. from the dashboard) arrive via webhook with no prior claim —
  // upsert so operator- and Stripe-initiated refunds reconcile through the same record instead of
  // drifting apart. Does not overwrite requested_at on an existing row.
  upsertRefundOperation(input: {
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
  }): Promise<void>;
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
  cancelled_at: string | null;
  cancelled_by: CancellationActor | null;
  rescheduled_from: string | null;
  created_at: string;
  updated_at: string;
}

function mapBooking(row: BookingRow): Booking {
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
  tourflow_synced, reminded_at, review_requested_at, cancel_token, operator_token, cancelled_at,
  cancelled_by, rescheduled_from, created_at, updated_at`;

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

export function createBookingRepository(db: D1Database): BookingRepository {
  const oneBooking = async (sql: string, ...params: unknown[]): Promise<Booking | null> => {
    const row = await first(db.prepare(sql).bind(...params).all<BookingRow>());
    return row ? mapBooking(row) : null;
  };

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
    getBookingByReference: (reference) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE reference = ?`, reference),
    getBookingBySessionId: (sessionId) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE stripe_session_id = ?`, sessionId),
    getBookingByPaymentIntent: (paymentIntent) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE stripe_payment_intent = ?`, paymentIntent),
    getBookingByCancelToken: (token) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE cancel_token = ?`, token),
    getBookingByOperatorToken: (token) => oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE operator_token = ?`, token),
    async countReferencesForYear(prefix) {
      const row = await first(db.prepare(
        'SELECT COUNT(*) AS count FROM bookings WHERE reference LIKE ?',
      ).bind(`${prefix}%`).all<{ count: number }>());
      return Number(row?.count ?? 0);
    },
    async insertHold(input) {
      const holdIp = input.holdIp ?? null;
      const holdLimit = input.maxActiveHoldsForIp ?? null;
      const result = await db.prepare(
        `INSERT INTO bookings (
          id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents,
          status, hold_expires_at, cancel_token, operator_token, hold_ip, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hold', ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL OR (
          SELECT COUNT(*) FROM bookings
          WHERE hold_ip = ? AND status = 'hold' AND hold_expires_at >= ?
        ) < ?`,
      ).bind(
        input.id, input.reference, input.tourSlug, input.people, input.pickupType,
        input.startsAt, input.endsAt, input.locale, input.priceCents, input.holdExpiresAt,
        input.cancelToken, input.operatorToken, holdIp, input.createdAt, input.updatedAt,
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
      const result = await db.prepare(
        `INSERT INTO bookings (
          id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents,
          status, hold_expires_at, cancel_token, operator_token, hold_ip, occupancy_units,
          occupancy_ends_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hold', ?, ?, ?, ?, ?, ?, ?, ?
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
        input.cancelToken, input.operatorToken, holdIp, input.occupancyUnits, input.occupancyEndsAt,
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
      await db.prepare(`UPDATE bookings SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
        .bind(...values, id).run();
      const updated = await oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
      if (!updated) throw new Error('Booking not found');
      return updated;
    },
    async transitionToCancelled(id, input) {
      const placeholders = input.expectedStatusIn.map(() => '?').join(', ');
      // starts_at clause is appended only when the caller supplies it, so callers that don't
      // care about a concurrent reschedule (e.g. the refund webhook) keep the original scope.
      const startsAtClause = input.expectedStartsAt !== undefined ? ' AND starts_at = ?' : '';
      const params = [
        input.cancelledAt, input.cancelledBy, input.updatedAt, id, ...input.expectedStatusIn,
        ...(input.expectedStartsAt !== undefined ? [input.expectedStartsAt] : []),
      ];
      const result = await db.prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})${startsAtClause}`,
      ).bind(...params).run();
      if (result.meta.changes === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async transitionToNoShow(id, input) {
      const placeholders = input.expectedStatusIn.map(() => '?').join(', ');
      const result = await db.prepare(
        `UPDATE bookings SET status = 'no_show', updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      ).bind(input.updatedAt, id, ...input.expectedStatusIn).run();
      if (result.meta.changes === 0) return null;
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
      const result = await db.prepare(
        `UPDATE bookings SET ${setClauses.join(', ')} WHERE id = ? AND status IN (${placeholders})`,
      ).bind(...entries.map(([, value]) => value), updatedAt, id, ...expectedStatusIn).run();
      if (result.meta.changes === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async confirmWithSideEffectOperations(id, input) {
      const { expectedStatusIn, updatedAt, leaseToken, oversold, ...patch } = input;
      const columnMap: Record<string, string> = {
        stripePaymentIntent: 'stripe_payment_intent', customerName: 'customer_name',
        customerEmail: 'customer_email', customerPhone: 'customer_phone', pickupAddress: 'pickup_address',
      };
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      const columns = entries.map(([key]) => columnMap[key]);
      if (columns.some((column) => !column)) throw new Error('Unsupported confirmation field');
      const placeholders = expectedStatusIn.map(() => '?').join(', ');
      const setClauses = [`status = 'confirmed'`, 'hold_expires_at = NULL', ...columns.map((column) => `${column} = ?`), 'updated_at = ?'];
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
      const results = await db.batch([
        db.prepare(
          `UPDATE bookings SET ${setClauses.join(', ')}
           WHERE id = ? AND status IN (${placeholders}) AND confirmation_lease_token = ?`,
        ).bind(...entries.map(([, value]) => value), updatedAt, id, ...expectedStatusIn, leaseToken),
        operation('calendar_create', 'pending', null, null),
        operation('email_confirmation', 'pending', null, null),
        ...(oversold ? [operation('oversell', 'succeeded', 'capacity_exceeded', updatedAt)] : []),
      ]);
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
      const result = await db.prepare(
        `UPDATE bookings SET ${columns.map((column) => `${column} = COALESCE(${column}, ?)`).join(', ')}, updated_at = ?
         WHERE id = ? AND status = 'confirmed' AND confirmation_lease_token = ?`,
      ).bind(...entries.map(([, value]) => value), updatedAt, id, leaseToken).run();
      return result.meta.changes > 0;
    },
    async ensureConfirmationSideEffectOperations(id, leaseToken, now) {
      const operation = (kind: Exclude<SideEffectOperationKind, 'oversell'>, syncedColumn: 'calendar_synced' | 'email_synced') => db.prepare(
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
      await db.batch([
        operation('calendar_create', 'calendar_synced'),
        operation('email_confirmation', 'email_synced'),
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
    async transitionReschedule(id, input) {
      const result = await db.prepare(
        `UPDATE bookings SET starts_at = ?, ends_at = ?, rescheduled_from = ?, updated_at = ?
         WHERE id = ? AND status = ? AND starts_at = ?`,
      ).bind(input.startsAt, input.endsAt, input.rescheduledFrom, input.updatedAt, id, input.expectedStatus, input.expectedStartsAt).run();
      if (result.meta.changes === 0) return null;
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
      const result = await db.prepare(
        `UPDATE bookings
         SET starts_at = ?, ends_at = ?, rescheduled_from = ?, occupancy_units = ?, occupancy_ends_at = ?, updated_at = ?
         WHERE id = ? AND status = ? AND starts_at = ?
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
           )`,
      ).bind(
        input.startsAt, input.endsAt, input.rescheduledFrom, input.occupancyUnits, input.occupancyEndsAt, input.updatedAt,
        id, input.expectedStatus, input.expectedStartsAt,
        // NOT EXISTS candidate points (self-excluded): the request's own start, then every other
        // active overlapping booking's own starts_at.
        input.startsAt,
        id, input.now, input.startsAt, input.occupancyEndsAt, input.startsAt,
        // sum-at-point (b2, self-excluded) + requestedUnits > capacity resolution.
        id, input.now,
        input.occupancyUnits,
        input.localDate, input.localDate, input.fleetDefaultCapacity,
      ).run();
      if (result.meta.changes === 0) return null;
      return oneBooking(`SELECT ${bookingColumns} FROM bookings WHERE id = ?`, id);
    },
    async listOccupancyBookings(from, to) {
      const result = await db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE starts_at < ? AND starts_at >= ? AND status IN ('hold', 'confirmed')
         ORDER BY starts_at`,
      ).bind(to, from).all<BookingRow>();
      return result.results.map(mapBooking);
    },
    async listUpcoming(now) {
      const result = await db.prepare(
        `SELECT ${bookingColumns} FROM bookings
         WHERE starts_at >= ? AND (status = 'confirmed' OR (status = 'hold' AND hold_expires_at > ?))
         ORDER BY starts_at`,
      ).bind(now, now).all<BookingRow>();
      return result.results.map(mapBooking);
    },
    async listSince(since) {
      const result = await db.prepare(`SELECT ${bookingColumns} FROM bookings WHERE updated_at > ? ORDER BY updated_at`).bind(since).all<BookingRow>();
      return result.results.map(mapBooking);
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
      // Preserve a terminal Stripe outcome; only its reconciliation timestamp may advance.
      await db.prepare(
        `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, stripe_refund_id, amount_cents, requested_at, resolved_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(booking_id) DO UPDATE SET
           payment_intent = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.payment_intent ELSE excluded.payment_intent END,
           choice = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.choice ELSE excluded.choice END,
           status = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.status ELSE excluded.status END,
           stripe_refund_id = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.stripe_refund_id ELSE excluded.stripe_refund_id END,
           amount_cents = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.amount_cents ELSE excluded.amount_cents END,
           resolved_at = excluded.resolved_at,
           error = CASE WHEN refund_operations.status = 'succeeded' THEN refund_operations.error ELSE excluded.error END`
      ).bind(
        input.id, input.bookingId, input.paymentIntent, input.choice, input.status,
        input.stripeRefundId, input.amountCents, input.requestedAt, input.resolvedAt, input.error ?? null,
      ).run();
    },
  };
}

export { mapBooking };
