import type { BookkitProviders } from '../src/context';
import type { Booking } from '../src/core/booking';
import type { PaymentProvider } from '../src/core/events';
import { HoldLimitExceededError, type BookingRepository, type RefundOperationRecord } from '../src/repo';
import { booking } from './fixtures';

// Shared in-memory fake repository + provider harness for handler tests.
// Kept general (seed bookings, override individual repo methods / providers)
// so other test files can build on it without re-implementing this plumbing.
export function fakeRepository(seed: Booking[] = []): BookingRepository & { rows: Map<string, Booking>; settings: Map<string, string>; refundOperations: Map<string, RefundOperationRecord> } {
  const rows = new Map(seed.map((item) => [item.id, item]));
  const holdIps = new Map<string, string>();
  const settings = new Map<string, string>();
  const leases = new Map<string, { token: string; until: string }>();
  // Keyed by booking_id, mirroring the real table's UNIQUE(booking_id) constraint.
  const refundOperations = new Map<string, RefundOperationRecord>();
  const find = (predicate: (item: Booking) => boolean) => [...rows.values()].find(predicate) ?? null;
  return {
    rows,
    sweepExpiredHolds: async (now) => {
      let changes = 0;
      for (const item of rows.values()) if (item.status === 'hold' && item.holdExpiresAt && item.holdExpiresAt < now) {
        rows.set(item.id, { ...item, status: 'expired', holdExpiresAt: null, updatedAt: now });
        changes += 1;
      }
      return changes;
    },
    expireHold: async (id, now) => {
      const current = rows.get(id);
      if (!current || current.status !== 'hold') return null;
      const expired = { ...current, status: 'expired' as const, holdExpiresAt: null, updatedAt: now };
      rows.set(id, expired);
      return expired;
    },
    acquireConfirmationLease: async (id, token, now, leaseUntil) => {
      // The real repo's UPDATE ... WHERE id = ? matches no row for unknown ids.
      if (!rows.has(id)) return false;
      const current = leases.get(id);
      if (current && current.until >= now) return false;
      leases.set(id, { token, until: leaseUntil });
      return true;
    },
    releaseConfirmationLease: async (id, token) => {
      if (leases.get(id)?.token === token) leases.delete(id);
    },
    getBookingById: async (id) => rows.get(id) ?? null,
    getBookingByReference: async (reference) => find((item) => item.reference === reference),
    getBookingBySessionId: async (sessionId) => find((item) => item.stripeSessionId === sessionId),
    getBookingByPaymentIntent: async (paymentIntent) => find((item) => item.stripePaymentIntent === paymentIntent),
    getBookingByCancelToken: async (token) => find((item) => item.cancelToken === token),
    getBookingByOperatorToken: async (token) => find((item) => item.operatorToken === token),
    countReferencesForYear: async (prefix) => [...rows.values()].filter((item) => item.reference.startsWith(prefix)).length,
    insertHold: async (input) => {
      if (input.holdIp && input.maxActiveHoldsForIp) {
        const active = [...rows.values()].filter((item) =>
          holdIps.get(item.id) === input.holdIp
          && item.status === 'hold'
          && item.holdExpiresAt !== null
          && item.holdExpiresAt >= input.createdAt,
        );
        if (active.length >= input.maxActiveHoldsForIp) throw new HoldLimitExceededError();
      }
      const created: Booking = { ...booking(), ...input, pickupAddress: null, customerName: null, customerEmail: null, customerPhone: null, status: 'hold', stripeSessionId: null, stripePaymentIntent: null, calendarEventId: null, calendarSynced: false, emailSynced: false, tourflowSynced: false, remindedAt: null, reviewRequestedAt: null, cancelledAt: null, cancelledBy: null, rescheduledFrom: null };
      rows.set(created.id, created);
      if (input.holdIp) holdIps.set(created.id, input.holdIp);
      return created;
    },
    updateBooking: async (id, patch) => {
      const current = rows.get(id);
      if (!current) throw new Error('missing booking');
      const updated = { ...current, ...patch } as Booking;
      rows.set(id, updated);
      return updated;
    },
    // Mirrors src/repo.ts's conditional UPDATE ... WHERE id = ? AND status IN (...): only
    // apply the mutation (and return the new row) when the current status still matches;
    // otherwise report the loss (null) instead of clobbering whatever won the race.
    transitionToCancelled: async (id, input) => {
      const current = rows.get(id);
      if (!current || !input.expectedStatusIn.includes(current.status)) return null;
      if (input.expectedStartsAt !== undefined && current.startsAt !== input.expectedStartsAt) return null;
      const updated: Booking = { ...current, status: 'cancelled', cancelledAt: input.cancelledAt, cancelledBy: input.cancelledBy, updatedAt: input.updatedAt };
      rows.set(id, updated);
      return updated;
    },
    transitionToNoShow: async (id, input) => {
      const current = rows.get(id);
      if (!current || !input.expectedStatusIn.includes(current.status)) return null;
      const updated: Booking = { ...current, status: 'no_show', updatedAt: input.updatedAt };
      rows.set(id, updated);
      return updated;
    },
    transitionToConfirmed: async (id, input) => {
      const current = rows.get(id);
      if (!current || !input.expectedStatusIn.includes(current.status)) return null;
      const { expectedStatusIn, updatedAt, ...patch } = input;
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const updated: Booking = { ...current, ...defined, status: 'confirmed', holdExpiresAt: null, updatedAt };
      rows.set(id, updated);
      return updated;
    },
    transitionReschedule: async (id, input) => {
      const current = rows.get(id);
      if (!current || current.status !== input.expectedStatus || current.startsAt !== input.expectedStartsAt) return null;
      const updated: Booking = { ...current, startsAt: input.startsAt, endsAt: input.endsAt, rescheduledFrom: input.rescheduledFrom, updatedAt: input.updatedAt };
      rows.set(id, updated);
      return updated;
    },
    listOccupancyBookings: async (from, to) => [...rows.values()].filter((item) => item.startsAt >= from && item.startsAt < to),
    // Mirrors src/repo.ts:260-267 — starts_at >= now AND (confirmed OR (hold AND hold_expires_at > now)), ordered by starts_at.
    listUpcoming: async (now) => [...rows.values()]
      .filter((item) => item.startsAt >= now && (item.status === 'confirmed' || (item.status === 'hold' && item.holdExpiresAt !== null && item.holdExpiresAt > now)))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    // Mirrors src/repo.ts:268 — updated_at > since, ordered by updated_at.
    listSince: async (since) => [...rows.values()]
      .filter((item) => item.updatedAt > since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    getDayOverride: async () => null,
    listDayOverrides: async () => [],
    upsertDayOverride: async () => undefined,
    deleteDayOverride: async () => undefined,
    listCapacityDefaults: async () => [],
    upsertCapacityDefault: async () => undefined,
    deleteCapacityDefault: async () => undefined,
    settings,
    listSettings: async () => Object.fromEntries(settings),
    upsertSetting: async (key, value) => { settings.set(key, value); },
    deleteSetting: async (key) => { settings.delete(key); },
    // Real D1 runs these in one implicit transaction (see src/repo.ts); tests that need to prove
    // atomicity override this whole method to reject before touching `settings` at all.
    applySettingsBatch: async (operations) => {
      for (const operation of operations) {
        if (operation.type === 'upsert') settings.set(operation.key, operation.value);
        else settings.delete(operation.key);
      }
    },
    refundOperations,
    // Mirrors src/repo.ts's WHERE NOT EXISTS conditional insert: claims only when no operation
    // row exists yet for this booking_id, so a racing loser can be told who won.
    claimRefundOperation: async (input) => {
      if (refundOperations.has(input.bookingId)) return false;
      refundOperations.set(input.bookingId, {
        id: input.id, bookingId: input.bookingId, paymentIntent: input.paymentIntent,
        choice: input.choice, status: 'requested', stripeRefundId: null, amountCents: null,
        requestedAt: input.requestedAt, resolvedAt: null, error: null,
      });
      return true;
    },
    getRefundOperationByBookingId: async (bookingId) => refundOperations.get(bookingId) ?? null,
    // Mirrors src/repo.ts's conditional UPDATE ... WHERE status != 'succeeded': once a row has
    // succeeded, no later resolve call (a stale operator retry, say) may regress its status or
    // clear its recorded refund id/amount.
    resolveRefundOperation: async (id, input) => {
      const current = [...refundOperations.values()].find((operation) => operation.id === id);
      if (!current || current.status === 'succeeded') return;
      refundOperations.set(current.bookingId, {
        ...current,
        status: input.status,
        stripeRefundId: input.stripeRefundId ?? null,
        amountCents: input.amountCents ?? null,
        error: input.error ?? null,
        resolvedAt: input.resolvedAt,
      });
    },
    // Mirrors the requested-status guard in src/repo.ts so a completed Stripe outcome survives
    // a stale losing cancellation request.
    deleteRefundOperation: async (id) => {
      const entry = [...refundOperations.entries()].find(([, operation]) => operation.id === id && operation.status === 'requested');
      if (entry) refundOperations.delete(entry[0]);
    },
    upsertRefundOperation: async (input) => {
      const current = refundOperations.get(input.bookingId);
      if (current?.status === 'succeeded') {
        refundOperations.set(input.bookingId, { ...current, resolvedAt: input.resolvedAt });
        return;
      }
      refundOperations.set(input.bookingId, {
        id: input.id, bookingId: input.bookingId, paymentIntent: input.paymentIntent,
        choice: input.choice, status: input.status, stripeRefundId: input.stripeRefundId,
        amountCents: input.amountCents, requestedAt: current?.requestedAt ?? input.requestedAt,
        resolvedAt: input.resolvedAt, error: input.error ?? null,
      });
    },
  };
}

// Records the idempotency key each refund() call would carry (mirroring StripeProvider's own
// deterministic `bookkit-refund-<paymentIntent>` derivation) so tests can assert a retried refund
// reuses the same key instead of minting a fresh one per attempt (BK-REFUND-001 F10). `resultFor`
// lets a test control the returned refund id/amount, or throw to simulate a Stripe-side failure.
export function fakeRefundTracker(
  resultFor: (paymentIntent: string, callNumber: number) => { refundId: string; amountCents: number } = (paymentIntent) => ({ refundId: `re_${paymentIntent}`, amountCents: 0 }),
): { refund: PaymentProvider['refund']; idempotencyKeys: string[] } {
  const idempotencyKeys: string[] = [];
  return {
    idempotencyKeys,
    refund: async (paymentIntent) => {
      idempotencyKeys.push(`bookkit-refund-${paymentIntent}`);
      return resultFor(paymentIntent, idempotencyKeys.length);
    },
  };
}

export function providers(overrides: Partial<BookkitProviders> = {}): BookkitProviders {
  return {
    payments: {
      createCheckout: async () => ({ url: 'https://checkout.test/cs_1', sessionId: 'cs_1' }),
      parseWebhook: async () => ({
        id: 'evt_1',
        type: 'checkout.session.completed',
        sessionId: 'cs_1',
        paymentIntent: 'pi_1',
        paid: true,
        amountCaptured: 10000,
        customerName: 'Ada Lovelace',
        customerEmail: 'ada@example.com',
        customerPhone: '+351910000000',
        pickupAddress: 'Praça do Comércio',
      }),
      getSession: async () => ({ status: 'open' }),
      refund: async () => ({ refundId: 're_test', amountCents: 0 }),
    },
    calendar: {
      listEvents: async () => [],
      createEvent: async () => 'cal_1',
      patchEvent: async () => undefined,
      deleteEvent: async () => undefined,
    },
    email: { send: async () => undefined },
    ...overrides,
  };
}
