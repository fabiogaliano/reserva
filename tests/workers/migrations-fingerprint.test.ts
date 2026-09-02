// checkReservaMigrationsApplied's filename ledger alone is fooled by a consumer migration reusing
// reserva's filename without running its SQL. These tests prove the schema fingerprint catches that
// against real D1: a fully migrated schema passes, a forged ledger fails, and a schema stopped short of the latest rebuild with a colliding ledger row fails distinctly too.
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

// Every table any of the 12 real migrations creates, so each test can tear the schema back to
// nothing before rebuilding exactly the state its scenario needs -- self-contained regardless of
// whether the pool isolates storage per test.
const RESERVA_TABLES = ['admin_change_history', 'operational_incidents', 'side_effect_operations', 'refund_operations', 'settings', 'capacity_defaults', 'day_overrides', 'bookings'];

async function resetSchema() {
  for (const table of RESERVA_TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await db.prepare('DROP TABLE IF EXISTS d1_migrations').run();
}

describe('checkReservaMigrationsApplied schema fingerprint against real D1', () => {
  it('passes against a real, fully migrated schema', async () => {
    await resetSchema();
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS, 'd1_migrations');

    await expect(checkReservaMigrationsApplied(db)).resolves.toBeUndefined();
  });

  it('fails distinctly (not "missing migrations") when the ledger is forged over a bare schema', async () => {
    await resetSchema();
    // d1_migrations is normally created by wrangler's own migration runner; create it directly
    // since no migration is actually being applied in this scenario -- nothing else in the
    // database was ever built, simulating a consumer database reserva was never really pointed at.
    await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run();
    for (const name of RESERVA_MIGRATIONS) await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();

    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  it('fails distinctly when a real schema stopped before 0013 has a colliding "0013" ledger row', async () => {
    await resetSchema();
    // 0015 and 0018 both rebuild side_effect_operations too, so a real run of either would
    // reestablish 'abandoned' on its own and mask the faked 0013 collision this test targets.
    const before0013 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0013_side_effect_operations_abandoned.sql' && migration.name !== '0015_pickup_options.sql'
      && migration.name !== '0018_v2_domain_rename.sql');
    await applyD1Migrations(db, before0013, 'd1_migrations');
    // Simulates a consumer migration reusing reserva's 0013 filename: the ledger row exists but
    // the widened `status` CHECK never ran, which a fingerprint checking only 'calendar_delete' would miss.
    for (const name of ['0013_side_effect_operations_abandoned.sql', '0015_pickup_options.sql', '0018_v2_domain_rename.sql']) {
      await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
    }

    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  it('fails distinctly when 0011 was skipped even though the later side-effect rebuilds were applied', async () => {
    await resetSchema();
    // 0015 and 0018 both rebuild `bookings` too, so a real run of either would reestablish 0011's
    // CHECKs and partial index on its own, masking the faked 0011 collision this test targets.
    const without0011 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0011_schema_constraints.sql' && migration.name !== '0015_pickup_options.sql'
      && migration.name !== '0018_v2_domain_rename.sql');
    await applyD1Migrations(db, without0011, 'd1_migrations');
    for (const name of ['0011_schema_constraints.sql', '0015_pickup_options.sql', '0018_v2_domain_rename.sql']) {
      await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
    }

    // 0012/0013 recreated the latest side-effect shape, but cannot recreate 0011's bookings CHECKs
    // or partial unique payment-intent index.
    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  // A consumer migration reusing '0014_meeting_points.sql' without running reserva's ALTER TABLE
  // would satisfy the ledger while `bookings` still lacks meeting_point_id/-label —
  // REQUIRED_BOOKINGS_COLUMNS must catch that collision.
  it('fails distinctly when a real schema stopped before 0014 has a colliding "0014" ledger row', async () => {
    await resetSchema();
    // 0015 and 0018's INSERT...SELECT both read meeting_point_id/-label, so neither can run for
    // real against a schema where 0014 never really applied — both must be excluded and faked here too.
    const before0014 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0014_meeting_points.sql' && migration.name !== '0015_pickup_options.sql'
      && migration.name !== '0018_v2_domain_rename.sql');
    await applyD1Migrations(db, before0014, 'd1_migrations');
    for (const name of ['0014_meeting_points.sql', '0015_pickup_options.sql', '0018_v2_domain_rename.sql']) {
      await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
    }

    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  // A consumer migration reusing '0015_pickup_options.sql' without running reserva's rebuild would
  // satisfy the ledger while `bookings` still carries 0011's pickup_type CHECK —
  // bookingsSchemaPresent's negative assertion must catch this.
  it('fails distinctly when a real schema stopped before 0015 has a colliding "0015" ledger row (old pickup_type CHECK still present)', async () => {
    await resetSchema();
    // 0018 rebuilds `bookings` without the old pickup_type CHECK, which would mask the
    // very absence this scenario targets.
    const before0015 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0015_pickup_options.sql' && migration.name !== '0018_v2_domain_rename.sql');
    await applyD1Migrations(db, before0015, 'd1_migrations');
    for (const name of ['0015_pickup_options.sql', '0018_v2_domain_rename.sql']) {
      await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
    }

    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  // A consumer migration reusing '0016_...sql' without running reserva's rebuild would satisfy
  // the ledger while the widened status CHECK, lease columns, and incident table are all still
  // absent — refundOperationsSchemaPresent/operationalIncidentsSchemaPresent must catch this.
  it('fails distinctly when a real schema stopped before 0016 has a colliding "0016" ledger row', async () => {
    await resetSchema();
    // 0017 must be excluded (and faked) too: its rebuild carries 0016's backoff columns forward, so
    // it cannot even execute against a schema where 0016 never really ran.
    // 0018 rebuilds operational_incidents, so it cannot execute where 0016 never created it.
    const before0016 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0016_operational_reconciliation.sql' && migration.name !== '0017_side_effect_operation_identity.sql'
      && migration.name !== '0018_v2_domain_rename.sql');
    await applyD1Migrations(db, before0016, 'd1_migrations');
    for (const name of ['0016_operational_reconciliation.sql', '0017_side_effect_operation_identity.sql', '0018_v2_domain_rename.sql']) {
      await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
    }

    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  // A consumer migration reusing '0017_...sql' without running reserva's identity rebuild leaves
  // the outbox addressed by the retired `kind` column — sideEffectOperationsSchemaPresent must catch it.
  it('fails distinctly when a real schema stopped before 0017 has a colliding "0017" ledger row', async () => {
    await resetSchema();
    // 0018's side_effect_operations copy reads the identity columns 0017 introduces.
    const before0017 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0017_side_effect_operation_identity.sql' && migration.name !== '0018_v2_domain_rename.sql');
    await applyD1Migrations(db, before0017, 'd1_migrations');
    for (const name of ['0017_side_effect_operation_identity.sql', '0018_v2_domain_rename.sql']) {
      await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
    }

    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  // A consumer migration reusing '0018_v2_domain_rename.sql' without running reserva's rebuild
  // leaves `bookings` on the pre-v2 shape (currency absent) — every read in src/repo.ts would fail,
  // so REMOVED_BOOKINGS_COLUMNS must catch the collision.
  it('fails distinctly when a real schema stopped before 0018 has a colliding "0018" ledger row', async () => {
    await resetSchema();
    const before0018 = bindings.TEST_MIGRATIONS.filter((migration) => migration.name !== '0018_v2_domain_rename.sql');
    await applyD1Migrations(db, before0018, 'd1_migrations');
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0018_v2_domain_rename.sql').run();

    await expect(checkReservaMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkReservaMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });
});
