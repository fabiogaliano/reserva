import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository } from '../../src/repo';

interface TestEnv {
  BOOKKIT_DB: D1Database;
}

const db = (env as unknown as TestEnv).BOOKKIT_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM refund_operations').run();
});

async function seedConfirmed(id: string): Promise<void> {
  await repo.insertHold({
    id,
    reference: `BKT-2026-${id}`,
    tourSlug: 'vintage',
    people: 2,
    pickupType: 'default',
    startsAt: '2026-08-01T09:00:00.000Z',
    endsAt: '2026-08-01T10:00:00.000Z',
    locale: 'en',
    priceCents: 12000,
    holdExpiresAt: '2026-07-21T10:35:00.000Z',
    cancelToken: `cancel-${id}`,
    operatorToken: `operator-${id}`,
    createdAt: '2026-07-21T10:00:00.000Z',
    updatedAt: '2026-07-21T10:00:00.000Z',
  });
  const confirmed = await repo.transitionToConfirmed(id, {
    expectedStatusIn: ['hold'],
    stripePaymentIntent: `pi_${id}`,
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
