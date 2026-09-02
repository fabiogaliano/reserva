import type { ReservaProviders } from '../src/context';
import type { Booking } from '../src/core/booking';
import type { PaymentProvider } from '../src/core/events';
import {
  defaultCapacityForDate,
  getOccupancyIntervals,
  maxConcurrentOccupancy,
  resolveCapacity,
  type OccupancyBooking,
  type OccupancyService,
} from '../src/core/occupancy';
import { sha256Base64Url } from '../src/http';
import {
  DuplicatePaymentRefError,
  HoldLimitExceededError,
  MUTATION_SIDE_EFFECT_LEASE_MS,
  SIDE_EFFECT_MAX_ATTEMPTS,
  sameSideEffectOperation,
  sideEffectOperationKey,
  type AdminChangeAction,
  type AdminChangeAudit,
  type AdminChangeDomain,
  type AdminChangeHistoryEntry,
  type BookingRepository,
  type OperationalIncidentRecord,
  type RefundOperationRecord,
  type SideEffectFamily,
  type SideEffectOperationIdentity,
  type SideEffectOperationRecord,
  type SideEffectOperationSeed,
} from '../src/repo';
import { booking } from './fixtures';

// Mirrors the DB-side token columns. `tokenState` retains presented values for
// hash lookup and, when configured, the fake encryption/decryption path on hydrated reads.
interface FakeTokenState {
  cancelToken: string;
  operatorToken: string;
  cancelTokenHash: string | null;
  operatorTokenHash: string | null;
  tokensExpireAt: string | null;
  cancelTokenRevokedAt: string | null;
}

export interface FakeRepositoryOptions {
  tokenEncryptionKey?: string;
}

