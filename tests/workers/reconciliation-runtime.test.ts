import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookkitContext } from '../../src/context';
import { runReconciliation } from '../../src/reconciliation';
import { config } from '../fixtures';
import { providers } from '../fakes';

interface TestEnv {
  BOOKKIT_DB: D1Database;
}

const db = (env as unknown as TestEnv).BOOKKIT_DB;
const clock = () => new Date('2026-08-14T10:00:00.000Z');

beforeEach(async () => {
  await db.prepare('DELETE FROM operational_incidents').run();
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
});

async function seedConfirmed(id: string): Promise<void> {
  const context = createBookkitContext({ config, db, clock, providers: providers() });
  await context.repo.insertHold({
    id,
    reference: `BKT-2026-${id}`,
    tourSlug: 'vintage',
    people: 2,
    pickupType: 'default',
    startsAt: '2026-08-20T09:00:00.000Z',
    endsAt: '2026-08-20T10:00:00.000Z',
    locale: 'en',
    priceCents: 12000,
    holdExpiresAt: '2026-07-21T10:35:00.000Z',
    cancelToken: `cancel-${id}`,
    operatorToken: `operator-${id}`,
    createdAt: '2026-07-21T10:00:00.000Z',
    updatedAt: '2026-07-21T10:00:00.000Z',
  });
  await context.repo.transitionToConfirmed(id, { expectedStatusIn: ['hold'], stripePaymentIntent: `pi_${id}`, updatedAt: '2026-07-21T10:01:00.000Z' });
}

// Plan 020 (design decision 1-2): proves runReconciliation's real end-to-end pipeline — expired
// hold sweep, resuming a stuck refund through the real claim, and incident persistence — against
// real workerd/D1, not just the in-memory fake exercised by tests/reconciliation.test.ts.
describe('runReconciliation against real D1', () => {
  it('sweeps an expired hold', async () => {
    const context = createBookkitContext({ config, db, clock, providers: providers() });
    await context.repo.insertHold({
      id: 'recon-d1-expired', reference: 'BKT-2026-recon-d1-expired', tourSlug: 'vintage', people: 2,
      pickupType: 'default', startsAt: '2026-08-20T09:00:00.000Z', endsAt: '2026-08-20T10:00:00.000Z',
      locale: 'en', priceCents: 12000, holdExpiresAt: '2026-08-14T09:00:00.000Z',
      cancelToken: 'cancel-recon-d1-expired', operatorToken: 'operator-recon-d1-expired',
      createdAt: '2026-08-14T08:00:00.000Z', updatedAt: '2026-08-14T08:00:00.000Z',
    });

    const summary = await runReconciliation(context);
    expect(summary.expiredHoldsSwept).toBe(1);
    await expect(context.repo.getBookingById('recon-d1-expired')).resolves.toMatchObject({ status: 'expired' });
  });

  it('resumes a stuck cancelled-booking refund via the real claim and shared executor', async () => {
    const id = 'recon-d1-refund';
    await seedConfirmed(id);
    const context = createBookkitContext({
      config, db, clock,
      providers: providers({
        payments: {
          createCheckout: async () => ({ url: '', sessionId: '' }),
          parseWebhook: async () => { throw new Error('unused'); },
          getSession: async () => ({ status: 'open' }),
          refund: async () => ({ refundId: 're_recon_d1', amountCents: 12000 }),
        },
      }),
    });
    await context.repo.transitionToCancelled(id, {
      expectedStatusIn: ['confirmed'], cancelledAt: '2026-08-14T09:00:00.000Z', cancelledBy: 'operator', updatedAt: '2026-08-14T09:00:00.000Z',
    });
    await context.repo.claimRefundOperation({ id: 'op-recon-d1', bookingId: id, paymentIntent: `pi_${id}`, choice: 'full', requestedAt: '2026-08-14T09:00:00.000Z' });

    const summary = await runReconciliation(context);
    expect(summary.refundBookingsProcessed).toBe(1);
    await expect(context.repo.getRefundOperationByBookingId(id)).resolves.toMatchObject({ status: 'succeeded', stripeRefundId: 're_recon_d1' });
  });

  it('reports an unreported oversell marker as a persisted, real-D1 incident row', async () => {
    const id = 'recon-d1-oversell';
    await seedConfirmed(id);
    const context = createBookkitContext({ config, db, clock, providers: providers() });
    await db.prepare(
      `INSERT INTO side_effect_operations (booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at)
       VALUES (?, 'oversell', 'succeeded', 'capacity_exceeded', 1, ?, ?, NULL, ?, ?)`,
    ).bind(id, '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z').run();

    const summary = await runReconciliation(context);
    expect(summary.incidentsOpened).toBe(1);
    await expect(context.repo.getIncidentBySource('oversell', id)).resolves.toMatchObject({
      status: 'open', severity: 'action_required', action: 'oversell', bookingId: id,
    });
  });
});
