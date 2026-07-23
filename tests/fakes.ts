import type { BookkitProviders } from '../src/context';
import type { Booking } from '../src/core/booking';
import type { PaymentProvider } from '../src/core/events';
import {
  defaultCapacityForDate,
  getOccupancyIntervals,
  maxConcurrentOccupancy,
  resolveCapacity,
  type OccupancyBooking,
  type OccupancyTour,
} from '../src/core/occupancy';
import {
  HoldLimitExceededError,
  type BookingRepository,
  type RefundOperationRecord,
  type SideEffectOperationRecord,
} from '../src/repo';
import { booking } from './fixtures';

// Shared in-memory fake repository + provider harness for handler tests.
// Kept general (seed bookings, override individual repo methods / providers)
// so other test files can build on it without re-implementing this plumbing.
export function fakeRepository(seed: Booking[] = []): BookingRepository & {
  rows: Map<string, Booking>;
  settings: Map<string, string>;
  refundOperations: Map<string, RefundOperationRecord>;
  sideEffectOperations: Map<string, SideEffectOperationRecord>;
} {
  const rows = new Map(seed.map((item) => [item.id, item]));
  const holdIps = new Map<string, string>();
  const settings = new Map<string, string>();
  const leases = new Map<string, { token: string; until: string }>();
  // Keyed by booking_id, mirroring the real table's UNIQUE(booking_id) constraint.
  const refundOperations = new Map<string, RefundOperationRecord>();
  const sideEffectOperations = new Map<string, SideEffectOperationRecord>();
  const sideEffectKey = (bookingId: string, kind: SideEffectOperationRecord['kind']) => `${bookingId}:${kind}`;
  // Mirrors the occupancy_units / occupancy_ends_at columns migration 0008 adds (see
  // src/repo.ts insertHoldWithCapacity / rescheduleWithCapacity): rows seeded directly via the
  // `booking()` fixture (bypassing these methods) have no entry here, matching a pre-migration
  // NULL row, so the same COALESCE(units, 1) / COALESCE(endsAt, row.endsAt) fallback applies.
  const occupancyMeta = new Map<string, { units: number; endsAt: string }>();
  const find = (predicate: (item: Booking) => boolean) => [...rows.values()].find(predicate) ?? null;
  // patch-05-r1 Fix 2: reuse the REAL getOccupancyIntervals/maxConcurrentOccupancy (src/core/
  // occupancy.ts) instead of a hand-rolled SUM-of-overlaps calc that could silently drift from
  // src/repo.ts's own NOT-EXISTS max-concurrency guard (see the Fix 1 comment there). Each row's
  // already-resolved occupancy_ends_at/occupancy_units (tracked in `occupancyMeta`, falling back
  // to COALESCE(_, endsAt)/COALESCE(_, 1) for rows seeded outside these methods, matching a
  // pre-migration-0008 NULL row) is smuggled through a trivial zero-turnaround tour whose
  // occupancyFor is the identity on a synthetic `people` count — that lets getOccupancyIntervals
  // do the real active/overlap bookkeeping instead of a second, parallel implementation of it.
  const zeroTurnaroundTour: OccupancyTour = { turnaroundMin: 0, occupancyFor: (units) => units };
  const toOccupancyBooking = (item: Booking): OccupancyBooking => {
    const meta = occupancyMeta.get(item.id);
    return {
      id: item.id,
      status: item.status,
      startsAt: item.startsAt,
      endsAt: meta?.endsAt ?? item.endsAt,
      holdExpiresAt: item.holdExpiresAt,
      people: meta?.units ?? 1,
    };
  };
  // Max-concurrent occupancy in [targetStart, targetEnd) — the same semantic src/repo.ts's guard
  // now evaluates via NOT EXISTS (patch-05-r1 Fix 1), not the sum of every overlapping booking.
  const maxConcurrentInInterval = (targetStart: string, targetEnd: string, now: string, excludeId?: string): number => {
    const intervals = getOccupancyIntervals({
      bookings: [...rows.values()].map(toOccupancyBooking),
      tour: zeroTurnaroundTour,
      now,
      ...(excludeId !== undefined ? { excludeBookingId: excludeId } : {}),
    });
    return maxConcurrentOccupancy(intervals, targetStart, targetEnd);
  };
  // Mirrors capacityForDate/defaultCapacityForDate (core/occupancy.ts): a day override for
  // localDate wins outright; otherwise the capacity_defaults row with the latest from_date <=
  // localDate applies; otherwise fleetDefaultCapacity. Calls through `repository` (not a
  // captured local) so a test overriding repo.getDayOverride/listCapacityDefaults (same pattern
  // as overriding repo.listOccupancyBookings elsewhere in these tests) is honored here too.
  const resolveCapacityFake = async (localDate: string, fleetDefaultCapacity: number): Promise<number> => {
    const override = await repository.getDayOverride(localDate);
    if (override) return resolveCapacity(override.capacity);
    const defaults = await repository.listCapacityDefaults();
    return defaultCapacityForDate(localDate, fleetDefaultCapacity, defaults);
  };
  const repository: BookingRepository & { rows: Map<string, Booking>; settings: Map<string, string>; refundOperations: Map<string, RefundOperationRecord>; sideEffectOperations: Map<string, SideEffectOperationRecord> } = {
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
    renewConfirmationLease: async (id, token, now, leaseUntil) => {
      const current = leases.get(id);
      if (!current || current.token !== token || current.until < now) return false;
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
    // Mirrors src/repo.ts's insertHoldWithCapacity: the hold-ip cap still throws
    // HoldLimitExceededError, but a capacity loss returns null instead.
    //
    // patch-05-r1 Fix 2: the async capacity resolution runs FIRST (its own await is fine — no
    // reader has touched `rows`/`holdIps` yet, so nothing here is order-sensitive to it). Every
    // read of `rows`/`holdIps`/`occupancyMeta` that the decision depends on, the decision itself,
    // and the write are then one synchronous block with NO await in between, so a concurrent call
    // can never interleave between "decide" and "write" (mirrors D1 evaluating hold-limit +
    // capacity in the single WHERE of one INSERT statement).
    insertHoldWithCapacity: async (input) => {
      const capacity = await resolveCapacityFake(input.localDate, input.fleetDefaultCapacity);
      if (input.holdIp && input.maxActiveHoldsForIp) {
        const active = [...rows.values()].filter((item) =>
          holdIps.get(item.id) === input.holdIp
          && item.status === 'hold'
          && item.holdExpiresAt !== null
          && item.holdExpiresAt >= input.createdAt,
        );
        if (active.length >= input.maxActiveHoldsForIp) throw new HoldLimitExceededError();
      }
      const used = maxConcurrentInInterval(input.startsAt, input.occupancyEndsAt, input.createdAt);
      if (used + input.occupancyUnits > capacity) return null;
      const created: Booking = { ...booking(), ...input, pickupAddress: null, customerName: null, customerEmail: null, customerPhone: null, status: 'hold', stripeSessionId: null, stripePaymentIntent: null, calendarEventId: null, calendarSynced: false, emailSynced: false, tourflowSynced: false, remindedAt: null, reviewRequestedAt: null, cancelledAt: null, cancelledBy: null, rescheduledFrom: null };
      rows.set(created.id, created);
      occupancyMeta.set(created.id, { units: input.occupancyUnits, endsAt: input.occupancyEndsAt });
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
    confirmWithSideEffectOperations: async (id, input) => {
      const current = rows.get(id);
      if (!current || !input.expectedStatusIn.includes(current.status) || leases.get(id)?.token !== input.leaseToken) return null;
      const { expectedStatusIn, leaseToken, oversold, updatedAt, ...patch } = input;
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const updated: Booking = { ...current, ...defined, status: 'confirmed', holdExpiresAt: null, updatedAt };
      rows.set(id, updated);
      for (const kind of ['calendar_create', 'email_confirmation'] as const) {
        const key = sideEffectKey(id, kind);
        if (!sideEffectOperations.has(key)) sideEffectOperations.set(key, {
          bookingId: id, kind, status: 'pending', providerResultId: null, attemptCount: 0,
          attemptedAt: null, resolvedAt: null, error: null, createdAt: updatedAt, updatedAt,
        });
      }
      if (oversold) {
        const key = sideEffectKey(id, 'oversell');
        if (!sideEffectOperations.has(key)) sideEffectOperations.set(key, {
          bookingId: id, kind: 'oversell', status: 'succeeded', providerResultId: 'capacity_exceeded',
          attemptCount: 0, attemptedAt: null, resolvedAt: updatedAt, error: null, createdAt: updatedAt, updatedAt,
        });
      }
      return updated;
    },
    applyConfirmedPaymentDetails: async (id, patch, leaseToken, updatedAt) => {
      const current = rows.get(id);
      if (!current || current.status !== 'confirmed' || leases.get(id)?.token !== leaseToken) return false;
      const updated: Booking = {
        ...current,
        ...(current.stripePaymentIntent === null && patch.stripePaymentIntent !== undefined ? { stripePaymentIntent: patch.stripePaymentIntent } : {}),
        ...(current.customerName === null && patch.customerName !== undefined ? { customerName: patch.customerName } : {}),
        ...(current.customerEmail === null && patch.customerEmail !== undefined ? { customerEmail: patch.customerEmail } : {}),
        ...(current.customerPhone === null && patch.customerPhone !== undefined ? { customerPhone: patch.customerPhone } : {}),
        ...(current.pickupAddress === null && patch.pickupAddress !== undefined ? { pickupAddress: patch.pickupAddress } : {}),
        updatedAt,
      };
      rows.set(id, updated);
      return true;
    },
    ensureConfirmationSideEffectOperations: async (id, leaseToken, now) => {
      if (rows.get(id)?.status !== 'confirmed' || leases.get(id)?.token !== leaseToken) return;
      const booking = rows.get(id);
      if (!booking) return;
      for (const kind of ['calendar_create', 'email_confirmation'] as const) {
        const key = sideEffectKey(id, kind);
        const synced = kind === 'calendar_create' ? booking.calendarSynced : booking.emailSynced;
        if (!sideEffectOperations.has(key)) sideEffectOperations.set(key, {
          bookingId: id, kind, status: synced ? 'succeeded' : 'pending',
          providerResultId: kind === 'calendar_create' ? booking.calendarEventId : null,
          attemptCount: 0, attemptedAt: null, resolvedAt: synced ? now : null, error: null,
          createdAt: now, updatedAt: now,
        });
      }
    },
    listSideEffectOperations: async (bookingId) => [...sideEffectOperations.values()]
      .filter((operation) => operation.bookingId === bookingId)
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    claimSideEffectOperation: async (bookingId, kind, leaseToken, attemptedAt) => {
      const key = sideEffectKey(bookingId, kind);
      const current = sideEffectOperations.get(key);
      if (!current || current.status === 'succeeded' || leases.get(bookingId)?.token !== leaseToken) return false;
      sideEffectOperations.set(key, {
        ...current, status: 'in_flight', attemptCount: current.attemptCount + 1,
        attemptedAt, error: null, updatedAt: attemptedAt,
      });
      return true;
    },
    resolveSideEffectOperation: async (input) => {
      const key = sideEffectKey(input.bookingId, input.kind);
      const operation = sideEffectOperations.get(key);
      const current = rows.get(input.bookingId);
      if (!operation || !current || operation.status === 'succeeded' || leases.get(input.bookingId)?.token !== input.leaseToken) return false;
      sideEffectOperations.set(key, {
        ...operation, status: input.status, providerResultId: input.providerResultId ?? null,
        error: input.error ?? null, resolvedAt: input.resolvedAt, updatedAt: input.resolvedAt,
      });
      rows.set(input.bookingId, {
        ...current,
        ...(input.kind === 'calendar_create'
          ? { calendarSynced: input.status === 'succeeded', calendarEventId: input.providerResultId ?? null }
          : { emailSynced: input.status === 'succeeded' }),
        updatedAt: input.resolvedAt,
      });
      return true;
    },
    sideEffectOperations,
    transitionReschedule: async (id, input) => {
      const current = rows.get(id);
      if (!current || current.status !== input.expectedStatus || current.startsAt !== input.expectedStartsAt) return null;
      const updated: Booking = { ...current, startsAt: input.startsAt, endsAt: input.endsAt, rescheduledFrom: input.rescheduledFrom, updatedAt: input.updatedAt };
      rows.set(id, updated);
      return updated;
    },
    // Mirrors src/repo.ts's rescheduleWithCapacity: transitionReschedule's CAS plus the same
    // max-concurrency capacity guard as insertHoldWithCapacity, excluding this booking's own id
    // from the occupancy calc so a move within a window it already occupies isn't counted
    // against itself. patch-05-r1 Fix 3: occupancy_units is now re-asserted (self-healing a
    // legacy NULL row), matching src/repo.ts.
    //
    // patch-05-r1 Fix 2 (atomicity): the CAS pre-check used to read `current` BEFORE the
    // `await resolveCapacityFake`, so two concurrent reschedules of the SAME booking could both
    // capture the pre-write row, both pass the stale CAS check, and the loser would then
    // unconditionally clobber the winner's write once its own await resumed. Resolving capacity
    // FIRST (before touching `rows` at all) and doing CAS + occupancy decision + write as one
    // synchronous block after it closes that gap — no concurrent call can observe `rows` between
    // this call's decide and its write (mirrors D1's single UPDATE ... WHERE transaction).
    rescheduleWithCapacity: async (id, input) => {
      const capacity = await resolveCapacityFake(input.localDate, input.fleetDefaultCapacity);
      const current = rows.get(id);
      if (!current || current.status !== input.expectedStatus || current.startsAt !== input.expectedStartsAt) return null;
      const used = maxConcurrentInInterval(input.startsAt, input.occupancyEndsAt, input.now, id);
      if (used + input.occupancyUnits > capacity) return null;
      const updated: Booking = { ...current, startsAt: input.startsAt, endsAt: input.endsAt, rescheduledFrom: input.rescheduledFrom, updatedAt: input.updatedAt };
      rows.set(id, updated);
      occupancyMeta.set(id, { units: input.occupancyUnits, endsAt: input.occupancyEndsAt });
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
  return repository;
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
        paymentStatus: 'paid',
        amountCaptured: 10000,
        currency: 'eur',
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
