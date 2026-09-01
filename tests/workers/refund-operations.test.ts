import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository } from '../../src/repo';

interface TestEnv {
  BOOKKIT_DB: D1Database;
}

const db = (env as unknown as TestEnv).BOOKKIT_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
});

async function seedConfirmed(id: string): Promise<void> {
  await repo.insertHold({
    id,
    reference: `BKT-2026-${id}`,
    serviceSlug: 'vintage',
    quantity: 2,
    pickupType: 'default',
    startsAt: '2026-08-01T09:00:00.000Z',
    endsAt: '2026-08-01T10:00:00.000Z',
    locale: 'en',
    priceMinor: 12000,
    currency: 'eur',
    holdExpiresAt: '2026-07-21T10:35:00.000Z',
    cancelToken: `cancel-${id}`,
    operatorToken: `operator-${id}`,
    createdAt: '2026-07-21T10:00:00.000Z',
    updatedAt: '2026-07-21T10:00:00.000Z',
  });
  const confirmed = await repo.transitionToConfirmed(id, {
    expectedStatusIn: ['hold'],
    paymentRef: `pi_${id}`,
    updatedAt: '2026-07-21T10:01:00.000Z',
  });
  expect(confirmed).toMatchObject({ status: 'confirmed' });
}

// BK-REFUND-001: claimRefundOperation is the compare-and-set primitive that makes a booking's
// refund decision race-proof. D1 processes every statement serially on a single-threaded Durable
// Object (see repo-cas-transitions.test.ts's header comment), so UNIQUE(booking_id) plus the
// WHERE NOT EXISTS conditional insert is a true claim under real concurrent writers, not just in
// a single-threaded fake. These tests exercise that against the real binding.
describe('refund_operations concurrent claim uniqueness on real D1', () => {
  it('exactly one of two concurrent claims for the same booking (different choices) wins', async () => {
    const id = 'refund-claim-race-a';
    await seedConfirmed(id);

    const [full, none] = await Promise.all([
      repo.claimRefundOperation({ id: 'op-full', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' }),
      repo.claimRefundOperation({ id: 'op-none', bookingId: id, paymentIntent: null, choice: 'none', requestedAt: '2026-07-21T11:00:00.001Z' }),
    ]);

    // Exactly one claim succeeds — never both, never neither.
    expect([full, none].filter(Boolean)).toHaveLength(1);

    const stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).not.toBeNull();
    // The stored row's id/choice agree with whichever call actually won.
    expect(stored?.id).toBe(full ? 'op-full' : 'op-none');
    expect(stored?.choice).toBe(full ? 'full' : 'none');
  });

  it('exactly one of five concurrent claims for the same booking wins', async () => {
    const id = 'refund-claim-race-b';
    await seedConfirmed(id);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        repo.claimRefundOperation({
          id: `op-${index}`,
          bookingId: id,
          paymentIntent: `pi_${id}`,
          choice: index % 2 === 0 ? 'full' : 'none',
          requestedAt: `2026-07-21T11:00:00.00${index}Z`,
        })),
    );

    expect(attempts.filter(Boolean)).toHaveLength(1);
    const stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).not.toBeNull();
    const winnerIndex = attempts.findIndex(Boolean);
    expect(stored?.id).toBe(`op-${winnerIndex}`);
  });

  it('a claim attempt after an existing operation row is a no-op and never overwrites it', async () => {
    const id = 'refund-claim-sequential';
    await seedConfirmed(id);

    const first = await repo.claimRefundOperation({ id: 'op-first', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    expect(first).toBe(true);

    const second = await repo.claimRefundOperation({ id: 'op-second', bookingId: id, paymentIntent: `pi_${id}`, choice: 'none', requestedAt: '2026-07-21T11:00:01.000Z' });
    expect(second).toBe(false);

    const stored = await repo.getRefundOperationByBookingId(id);
    expect(stored?.id).toBe('op-first');
    expect(stored?.choice).toBe('full');
  });

  it('resolveRefundOperation records the Stripe outcome by operation id, and upsertRefundOperation reconciles a Stripe-initiated refund without clobbering requested_at', async () => {
    const id = 'refund-resolve-upsert';
    await seedConfirmed(id);

    const claimed = await repo.claimRefundOperation({ id: 'op-resolve', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    expect(claimed).toBe(true);

    await repo.resolveRefundOperation('op-resolve', { status: 'succeeded', stripeRefundId: 're_1', amountCents: 12000, resolvedAt: '2026-07-21T11:00:05.000Z' });
    let stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).toMatchObject({ status: 'succeeded', stripeRefundId: 're_1', amountCents: 12000, requestedAt: '2026-07-21T11:00:00.000Z' });

    // A later charge.refunded webhook (e.g. a dashboard-initiated reconciliation) upserts onto
    // the same row instead of creating a second one, and must not overwrite requested_at.
    await repo.upsertRefundOperation({
      id: 'op-webhook', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', status: 'succeeded',
      stripeRefundId: 're_1', amountCents: 12000, requestedAt: '2026-07-21T12:00:00.000Z', resolvedAt: '2026-07-21T12:00:00.000Z',
    });
    stored = await repo.getRefundOperationByBookingId(id);
    expect(stored?.requestedAt).toBe('2026-07-21T11:00:00.000Z');
    expect(stored?.resolvedAt).toBe('2026-07-21T12:00:00.000Z');
  });

  it('deleteRefundOperation cannot destroy a succeeded row', async () => {
    const id = 'refund-delete-succeeded';
    await seedConfirmed(id);
    await repo.claimRefundOperation({
      id: 'op-delete-succeeded', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z',
    });
    await repo.resolveRefundOperation('op-delete-succeeded', {
      status: 'succeeded', stripeRefundId: 're-delete-succeeded', amountCents: 12000, resolvedAt: '2026-07-21T11:01:00.000Z',
    });

    await repo.deleteRefundOperation('op-delete-succeeded');

    await expect(repo.getRefundOperationByBookingId(id)).resolves.toMatchObject({
      id: 'op-delete-succeeded', status: 'succeeded', stripeRefundId: 're-delete-succeeded', amountCents: 12000,
    });
  });

  it('deleteRefundOperation removes a requested row', async () => {
    const id = 'refund-delete-requested';
    await seedConfirmed(id);
    await repo.claimRefundOperation({
      id: 'op-delete-requested', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z',
    });

    await repo.deleteRefundOperation('op-delete-requested');

    await expect(repo.getRefundOperationByBookingId(id)).resolves.toBeNull();
  });

  it('upsertRefundOperation never regresses an already-succeeded row', async () => {
    const id = 'refund-upsert-non-regressing';
    await seedConfirmed(id);

    const claimed = await repo.claimRefundOperation({ id: 'op-upsert-non-regress', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    expect(claimed).toBe(true);
    await repo.resolveRefundOperation('op-upsert-non-regress', { status: 'succeeded', stripeRefundId: 're_original', amountCents: 12000, resolvedAt: '2026-07-21T11:00:05.000Z' });

    await repo.upsertRefundOperation({
      id: 'op-webhook-stale', bookingId: id, paymentIntent: null, choice: 'none', status: 'failed',
      stripeRefundId: null, amountCents: null, requestedAt: '2026-07-21T12:00:00.000Z', resolvedAt: '2026-07-21T12:00:00.000Z', error: 'stale data',
    });

    const stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).toMatchObject({ id: 'op-upsert-non-regress', paymentIntent: `pi_${id}`, choice: 'full', status: 'succeeded', stripeRefundId: 're_original', amountCents: 12000, error: null });
  });

  // BK-REFUND-001 finding #5: resolveRefundOperation must be non-regressing against real D1 — a
  // succeeded row (e.g. already recorded by the charge.refunded webhook) can never be downgraded
  // to 'failed' or have its refund id/amount cleared by a later, stale operator-side attempt.
  it('authoritative Stripe data corrects an earlier none/succeeded audit row', async () => {
    const id = 'refund-authoritative-correction';
    await seedConfirmed(id);
    await repo.claimRefundOperation({ id: 'op-none', bookingId: id, paymentIntent: null, choice: 'none', requestedAt: '2026-07-21T11:00:00.000Z' });
    await repo.resolveRefundOperation('op-none', { status: 'succeeded', resolvedAt: '2026-07-21T11:00:01.000Z' });

    await repo.reconcileStripeRefundOperation({
      id: 'op-stripe', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', status: 'succeeded',
      stripeRefundId: 're_authoritative', amountCents: 12000,
      requestedAt: '2026-07-21T12:00:00.000Z', resolvedAt: '2026-07-21T12:00:00.000Z',
    });

    await expect(repo.getRefundOperationByBookingId(id)).resolves.toMatchObject({
      id: 'op-none', choice: 'full', status: 'succeeded', paymentIntent: `pi_${id}`,
      stripeRefundId: 're_authoritative', amountCents: 12000,
    });
  });

  // BK-REFUND-001: once a row is full/succeeded, it is the terminal, authoritative statement of
  // what Stripe did — stale/failed data reaching reconcileStripeRefundOperation afterwards (a
  // late-arriving duplicate webhook, a stale operator retry) must never regress it, and repeating
  // the SAME authoritative reconciliation must be a true no-op against real D1.
  it('reconcileStripeRefundOperation leaves an existing full/succeeded row unchanged against stale requested/failed data, and repeated identical reconciliations are idempotent', async () => {
    const id = 'refund-reconcile-non-regressing';
    await seedConfirmed(id);
    await repo.reconcileStripeRefundOperation({
      id: 'op-authoritative', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', status: 'succeeded',
      stripeRefundId: 're_authoritative', amountCents: 12000,
      requestedAt: '2026-07-21T11:00:00.000Z', resolvedAt: '2026-07-21T11:00:01.000Z',
    });

    // Stale requested data (as if a late-arriving duplicate claim/attempt reached the same row).
    await repo.reconcileStripeRefundOperation({
      id: 'op-stale-requested', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', status: 'requested',
      stripeRefundId: null, amountCents: null,
      requestedAt: '2026-07-21T12:00:00.000Z', resolvedAt: null,
    });
    let stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).toMatchObject({
      id: 'op-authoritative', choice: 'full', status: 'succeeded',
      stripeRefundId: 're_authoritative', amountCents: 12000,
    });

    // Stale failed data (as if a since-superseded operator attempt finally landed).
    await repo.reconcileStripeRefundOperation({
      id: 'op-stale-failed', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', status: 'failed',
      stripeRefundId: null, amountCents: null, error: 'stale failure',
      requestedAt: '2026-07-21T12:05:00.000Z', resolvedAt: '2026-07-21T12:05:00.000Z',
    });
    stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).toMatchObject({
      id: 'op-authoritative', choice: 'full', status: 'succeeded',
      stripeRefundId: 're_authoritative', amountCents: 12000, error: null,
    });

    // Repeating the identical authoritative reconciliation (e.g. Stripe redelivering the same
    // charge.refunded event) must be idempotent, not merely non-regressing.
    await repo.reconcileStripeRefundOperation({
      id: 'op-authoritative', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', status: 'succeeded',
      stripeRefundId: 're_authoritative', amountCents: 12000,
      requestedAt: '2026-07-21T11:00:00.000Z', resolvedAt: '2026-07-21T13:00:00.000Z',
    });
    stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).toMatchObject({
      id: 'op-authoritative', choice: 'full', status: 'succeeded',
      stripeRefundId: 're_authoritative', amountCents: 12000, resolvedAt: '2026-07-21T13:00:00.000Z',
    });
  });

  it('records an authoritative refund and cancellation in one D1 batch while preserving the refund on CAS loss', async () => {
    const id = 'refund-atomic-cancel';
    await seedConfirmed(id);
    const timestamp = '2026-07-21T12:00:00.000Z';
    const updated = await repo.upsertRefundOperationAndTransitionToCancelled({
      id: 'op-atomic', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', status: 'succeeded',
      stripeRefundId: 're_atomic', amountCents: 12000, requestedAt: timestamp, resolvedAt: timestamp,
    }, id, {
      expectedStatusIn: ['confirmed'], cancelledAt: timestamp, cancelledBy: 'operator', updatedAt: timestamp,
      mutationSideEffects: [
        { family: 'calendar_delete', eventPayloadJson: null, eventIdPrefix: null },
        { family: 'email', event: 'booking.cancelled_by_operator', eventPayloadJson: null, eventIdPrefix: null },
      ],
    });
    expect(updated).toMatchObject({ status: 'cancelled' });
    await expect(repo.getRefundOperationByBookingId(id)).resolves.toMatchObject({ status: 'succeeded', stripeRefundId: 're_atomic' });
    await expect(repo.listSideEffectOperations(id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'calendar_delete', status: 'pending' }),
      expect.objectContaining({ family: 'email', event: 'booking.cancelled_by_operator', status: 'pending' }),
    ]));

    const lostId = 'refund-atomic-cas-loss';
    await seedConfirmed(lostId);
    await repo.transitionToNoShow(lostId, { expectedStatusIn: ['confirmed'], updatedAt: timestamp });
    const lost = await repo.upsertRefundOperationAndTransitionToCancelled({
      id: 'op-cas-loss', bookingId: lostId, paymentIntent: `pi_${lostId}`, choice: 'full', status: 'succeeded',
      stripeRefundId: 're_cas_loss', amountCents: 12000, requestedAt: timestamp, resolvedAt: timestamp,
    }, lostId, { expectedStatusIn: ['confirmed'], cancelledAt: timestamp, cancelledBy: 'operator', updatedAt: timestamp });
    expect(lost).toBeNull();
    await expect(repo.getRefundOperationByBookingId(lostId)).resolves.toMatchObject({ status: 'succeeded', stripeRefundId: 're_cas_loss' });
    await expect(repo.getBookingById(lostId)).resolves.toMatchObject({ status: 'no_show' });
  });

  it('allows an expired operator token only for requested or failed refund recovery, including guarded legacy lookup', async () => {
    const now = '2026-07-21T12:00:00.000Z';
    const id = 'refund-token-recovery';
    await seedConfirmed(id);
    await db.prepare('UPDATE bookings SET tokens_expire_at = ? WHERE id = ?').bind('2026-07-01T00:00:00.000Z', id).run();
    const token = `operator-${id}`;
    await expect(repo.getBookingByOperatorToken(token, now)).resolves.toBeNull();
    await expect(repo.getBookingByOperatorTokenForRefundRecovery(token, now)).resolves.toBeNull();
    await repo.claimRefundOperation({ id: 'op-token', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    await expect(repo.getBookingByOperatorTokenForRefundRecovery(token, now)).resolves.toMatchObject({ id });
    await repo.resolveRefundOperation('op-token', { status: 'failed', error: 'retry', resolvedAt: '2026-07-21T11:01:00.000Z' });
    await expect(repo.getBookingByOperatorTokenForRefundRecovery(token, now)).resolves.toMatchObject({ id });
    await repo.resolveRefundOperation('op-token', { status: 'succeeded', stripeRefundId: 're_token', amountCents: 12000, resolvedAt: '2026-07-21T11:02:00.000Z' });
    await expect(repo.getBookingByOperatorTokenForRefundRecovery(token, now)).resolves.toBeNull();

    const legacyId = 'refund-token-recovery-legacy';
    const legacyToken = `operator-${legacyId}`;
    await seedConfirmed(legacyId);
    await db.prepare(
      `UPDATE bookings
       SET operator_token = ?, operator_token_hash = NULL, operator_token_enc = NULL,
           tokens_expire_at = ?
       WHERE id = ?`,
    ).bind(legacyToken, '2026-07-01T00:00:00.000Z', legacyId).run();
    await expect(repo.getBookingByOperatorTokenForRefundRecovery(legacyToken, now)).resolves.toBeNull();
    await repo.claimRefundOperation({ id: 'op-token-legacy', bookingId: legacyId, paymentIntent: `pi_${legacyId}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    await expect(repo.getBookingByOperatorTokenForRefundRecovery(legacyToken, now)).resolves.toMatchObject({ id: legacyId });
    const legacyRow = (await db.prepare(
      'SELECT operator_token, operator_token_hash FROM bookings WHERE id = ?',
    ).bind(legacyId).all<{ operator_token: string; operator_token_hash: string | null }>()).results[0];
    expect(legacyRow?.operator_token_hash).toBeTruthy();
    expect(legacyRow?.operator_token).not.toBe(legacyToken);
  });

  it('resolveRefundOperation never downgrades an already-succeeded row (status only ever advances)', async () => {
    const id = 'refund-resolve-non-regressing';
    await seedConfirmed(id);

    const claimed = await repo.claimRefundOperation({ id: 'op-non-regress', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-07-21T11:00:00.000Z' });
    expect(claimed).toBe(true);

    await repo.resolveRefundOperation('op-non-regress', { status: 'succeeded', stripeRefundId: 're_original', amountCents: 12000, resolvedAt: '2026-07-21T11:00:05.000Z' });
    let stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).toMatchObject({ status: 'succeeded', stripeRefundId: 're_original', amountCents: 12000 });

    // A stale retry (e.g. an operator's earlier in-flight request finally landing after the
    // webhook already reconciled this refund as succeeded) must not be able to mark it 'failed'
    // or clear the recorded refund id/amount.
    await repo.resolveRefundOperation('op-non-regress', { status: 'failed', error: 'stale attempt', resolvedAt: '2026-07-21T11:00:10.000Z' });
    stored = await repo.getRefundOperationByBookingId(id);
    expect(stored).toMatchObject({ status: 'succeeded', stripeRefundId: 're_original', amountCents: 12000, error: null });
  });
});
