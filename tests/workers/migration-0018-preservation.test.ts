// migrations/0018_v2_domain_rename.sql is the wave's one `bookings` rebuild — renames/drops/adds
// columns, relaxes pickup_type to nullable, and re-keys settings rows. Proves against real D1 that
// columns/FKs/indexes survive, dropped/added columns are correct, and sync flags convert to outbox rows.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;

// The pre-0018 physical shape (0015's 44 columns). Seeding through this list rather than
// src/repo.ts's app-read subset is what makes "did the copy drop anything" answerable.
const PRE_0018_COLUMNS = [
  'id', 'reference', 'tour_slug', 'people', 'pickup_type', 'pickup_address', 'starts_at', 'ends_at',
  'customer_name', 'customer_email', 'customer_phone', 'locale', 'price_cents', 'status', 'hold_expires_at',
  'stripe_session_id', 'stripe_payment_intent', 'calendar_event_id', 'calendar_synced', 'email_synced',
  'tourflow_synced', 'reminded_at', 'review_requested_at', 'cancel_token', 'operator_token', 'cancelled_at',
  'cancelled_by', 'rescheduled_from', 'created_at', 'updated_at', 'confirmation_lease_token',
  'confirmation_lease_until', 'hold_ip', 'occupancy_units', 'occupancy_ends_at', 'cancel_token_hash',
  'operator_token_hash', 'cancel_token_enc', 'operator_token_enc', 'tokens_expire_at',
  'cancel_token_revoked_at', 'reschedule_transition_version', 'meeting_point_id', 'meeting_point_label',
] as const;

// old physical column -> the v2 column its value must land in, byte for byte.
const RENAMED: Record<string, string> = {
  tour_slug: 'service_slug',
  people: 'quantity',
  price_cents: 'price_minor',
  stripe_session_id: 'payment_session_ref',
  stripe_payment_intent: 'payment_ref',
};

const DROPPED = ['calendar_synced', 'email_synced', 'tourflow_synced', 'reminded_at', 'review_requested_at'] as const;

type PreRow = Record<typeof PRE_0018_COLUMNS[number], string | number | null>;

// Deliberately distinctive values throughout: a swapped pair of columns in the copy would still
// type-check and still be "a string", so only unmistakable values catch a mismap.
function preRow(overrides: Partial<PreRow> & { id: string; reference: string; cancel_token: string; operator_token: string }): PreRow {
  return {
    tour_slug: 'vintage', people: 3,
    pickup_type: 'custom_both', pickup_address: '123 Distinctive Ave',
    starts_at: '2026-08-01T09:00:00.000Z', ends_at: '2026-08-01T10:00:00.000Z',
    customer_name: 'Distinctive Customer', customer_email: 'distinctive@example.test', customer_phone: '+15551234567',
    locale: 'fr', price_cents: 54321, status: 'confirmed', hold_expires_at: '2026-07-21T10:35:00.000Z',
    stripe_session_id: null, stripe_payment_intent: null, calendar_event_id: null,
    calendar_synced: 0, email_synced: 0, tourflow_synced: 1,
    reminded_at: '2026-07-30T00:00:00.000Z', review_requested_at: '2026-08-02T00:00:00.000Z',
    cancelled_at: null, cancelled_by: null, rescheduled_from: 'booking-previous',
    created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-26T00:00:00.000Z',
    confirmation_lease_token: 'lease-token-distinctive', confirmation_lease_until: '2026-07-21T10:05:00.000Z',
    hold_ip: '203.0.113.42', occupancy_units: 2, occupancy_ends_at: '2026-08-01T10:15:00.000Z',
    cancel_token_hash: null, operator_token_hash: null,
    cancel_token_enc: null, operator_token_enc: null, tokens_expire_at: '2026-09-01T00:00:00.000Z',
    cancel_token_revoked_at: null, reschedule_transition_version: 7,
    meeting_point_id: 'station', meeting_point_label: 'The Distinctive Station',
    ...overrides,
  };
}

