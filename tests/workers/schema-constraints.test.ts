// BK-SCHEMA-001 (handoff 12): proves migrations/0011_schema_constraints.sql's rebuild against real
// D1 (SQLite) -- the fake in-memory repo (tests/fakes.ts) has no schema at all, so it cannot prove
// any of this. Three concerns, three describe blocks: (1) the new CHECK constraints/partial unique
// index reject invalid rows at the DB layer, (2) a second booking cannot silently steal an
// already-used payment_ref through the real application write paths, (3) the rebuild
// itself is lossless -- every one of the 42 physical bookings columns survives migration 0011
// unchanged, which is the column-drop safety net for a migration that recreates the whole table.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository, DuplicatePaymentRefError } from '../../src/repo';

interface TestEnv {
  BOOKKIT_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.BOOKKIT_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM capacity_defaults').run();
});

// A minimal, always-valid row satisfying every NOT NULL/UNIQUE column, so each rejection-matrix
// test only needs to override the one field it's testing. Raw SQL (not the repo layer) is
// deliberate: this proves the SCHEMA itself rejects the row, independent of any application-level
// validation that might also happen to catch it.
const validBooking = {
  id: 'raw-valid', reference: 'BKT-RAW-VALID', service_slug: 'vintage', quantity: 2, pickup_type: 'default',
  starts_at: '2026-08-01T09:00:00.000Z', ends_at: '2026-08-01T10:00:00.000Z', locale: 'en',
  price_minor: 12000, currency: 'eur', status: 'hold', cancel_token: 'raw-valid-cancel', operator_token: 'raw-valid-operator',
  created_at: '2026-07-21T10:00:00.000Z', updated_at: '2026-07-21T10:00:00.000Z',
} as const;

