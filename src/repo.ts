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
  releaseConfirmationLease(id: string, token: string): Promise<void>;
  getBookingById(id: string): Promise<Booking | null>;
  getBookingByReference(reference: string): Promise<Booking | null>;
  getBookingBySessionId(sessionId: string): Promise<Booking | null>;
  getBookingByPaymentIntent?(paymentIntent: string): Promise<Booking | null>;
  getBookingByCancelToken(token: string): Promise<Booking | null>;
  getBookingByOperatorToken(token: string): Promise<Booking | null>;
  countReferencesForYear(prefix: string): Promise<number>;
  insertHold(input: BookingInsert): Promise<Booking>;
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
  transitionReschedule(id: string, input: {
    expectedStatus: BookingStatus;
    expectedStartsAt: string;
    startsAt: string;
    endsAt: string;
    rescheduledFrom: string;
    updatedAt: string;
  }): Promise<Booking | null>;
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
    async transitionReschedule(id, input) {
      const result = await db.prepare(
        `UPDATE bookings SET starts_at = ?, ends_at = ?, rescheduled_from = ?, updated_at = ?
         WHERE id = ? AND status = ? AND starts_at = ?`,
      ).bind(input.startsAt, input.endsAt, input.rescheduledFrom, input.updatedAt, id, input.expectedStatus, input.expectedStartsAt).run();
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
  };
}

export { mapBooking };
