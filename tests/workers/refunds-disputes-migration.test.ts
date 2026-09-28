// Migration 0007 moves what earlier releases knew about refunds and disputes onto the booking row.
// Its backfill runs once, against whatever a live database holds, so this builds that database on
// the migrations before it, seeds the rows 0007 reads, and only then applies 0007 itself.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBookingRepository } from '../../src/repo';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;
const MIGRATION = '0007_refunds_disputes.sql';

const RESERVA_TABLES = ['admin_change_history', 'operational_incidents', 'side_effect_operations', 'refund_operations', 'reconciliation_lease', 'settings', 'capacity_defaults', 'day_overrides', 'bookings'];

async function insertBooking(id: string, status: string) {
  await db.prepare(
    `INSERT INTO bookings (id, reference, service_slug, quantity, starts_at, ends_at, locale, price_minor, currency, status,
       cancel_token, operator_token, created_at, updated_at)
     VALUES (?, ?, 'vintage', 2, '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'eur', ?, ?, ?,
       '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
  ).bind(id, `BKT-${id}`, status, `${id}-cancel`, `${id}-operator`).run();
}

async function insertRefundOperation(bookingId: string, choice: string, status: string, amountCents: number | null, requestedAmountCents: number | null = null) {
  await db.prepare(
    `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, amount_cents, requested_amount_cents, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2026-06-02T00:00:00.000Z')`,
  ).bind(`op-${bookingId}`, bookingId, `pi_${bookingId}`, choice, status, amountCents, requestedAmountCents).run();
}

async function insertSideEffect(bookingId: string, family: string, name: string | null, event: string | null, discriminator: string | null, createdAt: string) {
  await db.prepare(
    `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?)`,
  ).bind(bookingId, family, name, event, discriminator, createdAt, createdAt).run();
}

describe(`migration ${MIGRATION} backfill`, () => {
  beforeAll(async () => {
    for (const table of RESERVA_TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    await db.prepare('DROP TABLE IF EXISTS d1_migrations').run();
    const earlier = bindings.TEST_MIGRATIONS.filter((migration) => migration.name !== MIGRATION);
    // Guards the premise: had the name not matched, 0007 would already have run on an empty table.
    expect(earlier).toHaveLength(bindings.TEST_MIGRATIONS.length - 1);
    await applyD1Migrations(db, earlier, 'd1_migrations');

    await insertBooking('full', 'cancelled');
    await insertRefundOperation('full', 'full', 'succeeded', 12000);
    await insertBooking('partial', 'cancelled');
    await insertRefundOperation('partial', 'partial', 'succeeded', 4500, 4500);
    // 'none' succeeds without the provider ever moving money, so it carries no amount.
    await insertBooking('none', 'cancelled');
    await insertRefundOperation('none', 'none', 'succeeded', null);
    // Only a succeeded row is proof the money moved; a failed one may even carry a stale amount.
    await insertBooking('failed', 'cancelled');
    await insertRefundOperation('failed', 'full', 'failed', 12000);

    await insertBooking('disputed', 'confirmed');
    await insertSideEffect('disputed', 'email_confirmation', null, null, null, '2026-06-01T00:00:00.000Z');
    await insertSideEffect('disputed', 'email', 'owner', 'payment.dispute_created', 'evt_dispute_1', '2026-07-02T00:00:00.000Z');
    await insertSideEffect('disputed', 'hook', 'ops', 'payment.dispute_created', 'evt_dispute_1', '2026-07-01T12:00:00.000Z');
    // Disputed and refunded: both backfills land on the same row.
    await insertBooking('disputed-refunded', 'cancelled');
    await insertRefundOperation('disputed-refunded', 'full', 'succeeded', 12000);
    await insertSideEffect('disputed-refunded', 'webhook', 'partner', 'payment.dispute_created', 'evt_dispute_2', '2026-07-03T00:00:00.000Z');

    await insertBooking('untouched', 'confirmed');
    await insertSideEffect('untouched', 'hook', 'ops', 'booking.confirmed', null, '2026-06-01T00:00:00.000Z');

    await applyD1Migrations(db, bindings.TEST_MIGRATIONS, 'd1_migrations');
  });

  const repo = createBookingRepository(db);

  it.each([
    ['full', 12000],
    ['partial', 4500],
    ['none', 0],
    ['failed', 0],
    ['untouched', 0],
  ])('carries the succeeded refund amount of %s over as its refunded total (%i)', async (id, amount) => {
    await expect(repo.getBookingById(id)).resolves.toMatchObject({ amountRefundedMinor: amount });
  });

  it('opens a dispute dated by its earliest outbox row, since no outcome was ever recorded', async () => {
    await expect(repo.getBookingById('disputed')).resolves.toMatchObject({
      disputedAt: '2026-07-01T12:00:00.000Z', disputeStatus: 'open', amountRefundedMinor: 0,
    });
    await expect(repo.getBookingById('disputed-refunded')).resolves.toMatchObject({
      disputedAt: '2026-07-03T00:00:00.000Z', disputeStatus: 'open', amountRefundedMinor: 12000,
    });
  });

  it('leaves a booking that was never disputed without a dispute', async () => {
    for (const id of ['full', 'partial', 'none', 'failed', 'untouched']) {
      await expect(repo.getBookingById(id)).resolves.toMatchObject({ disputedAt: null, disputeStatus: null });
    }
  });

  it('leaves every backfilled booking as it was otherwise', async () => {
    await expect(repo.getBookingById('disputed')).resolves.toMatchObject({ status: 'confirmed', updatedAt: '2026-06-01T00:00:00.000Z' });
    await expect(repo.getBookingById('full')).resolves.toMatchObject({ status: 'cancelled', updatedAt: '2026-06-01T00:00:00.000Z' });
  });
});
