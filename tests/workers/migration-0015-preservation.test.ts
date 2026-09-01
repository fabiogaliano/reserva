// Plan 018 (design decision 4): migrations/0015_pickup_options.sql rebuilds `bookings` the same
// way 0011/0013 already do (rename -> create -> INSERT...SELECT with an explicit column list ->
// drop -> rename — see tests/workers/schema-constraints.test.ts's 0011 lossless test and
// tests/workers/migration-0013-preservation.test.ts, which this mirrors), removing ONLY the
// pickup_type CHECK while every other 0011 CHECK and the partial unique payment-intent index
// survive byte-for-byte, and 0014's meeting_point_id/meeting_point_label columns carry through.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;

// The full 44-column physical checklist post-0014: 0011's 42 (see that migration's header) plus
// 0014's meeting_point_id/meeting_point_label. Ground truth for "did 0015's INSERT...SELECT drop
// or mismap anything" -- independent of src/repo.ts's app-read column subset.
const ALL_BOOKING_COLUMNS = [
  'id', 'reference', 'tour_slug', 'people', 'pickup_type', 'pickup_address', 'starts_at', 'ends_at',
  'customer_name', 'customer_email', 'customer_phone', 'locale', 'price_cents', 'status', 'hold_expires_at',
  'stripe_session_id', 'stripe_payment_intent', 'calendar_event_id', 'calendar_synced', 'email_synced',
  'tourflow_synced', 'reminded_at', 'review_requested_at', 'cancel_token', 'operator_token', 'cancelled_at',
  'cancelled_by', 'rescheduled_from', 'created_at', 'updated_at', 'confirmation_lease_token',
  'confirmation_lease_until', 'hold_ip', 'occupancy_units', 'occupancy_ends_at', 'cancel_token_hash',
  'operator_token_hash', 'cancel_token_enc', 'operator_token_enc', 'tokens_expire_at',
  'cancel_token_revoked_at', 'reschedule_transition_version', 'meeting_point_id', 'meeting_point_label',
] as const;

