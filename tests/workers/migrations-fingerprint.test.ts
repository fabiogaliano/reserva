// checkReservaMigrationsApplied's filename ledger alone is fooled by a consumer migration reusing
// reserva's filename without running its SQL. These tests prove the schema fingerprint catches that
// against real D1: the shipped schema passes, and every clause the fingerprint asserts -- the
// per-table column and index names replayed from migrations/*.sql into
// src/generated/schema-fingerprint.ts -- is pinned by damaging exactly that one thing while the
// ledger stays complete.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RESERVA_MIGRATIONS } from '../../src/generated/schema-fingerprint';
import { checkReservaMigrationsApplied } from '../../src/schema-check';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.RESERVA_DB;

// Every table reserva's schema creates, so each test can tear the schema back to nothing before
// rebuilding exactly the state its scenario needs -- self-contained regardless of whether the pool
// isolates storage per test.
const RESERVA_TABLES = ['admin_change_history', 'operational_incidents', 'side_effect_operations', 'refund_operations', 'reconciliation_lease', 'settings', 'capacity_defaults', 'day_overrides', 'bookings'];

async function resetSchema() {
  for (const table of RESERVA_TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await db.prepare('DROP TABLE IF EXISTS d1_migrations').run();
}

// The real schema and a complete ledger, so any subsequent failure can only come from the damage a
// test then inflicts -- never from a missing migration row.
async function applyRealSchema() {
  await resetSchema();
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS, 'd1_migrations');
}

async function expectFingerprintCollision() {
  await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
  await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
}

describe('checkReservaMigrationsApplied schema fingerprint against real D1', () => {
  it('passes against a real, fully migrated schema', async () => {
    await applyRealSchema();

    await expect(checkReservaMigrationsApplied(db)).resolves.toBeUndefined();
  });

  it('fails distinctly (not "missing migrations") when the ledger is forged over a bare schema', async () => {
    await resetSchema();
    // d1_migrations is normally created by wrangler's own migration runner; create it directly
    // since no migration is actually being applied in this scenario -- nothing else in the
    // database was ever built, simulating a consumer database reserva was never really pointed at.
    await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run();
    for (const name of RESERVA_MIGRATIONS) await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();

    await expectFingerprintCollision();
  });
});

// Each case below applies reserva's real schema, damages exactly one thing the fingerprint asserts,
// and leaves the ledger complete -- so the test goes green only while that specific clause exists.
describe('schema fingerprint catches targeted drift in `bookings`', () => {
  // SQLite refuses to drop an indexed column, so the index has to go first; the generated
  // fingerprint lists both the column and the index, so it still fails on the column alone.
  const BOOKINGS_COLUMN_INDEX: Record<string, string | undefined> = {
    cancel_token_hash: 'idx_bookings_cancel_token_hash',
    operator_token_hash: 'idx_bookings_operator_token_hash',
  };

  it.each([
    'occupancy_units', 'cancel_token_hash', 'operator_token_hash', 'cancel_token_revoked_at',
    'reschedule_transition_version', 'meeting_point_id', 'currency', 'metadata',
  ])('a required column missing: %s', async (column) => {
    await applyRealSchema();
    const dependentIndex = BOOKINGS_COLUMN_INDEX[column];
    if (dependentIndex) await db.prepare(`DROP INDEX ${dependentIndex}`).run();
    await db.prepare(`ALTER TABLE bookings DROP COLUMN ${column}`).run();

    await expectFingerprintCollision();
  });

  it.each([
    'tour_slug', 'people', 'price_cents', 'stripe_session_id', 'stripe_payment_intent',
    'calendar_synced', 'email_synced', 'tourflow_synced', 'reminded_at', 'review_requested_at',
  ])('a pre-v2 column name still present: %s', async (column) => {
    await applyRealSchema();
    await db.prepare(`ALTER TABLE bookings ADD COLUMN ${column} TEXT`).run();

    await expectFingerprintCollision();
  });

  it('an index missing: idx_bookings_payment_ref', async () => {
    await applyRealSchema();
    await db.prepare('DROP INDEX idx_bookings_payment_ref').run();

    await expectFingerprintCollision();
  });
});

describe('schema fingerprint catches targeted drift in `side_effect_operations`', () => {
  it.each([
    'idx_side_effect_operations_identity',
    'idx_side_effect_operations_pending',
    'idx_side_effect_operations_reconciliation',
  ])('an index missing: %s', async (index) => {
    await applyRealSchema();
    await db.prepare(`DROP INDEX ${index}`).run();

    await expectFingerprintCollision();
  });

  // The other identity columns are all bound into idx_side_effect_operations_identity, so removing
  // one would damage that clause too; these two are the only ones a single change can reach.
  it.each(['event_payload_json', 'failure_started_at'])('a required column missing: %s', async (column) => {
    await applyRealSchema();
    await db.prepare(`ALTER TABLE side_effect_operations DROP COLUMN ${column}`).run();

    await expectFingerprintCollision();
  });
});

describe('schema fingerprint catches targeted drift in `refund_operations`', () => {
  it.each(['idx_refund_operations_status', 'idx_refund_operations_reconciliation'])(
    'an index missing: %s',
    async (index) => {
      await applyRealSchema();
      await db.prepare(`DROP INDEX ${index}`).run();

      await expectFingerprintCollision();
    },
  );

  // next_attempt_at and attempted_at are both in idx_refund_operations_reconciliation, so dropping
  // either would damage that clause as well.
  it.each(['execution_claim_token', 'execution_claim_until', 'attempt_count', 'failure_started_at'])(
    'a required column missing: %s',
    async (column) => {
      await applyRealSchema();
      await db.prepare(`ALTER TABLE refund_operations DROP COLUMN ${column}`).run();

      await expectFingerprintCollision();
    },
  );
});

describe('schema fingerprint catches targeted drift in `operational_incidents`', () => {
  it('the table missing entirely', async () => {
    await applyRealSchema();
    await db.prepare('DROP TABLE operational_incidents').run();

    await expectFingerprintCollision();
  });

  // 0003 rebuilt the table to let a deployment-wide incident (`reconciliation_stale`) carry no
  // booking; a database still on 0002's NOT NULL rebuild has the same columns, so the ledger is
  // what catches that -- this pins the columns the rebuild kept.
  it.each(['alert_claim_token', 'resolution_kind'])('a required column missing: %s', async (column) => {
    await applyRealSchema();
    await db.prepare(`ALTER TABLE operational_incidents DROP COLUMN ${column}`).run();

    await expectFingerprintCollision();
  });

  it.each(['idx_operational_incidents_open', 'idx_operational_incidents_alert'])(
    'an index missing: %s',
    async (index) => {
      await applyRealSchema();
      await db.prepare(`DROP INDEX ${index}`).run();

      await expectFingerprintCollision();
    },
  );
});

// 0003's own table: a database migrated only as far as 0002 has a complete-looking schema apart
// from this, and the reconciliation lease is what keeps the cron and the ops route from
// double-claiming the same rows.
describe('schema fingerprint catches targeted drift in `reconciliation_lease`', () => {
  it('the table missing entirely', async () => {
    await applyRealSchema();
    await db.prepare('DROP TABLE reconciliation_lease').run();

    await expectFingerprintCollision();
  });

  it.each(['lease_token', 'lease_until', 'last_run_at', 'last_summary'])(
    'a required column missing: %s',
    async (column) => {
      await applyRealSchema();
      await db.prepare(`ALTER TABLE reconciliation_lease DROP COLUMN ${column}`).run();

      await expectFingerprintCollision();
    },
  );
});
