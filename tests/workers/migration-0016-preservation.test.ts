// migrations/0016_operational_reconciliation.sql is additive
// for side_effect_operations (two nullable columns + a new index) and for the brand-new
// operational_incidents table, but rebuilds refund_operations the same rename -> create ->
// INSERT...SELECT -> drop pattern as 0011/0012/0013/0015 (see 0011's header) to widen its `status`
// CHECK. This proves every existing refund_operations row/column/constraint survives that rebuild
// byte-for-byte, that the additive side_effect_operations columns/index land without disturbing
// its existing CHECK/index/FK, and that operational_incidents enforces its CHECKs and unique
// constraint.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;

const ALL_REFUND_COLUMNS = [
  'id', 'booking_id', 'payment_intent', 'choice', 'status', 'stripe_refund_id', 'amount_cents',
  'requested_at', 'resolved_at', 'error',
] as const;

describe('migration 0016 preserves refund_operations byte-for-byte, adds backoff columns to side_effect_operations, and creates operational_incidents', () => {
  it('applies the actual 0016 migration against a pre-0016 schema', async () => {
    for (const table of [
      'operational_incidents', 'side_effect_operations', 'refund_operations', 'settings',
      'capacity_defaults', 'day_overrides', 'bookings', 'd1_migrations_0016_test', 'd1_migrations',
    ]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();

    const migrationIndex = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === '0016_operational_reconciliation.sql');
    if (migrationIndex < 0) throw new Error('0016 migration missing from TEST_MIGRATIONS');
    const migration0016 = bindings.TEST_MIGRATIONS[migrationIndex];
    if (!migration0016) throw new Error('0016 migration missing from TEST_MIGRATIONS');
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, migrationIndex), 'd1_migrations_0016_test');

    // A booking row for the FK — refund_operations/operational_incidents both reference bookings(id).
    await db.prepare(
      `INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      'bk-1', 'BKT-0016-1', 'vintage', 2, 'default',
      '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 'en', 12000, 'confirmed',
      'bk1-cancel', 'bk1-operator', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
    ).run();

    const succeededRow: Record<typeof ALL_REFUND_COLUMNS[number], string | number | null> = {
      id: 'ro-succeeded', booking_id: 'bk-1', payment_intent: 'pi_0016_1', choice: 'full', status: 'succeeded',
      stripe_refund_id: 're_0016_1', amount_cents: 12000, requested_at: '2026-07-25T00:00:00.000Z',
      resolved_at: '2026-07-25T00:05:00.000Z', error: null,
    };
    await db.prepare(
      `INSERT INTO refund_operations (${ALL_REFUND_COLUMNS.join(', ')}) VALUES (${ALL_REFUND_COLUMNS.map(() => '?').join(', ')})`,
    ).bind(...ALL_REFUND_COLUMNS.map((column) => succeededRow[column])).run();

    const failedRow: Record<typeof ALL_REFUND_COLUMNS[number], string | number | null> = {
      id: 'ro-failed', booking_id: 'bk-2', payment_intent: 'pi_0016_2', choice: 'none', status: 'failed',
      stripe_refund_id: null, amount_cents: null, requested_at: '2026-07-26T00:00:00.000Z',
      resolved_at: '2026-07-26T00:05:00.000Z', error: 'stripe timeout',
    };
    await db.prepare(
      `INSERT INTO refund_operations (${ALL_REFUND_COLUMNS.join(', ')}) VALUES (${ALL_REFUND_COLUMNS.map(() => '?').join(', ')})`,
    ).bind(...ALL_REFUND_COLUMNS.map((column) => failedRow[column])).run();

    const refundSqlBefore = (await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'side_effect_operations'`).all<{ sql: string }>()).results[0]?.sql ?? '';

    await applyD1Migrations(db, [migration0016], 'd1_migrations_0016_test');

    // side_effect_operations' own CHECK/index/FK are untouched — ALTER TABLE ADD COLUMN inserts the
    // new column definitions but never removes or rewrites any existing clause, so every clause
    // that was present before 0016 must still appear verbatim (in the same relative order) after it.
    const sideEffectSqlAfter = (await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'side_effect_operations'`).all<{ sql: string }>()).results[0]?.sql ?? '';
    const beforeClauses = refundSqlBefore.split(/,\s*/).map((clause) => clause.trim());
    let cursor = 0;
    for (const clause of beforeClauses) {
      const index = sideEffectSqlAfter.indexOf(clause, cursor);
      expect(index, `clause "${clause}" missing (or reordered) after the 0016 ALTER TABLE ADD COLUMN`).toBeGreaterThanOrEqual(0);
      cursor = index + clause.length;
    }
    expect(sideEffectSqlAfter).toContain('failure_started_at');
    expect(sideEffectSqlAfter).toContain('next_attempt_at');
    await expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_side_effect_operations_pending'`).all<{ name: string }>(),
    ).resolves.toMatchObject({ results: [{ name: 'idx_side_effect_operations_pending' }] });
    await expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_side_effect_operations_reconciliation'`).all<{ name: string }>(),
    ).resolves.toMatchObject({ results: [{ name: 'idx_side_effect_operations_reconciliation' }] });
    const sideEffectColumns = new Set((await db.prepare('PRAGMA table_info(side_effect_operations)').all<{ name: string }>()).results.map((row) => row.name));
    expect(sideEffectColumns.has('failure_started_at')).toBe(true);
    expect(sideEffectColumns.has('next_attempt_at')).toBe(true);

    // Every refund_operations row/column survived the rebuild unchanged, including the ones this
    // migration didn't touch (payment_intent, error, resolved_at, ...).
    for (const row of [succeededRow, failedRow]) {
      const survived = (await db.prepare(`SELECT ${ALL_REFUND_COLUMNS.join(', ')} FROM refund_operations WHERE id = ?`).bind(row.id).all<Record<string, unknown>>()).results[0];
      expect(survived, `row ${row.id} missing after the 0016 rebuild`).toBeDefined();
      for (const column of ALL_REFUND_COLUMNS) {
        expect(survived?.[column], `column ${column} did not survive the 0016 rebuild unchanged for ${row.id}`).toBe(row[column]);
      }
    }
    // New execution-lease/backoff columns default to NULL/0 for a pre-existing row.
    const newColumns = (await db.prepare(
      `SELECT execution_claim_token, execution_claim_until, attempt_count, attempted_at, failure_started_at, next_attempt_at FROM refund_operations WHERE id = 'ro-succeeded'`,
    ).all<Record<string, unknown>>()).results[0];
    expect(newColumns).toMatchObject({
      execution_claim_token: null, execution_claim_until: null, attempt_count: 0,
      attempted_at: null, failure_started_at: null, next_attempt_at: null,
    });

    // UNIQUE(booking_id) is still enforced post-rebuild.
    await expect(
      db.prepare(
        `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('ro-dup', 'bk-1', 'pi_dup', 'full', 'requested', '2026-07-27T00:00:00.000Z').run(),
    ).rejects.toThrow();

    // The widened status CHECK now admits 'in_flight' and 'abandoned' (refund_operations, unlike
    // side_effect_operations, has never had a FOREIGN KEY on booking_id — see migrations/0006).
    await expect(
      db.prepare(
        `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('ro-in-flight', 'bk-2-inflight', 'pi_inflight', 'full', 'in_flight', '2026-07-27T00:00:00.000Z').run(),
    ).resolves.toBeDefined();
    await db.prepare(
      `INSERT INTO bookings (id, reference, tour_slug, people, pickup_type, starts_at, ends_at, locale, price_cents, status, cancel_token, operator_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      'bk-3', 'BKT-0016-3', 'vintage', 2, 'default',
      '2026-08-02T09:00:00.000Z', '2026-08-02T10:00:00.000Z', 'en', 12000, 'confirmed',
      'bk3-cancel', 'bk3-operator', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
    ).run();
    await expect(
      db.prepare(
        `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('ro-abandoned', 'bk-3', 'pi_abandoned', 'full', 'abandoned', '2026-07-27T00:00:00.000Z').run(),
    ).resolves.toBeDefined();
    await expect(
      db.prepare(
        `INSERT INTO refund_operations (id, booking_id, payment_intent, choice, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('ro-bad-status', 'bk-4', 'pi_bad', 'full', 'not-a-status', '2026-07-27T00:00:00.000Z').run(),
    ).rejects.toThrow();

    await expect(db.prepare('PRAGMA foreign_key_check').all()).resolves.toMatchObject({ results: [] });
    await expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_refund_operations_status'`).all<{ name: string }>(),
    ).resolves.toMatchObject({ results: [{ name: 'idx_refund_operations_status' }] });
    await expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_refund_operations_reconciliation'`).all<{ name: string }>(),
    ).resolves.toMatchObject({ results: [{ name: 'idx_refund_operations_reconciliation' }] });

    // operational_incidents: CHECK-constrained enums and the (source_type, source_key) unique
    // constraint, plus the two admin/alert-drain indexes.
    await expect(
      db.prepare(
        `INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, first_detected_at, last_detected_at, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind('inc-1', 'bk-1', 'side_effect', 'bk-1:calendar_create', 'calendar', 'open', 'delayed', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z').run(),
    ).resolves.toBeDefined();
    await expect(
      db.prepare('SELECT alert_revision, alerted_revision, alert_attempt_count FROM operational_incidents WHERE id = ?').bind('inc-1').all(),
    ).resolves.toMatchObject({ results: [{ alert_revision: 1, alerted_revision: 0, alert_attempt_count: 0 }] });
    // (source_type, source_key) unique.
    await expect(
      db.prepare(
        `INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, first_detected_at, last_detected_at, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind('inc-1-dup', 'bk-1', 'side_effect', 'bk-1:calendar_create', 'calendar', 'open', 'delayed', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z').run(),
    ).rejects.toThrow();
    // Bad enum values are rejected.
    await expect(
      db.prepare(
        `INSERT INTO operational_incidents (id, booking_id, source_type, source_key, action, status, severity, first_detected_at, last_detected_at, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind('inc-2', 'bk-1', 'not-a-source', 'bk-1:x', 'calendar', 'open', 'delayed', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z').run(),
    ).rejects.toThrow();
    for (const indexName of ['idx_operational_incidents_open', 'idx_operational_incidents_alert']) {
      await expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).bind(indexName).all<{ name: string }>(),
        `index ${indexName} missing after 0016`,
      ).resolves.toMatchObject({ results: [{ name: indexName }] });
    }
  });
});
