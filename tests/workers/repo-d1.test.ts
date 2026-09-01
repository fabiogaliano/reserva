import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runOwedMutationSideEffects } from '../../src/confirmation';
import { createReservaContext } from '../../src/context';
import { createBookingRepository, HoldLimitExceededError, type SideEffectOperationIdentity, type SideEffectOperationSeed } from '../../src/repo';
import { config } from '../fixtures';
import { providers } from '../fakes';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
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
      holdIp: '203.0.113.1',
      maxActiveHoldsForIp: 1,
      createdAt: '2026-07-21T10:00:00.000Z',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });

    await expect(repo.insertHold({
      id: 'booking-over-limit',
      reference: 'BKT-2026-003',
      serviceSlug: 'vintage',
      quantity: 1,
      pickupType: 'default',
      startsAt: '2026-08-01T13:00:00.000Z',
      endsAt: '2026-08-01T14:00:00.000Z',
      locale: 'en',
      priceMinor: 12000,
      currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z',
      cancelToken: 'cancel-token-over-limit',
      operatorToken: 'operator-token-over-limit',
      holdIp: '203.0.113.1',
      maxActiveHoldsForIp: 1,
      createdAt: '2026-07-21T10:00:01.000Z',
      updatedAt: '2026-07-21T10:00:01.000Z',
    })).rejects.toBeInstanceOf(HoldLimitExceededError);

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

  // Proves the optional subscriber row shares confirmWithSideEffectOperations' one D1
  // batch just like calendar_create/email_confirmation above — a failure inserting ONLY the
  // hook row (the other two rows would insert cleanly on their own) must still roll back the
  // whole batch, leaving the booking unconfirmed and no partial rows behind.
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

  // Proves the split confirmation-path email rows share confirmWithSideEffectOperations'
  // one D1 batch too — a failure inserting just the owner recipient's row (the customer row and
  // calendar_create would insert cleanly on their own) must still roll back the whole batch,
  // leaving the booking unconfirmed and no partial rows behind.
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

  it('persists capacity overrides', async () => {
    await repo.upsertDayOverride('2026-08-01', 1, 'reduced capacity');
    await expect(repo.getDayOverride('2026-08-01')).resolves.toEqual({
      date: '2026-08-01',
      capacity: 1,
      reason: 'reduced capacity',
    });
    await repo.deleteDayOverride('2026-08-01');
    await expect(repo.getDayOverride('2026-08-01')).resolves.toBeNull();
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

  // Migration 0015 removed the pickup_type CHECK (domain moved to
  // config-declared option ids, ServiceConfig.pickupOptions) -- this is the row the old CHECK
  // (pickup_type IN ('default','custom')) would have rejected, round-tripped through the real
  // application write/read paths, not just a raw SQL INSERT (see tests/workers/schema-constraints.test.ts
  // for the SQL-layer proof).
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

  // Migration 0018 makes pickup_type nullable so the
  // location-less service can store "no pickup at all" as NULL rather than a sentinel id. The
  // read-time floor must let NULL through untouched (it is a declared state, not a corrupt row),
  // which is the one case the empty-string rejection above must NOT be widened to cover.
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

  describe('token hashing, expiry, and revocation (BK-SEC-002)', () => {
    // A second repository instance bound to the SAME D1 database but with RESERVA_TOKEN_ENC_KEY
    // configured, so these tests can exercise the full "encrypt at insert, decrypt at read" round
    // trip that lets a later DB-loaded read (a confirmation email, the admin dashboard) regenerate
    // a working manage link — see migrations/0009_token_hashing.sql for why that's needed at all.
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
      // the real plaintext again (decrypted from cancel_token_enc/operator_token_enc) — this is
      // what lets a later DB-loaded read (confirmation email, admin dashboard) regenerate a
      // working link without D1 ever having stored that plaintext at rest.
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

    // migrations/0009_token_hashing.sql's ADD COLUMN statements alone leave
    // cancel_token_revoked_at NULL on every pre-existing row regardless of status, so a booking
    // that was ALREADY cancelled/no_show before this migration ran would otherwise keep a live
    // customer manage link forever (null hash -> the compat fallback in getBookingByCancelToken
    // just keeps matching the original plaintext cancel_token). The fix is a retroactive
    // `UPDATE ... WHERE status IN ('cancelled','no_show')` appended to the same migration. The
    // vitest-pool-workers harness applies every migration to an EMPTY database before any test
    // row exists, so 0009's own retroactive UPDATE never had a real row to act on when it
    // actually ran here — this test re-runs that exact statement (copied verbatim from the
    // migration) against hand-crafted rows shaped exactly like they'd have looked immediately
    // before 0009 ran, to prove the statement's logic is correct.
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

    // tokens_expire_at must move with the booking on reschedule (both
    // repo entry points — rescheduleWithCapacity, the one src/handlers/index.ts actually calls,
    // and transitionReschedule, exercised directly by tests/workers/repo-cas-transitions.test.ts)
    // — otherwise a booking moved later could have its manage link expire before the rescheduled
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

    it('transitionReschedule also moves tokens_expire_at to the caller-supplied value, and leaves it untouched when omitted', async () => {
      const created = await repo.insertHold({
        id: 'booking-reschedule-expiry-2', reference: 'BKT-2026-RESCHEXP2', serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
        startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
        holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: 'plain-resched-cancel', operatorToken: 'plain-resched-operator',
        tokensExpireAt: '2026-08-11T10:00:00.000Z',
        createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
      });
      await repo.transitionToConfirmed(created.id, { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
      const readExpiry = async () => (await db.prepare('SELECT tokens_expire_at FROM bookings WHERE id = ?').bind(created.id).all<{ tokens_expire_at: string }>()).results[0]?.tokens_expire_at;

      const newExpiry = '2026-08-12T11:00:00.000Z';
      const moved = await repo.transitionReschedule(created.id, {
        expectedStatus: 'confirmed', expectedStartsAt: '2026-08-01T09:00:00.000Z',
        startsAt: '2026-08-01T10:00:00.000Z', endsAt: '2026-08-01T11:00:00.000Z',
        rescheduledFrom: '2026-08-01T09:00:00.000Z', updatedAt: '2026-07-21T10:02:00.000Z',
        tokensExpireAt: newExpiry,
      });
      expect(moved).not.toBeNull();
      await expect(readExpiry()).resolves.toBe(newExpiry);

      const untouched = await repo.transitionReschedule(created.id, {
        expectedStatus: 'confirmed', expectedStartsAt: '2026-08-01T10:00:00.000Z',
        startsAt: '2026-08-01T11:00:00.000Z', endsAt: '2026-08-01T12:00:00.000Z',
        rescheduledFrom: '2026-08-01T10:00:00.000Z', updatedAt: '2026-07-21T10:03:00.000Z',
      });
      expect(untouched).not.toBeNull();
      await expect(readExpiry()).resolves.toBe(newExpiry);
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

  it('records outbox rows only for the winning transitionReschedule CAS on real D1', async () => {
    await seedBooking('mutation-transition-reschedule');
    await repo.transitionToConfirmed('mutation-transition-reschedule', {
      expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z',
    });
    const original = await repo.getBookingById('mutation-transition-reschedule');
    if (!original) throw new Error('seed booking missing');
    const common = {
      expectedStatus: 'confirmed' as const, expectedStartsAt: original.startsAt,
      rescheduledFrom: original.startsAt, updatedAt: '2026-07-21T10:02:00.000Z',
      mutationSideEffects: [{
        family: 'email', event: 'booking.rescheduled', eventPayloadJson: null, eventIdPrefix: null,
      }] satisfies SideEffectOperationSeed[],
    };

    const winner = await repo.transitionReschedule(original.id, {
      ...common, startsAt: '2026-08-02T09:00:00.000Z', endsAt: '2026-08-02T10:00:00.000Z',
    });
    const loser = await repo.transitionReschedule(original.id, {
      ...common, startsAt: '2026-08-03T09:00:00.000Z', endsAt: '2026-08-03T10:00:00.000Z',
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

  // repo.insertHold now always writes meeting_point_id/-label
  // (migration 0014), so it cannot seed the FK-parent booking rows below against this test's
  // deliberately pre-0010 schema. Only these FK-parent rows need to exist at all (nothing here
  // asserts on their own columns) -- a raw INSERT covering just the columns 0001_init.sql
  // guarantees NOT NULL, present since before every migration this suite ever slices before,
  // decouples this historical-schema test from the CURRENT repo.ts column list going forward.
  async function seedRawBookingForFk(id: string): Promise<void> {
    await db.prepare(
      `INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at)
       VALUES (?, ?, 'vintage', 2, 'default', '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'hold', ?, ?, '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z')`,
    ).bind(id, `BKT-2026-${id}`, `cancel-${id}`, `operator-${id}`).run();
  }

  it('applies the actual 0010 migration while preserving every legacy outbox row', async () => {
    for (const table of [
      'side_effect_operations', 'refund_operations', 'settings', 'capacity_defaults', 'day_overrides', 'bookings',
      'd1_migrations_0010_test', 'd1_migrations',
    ]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === '0010_mutation_side_effect_outbox.sql');
    if (migrationIndex < 0) throw new Error('0010 migration missing from TEST_MIGRATIONS');
    const migration0010 = bindings.TEST_MIGRATIONS[migrationIndex];
    if (!migration0010) throw new Error('0010 migration missing from TEST_MIGRATIONS');
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, migrationIndex), 'd1_migrations_0010_test');

    const legacyKinds = ['calendar_create', 'email_confirmation', 'oversell'];
    const statuses = ['pending', 'in_flight', 'succeeded', 'failed'];
    const seeded: Array<{ bookingId: string; kind: string; status: string; providerResultId: string | null; attemptCount: number; attemptedAt: string | null; resolvedAt: string | null; error: string | null; createdAt: string; updatedAt: string }> = [];
    for (const [kindIndex, kind] of legacyKinds.entries()) {
      for (const [statusIndex, status] of statuses.entries()) {
        const bookingId = `migration-${kindIndex}-${statusIndex}`;
        const stamp = `2026-07-21T10:0${kindIndex}${statusIndex}:00.000Z`;
        await seedRawBookingForFk(bookingId);
        const row = {
          bookingId, kind, status,
          providerResultId: status === 'succeeded' ? `provider-${kindIndex}-${statusIndex}` : null,
          attemptCount: statusIndex,
          attemptedAt: status === 'pending' ? null : stamp,
          resolvedAt: status === 'succeeded' || status === 'failed' ? stamp : null,
          error: status === 'failed' ? `error-${kindIndex}-${statusIndex}` : null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        seeded.push(row);
        await db.prepare(
          `INSERT INTO side_effect_operations (
             booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.bookingId, row.kind, row.status, row.providerResultId, row.attemptCount, row.attemptedAt,
          row.resolvedAt, row.error, row.createdAt, row.updatedAt,
        ).run();
      }
    }

    await applyD1Migrations(db, [migration0010], 'd1_migrations_0010_test');

    const preserved = await db.prepare(
      `SELECT booking_id AS bookingId, kind, status, provider_result_id AS providerResultId, attempt_count AS attemptCount,
         attempted_at AS attemptedAt, resolved_at AS resolvedAt, error, created_at AS createdAt, updated_at AS updatedAt
       FROM side_effect_operations WHERE booking_id LIKE 'migration-%' ORDER BY booking_id, kind`,
    ).all<typeof seeded[number]>();
    expect(preserved.results).toEqual([...seeded].sort((a, b) => a.bookingId.localeCompare(b.bookingId) || a.kind.localeCompare(b.kind)));

    await expect(db.prepare(
      `INSERT INTO side_effect_operations (booking_id, kind, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
    ).bind('migration-0-0', 'email:booking.no_show:customer', '2026-07-21T11:00:00.000Z', '2026-07-21T11:00:00.000Z').run()).resolves.toBeDefined();
    await expect(db.prepare(
      `INSERT INTO side_effect_operations (booking_id, kind, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
    ).bind('migration-0-1', 'tourflow:booking.rescheduled:123-456', '2026-07-21T11:00:00.000Z', '2026-07-21T11:00:00.000Z').run()).resolves.toBeDefined();
    await expect(db.prepare(
      `INSERT INTO side_effect_operations (booking_id, kind, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
    ).bind('migration-0-2', 'not-an-operation', '2026-07-21T11:00:00.000Z', '2026-07-21T11:00:00.000Z').run()).rejects.toThrow();
    await expect(db.prepare(
      `INSERT INTO side_effect_operations (booking_id, kind, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
    ).bind('migration-0-0', 'email:booking.no_show:customer', '2026-07-21T11:00:00.000Z', '2026-07-21T11:00:00.000Z').run()).rejects.toThrow();
    await expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_side_effect_operations_pending'`,
    ).all<{ name: string }>()).resolves.toMatchObject({ results: [{ name: 'idx_side_effect_operations_pending' }] });
  });
});
