// checkReservaMigrationsApplied's filename ledger alone is fooled by a consumer migration reusing
// reserva's filename without running its SQL. These tests prove the schema fingerprint catches that
// against real D1: the shipped schema passes, and every clause the fingerprint asserts -- columns,
// CHECKs, and indexes -- is pinned by damaging exactly that one thing while the ledger stays complete.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RESERVA_MIGRATIONS } from '../../src/migrations-manifest';
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
const RESERVA_TABLES = ['admin_change_history', 'operational_incidents', 'side_effect_operations', 'refund_operations', 'settings', 'capacity_defaults', 'day_overrides', 'bookings'];

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

// SQLite can't ALTER a CHECK constraint and the fingerprint reads sqlite_master text, so damage to a
// constraint has to be baked into the DDL: rewrite the CREATE TABLE, then restore every explicitly
// created index (auto-indexes from UNIQUE/PRIMARY KEY have a NULL sql and come back with the table).
async function rewriteTable(table: string, edit: (createTableSql: string) => string) {
  const schema = await db.prepare(`SELECT type, sql FROM sqlite_master WHERE tbl_name = '${table}'`)
    .all<{ type: string; sql: string | null }>();
  const createTable = schema.results.find((row) => row.type === 'table')?.sql;
  if (!createTable) throw new Error(`${table} is not in sqlite_master`);
  const indexes = schema.results.filter((row) => row.type === 'index' && row.sql !== null).map((row) => row.sql as string);
  const rewritten = edit(createTable);
  if (rewritten === createTable) throw new Error(`rewriteTable(${table}) changed nothing`);

  await db.prepare(`DROP TABLE ${table}`).run();
  await db.prepare(rewritten).run();
  for (const indexSql of indexes) await db.prepare(indexSql).run();
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
  // The token-hash columns carry unique indexes the fingerprint never inspects, and SQLite refuses
  // to drop an indexed column, so the index goes first -- the fingerprint still sees one change.
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

  it.each([
    'CHECK (quantity > 0)',
    'CHECK (ends_at > starts_at)',
    'CHECK (price_minor >= 0)',
    "CHECK (status IN ('hold','confirmed','cancelled','expired','no_show'))",
    "CHECK (cancelled_by IN ('customer','operator') OR cancelled_by IS NULL)",
  ])('a CHECK constraint absent: %s', async (check) => {
    await applyRealSchema();
    await rewriteTable('bookings', (sql) => sql.replace(check, ''));

    await expectFingerprintCollision();
  });

  it('the retired pickup_type CHECK back in place', async () => {
    await applyRealSchema();
    await rewriteTable('bookings', (sql) =>
      sql.replace(/pickup_type\s+TEXT,/, "pickup_type TEXT CHECK (pickup_type IN ('default','custom')),"));

    await expectFingerprintCollision();
  });

  it('pickup_type NOT NULL again', async () => {
    await applyRealSchema();
    await rewriteTable('bookings', (sql) => sql.replace(/pickup_type\s+TEXT,/, 'pickup_type TEXT NOT NULL,'));

    await expectFingerprintCollision();
  });

  it('idx_bookings_payment_ref present but no longer partial', async () => {
    await applyRealSchema();
    await db.prepare('DROP INDEX idx_bookings_payment_ref').run();
    // Name and uniqueness alone aren't enough: without the WHERE clause every NULL payment_ref
    // would collide, so the fingerprint has to compare the index SQL, not just find the name.
    await db.prepare('CREATE UNIQUE INDEX idx_bookings_payment_ref ON bookings (payment_ref)').run();

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

  it('the retired `kind` identity column still present', async () => {
    await applyRealSchema();
    await db.prepare('ALTER TABLE side_effect_operations ADD COLUMN kind TEXT').run();

    await expectFingerprintCollision();
  });

  // The other identity columns are all bound into idx_side_effect_operations_identity, so removing
  // one would damage that clause too; these two are the only ones a single change can reach.
  it.each(['event_payload_json', 'failure_started_at'])('a required column missing: %s', async (column) => {
    await applyRealSchema();
    await db.prepare(`ALTER TABLE side_effect_operations DROP COLUMN ${column}`).run();

    await expectFingerprintCollision();
  });

  it('a family missing from the family CHECK', async () => {
    await applyRealSchema();
    await rewriteTable('side_effect_operations', (sql) => sql.replace(/,\s*'webhook'/, ''));

    await expectFingerprintCollision();
  });

  it("'abandoned' missing from the status CHECK", async () => {
    await applyRealSchema();
    await rewriteTable('side_effect_operations', (sql) => sql.replace(/,'abandoned'/, ''));

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

  it("'abandoned' missing from the widened status CHECK", async () => {
    await applyRealSchema();
    await rewriteTable('refund_operations', (sql) => sql.replace(/,'abandoned'/, ''));

    await expectFingerprintCollision();
  });
});

describe('schema fingerprint catches targeted drift in `operational_incidents`', () => {
  it('the table missing entirely', async () => {
    await applyRealSchema();
    await db.prepare('DROP TABLE operational_incidents').run();

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