// Shared in-memory fake repository + provider harness for handler tests.
// Kept general (seed bookings, override individual repo methods / providers)
// so other test files can build on it without re-implementing this plumbing.
export function fakeRepository(seed: Booking[] = [], options: FakeRepositoryOptions = {}): BookingRepository & {
  rows: Map<string, Booking>;
  settings: Map<string, string>;
  refundOperations: Map<string, RefundOperationRecord>;
  sideEffectOperations: Map<string, SideEffectOperationRecord>;
  tokenState: Map<string, FakeTokenState>;
  adminChangeHistory: AdminChangeHistoryEntry[];
  recordMutationSideEffectOperations(bookingId: string, seeds: SideEffectOperationSeed[], now: string): Promise<void>;
} {
  const placeholderToken = (id: string, role: 'cancel' | 'operator') => `nohash:${id}:${role}`;
  const storeTokens = (item: Booking): Booking => ({
    ...item,
    cancelToken: placeholderToken(item.id, 'cancel'),
    operatorToken: placeholderToken(item.id, 'operator'),
  });
  const rows = new Map(seed.map((item) => [item.id, item]));
  const holdIps = new Map<string, string>();
  const settings = new Map<string, string>();
  const leases = new Map<string, { token: string; until: string }>();
  // Mirrors day_overrides / capacity_defaults (src/repo.ts:1425-1458): date/from_date -> row.
  const dayOverrides = new Map<string, { capacity: number; reason: string | null }>();
  const capacityDefaults = new Map<string, { capacity: number; reason: string | null }>();
  // Mirrors admin_change_history — appended in the same order the real db.batch() would
  // insert its rows, so a test can assert ordering the same way listAdminChangeHistory does.
  const adminChangeHistory: AdminChangeHistoryEntry[] = [];
  let nextAdminChangeHistoryId = 1;
  const pushAdminChangeHistory = (
    domain: AdminChangeDomain,
    itemKey: string,
    action: AdminChangeAction,
    value: string | null,
    audit: AdminChangeAudit,
  ) => {
    adminChangeHistory.push({
      id: nextAdminChangeHistoryId++,
      domain,
      itemKey,
      action,
      value,
      actor: audit.actor,
      changedAt: audit.changedAt,
    });
  };
  // Seeded rows model pre-migration legacy rows: their hash columns are null and their raw
  // token columns retain plaintext. Rows created by insertHold* use nohash placeholders at rest,
  // so only hydrated reads with a configured key can recover their presented values.
  const tokenState = new Map<string, FakeTokenState>(
    seed.map((item) => [item.id, {
      cancelToken: item.cancelToken,
      operatorToken: item.operatorToken,
      cancelTokenHash: null,
      operatorTokenHash: null,
      tokensExpireAt: null,
      cancelTokenRevokedAt: null,
    }]),
  );
  // Keyed by booking_id, mirroring the real table's UNIQUE(booking_id) constraint.
  const refundOperations = new Map<string, RefundOperationRecord>();
  const sideEffectOperations = new Map<string, SideEffectOperationRecord>();
  // Keyed by (source_type, source_key), mirroring the real table's
  // UNIQUE(source_type, source_key) constraint; the alert-claim methods are addressed by id, so
  // those look the row up by scanning values (this fake never holds enough rows for that to matter).
  const operationalIncidents = new Map<string, OperationalIncidentRecord>();
  const incidentKey = (sourceType: string, sourceKey: string) => `${sourceType}:${sourceKey}`;
  const rescheduleTransitionVersions = new Map(seed.map((item) => [item.id, 0]));
  // The same rendering src/reconciliation.ts's sideEffectIncidentSourceKey builds, so a
  // fake incident's source_key still addresses its row (mirrors the real table's identity index).
  const sideEffectKey = (bookingId: string, identity: SideEffectOperationIdentity) =>
    `${bookingId}:${sideEffectOperationKey(identity)}`;
  const identityOf = (identity: SideEffectOperationIdentity) => ({
    family: identity.family,
    name: identity.name ?? null,
    event: identity.event ?? null,
    discriminator: identity.discriminator ?? null,
  });
  const identitySort = (a: SideEffectOperationRecord, b: SideEffectOperationRecord) =>
    a.family.localeCompare(b.family) || (a.name ?? '').localeCompare(b.name ?? '')
    || (a.event ?? '').localeCompare(b.event ?? '') || (a.discriminator ?? '').localeCompare(b.discriminator ?? '');
  const insertOperation = (bookingId: string, identity: SideEffectOperationIdentity, now: string, overrides: Partial<SideEffectOperationRecord> = {}) => {
    const key = sideEffectKey(bookingId, identity);
    if (sideEffectOperations.has(key)) return;
    sideEffectOperations.set(key, {
      bookingId, ...identityOf(identity), eventPayloadJson: null, status: 'pending', providerResultId: null,
      attemptCount: 0, attemptedAt: null, resolvedAt: null, error: null, createdAt: now, updatedAt: now,
      failureStartedAt: null, nextAttemptAt: null, ...overrides,
    });
  };
  // Mirrors src/repo.ts's mutationSideEffectInsert: called only after the caller's own CAS
  // has won, and ON CONFLICT DO NOTHING so a retried dispatch resumes its row instead of
  // duplicating or clobbering it.
  const recordMutationSeeds = (bookingId: string, seeds: SideEffectOperationSeed[] | undefined, now: string, rescheduleVersion?: number) => {
    for (const seed of seeds ?? []) {
      // Mirrors the repository's json_set of '$.id' inside the winning batch — the
      // reschedule version is only knowable here, and the stored envelope must already carry it.
      const discriminator = rescheduleVersion === undefined ? (seed.discriminator ?? null) : String(rescheduleVersion);
      const identity = { ...identityOf(seed), discriminator };
      const payload = seed.eventPayloadJson === null || rescheduleVersion === undefined
        ? seed.eventPayloadJson
        : JSON.stringify({ ...JSON.parse(seed.eventPayloadJson), id: `${seed.eventIdPrefix}:${rescheduleVersion}` });
      insertOperation(bookingId, identity, now, { eventPayloadJson: payload });
    }
  };
  // Mirrors src/repo.ts's occupancy_units/occupancy_ends_at columns: rows seeded via the
  // `booking()` fixture have no entry, matching a pre-migration NULL row, so the same
  // COALESCE(units, 1) / COALESCE(endsAt, row.endsAt) fallback applies.
  const occupancyMeta = new Map<string, { units: number; endsAt: string }>();
  const find = (predicate: (item: Booking) => boolean) => [...rows.values()].find(predicate) ?? null;
  const hydrateBooking = (item: Booking): Booking => {
    const state = tokenState.get(item.id);
    if (!state || options.tokenEncryptionKey === undefined) return item;
    return { ...item, cancelToken: state.cancelToken, operatorToken: state.operatorToken };
  };
  const guardDuplicatePaymentIntent = (bookingId: string, paymentIntent: string | null | undefined): void => {
    if (paymentIntent === null || paymentIntent === undefined) return;
    if (find((item) => item.id !== bookingId && item.paymentRef === paymentIntent)) {
      throw new DuplicatePaymentRefError(paymentIntent);
    }
  };
  // Reuses the REAL getOccupancyIntervals/maxConcurrentOccupancy instead of a hand-rolled
  // overlap calc that could drift from src/repo.ts's own guard. occupancyMeta's per-row units/
  // endsAt are smuggled through a trivial zero-turnaround service so getOccupancyIntervals does
  // the real bookkeeping instead of a second, parallel implementation of it.
  const zeroTurnaroundTour: OccupancyService = { turnaroundMin: 0, occupancyFor: (units) => units };
  const toOccupancyBooking = (item: Booking): OccupancyBooking => {
    const meta = occupancyMeta.get(item.id);
    return {
      id: item.id,
      status: item.status,
      startsAt: item.startsAt,
      endsAt: meta?.endsAt ?? item.endsAt,
      holdExpiresAt: item.holdExpiresAt,
      quantity: meta?.units ?? 1,
    };
  };
  // Max-concurrent occupancy in [targetStart, targetEnd) — the same semantic src/repo.ts's guard
  // now evaluates via NOT EXISTS, not the sum of every overlapping booking.
  const maxConcurrentInInterval = (targetStart: string, targetEnd: string, now: string, excludeId?: string): number => {
    const intervals = getOccupancyIntervals({
      bookings: [...rows.values()].map(toOccupancyBooking),
      service: zeroTurnaroundTour,
      now,
      ...(excludeId !== undefined ? { excludeBookingId: excludeId } : {}),
    });
    return maxConcurrentOccupancy(intervals, targetStart, targetEnd);
  };
  // Mirrors capacityForDate/defaultCapacityForDate: day override wins, else the latest
  // applicable capacity_defaults row, else defaultCapacity. Calls through `repository` (not a
  // captured local) so a test overriding repo.getDayOverride/listCapacityDefaults is honored here.
  const resolveCapacityFake = async (localDate: string, defaultCapacity: number): Promise<number> => {
    const override = await repository.getDayOverride(localDate);
    if (override) return resolveCapacity(override.capacity);
    const defaults = await repository.listCapacityDefaults();
    return defaultCapacityForDate(localDate, defaultCapacity, defaults);
  };
  const repository: BookingRepository & { rows: Map<string, Booking>; settings: Map<string, string>; refundOperations: Map<string, RefundOperationRecord>; sideEffectOperations: Map<string, SideEffectOperationRecord>; tokenState: Map<string, FakeTokenState>; adminChangeHistory: AdminChangeHistoryEntry[]; recordMutationSideEffectOperations(bookingId: string, seeds: SideEffectOperationSeed[], now: string): Promise<void> } = {
    rows,
    tokenState,
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
      return hydrateBooking(expired);
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
    getBookingById: async (id) => {
      const item = rows.get(id);
      return item ? hydrateBooking(item) : null;
    },
    getBookingByReference: async (reference) => find((item) => item.reference === reference),
    getBookingBySessionRef: async (sessionRef) => {
      const item = find((candidate) => candidate.paymentSessionRef === sessionRef);
      return item ? hydrateBooking(item) : null;
    },
    getBookingByPaymentRef: async (paymentRef) => {
      const item = find((candidate) => candidate.paymentRef === paymentRef);
      return item ? hydrateBooking(item) : null;
    },
    // Mirrors src/repo.ts's hash-first lookup with a guarded legacy-plaintext fallback +
    // lazy backfill. An expired or revoked token returns null, indistinguishable from an
    // unknown one.
    getBookingByCancelToken: async (token, now) => {
      const hash = await sha256Base64Url(token);
      for (const item of rows.values()) {
        const state = tokenState.get(item.id);
        if (!state || state.cancelTokenRevokedAt !== null) continue;
        if (state.tokensExpireAt !== null && state.tokensExpireAt <= now) continue;
        if (state.cancelTokenHash === hash) return hydrateBooking(item);
        if (state.cancelTokenHash === null && state.cancelToken === token) {
          // Lazy backfill: first presentation of a legacy plaintext token upgrades the tracked
          // hash, closing the plaintext-fallback branch for next time (src/repo.ts does the same
          // via an UPDATE guarded by `cancel_token_hash IS NULL`).
          state.cancelTokenHash = hash;
          return hydrateBooking(item);
        }
      }
      return null;
    },
    // Operator tokens are never revoked (see migrations/0009_token_hashing.sql), so this checks
    // expiry only.
    getBookingByOperatorToken: async (token, now) => {
      const hash = await sha256Base64Url(token);
      for (const item of rows.values()) {
        const state = tokenState.get(item.id);
        if (!state) continue;
        if (state.tokensExpireAt !== null && state.tokensExpireAt <= now) continue;
        if (state.operatorTokenHash === hash) return hydrateBooking(item);
        if (state.operatorTokenHash === null && state.operatorToken === token) {
          state.operatorTokenHash = hash;
          return hydrateBooking(item);
        }
      }
      return null;
    },
    getBookingByOperatorTokenForRefundRecovery: async (token, now) => {
      const hash = await sha256Base64Url(token);
      for (const item of rows.values()) {
        const state = tokenState.get(item.id);
        if (!state) continue;
        const expired = state.tokensExpireAt !== null && state.tokensExpireAt <= now;
        if (expired && !['requested', 'failed'].includes(refundOperations.get(item.id)?.status ?? '')) continue;
        if (state.operatorTokenHash === hash) return hydrateBooking(item);
        if (state.operatorTokenHash === null && state.operatorToken === token) {
          state.operatorTokenHash = hash;
          return hydrateBooking(item);
        }
      }
      return null;
    },
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
      const created: Booking = { ...booking(), ...input, pickupAddress: null, customerName: null, customerEmail: null, customerPhone: null, status: 'hold', paymentSessionRef: null, paymentRef: null, calendarEventId: null, cancelledAt: null, cancelledBy: null, rescheduledFrom: null };
      const stored = storeTokens(created);
      rows.set(stored.id, stored);
      // A newly created row is hash-backed from the start (never "legacy"), mirroring
      // src/repo.ts's insertHold/insertHoldWithCapacity, which write only a hash.
      tokenState.set(stored.id, {
        cancelToken: input.cancelToken,
        operatorToken: input.operatorToken,
        cancelTokenHash: await sha256Base64Url(input.cancelToken),
        operatorTokenHash: await sha256Base64Url(input.operatorToken),
        tokensExpireAt: input.tokensExpireAt ?? null,
        cancelTokenRevokedAt: null,
      });
      if (input.holdIp) holdIps.set(stored.id, input.holdIp);
      return hydrateBooking(stored);
    },
    // Mirrors src/repo.ts's insertHoldWithCapacity: hold-ip cap still throws
    // HoldLimitExceededError, but a capacity loss returns null. Capacity resolves first (await),
    // then decide+write run as one synchronous block with no await between them, so a concurrent
    // call can't interleave (mirrors D1's single-statement WHERE).
    insertHoldWithCapacity: async (input) => {
      // Computed alongside capacity (both awaits, both independent of rows/holdIps/occupancyMeta)
      // so the decide+write block below stays the single synchronous block the comment above requires.
      const [capacity, cancelTokenHash, operatorTokenHash] = await Promise.all([
        resolveCapacityFake(input.localDate, input.defaultCapacity),
        sha256Base64Url(input.cancelToken),
        sha256Base64Url(input.operatorToken),
      ]);
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
      const created: Booking = { ...booking(), ...input, pickupAddress: null, customerName: null, customerEmail: null, customerPhone: null, status: 'hold', paymentSessionRef: null, paymentRef: null, calendarEventId: null, cancelledAt: null, cancelledBy: null, rescheduledFrom: null };
      const stored = storeTokens(created);
      rows.set(stored.id, stored);
      occupancyMeta.set(stored.id, { units: input.occupancyUnits, endsAt: input.occupancyEndsAt });
      // See the identical comment in insertHold above.
      tokenState.set(stored.id, {
        cancelToken: input.cancelToken,
        operatorToken: input.operatorToken,
        cancelTokenHash,
        operatorTokenHash,
        tokensExpireAt: input.tokensExpireAt ?? null,
        cancelTokenRevokedAt: null,
      });
      if (input.holdIp) holdIps.set(stored.id, input.holdIp);
      return hydrateBooking(stored);
    },
    updateBooking: async (id, patch) => {
      const current = rows.get(id);
      if (!current) throw new Error('missing booking');
      guardDuplicatePaymentIntent(id, patch.paymentRef);
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const updated = { ...current, ...defined } as Booking;
      rows.set(id, updated);
      return hydrateBooking(updated);
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
      // Mirrors src/repo.ts's COALESCE(cancel_token_revoked_at, ?) — a cancelled
      // booking's customer link is revoked; the operator token is left alone (see
      // migrations/0009_token_hashing.sql).
      const state = tokenState.get(id);
      if (state && state.cancelTokenRevokedAt === null) state.cancelTokenRevokedAt = input.cancelledAt;
      // Only reached once the CAS above has already confirmed this
      // transition applies — see recordMutationKinds's doc comment.
      recordMutationSeeds(id, input.mutationSideEffects, input.updatedAt);
      return hydrateBooking(updated);
    },
    upsertRefundOperationAndTransitionToCancelled: async (refund, id, input) => {
      await repository.reconcileStripeRefundOperation(refund);
      return repository.transitionToCancelled(id, input);
    },
    transitionToNoShow: async (id, input) => {
      const current = rows.get(id);
      if (!current || !input.expectedStatusIn.includes(current.status)) return null;
      const updated: Booking = { ...current, status: 'no_show', updatedAt: input.updatedAt };
      rows.set(id, updated);
      recordMutationSeeds(id, input.mutationSideEffects, input.updatedAt);
      const state = tokenState.get(id);
      if (state && state.cancelTokenRevokedAt === null) state.cancelTokenRevokedAt = input.updatedAt;
      return hydrateBooking(updated);
    },
    transitionToConfirmed: async (id, input) => {
      const current = rows.get(id);
      if (!current || !input.expectedStatusIn.includes(current.status)) return null;
      guardDuplicatePaymentIntent(id, input.paymentRef);
      const { expectedStatusIn, updatedAt, ...patch } = input;
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const updated: Booking = { ...current, ...defined, status: 'confirmed', holdExpiresAt: null, updatedAt };
      rows.set(id, updated);
      return hydrateBooking(updated);
    },
    confirmWithSideEffectOperations: async (id, input) => {
      const current = rows.get(id);
      if (!current || !input.expectedStatusIn.includes(current.status) || leases.get(id)?.token !== input.leaseToken) return null;
      guardDuplicatePaymentIntent(id, input.paymentRef);
      const { expectedStatusIn, leaseToken, oversold, updatedAt, eventSeeds, emailRecipients, ...patch } = input;
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const updated: Booking = { ...current, ...defined, status: 'confirmed', holdExpiresAt: null, updatedAt };
      rows.set(id, updated);
      insertOperation(id, { family: 'calendar_create' }, updatedAt);
      // Split rows (one per recipient) for a split-capable provider, otherwise the single
      // legacy combined row. Brand-new confirmation, so no row of either shape can already exist.
      const emailIdentities: SideEffectOperationIdentity[] = emailRecipients && emailRecipients.length > 0
        ? emailRecipients.map((recipient) => ({ family: 'email', name: recipient, event: 'booking.confirmed' }))
        : [{ family: 'email_confirmation' }];
      for (const identity of emailIdentities) insertOperation(id, identity, updatedAt);
      if (oversold) {
        insertOperation(id, { family: 'oversell' }, updatedAt, {
          status: 'succeeded', providerResultId: 'capacity_exceeded', resolvedAt: updatedAt,
        });
      }
      // Mirrors src/repo.ts — each subscriber's row is created in the
      // same "transaction" (here: the same synchronous call) as the status transition.
      for (const seed of eventSeeds ?? []) insertOperation(id, seed, updatedAt, { eventPayloadJson: seed.eventPayloadJson });
      return hydrateBooking(updated);
    },
    applyConfirmedPaymentDetails: async (id, patch, leaseToken, updatedAt) => {
      const current = rows.get(id);
      if (!current || current.status !== 'confirmed' || leases.get(id)?.token !== leaseToken) return false;
      if (Object.values(patch).every((value) => value === undefined)) return false;
      guardDuplicatePaymentIntent(id, patch.paymentRef);
      const updated: Booking = {
        ...current,
        ...(current.paymentRef === null && patch.paymentRef !== undefined ? { paymentRef: patch.paymentRef } : {}),
        ...(current.customerName === null && patch.customerName !== undefined ? { customerName: patch.customerName } : {}),
        ...(current.customerEmail === null && patch.customerEmail !== undefined ? { customerEmail: patch.customerEmail } : {}),
        ...(current.customerPhone === null && patch.customerPhone !== undefined ? { customerPhone: patch.customerPhone } : {}),
        ...(current.pickupAddress === null && patch.pickupAddress !== undefined ? { pickupAddress: patch.pickupAddress } : {}),
        updatedAt,
      };
      rows.set(id, updated);
      return true;
    },
    ensureConfirmationSideEffectOperations: async (id, leaseToken, now, eventSeeds, emailRecipients) => {
      if (rows.get(id)?.status !== 'confirmed' || leases.get(id)?.token !== leaseToken) return;
      const booking = rows.get(id);
      if (!booking) return;
      // The retired calendar_synced flag's information now lives in calendar_event_id
      // (an id is only ever written once the provider accepted the event) — mirrors src/repo.ts.
      const calendarSucceeded = booking.calendarEventId !== null;
      insertOperation(id, { family: 'calendar_create' }, now, {
        status: calendarSucceeded ? 'succeeded' : 'pending',
        providerResultId: booking.calendarEventId,
        resolvedAt: calendarSucceeded ? now : null,
      });
      // Same split-vs-combined choice as confirmWithSideEffectOperations, applied here for
      // legacy repair: a split row is only inserted when no legacy combined email_confirmation
      // row already exists — mirrors src/repo.ts's NOT EXISTS guard.
      const emailIdentities: SideEffectOperationIdentity[] = emailRecipients && emailRecipients.length > 0
        ? emailRecipients.map((recipient) => ({ family: 'email', name: recipient, event: 'booking.confirmed' }))
        : [{ family: 'email_confirmation' }];
      const combinedRowExists = sideEffectOperations.has(sideEffectKey(id, { family: 'email_confirmation' }));
      const skipSplit = emailRecipients && emailRecipients.length > 0 && combinedRowExists;
      if (!skipSplit) {
        for (const identity of emailIdentities) {
          // Migration 0018 materialized every already-sent confirmation email as a
          // succeeded row before dropping email_synced, so a booking with no row here has
          // genuinely never been emailed — mirrors src/repo.ts.
          insertOperation(id, identity, now, {});
        }
      }
      // The legacy-repair path for a subscriber registered after
      // this booking was confirmed — always 'pending', because the row's own status is the only
      // record of whether that subscriber has been told.
      for (const seed of eventSeeds ?? []) insertOperation(id, seed, now, { eventPayloadJson: seed.eventPayloadJson });
    },
    recordBookingEventOperations: async (bookingId, seeds, now) => {
      for (const seed of seeds) insertOperation(bookingId, seed, now, { eventPayloadJson: seed.eventPayloadJson });
    },
    listSideEffectOperations: async (bookingId) => [...sideEffectOperations.values()]
      .filter((operation) => operation.bookingId === bookingId)
      .sort(identitySort),
    recordMutationSideEffectOperations: async (bookingId, seeds, now) => {
      recordMutationSeeds(bookingId, seeds, now);
    },
    // 'abandoned' is terminal (never reclaimed), and attempt_count is capped the same way
    // src/repo.ts's claim SQL binds SIDE_EFFECT_MAX_ATTEMPTS. Also requires next_attempt_at
    // to be null or <= now.
    claimSideEffectOperation: async (bookingId, identity, leaseToken, attemptedAt) => {
      const key = sideEffectKey(bookingId, identity);
      const current = sideEffectOperations.get(key);
      if (!current || current.status === 'succeeded' || current.status === 'abandoned'
        || current.attemptCount >= SIDE_EFFECT_MAX_ATTEMPTS || leases.get(bookingId)?.token !== leaseToken
        || (current.nextAttemptAt !== null && current.nextAttemptAt > attemptedAt)) return null;
      const attemptNumber = current.attemptCount + 1;
      sideEffectOperations.set(key, {
        ...current, status: 'in_flight', attemptCount: attemptNumber,
        attemptedAt, error: null, updatedAt: attemptedAt,
      });
      return attemptNumber;
    },
    // The admin retry bypass — ignores next_attempt_at and the
    // attempt-count cap, but still requires lease ownership and a non-succeeded row.
    claimSideEffectOperationForRetry: async (bookingId, identity, leaseToken, attemptedAt) => {
      const key = sideEffectKey(bookingId, identity);
      const current = sideEffectOperations.get(key);
      if (!current || current.status === 'succeeded' || leases.get(bookingId)?.token !== leaseToken) return null;
      const attemptNumber = current.attemptCount + 1;
      sideEffectOperations.set(key, {
        ...current, status: 'in_flight', attemptCount: attemptNumber,
        attemptedAt, error: null, updatedAt: attemptedAt,
      });
      return attemptNumber;
    },
    // Mirrors src/repo.ts's aggregate resolve: calendar_synced flips off this resolve's own
    // outcome, but email_synced is recomputed from the current applicable row set (legacy
    // combined or every split row), true only once all are 'succeeded'.
    resolveSideEffectOperation: async (input) => {
      const key = sideEffectKey(input.bookingId, input.identity);
      const operation = sideEffectOperations.get(key);
      const current = rows.get(input.bookingId);
      if (!operation || !current || operation.status === 'succeeded' || operation.status === 'abandoned'
        || leases.get(input.bookingId)?.token !== input.leaseToken) return false;
      sideEffectOperations.set(key, {
        ...operation, status: input.status, providerResultId: input.providerResultId ?? null,
        error: input.error ?? null, resolvedAt: input.resolvedAt, updatedAt: input.resolvedAt,
        failureStartedAt: input.status === 'failed' ? (operation.failureStartedAt ?? input.resolvedAt) : null,
        nextAttemptAt: input.status === 'failed' ? (input.nextAttemptAt ?? null) : null,
      });
      if (input.identity.family === 'calendar_create') {
        rows.set(input.bookingId, {
          ...current, calendarEventId: input.providerResultId ?? null, updatedAt: input.resolvedAt,
        });
        return true;
      }
      rows.set(input.bookingId, { ...current, updatedAt: input.resolvedAt });
      return true;
    },
    // 'abandoned' already falls outside pending/failed/reclaimable-in_flight; the
    // attempt_count cap is a belt-and-braces guard mirroring src/repo.ts's claim SQL.
    // Also requires next_attempt_at to be null or <= now.
    claimMutationSideEffectOperation: async (bookingId, identity, attemptedAt) => {
      const key = sideEffectKey(bookingId, identity);
      const current = sideEffectOperations.get(key);
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const reclaimable = current?.status === 'in_flight'
        && current.attemptedAt !== null
        && current.attemptedAt < staleBefore;
      if (!current || current.attemptCount >= SIDE_EFFECT_MAX_ATTEMPTS
        || (current.nextAttemptAt !== null && current.nextAttemptAt > attemptedAt)
        || (current.status !== 'pending' && current.status !== 'failed' && !reclaimable)) return null;
      const attemptNumber = current.attemptCount + 1;
      sideEffectOperations.set(key, {
        ...current, status: 'in_flight', attemptCount: attemptNumber,
        attemptedAt, error: null, updatedAt: attemptedAt,
      });
      return attemptNumber;
    },
    // The admin retry bypass — ignores next_attempt_at and the
    // attempt-count cap, but still refuses a live (non-stale) in_flight lease.
    claimMutationSideEffectOperationForRetry: async (bookingId, identity, attemptedAt) => {
      const key = sideEffectKey(bookingId, identity);
      const current = sideEffectOperations.get(key);
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const reclaimable = current?.status === 'in_flight'
        && current.attemptedAt !== null
        && current.attemptedAt < staleBefore;
      if (!current || (current.status !== 'pending' && current.status !== 'failed' && current.status !== 'abandoned' && !reclaimable)) return null;
      const attemptNumber = current.attemptCount + 1;
      sideEffectOperations.set(key, {
        ...current, status: 'in_flight', attemptCount: attemptNumber,
        attemptedAt, error: null, updatedAt: attemptedAt,
      });
      return attemptNumber;
    },
    resolveMutationSideEffectOperation: async (input) => {
      const key = sideEffectKey(input.bookingId, input.identity);
      const current = sideEffectOperations.get(key);
      if (!current || current.status !== 'in_flight' || current.attemptedAt !== input.claimedAt) return false;
      sideEffectOperations.set(key, {
        ...current, status: input.status, providerResultId: input.providerResultId ?? null,
        error: input.error ?? null, resolvedAt: input.resolvedAt, updatedAt: input.resolvedAt,
        failureStartedAt: input.status === 'failed' ? (current.failureStartedAt ?? input.resolvedAt) : null,
        nextAttemptAt: input.status === 'failed' ? (input.nextAttemptAt ?? null) : null,
      });
      return true;
    },
    sideEffectOperations,
    transitionReschedule: async (id, input) => {
      const current = rows.get(id);
      if (!current || current.status !== input.expectedStatus || current.startsAt !== input.expectedStartsAt) return null;
      const updated: Booking = { ...current, startsAt: input.startsAt, endsAt: input.endsAt, rescheduledFrom: input.rescheduledFrom, updatedAt: input.updatedAt };
      rows.set(id, updated);
      const version = (rescheduleTransitionVersions.get(id) ?? 0) + 1;
      rescheduleTransitionVersions.set(id, version);
      recordMutationSeeds(id, input.mutationSideEffects, input.updatedAt, version);
      // Mirrors src/repo.ts's COALESCE(?, tokens_expire_at) — the real
      // repo binds `input.tokensExpireAt ?? null`, so both an omitted field and an explicit null
      // fall through to COALESCE's "keep the existing value" branch; only a real string moves it.
      const state = tokenState.get(id);
      if (state && input.tokensExpireAt != null) state.tokensExpireAt = input.tokensExpireAt;
      return hydrateBooking(updated);
    },
    // Mirrors src/repo.ts's rescheduleWithCapacity: transitionReschedule's CAS plus the same
    // max-concurrency guard as insertHoldWithCapacity, excluding this booking's own id so a move
    // within a window it already occupies isn't counted against itself. Capacity resolves first,
    // then CAS + decision + write run as one synchronous block, closing the race where two
    // concurrent reschedules of the same booking could both pass a stale CAS check.
    rescheduleWithCapacity: async (id, input) => {
      const capacity = await resolveCapacityFake(input.localDate, input.defaultCapacity);
      const current = rows.get(id);
      if (!current || current.status !== input.expectedStatus || current.startsAt !== input.expectedStartsAt) return null;
      const used = maxConcurrentInInterval(input.startsAt, input.occupancyEndsAt, input.now, id);
      if (used + input.occupancyUnits > capacity) return null;
      const updated: Booking = { ...current, startsAt: input.startsAt, endsAt: input.endsAt, rescheduledFrom: input.rescheduledFrom, updatedAt: input.updatedAt };
      rows.set(id, updated);
      occupancyMeta.set(id, { units: input.occupancyUnits, endsAt: input.occupancyEndsAt });
      // See the identical comment in transitionReschedule above.
      const state = tokenState.get(id);
      if (state && input.tokensExpireAt != null) state.tokensExpireAt = input.tokensExpireAt;
      const version = (rescheduleTransitionVersions.get(id) ?? 0) + 1;
      rescheduleTransitionVersions.set(id, version);
      recordMutationSeeds(id, input.mutationSideEffects, input.updatedAt, version);
      return hydrateBooking(updated);
    },
    listOccupancyBookings: async (from, to) => [...rows.values()]
      .filter((item) => (item.status === 'hold' || item.status === 'confirmed') && item.startsAt >= from && item.startsAt < to)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    // Mirrors src/repo.ts:260-267 — starts_at >= now AND (confirmed OR (hold AND hold_expires_at > now)), ordered by starts_at.
    listUpcoming: async (now) => [...rows.values()]
      .filter((item) => item.startsAt >= now && (item.status === 'confirmed' || (item.status === 'hold' && item.holdExpiresAt !== null && item.holdExpiresAt > now)))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map(hydrateBooking),
    // Mirrors src/repo.ts listAllFrom — starts_at >= bound, any status, ordered by starts_at.
    listAllFrom: async (startsAtFrom) => [...rows.values()]
      .filter((item) => item.startsAt >= startsAtFrom)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map(hydrateBooking),
    // Mirrors src/repo.ts:1425-1428 — exact-date lookup.
    getDayOverride: async (date) => {
      const found = dayOverrides.get(date);
      return found ? { date, ...found } : null;
    },
    // Mirrors src/repo.ts:1429-1434 — date >= from AND date <= to, ordered by date.
    listDayOverrides: async (from, to) => [...dayOverrides.entries()]
      .filter(([date]) => date >= from && date <= to)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, ...value })),
    // Mirrors src/repo.ts:1435-1439 — INSERT ... ON CONFLICT(date) DO UPDATE (upsert-by-date).
    upsertDayOverride: async (date, capacity, reason) => { dayOverrides.set(date, { capacity, reason }); },
    // Mirrors src/repo.ts:1441-1443.
    deleteDayOverride: async (date) => { dayOverrides.delete(date); },
    // Bounded by handleAdminPost's 366-day cap (a year of daily overrides), so a plain db.batch()
    // (mirrored here as a plain loop) never risks D1's per-batch statement limit. One
    // history entry per date, pushed in the same order the real batch's statements would run.
    upsertDayOverrides: async (dates, capacity, reason, audit) => {
      const value = JSON.stringify({ capacity, reason });
      for (const date of dates) {
        dayOverrides.set(date, { capacity, reason });
        pushAdminChangeHistory('day_override', date, 'upsert', value, audit);
      }
    },
    deleteDayOverrides: async (dates, audit) => {
      for (const date of dates) {
        dayOverrides.delete(date);
        pushAdminChangeHistory('day_override', date, 'delete', null, audit);
      }
    },
    // Mirrors src/repo.ts:1444-1448 — ordered by from_date.
    listCapacityDefaults: async () => [...capacityDefaults.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fromDate, value]) => ({ fromDate, ...value })),
    // Mirrors src/repo.ts:1450-1454 — INSERT ... ON CONFLICT(from_date) DO UPDATE (upsert-by-from_date).
    upsertCapacityDefault: async (fromDate, capacity, reason, audit) => {
      capacityDefaults.set(fromDate, { capacity, reason });
      pushAdminChangeHistory('capacity_default', fromDate, 'upsert', JSON.stringify({ capacity, reason }), audit);
    },
    // Mirrors src/repo.ts:1456-1458.
    deleteCapacityDefault: async (fromDate, audit) => {
      capacityDefaults.delete(fromDate);
      pushAdminChangeHistory('capacity_default', fromDate, 'delete', null, audit);
    },
    settings,
    listSettings: async () => Object.fromEntries(settings),
    upsertSetting: async (key, value) => { settings.set(key, value); },
    deleteSetting: async (key, audit) => {
      settings.delete(key);
      pushAdminChangeHistory('setting', key, 'delete', null, audit);
    },
    // Real D1 runs these in one implicit transaction (see src/repo.ts); tests that need to prove
    // atomicity override this whole method to reject before touching `settings` at all.
    applySettingsBatch: async (operations, audit) => {
      for (const operation of operations) {
        if (operation.type === 'upsert') {
          settings.set(operation.key, operation.value);
          pushAdminChangeHistory('setting', operation.key, 'upsert', operation.value, audit);
        } else {
          settings.delete(operation.key);
          pushAdminChangeHistory('setting', operation.key, 'delete', null, audit);
        }
      }
    },
    adminChangeHistory,
    // Mirrors src/repo.ts's `ORDER BY id DESC LIMIT ?` — most-recent-first.
    listAdminChangeHistory: async (limit) => [...adminChangeHistory].reverse().slice(0, limit),
    refundOperations,
    // Mirrors src/repo.ts's WHERE NOT EXISTS conditional insert: claims only when no operation
    // row exists yet for this booking_id, so a racing loser can be told who won.
    claimRefundOperation: async (input) => {
      if (refundOperations.has(input.bookingId)) return false;
      refundOperations.set(input.bookingId, {
        id: input.id, bookingId: input.bookingId, paymentIntent: input.paymentIntent,
        choice: input.choice, status: 'requested', stripeRefundId: null, amountCents: null,
        requestedAt: input.requestedAt, resolvedAt: null, error: null,
        executionClaimToken: null, executionClaimUntil: null, attemptCount: 0, attemptedAt: null,
        failureStartedAt: null, nextAttemptAt: null,
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
        executionClaimToken: null, executionClaimUntil: null,
        failureStartedAt: input.status === 'failed' ? (current.failureStartedAt ?? input.resolvedAt) : null,
        nextAttemptAt: input.status === 'failed' ? (input.nextAttemptAt ?? null) : null,
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
        id: current?.id ?? input.id, bookingId: input.bookingId, paymentIntent: input.paymentIntent,
        choice: input.choice, status: input.status, stripeRefundId: input.stripeRefundId,
        amountCents: input.amountCents, requestedAt: current?.requestedAt ?? input.requestedAt,
        resolvedAt: input.resolvedAt, error: input.error ?? null,
        executionClaimToken: current?.executionClaimToken ?? null, executionClaimUntil: current?.executionClaimUntil ?? null,
        attemptCount: current?.attemptCount ?? 0, attemptedAt: current?.attemptedAt ?? null,
        failureStartedAt: current?.failureStartedAt ?? null, nextAttemptAt: current?.nextAttemptAt ?? null,
      });
    },
    reconcileStripeRefundOperation: async (input) => {
      const current = refundOperations.get(input.bookingId);
      if (current?.status === 'succeeded' && current.choice === 'full') {
        refundOperations.set(input.bookingId, { ...current, resolvedAt: input.resolvedAt });
        return;
      }
      refundOperations.set(input.bookingId, {
        id: current?.id ?? input.id, bookingId: input.bookingId, paymentIntent: input.paymentIntent,
        choice: input.choice, status: input.status, stripeRefundId: input.stripeRefundId,
        amountCents: input.amountCents, requestedAt: current?.requestedAt ?? input.requestedAt,
        resolvedAt: input.resolvedAt, error: input.error ?? null,
        executionClaimToken: current?.executionClaimToken ?? null, executionClaimUntil: current?.executionClaimUntil ?? null,
        attemptCount: current?.attemptCount ?? 0, attemptedAt: current?.attemptedAt ?? null,
        failureStartedAt: current?.failureStartedAt ?? null, nextAttemptAt: current?.nextAttemptAt ?? null,
      });
    },

    // ---- Autonomous reconciliation -----------------------------------------------------------

    // Mirrors src/repo.ts's single-row lease: claimable from 'requested'/'failed' (never
    // 'succeeded'/'abandoned'), or a stale 'in_flight' row, gated by next_attempt_at and the same
    // attempt-count cap side-effect operations use.
    claimRefundExecution: async (id, attemptedAt) => {
      const current = [...refundOperations.values()].find((operation) => operation.id === id);
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const reclaimable = current?.status === 'in_flight'
        && current.attemptedAt !== null
        && current.attemptedAt < staleBefore;
      if (!current || current.attemptCount >= SIDE_EFFECT_MAX_ATTEMPTS
        || (current.nextAttemptAt !== null && current.nextAttemptAt > attemptedAt)
        || (current.status !== 'requested' && current.status !== 'failed' && !reclaimable)) return null;
      const attemptNumber = current.attemptCount + 1;
      refundOperations.set(current.bookingId, {
        ...current, status: 'in_flight', attemptCount: attemptNumber, attemptedAt, error: null,
      });
      return attemptNumber;
    },
    // The admin "Try again" bypass: ignores next_attempt_at and the attempt-count cap (so an
    // 'abandoned' refund can be retried once), but still refuses a live (non-stale) in_flight claim.
    claimRefundExecutionForRetry: async (id, attemptedAt) => {
      const current = [...refundOperations.values()].find((operation) => operation.id === id);
      const staleBefore = new Date(Date.parse(attemptedAt) - MUTATION_SIDE_EFFECT_LEASE_MS).toISOString();
      const reclaimable = current?.status === 'in_flight'
        && current.attemptedAt !== null
        && current.attemptedAt < staleBefore;
      if (!current || (current.status !== 'requested' && current.status !== 'failed' && current.status !== 'abandoned' && !reclaimable)) return null;
      const attemptNumber = current.attemptCount + 1;
      refundOperations.set(current.bookingId, {
        ...current, status: 'in_flight', attemptCount: attemptNumber, attemptedAt, error: null,
      });
      return attemptNumber;
    },

    listSideEffectExecutionCandidates: async (now, staleBefore, limit) => {
      const backoffMinutes = (attemptCount: number) => [5, 10, 20, 40, 60][Math.min(Math.max(attemptCount, 1) - 1, 4)] ?? 60;
      return [...sideEffectOperations.values()]
        .filter((row) => {
          if (row.family === 'oversell' || row.attemptCount >= SIDE_EFFECT_MAX_ATTEMPTS) return false;
          if (row.nextAttemptAt !== null && row.nextAttemptAt > now) return false;
          if (row.status === 'pending') return true;
          if (row.status === 'in_flight') return row.attemptedAt !== null && row.attemptedAt < staleBefore;
          if (row.status !== 'failed') return false;
          if (row.attemptedAt === null) return true;
          return new Date(Date.parse(row.attemptedAt) + backoffMinutes(row.attemptCount) * 60_000).toISOString() <= now;
        })
        .sort((a, b) => {
          const byTime = (a.nextAttemptAt ?? a.attemptedAt ?? a.createdAt).localeCompare(b.nextAttemptAt ?? b.attemptedAt ?? b.createdAt);
          return byTime || a.bookingId.localeCompare(b.bookingId) || identitySort(a, b);
        })
        .slice(0, limit);
    },
    listRefundExecutionCandidateBookingIds: async (now, staleBefore, limit) => [...refundOperations.values()]
      .filter((row) => row.attemptCount < SIDE_EFFECT_MAX_ATTEMPTS
        && (row.nextAttemptAt === null || row.nextAttemptAt <= now)
        && (row.status === 'requested' || row.status === 'failed'
          || (row.status === 'in_flight' && row.attemptedAt !== null && row.attemptedAt < staleBefore)))
      .sort((a, b) => (a.nextAttemptAt ?? a.attemptedAt ?? a.requestedAt).localeCompare(b.nextAttemptAt ?? b.attemptedAt ?? b.requestedAt)
        || a.bookingId.localeCompare(b.bookingId))
      .slice(0, limit)
      .map((row) => row.bookingId),
    listSideEffectIncidentCandidateBookingIds: async (failureDueBefore, limit) => {
      const candidates = [...sideEffectOperations.values()]
        .filter((row) => (row.status === 'abandoned' || (row.status === 'failed' && row.failureStartedAt !== null && row.failureStartedAt <= failureDueBefore))
          && !operationalIncidents.has(incidentKey('side_effect', sideEffectKey(row.bookingId, row))));
      const byBooking = new Map<string, string>();
      for (const row of candidates) {
        const existing = byBooking.get(row.bookingId);
        if (!existing || row.updatedAt < existing) byBooking.set(row.bookingId, row.updatedAt);
      }
      return [...byBooking.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])).slice(0, limit).map(([bookingId]) => bookingId);
    },
    listRefundIncidentCandidateBookingIds: async (limit) => [...refundOperations.values()]
      .filter((row) => {
        const item = rows.get(row.bookingId);
        return row.status !== 'succeeded'
          && (row.status === 'failed' || row.status === 'abandoned' || item?.status !== 'cancelled')
          && !operationalIncidents.has(incidentKey('refund', row.bookingId));
      })
      .sort((a, b) => (a.resolvedAt ?? a.requestedAt).localeCompare(b.resolvedAt ?? b.requestedAt) || a.bookingId.localeCompare(b.bookingId))
      .slice(0, limit)
      .map((row) => row.bookingId),
    listIncidentReprojectionCandidates: async (limit) => [...operationalIncidents.values()]
      .filter((incident) => {
        if (incident.status !== 'open' && !(incident.status === 'resolved' && incident.resolutionKind === 'manual')) return false;
        if (incident.sourceType === 'side_effect') {
          const operation = sideEffectOperations.get(incident.sourceKey);
          return operation !== undefined && operation.updatedAt !== incident.sourceUpdatedAt;
        }
        if (incident.sourceType === 'refund') {
          const operation = refundOperations.get(incident.sourceKey);
          return operation === undefined || (operation.resolvedAt ?? operation.requestedAt) !== incident.sourceUpdatedAt;
        }
        return false;
      })
      .sort((a, b) => a.lastDetectedAt.localeCompare(b.lastDetectedAt) || a.id.localeCompare(b.id))
      .slice(0, limit),
    // 'oversell' rows are permanent markers, so the candidate set
    // is simply "no incident row has ever been opened for this marker yet".
    listUnreportedOversellMarkers: async (limit) => {
      const markers = [...sideEffectOperations.values()]
        .filter((row) => row.family === 'oversell' && row.status === 'succeeded'
          && !operationalIncidents.has(incidentKey('oversell', row.bookingId)));
      return markers.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, limit);
    },

    upsertOpenIncident: async (input) => {
      const key = incidentKey(input.sourceType, input.sourceKey);
      const current = operationalIncidents.get(key);
      const shouldBumpAlertRevision = !current || current.status === 'resolved' || input.escalate;
      operationalIncidents.set(key, {
        id: current?.id ?? input.id,
        bookingId: input.bookingId,
        sourceType: input.sourceType,
        sourceKey: input.sourceKey,
        action: input.action,
        status: 'open',
        severity: input.severity,
        attemptCount: input.attemptCount,
        firstDetectedAt: current?.firstDetectedAt ?? input.now,
        lastDetectedAt: input.now,
        sourceUpdatedAt: input.sourceUpdatedAt,
        alertRevision: shouldBumpAlertRevision ? (current?.alertRevision ?? 0) + 1 : (current?.alertRevision ?? 1),
        alertedRevision: current?.alertedRevision ?? 0,
        alertAttemptCount: current?.alertAttemptCount ?? 0,
        alertClaimToken: current?.alertClaimToken ?? null,
        alertClaimUntil: current?.alertClaimUntil ?? null,
        alertNextAttemptAt: current?.alertNextAttemptAt ?? null,
        alertError: current?.alertError ?? null,
        resolvedAt: null,
        resolutionKind: null,
        resolvedBy: null,
        resolutionNote: null,
      });
    },
    getIncidentBySource: async (sourceType, sourceKey) => operationalIncidents.get(incidentKey(sourceType, sourceKey)) ?? null,
    resolveIncidentAutomatic: async (sourceType, sourceKey, resolvedAt) => {
      const key = incidentKey(sourceType, sourceKey);
      const current = operationalIncidents.get(key);
      if (!current || current.status !== 'open') return;
      operationalIncidents.set(key, {
        ...current, status: 'resolved', resolvedAt, resolutionKind: 'automatic', resolvedBy: null, resolutionNote: null,
      });
    },
    resolveIncidentManual: async (input) => {
      const key = incidentKey(input.sourceType, input.sourceKey);
      const current = operationalIncidents.get(key);
      if (!current || current.status !== 'open') return false;
      operationalIncidents.set(key, {
        ...current, status: 'resolved', resolvedAt: input.resolvedAt, resolutionKind: 'manual',
        resolvedBy: input.resolvedBy, resolutionNote: input.resolutionNote,
      });
      return true;
    },
    // Open cards sort action-required before delayed, then oldest first.
    listOpenIncidents: async (limit) => [...operationalIncidents.values()]
      .filter((incident) => incident.status === 'open')
      .sort((a, b) => {
        const rank = (incident: OperationalIncidentRecord) => (incident.severity === 'action_required' ? 0 : 1);
        const rankDiff = rank(a) - rank(b);
        return rankDiff !== 0 ? rankDiff : a.firstDetectedAt.localeCompare(b.firstDetectedAt);
      })
      .slice(0, limit),
    listRecentResolvedIncidents: async (since, limit) => [...operationalIncidents.values()]
      .filter((incident) => incident.status === 'resolved' && incident.resolvedAt !== null && incident.resolvedAt >= since)
      .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
      .slice(0, limit),
    countIncidentsSince: async (since) => {
      const all = [...operationalIncidents.values()];
      return {
        opened: all.filter((incident) => incident.firstDetectedAt >= since).length,
        resolved: all.filter((incident) => incident.status === 'resolved' && incident.resolvedAt !== null && incident.resolvedAt >= since).length,
      };
    },
    countOpenIncidents: async () => [...operationalIncidents.values()].filter((incident) => incident.status === 'open').length,
    // The same grouping the D1 implementation does in SQL — every
    // unsettled row counts as debt, abandoned rows counted separately, oldest pending first seen.
    countSideEffectDebtByFamily: async () => {
      const byFamily = new Map<SideEffectFamily, { family: SideEffectFamily; pending: number; abandoned: number; oldestPendingAt: string | null }>();
      for (const operation of sideEffectOperations.values()) {
        if (operation.status === 'succeeded') continue;
        const entry = byFamily.get(operation.family) ?? { family: operation.family, pending: 0, abandoned: 0, oldestPendingAt: null };
        if (operation.status === 'abandoned') {
          entry.abandoned += 1;
        } else {
          entry.pending += 1;
          if (entry.oldestPendingAt === null || operation.createdAt < entry.oldestPendingAt) entry.oldestPendingAt = operation.createdAt;
        }
        byFamily.set(operation.family, entry);
      }
      return [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family));
    },

    // Alert delivery's own claim/attempt/backoff, independent of the
    // incident's own detection state — mirrors claimRefundExecution's single-row-lease shape.
    listAlertCandidateIds: async (now, limit) => [...operationalIncidents.values()]
      .filter((incident) => incident.status === 'open' && incident.alertedRevision < incident.alertRevision
        && (incident.alertNextAttemptAt === null || incident.alertNextAttemptAt <= now)
        && (incident.alertClaimUntil === null || incident.alertClaimUntil < now))
      .sort((a, b) => (a.alertNextAttemptAt ?? a.firstDetectedAt).localeCompare(b.alertNextAttemptAt ?? b.firstDetectedAt))
      .slice(0, limit)
      .map((incident) => incident.id),
    claimIncidentAlert: async (id, token, now, leaseUntil) => {
      const current = [...operationalIncidents.values()].find((incident) => incident.id === id);
      if (!current || current.status !== 'open' || current.alertedRevision >= current.alertRevision) return null;
      if (current.alertNextAttemptAt !== null && current.alertNextAttemptAt > now) return null;
      if (current.alertClaimUntil !== null && current.alertClaimUntil >= now) return null;
      const claimed: OperationalIncidentRecord = {
        ...current, alertClaimToken: token, alertClaimUntil: leaseUntil, alertAttemptCount: current.alertAttemptCount + 1,
      };
      operationalIncidents.set(incidentKey(current.sourceType, current.sourceKey), claimed);
      return claimed;
    },
    resolveIncidentAlertSuccess: async (id, token, alertedRevision) => {
      const current = [...operationalIncidents.values()].find((incident) => incident.id === id);
      if (!current || current.alertClaimToken !== token) return;
      operationalIncidents.set(incidentKey(current.sourceType, current.sourceKey), {
        ...current, alertedRevision, alertClaimToken: null, alertClaimUntil: null, alertNextAttemptAt: null, alertError: null,
      });
    },
    resolveIncidentAlertFailure: async (id, token, error, nextAttemptAt) => {
      const current = [...operationalIncidents.values()].find((incident) => incident.id === id);
      if (!current || current.alertClaimToken !== token) return;
      operationalIncidents.set(incidentKey(current.sourceType, current.sourceKey), {
        ...current, alertClaimToken: null, alertClaimUntil: null, alertNextAttemptAt: nextAttemptAt, alertError: error.slice(0, 200),
      });
    },
  };
  return repository;
}

