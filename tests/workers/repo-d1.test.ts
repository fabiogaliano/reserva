import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../../src/confirmation';
import { createReservaContext } from '../../src/context';
import { createBookingRepository, HoldLimitExceededError, type SideEffectOperationIdentity, type SideEffectOperationSeed } from '../../src/repo';
import { config } from '../fixtures';
import { providers } from '../fakes';

interface TestEnv {
  RESERVA_DB: D1Database;
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
});

describe('D1 booking repository', () => {
  it('creates, reads, updates, and expires a hold through the real D1 binding', async () => {
    const created = await repo.insertHold({
      id: 'booking-1',
      reference: 'BKT-2026-001',
      serviceSlug: 'vintage',
      quantity: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token',
      operatorToken: 'operator-token',
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });

    expect(created).toMatchObject({ status: 'hold', serviceSlug: 'vintage', quantity: 2 });
    await repo.updateBooking(created.id, {
      paymentSessionRef: 'cs_test',
      updatedAt: '2026-07-21T10:01:00.000Z',
    });
    await expect(repo.getBookingBySessionRef('cs_test')).resolves.toMatchObject({ id: created.id });
    await expect(repo.sweepExpiredHolds('2026-07-21T10:35:00.000Z')).resolves.toBe(0);
    await expect(repo.sweepExpiredHolds('2026-07-21T10:35:00.001Z')).resolves.toBe(1);
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ status: 'expired', holdExpiresAt: null });
  });

  // insertHoldWithCapacity is the checkout path; its per-IP cap is a separate WHERE clause from
  // insertHold's, plus a post-failure reclassification that must throw rather than report a
  // capacity loss. Capacity is ample so only the cap can refuse the second hold.
  it('refuses a second active hold from the same IP through insertHoldWithCapacity once the per-IP cap is reached', async () => {
    const hold = (id: string, holdIp: string, createdAt: string) => repo.insertHoldWithCapacity({
      id, reference: `BKT-2026-${id}`, serviceSlug: 'vintage', quantity: 1, pickupType: 'default',
      startsAt: '2026-08-01T13:00:00.000Z', endsAt: '2026-08-01T14:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: `cancel-${id}`, operatorToken: `operator-${id}`,
      holdIp, maxActiveHoldsForIp: 1,
      occupancyUnits: 1, occupancyEndsAt: '2026-08-01T14:00:00.000Z', localDate: '2026-08-01', defaultCapacity: 10,
      createdAt, updatedAt: createdAt,
    });

    await expect(hold('ip-cap-first', '203.0.113.1', '2026-07-21T10:00:00.000Z')).resolves.toMatchObject({ status: 'hold' });
    await expect(hold('ip-cap-over', '203.0.113.1', '2026-07-21T10:00:01.000Z')).rejects.toBeInstanceOf(HoldLimitExceededError);
    await expect(hold('ip-cap-other-ip', '203.0.113.2', '2026-07-21T10:00:02.000Z')).resolves.toMatchObject({ status: 'hold' });
    await expect(repo.getBookingById('ip-cap-over')).resolves.toBeNull();
  });

  it('serializes confirmation leases and expires holds with compare-and-set semantics', async () => {
    const created = await repo.insertHold({
      id: 'booking-lease',
      reference: 'BKT-2026-002',
      serviceSlug: 'vintage',
      quantity: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T11:00:00.000Z',
      endsAt: '2026-08-01T12:00:00.000Z',
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token-lease',
      operatorToken: 'operator-token-lease',
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });

    const claims = await Promise.all([
      repo.acquireConfirmationLease(created.id, 'lease-a', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z'),
      repo.acquireConfirmationLease(created.id, 'lease-b', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await repo.releaseConfirmationLease(created.id, claims[0] ? 'lease-a' : 'lease-b');
    await expect(repo.acquireConfirmationLease(created.id, 'lease-c', '2026-07-21T10:00:01.000Z', '2026-07-21T10:05:01.000Z')).resolves.toBe(true);
    await repo.releaseConfirmationLease(created.id, 'lease-c');

    await repo.transitionToConfirmed(created.id, { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
    await expect(repo.expireHold(created.id, '2026-07-21T10:02:00.000Z')).resolves.toBeNull();
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ status: 'confirmed' });
  });

  // A confirmer that stalls past its lease must not write outcomes once another caller has taken
  // the lease over; only the SQL token predicates enforce that, so it is proven here on real D1.
  it('fences an expired lease holder\'s late calendar claim and resolve after another caller takes the lease over', async () => {
    const created = await repo.insertHold({
      id: 'booking-lease-fence', reference: 'BKT-2026-FENCE', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'cancel-token-fence', operatorToken: 'operator-token-fence',
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });
    const calendar: SideEffectOperationIdentity = { family: 'calendar_create' };
    await expect(repo.acquireConfirmationLease(created.id, 'lease-a', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z')).resolves.toBe(true);
    await expect(repo.confirmWithSideEffectOperations(created.id, {
      expectedStatusIn: ['hold'], leaseToken: 'lease-a', oversold: false, updatedAt: '2026-07-21T10:01:00.000Z',
    })).resolves.toMatchObject({ status: 'confirmed' });
    await expect(repo.claimSideEffectOperation(created.id, calendar, 'lease-a', '2026-07-21T10:01:00.000Z')).resolves.toBe(1);

    await expect(repo.acquireConfirmationLease(created.id, 'lease-b', '2026-07-21T10:04:00.000Z', '2026-07-21T10:09:00.000Z')).resolves.toBe(false);
    await expect(repo.acquireConfirmationLease(created.id, 'lease-b', '2026-07-21T10:06:00.000Z', '2026-07-21T10:11:00.000Z')).resolves.toBe(true);
    await expect(repo.renewConfirmationLease(created.id, 'lease-a', '2026-07-21T10:06:01.000Z', '2026-07-21T10:11:01.000Z')).resolves.toBe(false);
    await expect(repo.claimSideEffectOperation(created.id, calendar, 'lease-b', '2026-07-21T10:06:02.000Z')).resolves.toBe(2);

    await expect(repo.claimSideEffectOperation(created.id, calendar, 'lease-a', '2026-07-21T10:06:03.000Z')).resolves.toBeNull();
    await expect(repo.resolveSideEffectOperation({
      bookingId: created.id, identity: calendar, leaseToken: 'lease-a', status: 'succeeded',
      providerResultId: 'event-from-a', resolvedAt: '2026-07-21T10:06:04.000Z',
    })).resolves.toBe(false);
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ calendarEventId: null });

    await expect(repo.resolveSideEffectOperation({
      bookingId: created.id, identity: calendar, leaseToken: 'lease-b', status: 'succeeded',
      providerResultId: 'event-from-b', resolvedAt: '2026-07-21T10:06:05.000Z',
    })).resolves.toBe(true);
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ calendarEventId: 'event-from-b' });
    await expect(repo.listSideEffectOperations(created.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'calendar_create', status: 'succeeded', attemptCount: 2, providerResultId: 'event-from-b' }),
    ]));
  });

  it('rolls back the confirmation status when creating its outbox rows fails inside the same batch', async () => {
    const created = await repo.insertHold({
      id: 'booking-outbox-atomic',
      reference: 'BKT-2026-OUTBOX',
      serviceSlug: 'vintage',
      quantity: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token-outbox',
      operatorToken: 'operator-token-outbox',
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    await repo.acquireConfirmationLease(created.id, 'lease-outbox', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z');
    await db.prepare(`CREATE TRIGGER fail_confirmation_outbox
      BEFORE INSERT ON side_effect_operations
      BEGIN SELECT RAISE(ABORT, 'outbox insert failed'); END`).run();

    await expect(repo.confirmWithSideEffectOperations(created.id, {
      expectedStatusIn: ['hold'],
      leaseToken: 'lease-outbox',
      oversold: false,
      updatedAt: '2026-07-21T10:01:00.000Z',
    })).rejects.toThrow('outbox insert failed');

    expect((await repo.getBookingById(created.id))?.status).toBe('hold');
    await expect(db.prepare('SELECT * FROM side_effect_operations WHERE booking_id = ?').bind(created.id).all()).resolves.toMatchObject({ results: [] });
    await db.prepare('DROP TRIGGER fail_confirmation_outbox').run();
  });

  // Proves the optional subscriber row shares confirmWithSideEffectOperations' one D1 batch too —
  // a failure inserting only the hook row must still roll back the whole batch, leaving the
  // booking unconfirmed and no partial rows behind.
  it('rolls back the confirmation status when creating its hook outbox row fails inside the same batch', async () => {
    const created = await repo.insertHold({
      id: 'booking-hook-outbox-atomic',
      reference: 'BKT-2026-TFOUTBOX',
      serviceSlug: 'vintage',
      quantity: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token-tf-outbox',
      operatorToken: 'operator-token-tf-outbox',
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    await repo.acquireConfirmationLease(created.id, 'lease-tf-outbox', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z');
    await db.prepare(`CREATE TRIGGER fail_hook_outbox
      BEFORE INSERT ON side_effect_operations WHEN NEW.family = 'hook'
      BEGIN SELECT RAISE(ABORT, 'hook outbox insert failed'); END`).run();

    await expect(repo.confirmWithSideEffectOperations(created.id, {
      expectedStatusIn: ['hold'],
      leaseToken: 'lease-tf-outbox',
      oversold: false,
      updatedAt: '2026-07-21T10:01:00.000Z',
      eventSeeds: [{
        family: 'hook', name: 'ops', event: 'booking.confirmed',
        eventPayloadJson: '{"apiVersion":1}', eventIdPrefix: null,
      }],
    })).rejects.toThrow('hook outbox insert failed');

    expect((await repo.getBookingById(created.id))?.status).toBe('hold');
    await expect(db.prepare('SELECT * FROM side_effect_operations WHERE booking_id = ?').bind(created.id).all()).resolves.toMatchObject({ results: [] });
    await db.prepare('DROP TRIGGER fail_hook_outbox').run();
  });

  // Proves the split confirmation-path email rows share confirmWithSideEffectOperations' one D1
  // batch too — a failure inserting just the owner recipient's row must still roll back the whole
  // batch, leaving the booking unconfirmed and no partial rows behind.
  it('rolls back the confirmation status when creating a split email outbox row fails inside the same batch', async () => {
    const created = await repo.insertHold({
      id: 'booking-email-split-outbox-atomic',
      reference: 'BKT-2026-EMAILSPLIT',
      serviceSlug: 'vintage',
      quantity: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token-email-split-outbox',
      operatorToken: 'operator-token-email-split-outbox',
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    await repo.acquireConfirmationLease(created.id, 'lease-email-split-outbox', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z');
    await db.prepare(`CREATE TRIGGER fail_email_split_outbox
      BEFORE INSERT ON side_effect_operations WHEN NEW.family = 'email' AND NEW.name = 'owner'
      BEGIN SELECT RAISE(ABORT, 'email split outbox insert failed'); END`).run();

    await expect(repo.confirmWithSideEffectOperations(created.id, {
      expectedStatusIn: ['hold'],
      leaseToken: 'lease-email-split-outbox',
      oversold: false,
      updatedAt: '2026-07-21T10:01:00.000Z',
      emailRecipients: ['customer', 'owner'],
    })).rejects.toThrow('email split outbox insert failed');

    expect((await repo.getBookingById(created.id))?.status).toBe('hold');
    await expect(db.prepare('SELECT * FROM side_effect_operations WHERE booking_id = ?').bind(created.id).all()).resolves.toMatchObject({ results: [] });
    await db.prepare('DROP TRIGGER fail_email_split_outbox').run();
  });

  it('legacy repair adds no combined confirmation email row beside split rows after a swap to a send-only provider (re-mailed the customer)', async () => {
    const created = await repo.insertHold({
      id: 'booking-email-repair-no-combined',
      reference: 'BKT-2026-EMAILREPAIR',
      serviceSlug: 'vintage',
      quantity: 2,
      pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token-email-repair',
      operatorToken: 'operator-token-email-repair',
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    await repo.acquireConfirmationLease(created.id, 'lease-email-repair', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z');
    await repo.confirmWithSideEffectOperations(created.id, {
      expectedStatusIn: ['hold'],
      leaseToken: 'lease-email-repair',
      oversold: false,
      updatedAt: '2026-07-21T10:01:00.000Z',
      emailRecipients: ['customer', 'owner'],
    });

    // A later pass under a provider without sendToRecipient asks for the combined shape.
    await repo.ensureConfirmationSideEffectOperations(created.id, 'lease-email-repair', '2026-07-21T10:02:00.000Z');

    const emailRows = await db.prepare(
      `SELECT family, name FROM side_effect_operations WHERE booking_id = ? AND family IN ('email', 'email_confirmation') ORDER BY family, name`,
    ).bind(created.id).all();
    expect(emailRows.results).toEqual([{ family: 'email', name: 'customer' }, { family: 'email', name: 'owner' }]);
  });

  // migrations/0014_meeting_points.sql's two nullable columns, against real D1.
  describe('meeting point columns (migration 0014)', () => {
    it('round-trips meeting_point_id/meeting_point_label through insertHoldWithCapacity when set', async () => {
      const created = await repo.insertHoldWithCapacity({
        id: 'booking-meeting-point-set', reference: 'BKT-2026-MP1', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'mp-set-cancel', operatorToken: 'mp-set-operator',
        meetingPointId: 'tuk-tuk-a', meetingPointLabel: 'Praça do Comércio (tuk-tuk A)',
        occupancyUnits: 1, occupancyEndsAt: '2026-08-01T10:00:00.000Z', localDate: '2026-08-01', defaultCapacity: 5,
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });

      expect(created).toMatchObject({ meetingPointId: 'tuk-tuk-a', meetingPointLabel: 'Praça do Comércio (tuk-tuk A)' });
      await expect(repo.getBookingById(created!.id)).resolves.toMatchObject({
        meetingPointId: 'tuk-tuk-a', meetingPointLabel: 'Praça do Comércio (tuk-tuk A)',
      });
    });

    it('leaves meeting_point_id/meeting_point_label NULL through insertHoldWithCapacity when the caller omits them', async () => {
      const created = await repo.insertHoldWithCapacity({
        id: 'booking-meeting-point-absent', reference: 'BKT-2026-MP2', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'mp-absent-cancel', operatorToken: 'mp-absent-operator',
        occupancyUnits: 1, occupancyEndsAt: '2026-08-01T10:00:00.000Z', localDate: '2026-08-01', defaultCapacity: 5,
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });

      expect(created).toMatchObject({ meetingPointId: null, meetingPointLabel: null });
      const row = (await db.prepare(
        'SELECT meeting_point_id, meeting_point_label FROM bookings WHERE id = ?',
      ).bind(created!.id).all<{ meeting_point_id: string | null; meeting_point_label: string | null }>()).results[0];
      expect(row?.meeting_point_id).toBeNull();
      expect(row?.meeting_point_label).toBeNull();
    });

    it('maps a pre-0014-shaped row (meeting_point columns NULL, as every column was before this migration) cleanly through mapBooking', async () => {
      await repo.insertHold({
        id: 'booking-meeting-point-legacy', reference: 'BKT-2026-MP3', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'mp-legacy-cancel', operatorToken: 'mp-legacy-operator',
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });
      // Simulates a row written before migration 0014 ran: explicitly force both columns back to
      // NULL (insertHold already writes NULL for an omitted input, but this asserts the DB state
      // itself, not just the insert path's default).
      await db.prepare('UPDATE bookings SET meeting_point_id = NULL, meeting_point_label = NULL WHERE id = ?')
        .bind('booking-meeting-point-legacy').run();

      await expect(repo.getBookingById('booking-meeting-point-legacy')).resolves.toMatchObject({
        meetingPointId: null, meetingPointLabel: null,
      });
    });
  });

  // Migration 0015 removed the pickup_type CHECK (domain moved to config-declared option ids) —
  // this is the row the old CHECK would have rejected, round-tripped through the real application
  // write/read paths (see schema-constraints.test.ts for the SQL-layer proof).
  it('inserts and reads back a booking with a non-enum pickup_type id (migration 0015)', async () => {
    const created = await repo.insertHold({
      id: 'booking-pickup-non-enum', reference: 'BKT-2026-PICKUPNE', serviceSlug: 'vintage', quantity: 2,
      pickupType: 'custom_both',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 21000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'pickup-ne-cancel', operatorToken: 'pickup-ne-operator',
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });

    expect(created).toMatchObject({ pickupType: 'custom_both' });
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ pickupType: 'custom_both' });
  });

  // With the SQL CHECK gone, SQLite happily stores pickup_type = ''
  // (e.g. a hand-restored row) -- mapBooking's read-time floor must reject it, since an empty id
  // is undeclarable under every possible config.
  it('rejects a stored empty-string pickup_type at read time (InvalidBookingRowError)', async () => {
    await repo.insertHold({
      id: 'booking-pickup-empty', reference: 'BKT-2026-PICKUPEMPTY', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'pickup-empty-cancel', operatorToken: 'pickup-empty-operator',
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });
    await db.prepare(`UPDATE bookings SET pickup_type = '' WHERE id = ?`).bind('booking-pickup-empty').run();

    await expect(repo.getBookingById('booking-pickup-empty')).rejects.toThrow(/pickup_type must be a non-empty string/);
  });

  // Migration 0018 makes pickup_type nullable for the location-less service to store "no pickup
  // at all" as NULL — the read-time floor must let NULL through untouched, since it's a declared
  // state, not a corrupt row.
  it('hydrates a NULL pickup_type as pickupType: null rather than rejecting the row', async () => {
    await repo.insertHold({
      id: 'booking-pickup-null', reference: 'BKT-2026-PICKUPNULL', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'pickup-null-cancel', operatorToken: 'pickup-null-operator',
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });
    await db.prepare('UPDATE bookings SET pickup_type = NULL WHERE id = ?').bind('booking-pickup-null').run();

    await expect(repo.getBookingById('booking-pickup-null')).resolves.toMatchObject({ pickupType: null });
  });

  it('round-trips the payer-given headcount through confirmation without letting a late detail overwrite it', async () => {
    const created = await repo.insertHold({
      id: 'booking-guests', reference: 'BKT-2026-GUESTS', serviceSlug: 'vintage', quantity: 4, pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'guests-cancel', operatorToken: 'guests-operator',
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });
    expect(created.guestCount).toBeNull();

    await repo.transitionToConfirmed(created.id, { expectedStatusIn: ['hold'], guestCount: 3, updatedAt: '2026-07-21T10:01:00.000Z' });
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ quantity: 4, guestCount: 3 });

    await repo.acquireConfirmationLease(created.id, 'lease-guests', '2026-07-21T10:02:00.000Z', '2026-07-21T10:07:00.000Z');
    await repo.applyConfirmedPaymentDetails(created.id, { guestCount: 2 }, 'lease-guests', '2026-07-21T10:02:00.000Z');
    await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ guestCount: 3 });

    await expect(db.prepare('UPDATE bookings SET guest_count = 0 WHERE id = ?').bind(created.id).run()).rejects.toThrow(/CHECK/);
  });

  describe('refund total and dispute status', () => {
    const insertMoneyBooking = (id: string) => repo.insertHold({
      id, reference: `BKT-2026-${id}`, serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: `${id}-cancel`, operatorToken: `${id}-operator`,
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });

    it('counts bookings per stored metadata value: confirmed ahead as upcoming, confirmed or no-show behind as past', async () => {
      const place = async (id: string, value: string, status: string, startsAt: string) => {
        const created = await repo.insertHold({
          id, reference: `BKT-2026-${id}`, serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
          startsAt, endsAt: startsAt.replace('T09:', 'T10:'), locale: 'en', priceMinor: 12000, currency: 'eur', metadata: { channel: value },
          holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: `${id}-cancel`, operatorToken: `${id}-operator`,
          createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
        });
        await db.prepare('UPDATE bookings SET status = ? WHERE id = ?').bind(status, created.id).run();
      };
      const now = '2026-08-01T00:00:00.000Z';
      await place('ch-up', 'hotel', 'confirmed', '2026-08-05T09:00:00.000Z');
      await place('ch-past', 'hotel', 'confirmed', '2026-07-05T09:00:00.000Z');
      await place('ch-noshow', 'hotel', 'no_show', '2026-07-06T09:00:00.000Z');
      await place('ch-cancelled', 'hotel', 'cancelled', '2026-08-06T09:00:00.000Z');
      await place('ch-hold', 'kiosk', 'hold', '2026-08-07T09:00:00.000Z');

      const counts = await repo.countMetadataValues('channel', now);
      expect([...counts].sort((a, b) => a.value.localeCompare(b.value))).toEqual([
        { value: 'hotel', upcoming: 1, past: 2 },
        { value: 'kiosk', upcoming: 0, past: 0 },
      ]);
      await expect(repo.countMetadataValues('nobody_uses_this', now)).resolves.toEqual([]);
    });

    it('starts a booking with nothing refunded and no dispute', async () => {
      await expect(insertMoneyBooking('money-new')).resolves.toMatchObject({ amountRefundedMinor: 0, disputedAt: null, disputeStatus: null });
    });

    it('keeps the largest refunded total whatever order the totals arrive in', async () => {
      const created = await insertMoneyBooking('money-refund');

      await repo.recordRefundedAmount(created.id, 5000);
      await repo.recordRefundedAmount(created.id, 2000);
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ amountRefundedMinor: 5000, updatedAt: created.updatedAt });
      await repo.recordRefundedAmount(created.id, 12000);
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ amountRefundedMinor: 12000 });

      await expect(db.prepare('UPDATE bookings SET amount_refunded_minor = -1 WHERE id = ?').bind(created.id).run()).rejects.toThrow(/CHECK/);
    });

    it('opens a dispute once and lets its close set the outcome', async () => {
      const created = await insertMoneyBooking('money-dispute');

      await repo.markDisputed(created.id, '2026-07-22T08:00:00.000Z');
      await repo.markDisputed(created.id, '2026-07-23T08:00:00.000Z');
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ disputedAt: '2026-07-22T08:00:00.000Z', disputeStatus: 'open' });

      await repo.closeDispute(created.id, 'won', '2026-09-01T08:00:00.000Z');
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ disputedAt: '2026-07-22T08:00:00.000Z', disputeStatus: 'won' });
    });

    it('reopens on a later dispute, and moves the date on a later close, only with the provider’s creation time', async () => {
      const created = await insertMoneyBooking('money-dispute-second');
      const first = '2026-07-22T08:00:00.000Z';
      const second = '2026-08-30T08:00:00.000Z';

      await repo.markDisputed(created.id, first, true);
      await repo.closeDispute(created.id, 'won', first, true);
      await repo.markDisputed(created.id, first, true);
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ disputedAt: first, disputeStatus: 'won' });

      // Without the provider's time a later opening is indistinguishable from a redelivery.
      await repo.markDisputed(created.id, second);
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ disputedAt: first, disputeStatus: 'won' });

      await repo.markDisputed(created.id, second, true);
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ disputedAt: second, disputeStatus: 'open' });

      const third = '2026-09-15T08:00:00.000Z';
      await repo.closeDispute(created.id, 'lost', third, true);
      await repo.markDisputed(created.id, third, true);
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ disputedAt: third, disputeStatus: 'lost' });
    });

    it('ends in the outcome when the close is recorded before the dispute opens', async () => {
      const created = await insertMoneyBooking('money-dispute-reversed');

      await repo.closeDispute(created.id, 'lost', '2026-09-01T08:00:00.000Z');
      await repo.markDisputed(created.id, '2026-09-01T08:05:00.000Z');
      await expect(repo.getBookingById(created.id)).resolves.toMatchObject({ disputedAt: '2026-09-01T08:00:00.000Z', disputeStatus: 'lost' });

      await expect(db.prepare("UPDATE bookings SET dispute_status = 'pending' WHERE id = ?").bind(created.id).run()).rejects.toThrow(/CHECK/);
    });
  });

  describe('token hashing, expiry, and revocation', () => {
    // A second repository instance bound to the same D1 database but with RESERVA_TOKEN_ENC_KEY
    // configured, so these tests can exercise the full encrypt-at-insert/decrypt-at-read round trip
    // (see migrations/0009_token_hashing.sql).
    const encRepo = createBookingRepository(db, (name) => (name === 'RESERVA_TOKEN_ENC_KEY' ? 'test-only-token-encryption-secret' : undefined));

    it('never stores a plaintext token for a new booking, even without RESERVA_TOKEN_ENC_KEY configured, and lookup still authenticates', async () => {
      const created = await repo.insertHold({
        id: 'booking-noenc-1', reference: 'BKT-2026-NOENC1', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'noenc-cancel-token', operatorToken: 'noenc-operator-token',
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });

      const row = (await db.prepare(
        'SELECT cancel_token, cancel_token_hash, cancel_token_enc FROM bookings WHERE id = ?',
      ).bind(created.id).all<{ cancel_token: string; cancel_token_hash: string; cancel_token_enc: string | null }>()).results[0];
      expect(row?.cancel_token_hash).toBeTruthy();
      expect(row?.cancel_token_hash).not.toBe('noenc-cancel-token'); // stored value is a hash, not the presented token
      expect(row?.cancel_token).not.toBe('noenc-cancel-token'); // legacy column holds a placeholder, not real plaintext
      expect(row?.cancel_token_enc).toBeNull(); // no key configured -> no encrypted blob either; degrades, never falls back to plaintext

      // Lookup still authenticates via the hash — link *regeneration* is what's degraded without
      // a key, not the security-critical lookup path.
      await expect(repo.getBookingByCancelToken('noenc-cancel-token', '2026-07-21T10:00:00.000Z')).resolves.toMatchObject({ id: created.id });
    });

    it('with RESERVA_TOKEN_ENC_KEY configured: hashes for lookup, encrypts for link regeneration, denies the hash presented as a token, and enforces expiry + cancel-token-only revocation', async () => {
      const created = await encRepo.insertHold({
        id: 'booking-hash-1', reference: 'BKT-2026-HASH1', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'hash-cancel-token', operatorToken: 'hash-operator-token',
        tokensExpireAt: '2026-09-01T00:00:00.000Z',
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });

      const row = (await db.prepare(
        'SELECT cancel_token, cancel_token_hash, cancel_token_enc FROM bookings WHERE id = ?',
      ).bind(created.id).all<{ cancel_token: string; cancel_token_hash: string; cancel_token_enc: string | null }>()).results[0];
      expect(row?.cancel_token_hash).toBeTruthy();
      expect(row?.cancel_token_hash).not.toBe('hash-cancel-token');
      expect(row?.cancel_token).not.toBe('hash-cancel-token');
      expect(row?.cancel_token_enc).toBeTruthy(); // encrypted blob present now that a key is configured

      // The stored hash cannot itself be presented as a token (no hash-as-credential oracle).
      await expect(encRepo.getBookingByCancelToken(row!.cancel_token_hash, '2026-07-21T10:00:00.000Z')).resolves.toBeNull();

      // Full round trip: the presented token authenticates, and the returned booking's tokens are
      // the real plaintext again (decrypted from cancel_token_enc/operator_token_enc), without D1
      // ever having stored that plaintext at rest.
      await expect(encRepo.getBookingByCancelToken('hash-cancel-token', '2026-07-21T10:00:00.000Z')).resolves.toMatchObject({ id: created.id, cancelToken: 'hash-cancel-token' });
      await expect(encRepo.getBookingByOperatorToken('hash-operator-token', '2026-07-21T10:00:00.000Z')).resolves.toMatchObject({ id: created.id, operatorToken: 'hash-operator-token' });
      await expect(encRepo.getBookingById(created.id)).resolves.toMatchObject({ cancelToken: 'hash-cancel-token', operatorToken: 'hash-operator-token' });

      // Expired: `now` is past tokens_expire_at — denied exactly like an unknown token.
      await expect(encRepo.getBookingByCancelToken('hash-cancel-token', '2026-09-02T00:00:00.000Z')).resolves.toBeNull();

      // Revoked: cancelling the booking revokes the customer token but not the operator token
      // (see migrations/0009_token_hashing.sql for why).
      await encRepo.transitionToConfirmed(created.id, { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
      await encRepo.transitionToCancelled(created.id, {
        expectedStatusIn: ['confirmed'], cancelledAt: '2026-07-21T11:00:00.000Z', cancelledBy: 'customer', updatedAt: '2026-07-21T11:00:00.000Z',
      });
      await expect(encRepo.getBookingByCancelToken('hash-cancel-token', '2026-07-21T11:00:01.000Z')).resolves.toBeNull();
      await expect(encRepo.getBookingByOperatorToken('hash-operator-token', '2026-07-21T11:00:01.000Z')).resolves.toMatchObject({ id: created.id });
    });

    it('authenticates a legacy plaintext-only row via the compat fallback, then lazily upgrades it to a hash (+ encrypted blob, when a key is configured)', async () => {
      // Simulate a pre-migration row: insert normally (which now writes a hash), then overwrite
      // the token columns back to exactly what a row created before this migration looked like —
      // real plaintext, no hash, no encrypted blob.
      const created = await encRepo.insertHold({
        id: 'booking-legacy-1', reference: 'BKT-2026-LEGACY1', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'legacy-cancel-token', operatorToken: 'legacy-operator-token',
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });
      await db.prepare(
        `UPDATE bookings SET cancel_token = ?, cancel_token_hash = NULL, cancel_token_enc = NULL,
           operator_token = ?, operator_token_hash = NULL, operator_token_enc = NULL
         WHERE id = ?`,
      ).bind('legacy-cancel-token', 'legacy-operator-token', created.id).run();

      const first = await encRepo.getBookingByCancelToken('legacy-cancel-token', '2026-07-21T10:00:00.000Z');
      expect(first).toMatchObject({ id: created.id, cancelToken: 'legacy-cancel-token' });

      const backfilled = (await db.prepare(
        'SELECT cancel_token, cancel_token_hash, cancel_token_enc FROM bookings WHERE id = ?',
      ).bind(created.id).all<{ cancel_token: string; cancel_token_hash: string; cancel_token_enc: string | null }>()).results[0];
      expect(backfilled?.cancel_token_hash).toBeTruthy();
      expect(backfilled?.cancel_token).not.toBe('legacy-cancel-token');
      expect(backfilled?.cancel_token_enc).toBeTruthy(); // backfill also encrypts, so future reads keep regenerating a working link

      // Second lookup now resolves through the hash path (decrypting cancel_token_enc) and still authenticates.
      await expect(encRepo.getBookingByCancelToken('legacy-cancel-token', '2026-07-21T10:00:01.000Z')).resolves.toMatchObject({ id: created.id, cancelToken: 'legacy-cancel-token' });
    });

    // migration 0009's retroactive UPDATE never had a real row to act on when it ran here (the
    // harness migrates an empty database) — this re-runs that exact statement against
    // hand-crafted rows shaped like they'd have looked immediately before 0009 ran.
    it("re-running migration 0009's retroactive UPDATE revokes an already-terminal (cancelled/no_show) legacy row's customer token, while leaving its operator token usable", async () => {
      await db.prepare(
        `INSERT INTO bookings (
           id, reference, service_slug, quantity, pickup_type, starts_at, ends_at, locale, price_minor, currency,
           status, cancel_token, operator_token, cancelled_at, cancelled_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'booking-legacy-terminal-1', 'BKT-2026-LEGTERM1', 'vintage', 2, 'default',
        '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'eur',
        'cancelled', 'legacy-terminal-cancel-token', 'legacy-terminal-operator-token',
        '2026-07-20T09:00:00.000Z', 'customer', '2026-07-20T09:00:00.000Z', '2026-07-20T09:00:00.000Z',
      ).run();
      // no_show has no cancelled_at, exercising the COALESCE(cancelled_at, updated_at) fallback.
      await db.prepare(
        `INSERT INTO bookings (
           id, reference, service_slug, quantity, pickup_type, starts_at, ends_at, locale, price_minor, currency,
           status, cancel_token, operator_token, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'booking-legacy-terminal-2', 'BKT-2026-LEGTERM2', 'vintage', 2, 'default',
        '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'eur',
        'no_show', 'legacy-terminal-cancel-token-2', 'legacy-terminal-operator-token-2',
        '2026-07-20T09:00:00.000Z', '2026-07-20T09:30:00.000Z',
      ).run();
      // A non-terminal legacy row must NOT be retroactively revoked.
      await db.prepare(
        `INSERT INTO bookings (
           id, reference, service_slug, quantity, pickup_type, starts_at, ends_at, locale, price_minor, currency,
           status, cancel_token, operator_token, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'booking-legacy-active-1', 'BKT-2026-LEGACT1', 'vintage', 2, 'default',
        '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'eur',
        'confirmed', 'legacy-active-cancel-token', 'legacy-active-operator-token',
        '2026-07-20T09:00:00.000Z', '2026-07-20T09:00:00.000Z',
      ).run();

      // The exact statement migrations/0009_token_hashing.sql runs after its ADD COLUMN block.
      await db.prepare(
        `UPDATE bookings SET cancel_token_revoked_at = COALESCE(cancelled_at, updated_at) WHERE status IN ('cancelled','no_show')`,
      ).run();

      const now = '2026-07-21T10:00:00.000Z';
      await expect(repo.getBookingByCancelToken('legacy-terminal-cancel-token', now)).resolves.toBeNull();
      await expect(repo.getBookingByCancelToken('legacy-terminal-cancel-token-2', now)).resolves.toBeNull();
      await expect(repo.getBookingByOperatorToken('legacy-terminal-operator-token', now)).resolves.toMatchObject({ id: 'booking-legacy-terminal-1' });
      await expect(repo.getBookingByOperatorToken('legacy-terminal-operator-token-2', now)).resolves.toMatchObject({ id: 'booking-legacy-terminal-2' });
      // Control: an active (non-terminal) legacy row's customer token is untouched.
      await expect(repo.getBookingByCancelToken('legacy-active-cancel-token', now)).resolves.toMatchObject({ id: 'booking-legacy-active-1' });
    });

    // tokens_expire_at must move with the booking on reschedule —
    // otherwise a booking moved later could have its manage link expire before the rescheduled
    // service, and one moved earlier would keep an over-long window relative to its new end.
    it('rescheduleWithCapacity moves tokens_expire_at to (new endsAt + tokenExpiryDays) on both a later and an earlier reschedule, and leaves it untouched when the caller omits it', async () => {
      const created = await repo.insertHoldWithCapacity({
        id: 'booking-reschedule-expiry-1', reference: 'BKT-2026-RESCHEXP1', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'resched-exp-cancel-1', operatorToken: 'resched-exp-operator-1',
        tokensExpireAt: '2026-08-11T10:00:00.000Z',
        occupancyUnits: 1, occupancyEndsAt: '2026-08-01T10:00:00.000Z', localDate: '2026-08-01', defaultCapacity: 5,
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });
      expect(created).not.toBeNull();
      await repo.transitionToConfirmed(created!.id, { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
      const readExpiry = async () => (await db.prepare('SELECT tokens_expire_at FROM bookings WHERE id = ?').bind(created!.id).all<{ tokens_expire_at: string }>()).results[0]?.tokens_expire_at;

      // Later: new end (11:00) is an hour past the original (10:00).
      const laterExpiry = '2026-08-11T11:00:00.000Z';
      const later = await repo.rescheduleWithCapacity(created!.id, {
        expectedStatus: 'confirmed', expectedStartsAt: '2026-08-01T09:00:00.000Z',
        startsAt: '2026-08-01T10:00:00.000Z', endsAt: '2026-08-01T11:00:00.000Z',
        rescheduledFrom: '2026-08-01T09:00:00.000Z', updatedAt: '2026-07-21T10:02:00.000Z', now: '2026-07-21T10:02:00.000Z',
        tokensExpireAt: laterExpiry,
        occupancyUnits: 1, occupancyEndsAt: '2026-08-01T11:00:00.000Z', localDate: '2026-08-01', defaultCapacity: 5,
      });
      expect(later).not.toBeNull();
      await expect(readExpiry()).resolves.toBe(laterExpiry);

      // Earlier: new end (09:30) is before the previous new end (11:00) computed above.
      const earlierExpiry = '2026-08-09T09:30:00.000Z';
      const earlier = await repo.rescheduleWithCapacity(created!.id, {
        expectedStatus: 'confirmed', expectedStartsAt: '2026-08-01T10:00:00.000Z',
        startsAt: '2026-08-01T08:30:00.000Z', endsAt: '2026-08-01T09:30:00.000Z',
        rescheduledFrom: '2026-08-01T10:00:00.000Z', updatedAt: '2026-07-21T10:03:00.000Z', now: '2026-07-21T10:03:00.000Z',
        tokensExpireAt: earlierExpiry,
        occupancyUnits: 1, occupancyEndsAt: '2026-08-01T09:30:00.000Z', localDate: '2026-08-01', defaultCapacity: 5,
      });
      expect(earlier).not.toBeNull();
      await expect(readExpiry()).resolves.toBe(earlierExpiry);

      // Omitted: a caller that doesn't pass tokensExpireAt leaves the column untouched (COALESCE
      // falls through to the existing value) rather than clobbering it to NULL.
      const untouched = await repo.rescheduleWithCapacity(created!.id, {
        expectedStatus: 'confirmed', expectedStartsAt: '2026-08-01T08:30:00.000Z',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z',
        rescheduledFrom: '2026-08-01T08:30:00.000Z', updatedAt: '2026-07-21T10:04:00.000Z', now: '2026-07-21T10:04:00.000Z',
        occupancyUnits: 1, occupancyEndsAt: '2026-08-01T10:00:00.000Z', localDate: '2026-08-01', defaultCapacity: 5,
      });
      expect(untouched).not.toBeNull();
      await expect(readExpiry()).resolves.toBe(earlierExpiry);
    });

    // Strengthens the dump-non-usability property beyond the cancel-token-only,
    // hash-only checks above — for BOTH token families, every stored representation (hash,
    // placeholder, ciphertext) must be rejected by BOTH lookup methods, not just its "own" one.
    it('a dumped row never authenticates via its own hash, placeholder, or encrypted blob — for either token family, against either lookup method', async () => {
      const created = await encRepo.insertHold({
        id: 'booking-dump-1', reference: 'BKT-2026-DUMP1', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'dump-cancel-token', operatorToken: 'dump-operator-token',
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });
      const row = (await db.prepare(
        `SELECT cancel_token, cancel_token_hash, cancel_token_enc, operator_token, operator_token_hash, operator_token_enc
         FROM bookings WHERE id = ?`,
      ).bind(created.id).all<{
        cancel_token: string; cancel_token_hash: string; cancel_token_enc: string;
        operator_token: string; operator_token_hash: string; operator_token_enc: string;
      }>()).results[0]!;

      // Neither legacy plaintext column holds a real token — this holds for BOTH families, not
      // just the customer one the earlier tests in this file already cover.
      expect(row.cancel_token).not.toBe('dump-cancel-token');
      expect(row.operator_token).not.toBe('dump-operator-token');

      const now = '2026-07-21T10:00:00.000Z';
      const dumpedValues = [
        row.cancel_token_hash, row.cancel_token, row.cancel_token_enc,
        row.operator_token_hash, row.operator_token, row.operator_token_enc,
      ];
      for (const value of dumpedValues) {
        await expect(encRepo.getBookingByCancelToken(value, now)).resolves.toBeNull();
        await expect(encRepo.getBookingByOperatorToken(value, now)).resolves.toBeNull();
      }
    });

    it('fails closed (falls back to the placeholder, never throws or leaks a wrong value) when decrypting a corrupted or foreign-key-encrypted token blob', async () => {
      const created = await encRepo.insertHold({
        id: 'booking-corrupt-1', reference: 'BKT-2026-CORRUPT1', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'corrupt-cancel-token', operatorToken: 'corrupt-operator-token',
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });
      const original = (await db.prepare(
        'SELECT cancel_token, cancel_token_enc FROM bookings WHERE id = ?',
      ).bind(created.id).all<{ cancel_token: string; cancel_token_enc: string }>()).results[0]!;

      // Corrupt/tampered: flip the last character of the stored ciphertext blob (still valid
      // base64url, so this exercises AES-GCM's auth-tag rejection, not a decode error).
      const tampered = original.cancel_token_enc.slice(0, -1) + (original.cancel_token_enc.at(-1) === 'A' ? 'B' : 'A');
      await db.prepare('UPDATE bookings SET cancel_token_enc = ? WHERE id = ?').bind(tampered, created.id).run();
      const corruptRead = await encRepo.getBookingById(created.id);
      expect(corruptRead).not.toBeNull();
      // Decrypt failed closed -> hydrateBooking never overrides mapBooking's default, so the
      // returned token is exactly the (placeholder) legacy column value, never the real token and
      // never garbage decrypted bytes.
      expect(corruptRead!.cancelToken).not.toBe('corrupt-cancel-token');
      expect(corruptRead!.cancelToken).toBe(original.cancel_token);

      // Foreign-key: restore the untouched ciphertext, then read the SAME row through a DIFFERENT
      // repository instance configured with a different RESERVA_TOKEN_ENC_KEY. AES-GCM's auth tag
      // rejects it just as decisively as a tampered blob.
      await db.prepare('UPDATE bookings SET cancel_token_enc = ? WHERE id = ?').bind(original.cancel_token_enc, created.id).run();
      const wrongKeyRepo = createBookingRepository(db, (name) => (name === 'RESERVA_TOKEN_ENC_KEY' ? 'a-totally-different-secret' : undefined));
      const foreignRead = await wrongKeyRepo.getBookingById(created.id);
      expect(foreignRead).not.toBeNull();
      expect(foreignRead!.cancelToken).not.toBe('corrupt-cancel-token');
      expect(foreignRead!.cancelToken).toBe(original.cancel_token);
    });
  });
});

describe('mutation side-effect outbox on real D1', () => {
  async function seedBooking(id: string): Promise<void> {
    await repo.insertHold({
      id, reference: `BKT-2026-${id}`, serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: `cancel-${id}`, operatorToken: `operator-${id}`,
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });
  }

  it('fences a stale resolver token after a mutation-side-effect reclaim', async () => {
    await seedBooking('mutation-stale-lease');
    const identity: SideEffectOperationIdentity = { family: 'email', event: 'booking.no_show' };
    const oldClaimedAt = '2026-07-21T08:00:00.000Z';
    await db.prepare(
      `INSERT INTO side_effect_operations (
         booking_id, family, name, event, discriminator, event_payload_json,
         status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
       ) VALUES (?, 'email', NULL, ?, NULL, NULL, 'in_flight', NULL, 1, ?, NULL, NULL, ?, ?)`,
    ).bind('mutation-stale-lease', identity.event, oldClaimedAt, oldClaimedAt, oldClaimedAt).run();

    const reclaimedAt = '2026-07-21T08:06:00.000Z';
    await expect(repo.claimMutationSideEffectOperation('mutation-stale-lease', identity, reclaimedAt)).resolves.toBe(2);
    await expect(repo.resolveMutationSideEffectOperation({
      bookingId: 'mutation-stale-lease', identity, status: 'failed', claimedAt: oldClaimedAt,
      error: 'late original worker', resolvedAt: '2026-07-21T08:06:01.000Z',
    })).resolves.toBe(false);
    await expect(repo.claimMutationSideEffectOperation('mutation-stale-lease', identity, '2026-07-21T08:07:00.000Z')).resolves.toBeNull();
    await expect(repo.resolveMutationSideEffectOperation({
      bookingId: 'mutation-stale-lease', identity, status: 'succeeded', claimedAt: reclaimedAt,
      resolvedAt: '2026-07-21T08:07:00.000Z',
    })).resolves.toBe(true);
    await expect(repo.listSideEffectOperations('mutation-stale-lease')).resolves.toEqual([
      expect.objectContaining({ ...identity, name: null, status: 'succeeded', attemptCount: 2, attemptedAt: reclaimedAt }),
    ]);
  });

  it('reclaims a stale in-flight operation through the mutation drain', async () => {
    await seedBooking('mutation-stale-drain');
    const identity: SideEffectOperationIdentity = { family: 'email', event: 'booking.no_show' };
    await db.prepare(
      `INSERT INTO side_effect_operations (
         booking_id, family, name, event, discriminator, event_payload_json,
         status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
       ) VALUES (?, 'email', NULL, ?, NULL, NULL, 'in_flight', NULL, 1, ?, NULL, NULL, ?, ?)`,
    ).bind('mutation-stale-drain', identity.event, '2026-07-21T08:00:00.000Z', '2026-07-21T08:00:00.000Z', '2026-07-21T08:00:00.000Z').run();
    const current = await repo.getBookingById('mutation-stale-drain');
    if (!current) throw new Error('seed booking missing');
    let sends = 0;
    const context = createReservaContext({
      config, db, repo, clock: () => new Date('2026-07-21T08:06:00.000Z'),
      providers: providers({ email: { send: async () => { sends += 1; } } }),
    });

    await runOwedMutationSideEffects(context, current);
    expect(sends).toBe(1);
    await expect(repo.listSideEffectOperations(current.id)).resolves.toEqual([
      expect.objectContaining({ ...identity, name: null, status: 'succeeded', attemptCount: 2 }),
    ]);
  });

  it('records outbox rows only for the winning rescheduleWithCapacity CAS on real D1', async () => {
    await seedBooking('mutation-reschedule');
    await repo.transitionToConfirmed('mutation-reschedule', {
      expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z',
    });
    const original = await repo.getBookingById('mutation-reschedule');
    if (!original) throw new Error('seed booking missing');
    // Capacity is ample, so the loser can only lose its stale expectedStartsAt CAS.
    const common = {
      expectedStatus: 'confirmed' as const, expectedStartsAt: original.startsAt,
      rescheduledFrom: original.startsAt, updatedAt: '2026-07-21T10:02:00.000Z', now: '2026-07-21T10:02:00.000Z',
      occupancyUnits: 1, defaultCapacity: 10,
      mutationSideEffects: [{
        family: 'email', event: 'booking.rescheduled', eventPayloadJson: null, eventIdPrefix: null,
      }] satisfies SideEffectOperationSeed[],
    };

    const winner = await repo.rescheduleWithCapacity(original.id, {
      ...common, startsAt: '2026-08-02T09:00:00.000Z', endsAt: '2026-08-02T10:00:00.000Z',
      occupancyEndsAt: '2026-08-02T10:00:00.000Z', localDate: '2026-08-02',
    });
    const loser = await repo.rescheduleWithCapacity(original.id, {
      ...common, startsAt: '2026-08-03T09:00:00.000Z', endsAt: '2026-08-03T10:00:00.000Z',
      occupancyEndsAt: '2026-08-03T10:00:00.000Z', localDate: '2026-08-03',
    });

    expect(winner).toMatchObject({ startsAt: '2026-08-02T09:00:00.000Z' });
    expect(loser).toBeNull();
    await expect(repo.listSideEffectOperations(original.id)).resolves.toEqual([
      expect.objectContaining({ family: 'email', event: 'booking.rescheduled', discriminator: '1', status: 'pending' }),
    ]);
  });

  it('rolls back a cancellation when its atomically-batched outbox insert fails', async () => {
    await seedBooking('mutation-atomic');
    await repo.transitionToConfirmed('mutation-atomic', { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
    await db.prepare(`CREATE TRIGGER fail_mutation_outbox
      BEFORE INSERT ON side_effect_operations
      BEGIN SELECT RAISE(ABORT, 'mutation outbox insert failed'); END`).run();

    await expect(repo.transitionToCancelled('mutation-atomic', {
      expectedStatusIn: ['confirmed'], cancelledAt: '2026-07-21T10:02:00.000Z', cancelledBy: 'operator',
      updatedAt: '2026-07-21T10:02:00.000Z',
      mutationSideEffects: [{ family: 'email', event: 'booking.cancelled_by_operator', eventPayloadJson: null, eventIdPrefix: null }],
    })).rejects.toThrow('mutation outbox insert failed');
    await expect(repo.getBookingById('mutation-atomic')).resolves.toMatchObject({ status: 'confirmed' });
    await db.prepare('DROP TRIGGER fail_mutation_outbox').run();
  });

  it('records a pending outbox row only for the winning no-show CAS', async () => {
    await seedBooking('mutation-no-show');
    await repo.transitionToConfirmed('mutation-no-show', { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
    const input: Parameters<typeof repo.transitionToNoShow>[1] = {
      expectedStatusIn: ['confirmed'], updatedAt: '2026-07-21T10:02:00.000Z',
      mutationSideEffects: [{ family: 'email', event: 'booking.no_show', eventPayloadJson: null, eventIdPrefix: null }],
    };

    await expect(repo.transitionToNoShow('mutation-no-show', input)).resolves.toMatchObject({ status: 'no_show' });
    await expect(repo.transitionToNoShow('mutation-no-show', input)).resolves.toBeNull();
    await expect(repo.listSideEffectOperations('mutation-no-show')).resolves.toEqual([
      expect.objectContaining({ family: 'email', event: 'booking.no_show', status: 'pending' }),
    ]);
  });

});
