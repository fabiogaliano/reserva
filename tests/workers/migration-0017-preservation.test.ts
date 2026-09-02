// Proves migrations/0017_side_effect_operation_identity.sql's decomposition of the colon-string
// `kind` into family/name/event/discriminator columns is lossless for every legacy kind shape, the
// new unique index dedupes rows with NULLs, and open incidents are re-keyed correctly.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;

const PRESERVED_COLUMNS = [
  'booking_id', 'status', 'provider_result_id', 'attempt_count', 'attempted_at', 'resolved_at',
  'error', 'created_at', 'updated_at', 'failure_started_at', 'next_attempt_at',
] as const;

interface LegacyRow {
  kind: string;
  identity: { family: string; name: string | null; event: string | null; discriminator: string | null };
  displayKey: string;
}

// One entry per kind shape the pre-0017 grammar could produce (see the migration header's mapping
// table). `displayKey` is what sideEffectOperationKey builds from the identity columns afterwards.
const LEGACY_ROWS: LegacyRow[] = [
  { kind: 'calendar_create', identity: { family: 'calendar_create', name: null, event: null, discriminator: null }, displayKey: 'calendar_create' },
  { kind: 'calendar_delete', identity: { family: 'calendar_delete', name: null, event: null, discriminator: null }, displayKey: 'calendar_delete' },
  { kind: 'email_confirmation', identity: { family: 'email_confirmation', name: null, event: null, discriminator: null }, displayKey: 'email_confirmation' },
  { kind: 'oversell', identity: { family: 'oversell', name: null, event: null, discriminator: null }, displayKey: 'oversell' },
  { kind: 'email:booking.no_show', identity: { family: 'email', name: null, event: 'booking.no_show', discriminator: null }, displayKey: 'email:booking.no_show' },
  { kind: 'email:booking.confirmed:customer', identity: { family: 'email', name: 'customer', event: 'booking.confirmed', discriminator: null }, displayKey: 'email:customer:booking.confirmed' },
  { kind: 'email:booking.confirmed:owner', identity: { family: 'email', name: 'owner', event: 'booking.confirmed', discriminator: null }, displayKey: 'email:owner:booking.confirmed' },
  { kind: 'email:booking.rescheduled:3', identity: { family: 'email', name: null, event: 'booking.rescheduled', discriminator: '3' }, displayKey: 'email:booking.rescheduled:3' },
  { kind: 'email:booking.rescheduled:customer:2', identity: { family: 'email', name: 'customer', event: 'booking.rescheduled', discriminator: '2' }, displayKey: 'email:customer:booking.rescheduled:2' },
  { kind: 'tourflow:booking.confirmed', identity: { family: 'hook', name: 'ops', event: 'booking.confirmed', discriminator: null }, displayKey: 'hook:ops:booking.confirmed' },
  { kind: 'tourflow:booking.rescheduled:5', identity: { family: 'hook', name: 'ops', event: 'booking.rescheduled', discriminator: '5' }, displayKey: 'hook:ops:booking.rescheduled:5' },
];

function legacyValues(kind: string, index: number): Record<typeof PRESERVED_COLUMNS[number], string | number | null> {
  return {
    booking_id: 'bk-0017',
    status: index % 2 === 0 ? 'failed' : 'succeeded',
    provider_result_id: index % 2 === 0 ? null : `provider-${index}`,
    attempt_count: index,
    attempted_at: `2026-07-25T00:0${index % 10}:00.000Z`,
    resolved_at: index % 2 === 0 ? null : `2026-07-25T01:0${index % 10}:00.000Z`,
    error: index % 2 === 0 ? `boom ${kind}` : null,
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: `2026-07-25T02:0${index % 10}:00.000Z`,
    failure_started_at: index % 2 === 0 ? '2026-07-25T00:00:00.000Z' : null,
    next_attempt_at: index % 2 === 0 ? '2026-07-25T03:00:00.000Z' : null,
  };
}