function insertRawBooking(overrides: Record<string, unknown>) {
  const row: Record<string, unknown> = { ...validBooking, ...overrides };
  const columns = Object.keys(row);
  return db.prepare(`INSERT INTO bookings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .bind(...columns.map((column) => row[column])).run();
}

describe('bookings CHECK constraints and partial unique index (BK-SCHEMA-001, migration 0011)', () => {
  it('rejects quantity = 0', async () => {
    await expect(insertRawBooking({
      id: 'quantity-0', reference: 'BKT-PEOPLE-0', cancel_token: 'ct-quantity-0', operator_token: 'ot-quantity-0', quantity: 0,
    })).rejects.toThrow();
  });

  it('rejects quantity = -1', async () => {
    await expect(insertRawBooking({
      id: 'quantity-neg1', reference: 'BKT-PEOPLE-NEG1', cancel_token: 'ct-quantity-neg1', operator_token: 'ot-quantity-neg1', quantity: -1,
    })).rejects.toThrow();
  });

  it('rejects price_minor = -1', async () => {
    await expect(insertRawBooking({
      id: 'price-neg1', reference: 'BKT-PRICE-NEG1', cancel_token: 'ct-price-neg1', operator_token: 'ot-price-neg1', price_minor: -1,
    })).rejects.toThrow();
  });

  it('rejects ends_at equal to starts_at', async () => {
    await expect(insertRawBooking({
      id: 'ends-eq', reference: 'BKT-ENDS-EQ', cancel_token: 'ct-ends-eq', operator_token: 'ot-ends-eq',
      ends_at: validBooking.starts_at,
    })).rejects.toThrow();
  });

  it('rejects ends_at before starts_at', async () => {
    await expect(insertRawBooking({
      id: 'ends-before', reference: 'BKT-ENDS-BEFORE', cancel_token: 'ct-ends-before', operator_token: 'ot-ends-before',
      ends_at: '2026-08-01T08:00:00.000Z',
    })).rejects.toThrow();
  });

  it.each(['calendar_synced', 'email_synced', 'tourflow_synced'] as const)('rejects %s = 2', async (column) => {
    await expect(insertRawBooking({
      id: `sync-${column}`, reference: `BKT-SYNC-${column}`, cancel_token: `ct-sync-${column}`, operator_token: `ot-sync-${column}`,
      [column]: 2,
    })).rejects.toThrow();
  });

  it('rejects a duplicate payment_ref across two bookings (idx_bookings_payment_ref)', async () => {
    await insertRawBooking({
      id: 'pi-1', reference: 'BKT-PI-1', cancel_token: 'ct-pi-1', operator_token: 'ot-pi-1', payment_ref: 'pi_duplicate_test',
    });
    await expect(insertRawBooking({
      id: 'pi-2', reference: 'BKT-PI-2', cancel_token: 'ct-pi-2', operator_token: 'ot-pi-2', payment_ref: 'pi_duplicate_test',
    })).rejects.toThrow();
  });

  it('allows multiple bookings with a NULL payment_ref (the unique index is partial)', async () => {
    await insertRawBooking({ id: 'pi-null-1', reference: 'BKT-PI-NULL-1', cancel_token: 'ct-pi-null-1', operator_token: 'ot-pi-null-1' });
    await expect(insertRawBooking({
      id: 'pi-null-2', reference: 'BKT-PI-NULL-2', cancel_token: 'ct-pi-null-2', operator_token: 'ot-pi-null-2',
    })).resolves.toBeDefined();
  });

  it('still accepts a fully valid row (control -- the matrix above is testing the CHECKs, not breaking normal inserts)', async () => {
    await expect(insertRawBooking({
      id: 'control-valid', reference: 'BKT-CONTROL-VALID', cancel_token: 'ct-control-valid', operator_token: 'ot-control-valid',
    })).resolves.toBeDefined();
  });

  // Plan 018 (design decision 4/5): migration 0015 rebuilds `bookings` with the
  // CHECK (pickup_type IN ('default','custom')) removed -- the domain now lives in
  // ServiceConfig.pickupOptions (config), which the DB can't enumerate. A non-enum pickup id, which
  // this same INSERT would have rejected before 0015, must now succeed at the SQL level.
  it('accepts a non-enum pickup_type (migration 0015 removed the CHECK; the domain now lives in config)', async () => {
    await expect(insertRawBooking({
      id: 'pickup-non-enum', reference: 'BKT-PICKUP-NON-ENUM', cancel_token: 'ct-pickup-non-enum', operator_token: 'ot-pickup-non-enum',
      pickup_type: 'custom_both',
    })).resolves.toBeDefined();
  });
});

describe('capacity table CHECK constraints (migration 0011)', () => {
  it('rejects a negative capacity_defaults.capacity', async () => {
    await expect(
      db.prepare('INSERT INTO capacity_defaults (from_date, capacity, reason) VALUES (?, ?, ?)').bind('2026-08-01', -1, null).run(),
    ).rejects.toThrow();
  });

  it('rejects a negative day_overrides.capacity', async () => {
    await expect(
      db.prepare('INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)').bind('2026-08-01', -1, null).run(),
    ).rejects.toThrow();
  });

  it('allows capacity = 0 on both capacity tables (a fully closed day/period is valid)', async () => {
    await expect(
      db.prepare('INSERT INTO day_overrides (date, capacity, reason) VALUES (?, ?, ?)').bind('2026-08-01', 0, 'closed').run(),
    ).resolves.toBeDefined();
    await expect(
      db.prepare('INSERT INTO capacity_defaults (from_date, capacity, reason) VALUES (?, ?, ?)').bind('2026-08-01', 0, 'closed').run(),
    ).resolves.toBeDefined();
  });
});

describe('duplicate payment_ref surfaces a clean conflict through the real write paths, not an unhandled 500', () => {
  async function seedHold(id: string) {
    return repo.insertHold({
      id, reference: `BKT-DUPPI-${id}`, serviceSlug: 'vintage', quantity: 2, pickupType: 'default',
      startsAt: '2026-08-01T09:00:00.000Z', endsAt: '2026-08-01T10:00:00.000Z', locale: 'en', priceMinor: 12000, currency: 'eur',
      holdExpiresAt: '2026-07-21T10:35:00.000Z', cancelToken: `cancel-${id}`, operatorToken: `operator-${id}`,
      createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    });
  }

  it('confirmWithSideEffectOperations rejects a second booking claiming an already-used payment intent, and leaves it unadvanced', async () => {
    const first = await seedHold('confirm-1');
    const second = await seedHold('confirm-2');
    await repo.acquireConfirmationLease(first.id, 'lease-1', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z');
    await repo.confirmWithSideEffectOperations(first.id, {
      expectedStatusIn: ['hold'], paymentRef: 'pi_shared_confirm', leaseToken: 'lease-1', oversold: false,
      updatedAt: '2026-07-21T10:01:00.000Z',
    });

    await repo.acquireConfirmationLease(second.id, 'lease-2', '2026-07-21T10:00:00.000Z', '2026-07-21T10:05:00.000Z');
    const attempt = repo.confirmWithSideEffectOperations(second.id, {
      expectedStatusIn: ['hold'], paymentRef: 'pi_shared_confirm', leaseToken: 'lease-2', oversold: false,
      updatedAt: '2026-07-21T10:02:00.000Z',
    });
    await expect(attempt).rejects.toBeInstanceOf(DuplicatePaymentRefError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'duplicate_payment_ref' });

    // The batch rolled back atomically -- the loser's status/outbox rows must not have advanced.
    await expect(repo.getBookingById(second.id)).resolves.toMatchObject({ status: 'hold' });
    await expect(repo.listSideEffectOperations(second.id)).resolves.toEqual([]);
  });

  it('applyConfirmedPaymentDetails rejects backfilling an already-confirmed booking with a payment intent already used by another booking', async () => {
    const first = await seedHold('apply-1');
    const second = await seedHold('apply-2');
    await repo.transitionToConfirmed(first.id, {
      expectedStatusIn: ['hold'], paymentRef: 'pi_shared_apply', updatedAt: '2026-07-21T10:01:00.000Z',
    });
    await repo.transitionToConfirmed(second.id, { expectedStatusIn: ['hold'], updatedAt: '2026-07-21T10:01:00.000Z' });
    await repo.acquireConfirmationLease(second.id, 'lease-apply', '2026-07-21T10:02:00.000Z', '2026-07-21T10:07:00.000Z');

    const attempt = repo.applyConfirmedPaymentDetails(
      second.id, { paymentRef: 'pi_shared_apply' }, 'lease-apply', '2026-07-21T10:03:00.000Z',
    );
    await expect(attempt).rejects.toBeInstanceOf(DuplicatePaymentRefError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'duplicate_payment_ref' });
    await expect(repo.getBookingById(second.id)).resolves.toMatchObject({ paymentRef: null });
  });

  it('the generic updateBooking also rejects a duplicate payment intent (defense in depth for any future caller)', async () => {
    const first = await seedHold('update-1');
    const second = await seedHold('update-2');
    await repo.updateBooking(first.id, { paymentRef: 'pi_shared_update', updatedAt: '2026-07-21T10:01:00.000Z' });

    const attempt = repo.updateBooking(second.id, { paymentRef: 'pi_shared_update', updatedAt: '2026-07-21T10:02:00.000Z' });
    await expect(attempt).rejects.toBeInstanceOf(DuplicatePaymentRefError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'duplicate_payment_ref' });
  });

  // MEDIUM-1 (sol review): guardDuplicatePaymentIntent used to skip reclassification via a
  // truthiness check on paymentRef, so a collision on '' (falsy but non-null, and still covered
  // by the partial index's WHERE payment_ref IS NOT NULL clause) would have bubbled up
  // as an unhandled 500 instead of a clean 409.
  it('also rejects a duplicate EMPTY-STRING payment intent, not just a truthy one', async () => {
    const first = await seedHold('empty-1');
    const second = await seedHold('empty-2');
    await repo.updateBooking(first.id, { paymentRef: '', updatedAt: '2026-07-21T10:01:00.000Z' });

    const attempt = repo.updateBooking(second.id, { paymentRef: '', updatedAt: '2026-07-21T10:02:00.000Z' });
    await expect(attempt).rejects.toBeInstanceOf(DuplicatePaymentRefError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'duplicate_payment_ref' });
  });
});

describe('migration 0011 rebuild is lossless (BK-SCHEMA-001)', () => {
  // The full 42-column physical checklist from migrations 0001 (30), 0002 (+2), 0003 (+1), 0008
  // (+2), 0009 (+6), 0010 (+1) -- see docs/tmp/handoff-audit-fixes/12-schema-constraints.md. This
  // list, not src/repo.ts's 36-column `bookingColumns` (the app-read subset), is the ground truth
  // for "did the rebuild's INSERT...SELECT drop or mismap anything" -- it deliberately includes the
  // 6 columns bookingColumns omits (confirmation_lease_token/until, hold_ip, occupancy_units/
  // ends_at, reschedule_transition_version).
  const ALL_BOOKING_COLUMNS = [
    'id', 'reference', 'tour_slug', 'people', 'pickup_type', 'pickup_address', 'starts_at', 'ends_at',
    'customer_name', 'customer_email', 'customer_phone', 'locale', 'price_cents', 'status', 'hold_expires_at',
    'stripe_session_id', 'stripe_payment_intent', 'calendar_event_id', 'calendar_synced', 'email_synced',
    'tourflow_synced', 'reminded_at', 'review_requested_at', 'cancel_token', 'operator_token', 'cancelled_at',
    'cancelled_by', 'rescheduled_from', 'created_at', 'updated_at', 'confirmation_lease_token',
    'confirmation_lease_until', 'hold_ip', 'occupancy_units', 'occupancy_ends_at', 'cancel_token_hash',
    'operator_token_hash', 'cancel_token_enc', 'operator_token_enc', 'tokens_expire_at',
    'cancel_token_revoked_at', 'reschedule_transition_version',
  ] as const;

  it('applies the real 0011 migration from TEST_MIGRATIONS and preserves every one of the 42 physical columns of a pre-seeded row, plus a real FK child row, unchanged', async () => {
    expect(ALL_BOOKING_COLUMNS).toHaveLength(42);

    for (const table of [
      'bookings_new', 'day_overrides_new', 'capacity_defaults_new',
      'side_effect_operations', 'refund_operations', 'settings', 'capacity_defaults', 'day_overrides', 'bookings',
      'd1_migrations_0011_test', 'd1_migrations',
    ]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();

    const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === '0011_schema_constraints.sql');
    if (migrationIndex < 0) throw new Error('0011 migration missing from TEST_MIGRATIONS');
    const migration0011 = bindings.TEST_MIGRATIONS[migrationIndex];
    if (!migration0011) throw new Error('0011 migration missing from TEST_MIGRATIONS');
    // Everything through 0010 -- a schema with none of 0011's new constraints yet, matching what a
    // pre-rebuild production database looks like.
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, migrationIndex), 'd1_migrations_0011_test');

    // Every one of the 42 columns set to a distinctive, non-default, non-NULL-where-possible value,
    // so a dropped or mismapped column in the rebuild's INSERT...SELECT is caught here rather than
    // silently losing data in production.
    const seeded: Record<typeof ALL_BOOKING_COLUMNS[number], string | number | null> = {
      id: 'lossless-1', reference: 'BKT-LOSSLESS-1', tour_slug: 'vintage', people: 3,
      pickup_type: 'custom', pickup_address: '123 Distinctive Ave',
      starts_at: '2026-08-01T09:00:00.000Z', ends_at: '2026-08-01T10:00:00.000Z',
      customer_name: 'Distinctive Customer', customer_email: 'distinctive@example.test', customer_phone: '+15551234567',
      locale: 'fr', price_cents: 54321, status: 'confirmed', hold_expires_at: '2026-07-21T10:35:00.000Z',
      stripe_session_id: 'cs_distinctive', stripe_payment_intent: 'pi_distinctive', calendar_event_id: 'cal_distinctive',
      calendar_synced: 1, email_synced: 1, tourflow_synced: 1,
      reminded_at: '2026-07-30T00:00:00.000Z', review_requested_at: '2026-08-02T00:00:00.000Z',
      cancel_token: 'distinctive-cancel-token', operator_token: 'distinctive-operator-token',
      cancelled_at: '2026-07-25T00:00:00.000Z', cancelled_by: 'operator', rescheduled_from: '2026-07-31T09:00:00.000Z',
      created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-21T00:00:00.000Z',
      confirmation_lease_token: 'distinctive-lease-token', confirmation_lease_until: '2026-07-21T10:05:00.000Z',
      hold_ip: '203.0.113.99',
      occupancy_units: 4, occupancy_ends_at: '2026-08-01T10:30:00.000Z',
      cancel_token_hash: 'distinctive-cancel-hash', operator_token_hash: 'distinctive-operator-hash',
      cancel_token_enc: 'distinctive-cancel-enc', operator_token_enc: 'distinctive-operator-enc',
      tokens_expire_at: '2026-09-01T00:00:00.000Z', cancel_token_revoked_at: '2026-07-26T00:00:00.000Z',
      reschedule_transition_version: 7,
    };
    await db.prepare(
      `INSERT INTO bookings (${ALL_BOOKING_COLUMNS.join(', ')}) VALUES (${ALL_BOOKING_COLUMNS.map(() => '?').join(', ')})`,
    ).bind(...ALL_BOOKING_COLUMNS.map((column) => seeded[column])).run();

    // HIGH-2 (sol review): side_effect_operations.booking_id REFERENCES bookings(id) (migrations
    // 0007, 0010), and D1 enforces foreign keys -- so DROP TABLE bookings inside 0011's rebuild
    // must not choke on a real child row. A prior version of this test masked that risk entirely
    // by dropping side_effect_operations and never seeding one; this seeds a real child row
    // instead, and the assertions below prove it (and its FK reference) survive the rebuild.
    await db.prepare(
      `INSERT INTO side_effect_operations (
         booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
       ) VALUES (?, 'calendar_create', 'pending', NULL, 0, NULL, NULL, NULL, ?, ?)`,
    ).bind('lossless-1', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z').run();

    // The actual production migration, run for real -- not a hand-copied approximation of it.
    await applyD1Migrations(db, [migration0011], 'd1_migrations_0011_test');

    const survived = (await db.prepare(
      `SELECT ${ALL_BOOKING_COLUMNS.join(', ')} FROM bookings WHERE id = ?`,
    ).bind('lossless-1').all<Record<string, unknown>>()).results[0];
    expect(survived).toBeDefined();
    for (const column of ALL_BOOKING_COLUMNS) {
      expect(survived?.[column], `column ${column} did not survive the 0011 rebuild unchanged`).toBe(seeded[column]);
    }

    // The FK child row survives the parent rebuild (DROP bookings + RENAME bookings_new -> bookings
    // preserves the referenced id), and no foreign key is left dangling anywhere in the database.
    await expect(
      db.prepare(`SELECT booking_id, kind, status FROM side_effect_operations WHERE booking_id = ?`).bind('lossless-1').all(),
    ).resolves.toMatchObject({ results: [{ booking_id: 'lossless-1', kind: 'calendar_create', status: 'pending' }] });
    await expect(db.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] });

    // The rebuild's own new constraints are live on the migrated (not freshly created) table.
    await expect(
      db.prepare('INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind('post-migrate-invalid', 'BKT-POST-MIGRATE', 'vintage', 0, 'default', '2026-08-02T09:00:00.000Z', '2026-08-02T10:00:00.000Z', 'en', 12000, 'hold', 'post-cancel', 'post-operator', '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z')
        .run(),
    ).rejects.toThrow();
    await expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bookings_payment_intent'`).all<{ name: string }>(),
    ).resolves.toMatchObject({ results: [{ name: 'idx_bookings_payment_intent' }] });
    for (const indexName of [
      'idx_bookings_window', 'idx_bookings_status_hold', 'idx_bookings_confirmation_lease',
      'idx_bookings_hold_ip', 'idx_bookings_cancel_token_hash', 'idx_bookings_operator_token_hash',
    ]) {
      await expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).bind(indexName).all<{ name: string }>(),
        `index ${indexName} missing after the 0011 rebuild`,
      ).resolves.toMatchObject({ results: [{ name: indexName }] });
    }
  });
});