// Tracks the idempotency key and expected amount each refund() call carries (mirroring the
// Stripe adapter's deterministic `reserva-refund-<paymentRef>` derivation) so tests can assert
// a retry reuses the same key. `resultFor` lets a test control the result or throw to simulate
// a provider-side failure.
export function fakeRefundTracker(
  resultFor: (paymentRef: string, callNumber: number) => { refundRef: string; amountMinor: number } = (paymentRef) => ({ refundRef: `re_${paymentRef}`, amountMinor: 0 }),
): { refund: PaymentProvider['refund']; idempotencyKeys: string[]; expectedAmounts: number[] } {
  const idempotencyKeys: string[] = [];
  const expectedAmounts: number[] = [];
  return {
    idempotencyKeys,
    expectedAmounts,
    refund: async (paymentRef, expectedAmountMinor) => {
      idempotencyKeys.push(`reserva-refund-${paymentRef}`);
      expectedAmounts.push(expectedAmountMinor);
      return resultFor(paymentRef, idempotencyKeys.length);
    },
  };
}

export type FakeRepository = ReturnType<typeof fakeRepository>;

// Tests address an outbox row by its identity columns, never by a hand-built key string —
// the same rule src/ follows, so a test can't encode a key shape the repository doesn't produce.
export function seedSideEffectOperation(
  repo: FakeRepository,
  bookingId: string,
  identity: SideEffectOperationIdentity,
  overrides: Partial<SideEffectOperationRecord> = {},
): SideEffectOperationRecord {
  const now = overrides.createdAt ?? '2026-06-14T08:00:00.000Z';
  const row: SideEffectOperationRecord = {
    bookingId,
    family: identity.family,
    name: identity.name ?? null,
    event: identity.event ?? null,
    discriminator: identity.discriminator ?? null,
    eventPayloadJson: null,
    status: 'pending',
    providerResultId: null,
    attemptCount: 0,
    attemptedAt: null,
    resolvedAt: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    failureStartedAt: null,
    nextAttemptAt: null,
    ...overrides,
  };
  repo.sideEffectOperations.set(`${bookingId}:${sideEffectOperationKey(identity)}`, row);
  return row;
}