describe('migration 0017 decomposes every legacy outbox kind into identity columns without losing a row', () => {
  it('applies the actual 0017 migration against a pre-0017 schema', async () => {
    for (const table of [
      'operational_incidents', 'side_effect_operations', 'refund_operations', 'settings',
      'capacity_defaults', 'day_overrides', 'bookings', 'd1_migrations_0017_test', 'd1_migrations',
    ]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();

    const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === '0017_side_effect_operation_identity.sql');
    if (migrationIndex < 0) throw new Error('0017 migration missing from TEST_MIGRATIONS');
    const migration0017 = bindings.TEST_MIGRATIONS[migrationIndex];
    if (!migration0017) throw new Error('0017 migration missing from TEST_MIGRATIONS');
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, migrationIndex), 'd1_migrations_0017_test');

    await db.prepare(
      `INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      'bk-0017', 'BKT-0017-1', 'vintage', 2, 'default',
      '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'confirmed',
      'bk0017-cancel', 'bk0017-operator', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
    ).run();

    const seeded = new Map<string, Record<string, string | number | null>>();
    for (const [index, row] of LEGACY_ROWS.entries()) {
      const values = legacyValues(row.kind, index);
      seeded.set(row.kind, values);
      await db.prepare(
        `INSERT INTO side_effect_operations (kind, ${PRESERVED_COLUMNS.join(', ')})
         VALUES (?, ${PRESERVED_COLUMNS.map(() => '?').join(', ')})`,
      ).bind(row.kind, ...PRESERVED_COLUMNS.map((column) => values[column])).run();
    }

    // An open incident for one of the rows whose display string CHANGES under the new identity
    // (email:<event>:<recipient> becomes email:<recipient>:<event>), so the re-key below is real.
    await db.prepare(
      `INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, first_detected_at, last_detected_at, source_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      'inc-0017', 'bk-0017', 'side_effect', 'bk-0017:email:booking.confirmed:owner', 'confirmation_email',
      'open', 'delayed', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z',
    ).run();
    // A refund incident keyed by booking id alone must be left completely alone by the re-key.
    await db.prepare(
      `INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, first_detected_at, last_detected_at, source_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      'inc-0017-refund', 'bk-0017', 'refund', 'bk-0017', 'refund',
      'open', 'delayed', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z',
    ).run();

    await applyD1Migrations(db, [migration0017], 'd1_migrations_0017_test');

    const rows = (await db.prepare(
      `SELECT family, name, event, discriminator, event_payload_json, ${PRESERVED_COLUMNS.join(', ')} FROM side_effect_operations`,
    ).all<Record<string, string | number | null>>()).results;
    expect(rows).toHaveLength(LEGACY_ROWS.length);

    for (const legacy of LEGACY_ROWS) {
      const migrated = rows.find((row) =>
        row.family === legacy.identity.family
        && row.name === legacy.identity.name
        && row.event === legacy.identity.event
        && row.discriminator === legacy.identity.discriminator);
      expect(migrated, `kind "${legacy.kind}" did not decompose into ${JSON.stringify(legacy.identity)}`).toBeDefined();
      const before = seeded.get(legacy.kind);
      for (const column of PRESERVED_COLUMNS) {
        expect(migrated?.[column], `column ${column} changed for "${legacy.kind}"`).toBe(before?.[column]);
      }
      // The documented compatibility exception: no pre-0017 row has an occurrence snapshot, so
      // event_payload_json is NULL for every migrated row — including the converted hook rows,
      // which is exactly what lets them fall back to reconstructing from current booking state.
      expect(migrated?.event_payload_json, `"${legacy.kind}" must not invent a payload`).toBeNull();
    }

    // The kind column is gone, so no code path can fall back to parsing it.
    const columns = new Set((await db.prepare('PRAGMA table_info(side_effect_operations)').all<{ name: string }>()).results.map((row) => row.name));
    expect(columns.has('kind')).toBe(false);

    // The expression unique index is what enforces one row per identity now: a plain UNIQUE would
    // treat these NULL-bearing identities as distinct and let a duplicate through.
    await expect(
      db.prepare(
        `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, event_payload_json, status, attempt_count, created_at, updated_at)
         VALUES (?, 'email_confirmation', NULL, NULL, NULL, NULL, 'pending', 0, ?, ?)`,
      ).bind('bk-0017', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z').run(),
    ).rejects.toThrow();
    // A different subscriber name for the same event is a different identity and still inserts.
    await expect(
      db.prepare(
        `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, event_payload_json, status, attempt_count, created_at, updated_at)
         VALUES (?, 'webhook', 'partner', 'booking.confirmed', NULL, '{"apiVersion":1}', 'pending', 0, ?, ?)`,
      ).bind('bk-0017', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z').run(),
    ).resolves.toBeDefined();
    // The family CHECK still closes the set.
    await expect(
      db.prepare(
        `INSERT INTO side_effect_operations (booking_id, family, name, event, discriminator, event_payload_json, status, attempt_count, created_at, updated_at)
         VALUES (?, 'not-a-family', NULL, NULL, NULL, NULL, 'pending', 0, ?, ?)`,
      ).bind('bk-0017', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z').run(),
    ).rejects.toThrow();

    await expect(db.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] });
    for (const indexName of [
      'idx_side_effect_operations_identity', 'idx_side_effect_operations_pending', 'idx_side_effect_operations_reconciliation',
    ]) {
      await expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).bind(indexName).all<{ name: string }>(),
        `index ${indexName} missing after 0017`,
      ).resolves.toMatchObject({ results: [{ name: indexName }] });
    }

    await expect(db.prepare('SELECT source_key FROM operational_incidents WHERE id = ?').bind('inc-0017').all())
      .resolves.toMatchObject({ results: [{ source_key: 'bk-0017:email:owner:booking.confirmed' }] });
    await expect(db.prepare('SELECT source_key FROM operational_incidents WHERE id = ?').bind('inc-0017-refund').all())
      .resolves.toMatchObject({ results: [{ source_key: 'bk-0017' }] });
  });
});