describe('migration 0015 rebuild removes the pickup_type CHECK, preserving every other CHECK, the partial index, and every bookings row byte-for-byte', () => {
  it('applies the actual 0015 migration against a pre-0015 schema', async () => {
    expect(ALL_BOOKING_COLUMNS).toHaveLength(44);

    for (const table of [
      'bookings_new', 'side_effect_operations', 'refund_operations', 'settings', 'capacity_defaults',
      'day_overrides', 'bookings', 'd1_migrations_0015_test', 'd1_migrations',
    ]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();

    const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === '0015_pickup_options.sql');
    if (migrationIndex < 0) throw new Error('0015 migration missing from TEST_MIGRATIONS');
    const migration0015 = bindings.TEST_MIGRATIONS[migrationIndex];
    if (!migration0015) throw new Error('0015 migration missing from TEST_MIGRATIONS');
    // Everything through 0014 -- a schema still carrying 0011's pickup_type CHECK, matching what a
    // pre-upgrade production database looks like.
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, migrationIndex), 'd1_migrations_0015_test');

    // Row 1: every one of the 44 columns set to a distinctive, non-default, non-NULL-where-possible
    // value, including meeting-point columns SET (post-0014 write) -- pickup_type is still
    // constrained to 'default'/'custom' at this point in the migration chain, so it can't yet hold
    // a non-enum id; that's exactly what 0015 unblocks, proven by the post-migration insert below.
    const withMeetingPoint: Record<typeof ALL_BOOKING_COLUMNS[number], string | number | null> = {
      id: 'mp-1', reference: 'BKT-0015-MP1', tour_slug: 'vintage', people: 3,
      pickup_type: 'custom', pickup_address: '123 Distinctive Ave',
      starts_at: '2026-08-01T09:00:00.000Z', ends_at: '2026-08-01T10:00:00.000Z',
      customer_name: 'Distinctive Customer', customer_email: 'distinctive@example.test', customer_phone: '+15551234567',
      locale: 'fr', price_cents: 54321, status: 'confirmed', hold_expires_at: '2026-07-21T10:35:00.000Z',
      stripe_session_id: 'cs_0015_mp1', stripe_payment_intent: 'pi_0015_mp1', calendar_event_id: 'cal_0015_mp1',
      calendar_synced: 1, email_synced: 1, tourflow_synced: 1,
      reminded_at: '2026-07-30T00:00:00.000Z', review_requested_at: '2026-08-02T00:00:00.000Z',
      cancel_token: 'mp1-cancel-token', operator_token: 'mp1-operator-token',
      cancelled_at: '2026-07-25T00:00:00.000Z', cancelled_by: 'operator', rescheduled_from: '2026-07-31T09:00:00.000Z',
      created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-21T00:00:00.000Z',
      confirmation_lease_token: 'mp1-lease-token', confirmation_lease_until: '2026-07-21T10:05:00.000Z',
      hold_ip: '203.0.113.99',
      occupancy_units: 4, occupancy_ends_at: '2026-08-01T10:30:00.000Z',
      cancel_token_hash: 'mp1-cancel-hash', operator_token_hash: 'mp1-operator-hash',
      cancel_token_enc: 'mp1-cancel-enc', operator_token_enc: 'mp1-operator-enc',
      tokens_expire_at: '2026-09-01T00:00:00.000Z', cancel_token_revoked_at: '2026-07-26T00:00:00.000Z',
      reschedule_transition_version: 7,
      meeting_point_id: 'tuk-tuk-a', meeting_point_label: 'Praça do Comércio (tuk-tuk A)',
    };
    // Row 2: a minimal-but-valid row with every nullable column (including both meeting-point
    // columns) left NULL, matching a pre-0014 row that never had them set.
    const withoutMeetingPoint: Record<typeof ALL_BOOKING_COLUMNS[number], string | number | null> = {
      id: 'mp-2', reference: 'BKT-0015-MP2', tour_slug: 'vintage', people: 2,
      pickup_type: 'default', pickup_address: null,
      starts_at: '2026-08-02T09:00:00.000Z', ends_at: '2026-08-02T10:00:00.000Z',
      customer_name: null, customer_email: null, customer_phone: null,
      locale: 'en', price_cents: 12000, status: 'hold', hold_expires_at: '2026-07-21T10:40:00.000Z',
      stripe_session_id: null, stripe_payment_intent: null, calendar_event_id: null,
      calendar_synced: 0, email_synced: 0, tourflow_synced: 0,
      reminded_at: null, review_requested_at: null,
      cancel_token: 'mp2-cancel-token', operator_token: 'mp2-operator-token',
      cancelled_at: null, cancelled_by: null, rescheduled_from: null,
      created_at: '2026-07-21T09:00:00.000Z', updated_at: '2026-07-21T09:00:00.000Z',
      confirmation_lease_token: null, confirmation_lease_until: null,
      hold_ip: null,
      occupancy_units: null, occupancy_ends_at: null,
      cancel_token_hash: null, operator_token_hash: null,
      cancel_token_enc: null, operator_token_enc: null,
      tokens_expire_at: null, cancel_token_revoked_at: null,
      reschedule_transition_version: 0,
      meeting_point_id: null, meeting_point_label: null,
    };
    for (const row of [withMeetingPoint, withoutMeetingPoint]) {
      await db.prepare(
        `INSERT INTO bookings (${ALL_BOOKING_COLUMNS.join(', ')}) VALUES (${ALL_BOOKING_COLUMNS.map(() => '?').join(', ')})`,
      ).bind(...ALL_BOOKING_COLUMNS.map((column) => row[column])).run();
    }

    // A real FK child row, proving the FK-hold/restore dance around this migration's bookings
    // rebuild (same reasoning as 0011's header) leaves it and the FK itself intact.
    await db.prepare(
      `INSERT INTO side_effect_operations (
         booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
       ) VALUES (?, 'calendar_create', 'pending', NULL, 0, NULL, NULL, NULL, ?, ?)`,
    ).bind('mp-1', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z').run();
    // A nonterminal row already at the attempt cap -- what a skipped 0013 (consumer filename
    // collision) leaves behind. 0015's copy must re-apply 0013's abandon-at-cap conversion, or
    // this row stays claimable-by-nobody forever (both claim predicates in src/repo.ts reject
    // attempt_count >= 10) while the rebuilt schema satisfies the runtime fingerprint.
    await db.prepare(
      `INSERT INTO side_effect_operations (
         booking_id, kind, status, provider_result_id, attempt_count, attempted_at, resolved_at, error, created_at, updated_at
       ) VALUES (?, 'email_confirmation', 'failed', NULL, 10, ?, NULL, 'provider 500', ?, ?)`,
    ).bind('mp-2', '2026-07-21T09:30:00.000Z', '2026-07-21T09:00:00.000Z', '2026-07-21T09:45:00.000Z').run();

    // The pre-0015 schema text, captured for the direct byte-for-byte comparison below -- the
    // composed 0011-0014 shape as sqlite_master actually stores it.
    const normalizedSql = async (type: 'table' | 'index', name: string): Promise<string> => {
      const row = (await db.prepare(`SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`)
        .bind(type, name).all<{ sql: string | null }>()).results[0];
      return row?.sql?.toLowerCase().replace(/\s+/g, '') ?? '';
    };
    const bookingsSqlBefore = await normalizedSql('table', 'bookings');
    const sideEffectSqlBefore = await normalizedSql('table', 'side_effect_operations');
    const paymentIndexSqlBefore = await normalizedSql('index', 'idx_bookings_payment_intent');

    // The actual production migration, run for real -- not a hand-copied approximation of it.
    await applyD1Migrations(db, [migration0015], 'd1_migrations_0015_test');

    // Direct proof of "removes ONLY the pickup_type CHECK": the rebuilt bookings schema equals the
    // pre-0015 schema with exactly that CHECK deleted -- every other CHECK and column definition
    // byte-for-byte (modulo whitespace), not just the behaviorally sampled subset below. The
    // side_effect_operations table and the partial payment-intent index must come back unchanged.
    const removedCheck = "check(pickup_typein('default','custom'))";
    expect(bookingsSqlBefore).toContain(removedCheck);
    expect(await normalizedSql('table', 'bookings')).toBe(bookingsSqlBefore.replace(removedCheck, ''));
    expect(await normalizedSql('table', 'side_effect_operations')).toBe(sideEffectSqlBefore);
    expect(await normalizedSql('index', 'idx_bookings_payment_intent')).toBe(paymentIndexSqlBefore);

    // The at-cap leftover was converted exactly the way 0013's own upgrade CASE converts one:
    // terminal 'abandoned', resolved_at backfilled from updated_at, a migration-named error.
    await expect(
      db.prepare(`SELECT status, resolved_at, error, attempt_count FROM side_effect_operations WHERE booking_id = ? AND kind = 'email_confirmation'`).bind('mp-2').all(),
    ).resolves.toMatchObject({
      results: [{
        status: 'abandoned', resolved_at: '2026-07-21T09:45:00.000Z',
        error: 'max attempts (10) reached during upgrade to migration 0015', attempt_count: 10,
      }],
    });

    for (const row of [withMeetingPoint, withoutMeetingPoint]) {
      const survived = (await db.prepare(
        `SELECT ${ALL_BOOKING_COLUMNS.join(', ')} FROM bookings WHERE id = ?`,
      ).bind(row.id).all<Record<string, unknown>>()).results[0];
      expect(survived).toBeDefined();
      for (const column of ALL_BOOKING_COLUMNS) {
        expect(survived?.[column], `column ${column} did not survive the 0015 rebuild unchanged for ${row.id}`).toBe(row[column]);
      }
    }

    // The FK child row survives the parent rebuild, and no foreign key is left dangling anywhere.
    await expect(
      db.prepare(`SELECT booking_id, kind, status FROM side_effect_operations WHERE booking_id = ?`).bind('mp-1').all(),
    ).resolves.toMatchObject({ results: [{ booking_id: 'mp-1', kind: 'calendar_create', status: 'pending' }] });
    await expect(db.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] });

    // The whole point of this migration: a non-enum pickup id, which the pre-0015 CHECK would have
    // rejected, is now accepted on the migrated (not freshly created) table.
    await expect(
      db.prepare(
        'INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        'post-0015-nonenum', 'BKT-0015-NONENUM', 'vintage', 2, 'custom_both',
        '2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z', 'en', 21000, 'hold',
        'post-0015-cancel', 'post-0015-operator', '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z',
      ).run(),
    ).resolves.toBeDefined();

    // Every other 0011 CHECK is still enforced (people>0, ends_at>starts_at, price_cents>=0, a
    // valid status, the 0/1 sync flags, and a valid cancelled_by) -- only pickup_type's CHECK is gone.
    await expect(
      db.prepare(
        'INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        'post-0015-people-0', 'BKT-0015-PEOPLE0', 'vintage', 0, 'default',
        '2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z', 'en', 12000, 'hold',
        'post-0015-people0-cancel', 'post-0015-people0-operator', '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z',
      ).run(),
    ).rejects.toThrow();
    await expect(
      db.prepare(
        'INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        'post-0015-bad-status', 'BKT-0015-BADSTATUS', 'vintage', 2, 'default',
        '2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z', 'en', 12000, 'not-a-status',
        'post-0015-badstatus-cancel', 'post-0015-badstatus-operator', '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z',
      ).run(),
    ).rejects.toThrow();

    // A duplicate stripe_payment_intent is still rejected -- the partial unique index survived.
    await db.prepare(
      'INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, stripe_payment_intent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      'post-0015-pi-1', 'BKT-0015-PI1', 'vintage', 2, 'default',
      '2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z', 'en', 12000, 'hold',
      'post-0015-pi1-cancel', 'post-0015-pi1-operator', 'pi_0015_dup', '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z',
    ).run();
    await expect(
      db.prepare(
        'INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, stripe_payment_intent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        'post-0015-pi-2', 'BKT-0015-PI2', 'vintage', 2, 'default',
        '2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z', 'en', 12000, 'hold',
        'post-0015-pi2-cancel', 'post-0015-pi2-operator', 'pi_0015_dup', '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z',
      ).run(),
    ).rejects.toThrow();

    // The rebuilt table's own CREATE TABLE sql must not carry the old pickup_type CHECK anywhere --
    // normalized the same way src/runtime-context.ts's bookingsSchemaPresent checks it.
    const bookingsSchema = (await db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bookings'`,
    ).all<{ sql: string }>()).results[0];
    const normalizedBookingsSql = bookingsSchema?.sql?.toLowerCase().replace(/\s+/g, '') ?? '';
    expect(normalizedBookingsSql).not.toContain("check(pickup_typein(");
    await expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bookings_payment_intent'`).all<{ name: string }>(),
    ).resolves.toMatchObject({ results: [{ name: 'idx_bookings_payment_intent' }] });
    for (const indexName of [
      'idx_bookings_window', 'idx_bookings_status_hold', 'idx_bookings_confirmation_lease',
      'idx_bookings_hold_ip', 'idx_bookings_cancel_token_hash', 'idx_bookings_operator_token_hash',
    ]) {
      await expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).bind(indexName).all<{ name: string }>(),
        `index ${indexName} missing after the 0015 rebuild`,
      ).resolves.toMatchObject({ results: [{ name: indexName }] });
    }

    // side_effect_operations itself (rebuilt twice by this migration for the FK-hold/restore
    // dance) still carries its own CHECKs and index untouched.
    await expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_side_effect_operations_pending'`).all<{ name: string }>(),
    ).resolves.toMatchObject({ results: [{ name: 'idx_side_effect_operations_pending' }] });
    // A different kind than the 'calendar_create' row already seeded for 'mp-1' above (the PK is
    // (booking_id, kind)) -- 'abandoned' is 0013's status addition, still legal post-0015.
    await expect(
      db.prepare(
        `INSERT INTO side_effect_operations (booking_id, kind, status, attempt_count, created_at, updated_at)
         VALUES (?, 'oversell', 'abandoned', 10, ?, ?)`,
      ).bind('mp-1', '2026-07-21T11:00:00.000Z', '2026-07-21T11:00:00.000Z').run(),
    ).resolves.toBeDefined();
  });
});