async function insertPreRow(row: PreRow): Promise<void> {
  await db.prepare(
    `INSERT INTO bookings (${PRE_0018_COLUMNS.join(', ')}) VALUES (${PRE_0018_COLUMNS.map(() => '?').join(', ')})`,
  ).bind(...PRE_0018_COLUMNS.map((column) => row[column])).run();
}

async function tableSql(name: string): Promise<string> {
  const result = await db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).bind(name).all<{ sql: string | null }>();
  return result.results[0]?.sql ?? '';
}

describe('migration 0018 rebuilds bookings for the v2 domain without losing a row, a child, or a setting', () => {
  it('applies the actual 0018 migration against a pre-0018 schema', async () => {
    for (const table of [
      'operational_incidents', 'side_effect_operations', 'refund_operations', 'settings',
      'capacity_defaults', 'day_overrides', 'bookings', 'd1_migrations_0018_test', 'd1_migrations',
    ]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();

    const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === '0018_v2_domain_rename.sql');
    if (migrationIndex < 0) throw new Error('0018 migration missing from TEST_MIGRATIONS');
    const migration0018 = bindings.TEST_MIGRATIONS[migrationIndex];
    if (!migration0018) throw new Error('0018 migration missing from TEST_MIGRATIONS');
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, migrationIndex), 'd1_migrations_0018_test');

    // Row 1: every column populated, both sync flags already true and NO outbox row — a booking
    // confirmed before migration 0010, whose flags are the only surviving delivery record.
    const legacyConfirmed = preRow({
      id: 'bk-0018-legacy', reference: 'BKT-0018-LEGACY',
      cancel_token: 'legacy-cancel', operator_token: 'legacy-operator',
      stripe_session_id: 'cs_0018_legacy', stripe_payment_intent: 'pi_0018_legacy',
      calendar_event_id: 'cal_0018_legacy', calendar_synced: 1, email_synced: 1,
      cancel_token_hash: 'legacy-cancel-hash', operator_token_hash: 'legacy-operator-hash',
    });
    // Row 2: a hold with every nullable column NULL, and pickup_type 'default' — proves an existing
    // id survives the relaxation to nullable rather than being normalized away.
    const plainHold = preRow({
      id: 'bk-0018-hold', reference: 'BKT-0018-HOLD',
      cancel_token: 'hold-cancel', operator_token: 'hold-operator',
      pickup_type: 'default', pickup_address: null, people: 1, price_cents: 0,
      customer_name: null, customer_email: null, customer_phone: null,
      status: 'hold', calendar_synced: 0, email_synced: 0, tourflow_synced: 0,
      reminded_at: null, review_requested_at: null, rescheduled_from: null,
      confirmation_lease_token: null, confirmation_lease_until: null, hold_ip: null,
      occupancy_units: null, occupancy_ends_at: null, tokens_expire_at: null,
      cancel_token_hash: 'hold-cancel-hash', operator_token_hash: 'hold-operator-hash',
      reschedule_transition_version: 0,
    });
    // Row 3: already has its own confirmation rows (a post-0010 booking). Its true flags must NOT
    // mint a second, duplicate row.
    const modernConfirmed = preRow({
      id: 'bk-0018-modern', reference: 'BKT-0018-MODERN',
      cancel_token: 'modern-cancel', operator_token: 'modern-operator',
      calendar_event_id: 'cal_0018_modern', calendar_synced: 1, email_synced: 1,
      cancel_token_hash: 'modern-cancel-hash', operator_token_hash: 'modern-operator-hash',
    });
    for (const row of [legacyConfirmed, plainHold, modernConfirmed]) await insertPreRow(row);

    await db.prepare(
      `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, event_payload_json, status, provider_result_id, attempt_count, created_at, updated_at)
       VALUES (?, 'calendar_create', NULL, NULL, NULL, NULL, 'succeeded', ?, 1, ?, ?)`,
    ).bind('bk-0018-modern', 'cal_0018_modern', '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z').run();
    // The split per-recipient shape counts as "the confirmation email already has rows" too.
    for (const recipient of ['customer', 'owner']) {
      await db.prepare(
        `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, event_payload_json, status, attempt_count, created_at, updated_at)
         VALUES (?, 'email', ?, 'booking.confirmed', NULL, NULL, 'succeeded', 1, ?, ?)`,
      ).bind('bk-0018-modern', recipient, '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z').run();
    }
    await db.prepare(
      `INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, first_detected_at, last_detected_at, source_updated_at)
       VALUES (?, ?, 'side_effect', ?, 'calendar', 'open', 'delayed', ?, ?, ?)`,
    ).bind(
      'inc-0018', 'bk-0018-legacy', 'bk-0018-legacy:calendar_create',
      '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z',
    ).run();

    for (const [key, value] of [['fleet.defaultCapacity', '7'], ['payments.methods', '["card","mb_way"]'], ['booking.minNoticeHours', '3']]) {
      await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
    }

    await applyD1Migrations(db, [migration0018], 'd1_migrations_0018_test');

    // --- every surviving column, byte for byte -------------------------------------------------
    const survivors = PRE_0018_COLUMNS.filter((column) => !(DROPPED as readonly string[]).includes(column));
    const selected = survivors.map((column) => RENAMED[column] ?? column);
    const migrated = (await db.prepare(
      `SELECT ${selected.join(', ')} FROM bookings ORDER BY id`,
    ).all<Record<string, string | number | null>>()).results;
    expect(migrated).toHaveLength(3);

    for (const before of [legacyConfirmed, plainHold, modernConfirmed]) {
      const after = migrated.find((row) => row.id === before.id);
      expect(after, `booking ${before.id} did not survive the rebuild`).toBeDefined();
      for (const column of survivors) {
        const target = RENAMED[column] ?? column;
        expect(after?.[target], `${column} -> ${target} changed for ${before.id}`).toBe(before[column]);
      }
    }

    // --- the shape change itself ---------------------------------------------------------------
    const columns = new Set((await db.prepare('PRAGMA table_info(bookings)').all<{ name: string }>()).results.map((row) => row.name));
    for (const dropped of DROPPED) expect(columns.has(dropped), `${dropped} should be gone`).toBe(false);
    for (const renamed of Object.keys(RENAMED)) expect(columns.has(renamed), `${renamed} should be gone`).toBe(false);
    expect(columns.has('currency')).toBe(true);
    expect(columns.has('metadata')).toBe(true);

    // Every pre-0018 row was priced in euros (see the migration header) — the backfill has to say so
    // for all of them, and metadata starts empty rather than inventing a payload.
    await expect(db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE currency = ?').bind('eur').all())
      .resolves.toMatchObject({ results: [{ n: 3 }] });
    await expect(db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE metadata IS NOT NULL').all())
      .resolves.toMatchObject({ results: [{ n: 0 }] });

    // pickup_type is nullable now: the location-less service can store NULL. A NOT NULL column
    // would reject this outright.
    await expect(
      db.prepare(
        `INSERT INTO bookings (id, reference, service_slug, quantity, pickup_type, starts_at, ends_at, locale, price_minor, currency, status, cancel_token, operator_token, created_at, updated_at)
         VALUES (?, ?, 'vintage', 2, NULL, '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', 'en', 12000, 'jpy', 'hold', ?, ?, ?, ?)`,
      ).bind(
        'bk-0018-nullpickup', 'BKT-0018-NULLPICKUP', 'nullpickup-cancel', 'nullpickup-operator',
        '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z',
      ).run(),
    ).resolves.toBeDefined();
    await expect(db.prepare('SELECT pickup_type FROM bookings WHERE id = ?').bind('bk-0018-nullpickup').all())
      .resolves.toMatchObject({ results: [{ pickup_type: null }] });

    // 0011's other CHECKs are re-expressed against the new names, and 0015's removal of the
    // pickup_type CHECK still holds (the non-enum 'custom_both' above round-tripped).
    const bookingsSql = (await tableSql('bookings')).toLowerCase().replace(/\s+/g, '');
    expect(bookingsSql).toContain('check(quantity>0)');
    expect(bookingsSql).toContain('check(ends_at>starts_at)');
    expect(bookingsSql).toContain('check(price_minor>=0)');
    expect(bookingsSql).not.toContain("pickup_typein('default','custom')");

    // --- children and indexes ------------------------------------------------------------------
    await expect(db.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] });
    await expect(db.prepare('SELECT source_key, status FROM operational_incidents WHERE id = ?').bind('inc-0018').all())
      .resolves.toMatchObject({ results: [{ source_key: 'bk-0018-legacy:calendar_create', status: 'open' }] });

    for (const indexName of [
      'idx_bookings_window', 'idx_bookings_status_hold', 'idx_bookings_confirmation_lease',
      'idx_bookings_hold_ip', 'idx_bookings_cancel_token_hash', 'idx_bookings_operator_token_hash',
      'idx_bookings_payment_ref', 'idx_side_effect_operations_identity', 'idx_side_effect_operations_pending',
      'idx_side_effect_operations_reconciliation', 'idx_operational_incidents_open', 'idx_operational_incidents_alert',
    ]) {
      await expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).bind(indexName).all<{ name: string }>(),
        `index ${indexName} missing after 0018`,
      ).resolves.toMatchObject({ results: [{ name: indexName }] });
    }
    // The partial payment index still enforces uniqueness under its new name.
    await expect(
      db.prepare('UPDATE bookings SET payment_ref = ? WHERE id = ?').bind('pi_0018_legacy', 'bk-0018-hold').run(),
    ).rejects.toThrow();

    // --- the sync flags became the rows they described -----------------------------------------
    const legacyRows = (await db.prepare(
      'SELECT family, name, event, status, provider_result_id, resolved_at FROM side_effect_operations WHERE booking_id = ? ORDER BY family',
    ).bind('bk-0018-legacy').all<Record<string, string | null>>()).results;
    expect(legacyRows).toEqual([
      { family: 'calendar_create', name: null, event: null, status: 'succeeded', provider_result_id: 'cal_0018_legacy', resolved_at: legacyConfirmed.updated_at },
      { family: 'email_confirmation', name: null, event: null, status: 'succeeded', provider_result_id: null, resolved_at: legacyConfirmed.updated_at },
    ]);
    // A booking whose flags were false has no delivery record to preserve, so nothing is minted.
    await expect(db.prepare('SELECT COUNT(*) AS n FROM side_effect_operations WHERE booking_id = ?').bind('bk-0018-hold').all())
      .resolves.toMatchObject({ results: [{ n: 0 }] });
    // And a booking that already had its rows keeps exactly those three, not five.
    const modernRows = (await db.prepare(
      'SELECT family, name FROM side_effect_operations WHERE booking_id = ? ORDER BY family, name',
    ).bind('bk-0018-modern').all<{ family: string; name: string | null }>()).results;
    expect(modernRows).toEqual([
      { family: 'calendar_create', name: null },
      { family: 'email', name: 'customer' },
      { family: 'email', name: 'owner' },
    ]);

    // --- settings ------------------------------------------------------------------------------
    // The operator's saved capacity has to follow the config key, or the rename silently reverts it.
    await expect(db.prepare('SELECT value FROM settings WHERE key = ?').bind('capacity.default').all())
      .resolves.toMatchObject({ results: [{ value: '7' }] });
    await expect(db.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').bind('fleet.defaultCapacity').all())
      .resolves.toMatchObject({ results: [{ n: 0 }] });
    // payments.methods is no longer a setting anything can read or clear, so it must not linger.
    await expect(db.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').bind('payments.methods').all())
      .resolves.toMatchObject({ results: [{ n: 0 }] });
    await expect(db.prepare('SELECT value FROM settings WHERE key = ?').bind('booking.minNoticeHours').all())
      .resolves.toMatchObject({ results: [{ value: '3' }] });
  });
});
