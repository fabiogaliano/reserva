import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository } from '../../src/repo';

interface TestEnv {
  RESERVA_DB: D1Database;
}

const db = (env as unknown as TestEnv).RESERVA_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM refund_operations').run();
});

// Pairwise interleavings against real D1: each test races two conflicting transitions on one
// seeded booking and asserts the loser's CAS reports no change and leaks no fields into the
// winner's row. Genuinely forbidden pairs run both orderings; confirm-vs-cancel doesn't, since a
// cancel after a confirm is a legitimate sequential transition, not a race loss.
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
    updatedAt: '2026-07-21T10:01:00.000Z',
  });
  expect(confirmed).toMatchObject({ status: 'confirmed' });
}

describe('pairwise CAS interleavings on real D1', () => {
  it('cancel vs no-show: cancel wins first, the racing no-show loses and cannot leave a no_show row with cancelled_by set', async () => {
    const id = 'cas-cancel-vs-noshow-a';
    await seedConfirmed(id);

    const winner = await repo.transitionToCancelled(id, {
      expectedStatusIn: ['confirmed'],
      cancelledAt: '2026-07-21T11:00:00.000Z',
      cancelledBy: 'customer',
      updatedAt: '2026-07-21T11:00:00.000Z',
    });
    expect(winner).toMatchObject({ status: 'cancelled', cancelledBy: 'customer' });

    // The exact corrupted-row example: a stale no-show that only patches
    // status + updated_at must not land on top of an already-cancelled row.
    const loser = await repo.transitionToNoShow(id, {
      expectedStatusIn: ['confirmed'],
      updatedAt: '2026-07-21T11:00:01.000Z',
    });
    expect(loser).toBeNull();

    const final = await repo.getBookingById(id);
    expect(final?.status).toBe('cancelled');
    expect(final?.cancelledBy).toBe('customer');
    expect(final?.status === 'no_show' && final?.cancelledBy !== null).toBe(false);
  });

  it('cancel vs no-show: no-show wins first, the racing cancel loses and cannot overwrite the no_show row with cancel fields', async () => {
    const id = 'cas-cancel-vs-noshow-b';
    await seedConfirmed(id);

    const winner = await repo.transitionToNoShow(id, {
      expectedStatusIn: ['confirmed'],
      updatedAt: '2026-07-21T11:00:00.000Z',
    });
    expect(winner).toMatchObject({ status: 'no_show' });

    const loser = await repo.transitionToCancelled(id, {
      expectedStatusIn: ['confirmed'],
      cancelledAt: '2026-07-21T11:00:01.000Z',
      cancelledBy: 'customer',
      updatedAt: '2026-07-21T11:00:01.000Z',
    });
    expect(loser).toBeNull();

    const final = await repo.getBookingById(id);
    expect(final?.status).toBe('no_show');
    expect(final?.cancelledBy).toBeNull();
    expect(final?.cancelledAt).toBeNull();
  });

  it('cancel vs reschedule: cancel wins first, the racing reschedule loses and cannot move a cancelled booking', async () => {
    const id = 'cas-cancel-vs-reschedule-a';
    await seedConfirmed(id);
    const original = await repo.getBookingById(id);
    if (!original) throw new Error('seed missing');

    const winner = await repo.transitionToCancelled(id, {
      expectedStatusIn: ['confirmed'],
      expectedStartsAt: original.startsAt,
      cancelledAt: '2026-07-21T11:00:00.000Z',
      cancelledBy: 'operator',
      updatedAt: '2026-07-21T11:00:00.000Z',
    });
    expect(winner).toMatchObject({ status: 'cancelled' });

    const loser = await repo.transitionReschedule(id, {
      expectedStatus: 'confirmed',
      expectedStartsAt: original.startsAt,
      startsAt: '2026-08-02T09:00:00.000Z',
      endsAt: '2026-08-02T10:00:00.000Z',
      rescheduledFrom: original.startsAt,
      updatedAt: '2026-07-21T11:00:01.000Z',
    });
    expect(loser).toBeNull();

    const final = await repo.getBookingById(id);
    expect(final?.status).toBe('cancelled');
    expect(final?.startsAt).toBe(original.startsAt);
  });

  // Without the expectedStartsAt guard, a stale cancel (still holding the pre-reschedule
  // starts_at) would win here too, computing its decision against a starts_at the row no longer
  // has. The guard makes the reschedule's own starts_at change invalidate the stale cancel.
  it('cancel vs reschedule: reschedule wins first, the racing stale cancel loses instead of clobbering the moved booking', async () => {
    const id = 'cas-cancel-vs-reschedule-b';
    await seedConfirmed(id);
    const original = await repo.getBookingById(id);
    if (!original) throw new Error('seed missing');

    const winner = await repo.transitionReschedule(id, {
      expectedStatus: 'confirmed',
      expectedStartsAt: original.startsAt,
      startsAt: '2026-08-02T09:00:00.000Z',
      endsAt: '2026-08-02T10:00:00.000Z',
      rescheduledFrom: original.startsAt,
      updatedAt: '2026-07-21T11:00:00.000Z',
    });
    expect(winner).toMatchObject({ status: 'confirmed', startsAt: '2026-08-02T09:00:00.000Z' });

    // The stale cancel still carries the pre-reschedule starts_at, mirroring what an HTTP
    // handler read before the race.
    const loser = await repo.transitionToCancelled(id, {
      expectedStatusIn: ['confirmed'],
      expectedStartsAt: original.startsAt,
      cancelledAt: '2026-07-21T11:00:01.000Z',
      cancelledBy: 'customer',
      updatedAt: '2026-07-21T11:00:01.000Z',
    });
    expect(loser).toBeNull();

    const final = await repo.getBookingById(id);
    expect(final?.status).toBe('confirmed');
    expect(final?.startsAt).toBe('2026-08-02T09:00:00.000Z');
    expect(final?.cancelledAt).toBeNull();
    expect(final?.cancelledBy).toBeNull();
  });

  it('no-show vs refund-webhook: the refund wins first, the racing no-show loses and cannot resurrect a cancelled booking as no_show', async () => {
    const id = 'cas-noshow-vs-refund-a';
    await seedConfirmed(id);

    // Mirrors the charge.refunded webhook branch's CAS scope after the fix: non-terminal
    // statuses only — no_show and cancelled are terminal and must never be resurrected.
    const winner = await repo.transitionToCancelled(id, {
      expectedStatusIn: ['hold', 'confirmed', 'expired'],
      cancelledAt: '2026-07-21T11:00:00.000Z',
      cancelledBy: 'operator',
      updatedAt: '2026-07-21T11:00:00.000Z',
    });
    expect(winner).toMatchObject({ status: 'cancelled', cancelledBy: 'operator' });

    const loser = await repo.transitionToNoShow(id, {
      expectedStatusIn: ['confirmed'],
      updatedAt: '2026-07-21T11:00:01.000Z',
    });
    expect(loser).toBeNull();

    const final = await repo.getBookingById(id);
    expect(final?.status).toBe('cancelled');
    expect(final?.cancelledBy).toBe('operator');
    expect(final?.status === 'no_show' && final?.cancelledBy !== null).toBe(false);
  });

  // A refund arriving after an operator marks the booking no_show must not resurrect that
  // terminal state. Excluding 'no_show' from the webhook's expectedStatusIn makes the refund's
  // CAS correctly report no match, leaving the booking exactly as the operator left it.
  it('no-show vs refund-webhook: no-show wins first, the racing refund loses and cannot overwrite the terminal no_show state', async () => {
    const id = 'cas-noshow-vs-refund-b';
    await seedConfirmed(id);

    const winner = await repo.transitionToNoShow(id, {
      expectedStatusIn: ['confirmed'],
      updatedAt: '2026-07-21T11:00:00.000Z',
    });
    expect(winner).toMatchObject({ status: 'no_show' });

    const loser = await repo.transitionToCancelled(id, {
      expectedStatusIn: ['hold', 'confirmed', 'expired'],
      cancelledAt: '2026-07-21T11:00:01.000Z',
      cancelledBy: 'operator',
      updatedAt: '2026-07-21T11:00:01.000Z',
    });
    expect(loser).toBeNull();

    const final = await repo.getBookingById(id);
    expect(final?.status).toBe('no_show');
    expect(final?.cancelledBy).toBeNull();
    expect(final?.cancelledAt).toBeNull();
  });

  it('confirm vs cancel: an operator cancel of a held booking wins first, the racing payment confirmation loses and cannot resurrect it', async () => {
    const id = 'cas-confirm-vs-cancel';
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

    const winner = await repo.transitionToCancelled(id, {
      expectedStatusIn: ['hold', 'confirmed', 'expired'],
      cancelledAt: '2026-07-21T11:00:00.000Z',
      cancelledBy: 'operator',
      updatedAt: '2026-07-21T11:00:00.000Z',
    });
    expect(winner).toMatchObject({ status: 'cancelled', cancelledBy: 'operator' });

    const loser = await repo.transitionToConfirmed(id, {
      expectedStatusIn: ['hold', 'expired'],
      paymentRef: 'pi_stale_confirm',
      updatedAt: '2026-07-21T11:00:01.000Z',
    });
    expect(loser).toBeNull();

    const final = await repo.getBookingById(id);
    expect(final?.status).toBe('cancelled');
    expect(final?.paymentRef).toBeNull();
  });
});