// Says "this booking's confirmation was already delivered" via succeeded outbox rows (what
// the retired calendarSynced/emailSynced flags used to mean), so the repair path in
// handlers/status-manage.ts sees nothing left owed instead of a legacy row to heal.
export function seedSettledConfirmation(
  repo: FakeRepository,
  bookingId: string,
  overrides: Partial<SideEffectOperationRecord> = {},
): void {
  const settled: Partial<SideEffectOperationRecord> = { status: 'succeeded', attemptCount: 1, ...overrides };
  const resolvedAt = settled.resolvedAt ?? settled.createdAt ?? '2026-06-14T08:00:00.000Z';
  seedSideEffectOperation(repo, bookingId, { family: 'calendar_create' }, { ...settled, resolvedAt, providerResultId: repo.rows.get(bookingId)?.calendarEventId ?? 'cal_settled' });
  seedSideEffectOperation(repo, bookingId, { family: 'email_confirmation' }, { ...settled, resolvedAt });
}

export function sideEffectOperation(
  repo: FakeRepository,
  bookingId: string,
  identity: SideEffectOperationIdentity,
): SideEffectOperationRecord | undefined {
  return [...repo.sideEffectOperations.values()]
    .find((row) => row.bookingId === bookingId && sameSideEffectOperation(row, identity));
}

export function providers(overrides: Partial<ReservaProviders> = {}): ReservaProviders {
  return {
    payments: {
      createCheckout: async () => ({ url: 'https://checkout.test/cs_1', sessionRef: 'cs_1' }),
      parseWebhook: async () => ({
        id: 'evt_1',
        type: 'checkout_completed',
        sessionRef: 'cs_1',
        paymentRef: 'pi_1',
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
      refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
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
