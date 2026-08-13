// Plan 008 (audit finding #6): checkBookkitMigrationsApplied's filename ledger alone is fooled by
// a consumer migration that happens to reuse one of bookkit's filenames without ever running
// bookkit's SQL. These tests prove the schema fingerprint added on top of the ledger catches
// exactly that, against real D1 -- a real, fully migrated schema passes; a forged ledger over a
// bare schema fails distinctly; and a real schema stopped before the LATEST side_effect_operations
// rebuild (0013, plan 016) with a colliding ledger row for it also fails distinctly (not silently
// passing on 0008-0012 alone).
//
// Plan 016: this third scenario used to target a collision on 0012 specifically. It must target
// the CURRENT latest side_effect_operations rebuild instead, because every later full-table
// rebuild (0013's ALTER TABLE RENAME -> CREATE TABLE -> INSERT...SELECT, same shape as 0012's own
// rebuild) unconditionally re-establishes the FULL target `kind` CHECK regardless of whether an
// earlier rebuild in the chain (like 0012) actually ran for real -- so once 0013 exists, a
// 0012-specific collision test can no longer fail even with the schema fingerprint working
// correctly. sideEffectOperationsSchemaPresent (src/runtime-context.ts) now also checks for 0013's
// 'abandoned' status, keeping this detector accurate for the actual latest rebuild.
//
// Plan 017 (design decision 6): 0014 adds two plain additive `bookings` columns rather than
// rebuilding a table, so it's covered the same way as 0008-0010's columns (REQUIRED_BOOKINGS_COLUMNS
// in src/runtime-context.ts), not by sideEffectOperationsSchemaPresent's rebuild-shape checks.
//
// Plan 018 (design decision 5): 0015 rebuilds `bookings` again, this time REMOVING the pickup_type
// CHECK (domain moved to config-declared option ids). bookingsSchemaPresent now asserts its ABSENCE
// instead of its presence -- a schema stopped before 0015 still has the old CHECK, so a colliding
// "0015" ledger row must fail the same way every other rebuild-collision scenario here does.
//
// 0015 is now ALSO the CURRENT latest rebuild for BOTH tables at once: it rebuilds `bookings`
// itself (reestablishing every one of 0011's other CHECKs and the partial index verbatim, same
// "later rebuild re-establishes the full target shape" fact the 0012-to-0013 note above already
// describes) AND, as a side effect of its FK-hold/restore dance around dropping `bookings` (see
// that migration's header), rebuilds `side_effect_operations` too, reestablishing 0013's 'abandoned'
// status. So a REAL 0015 run now masks a faked/skipped 0011 or 0013 exactly the way 0013 already
// masked 0012 -- the "0013 skipped" and "0011 skipped" scenarios below must fake 0015's ledger row
// too (real 0015 excluded) to still isolate their own target migration's absence. And 0015's own
// INSERT...SELECT reads meeting_point_id/meeting_point_label (0014), so a real 0015 run can't even
// execute against a schema where 0014 didn't really apply -- the "0014 skipped" scenario must do
// the same for the same structural reason, not just to preserve test intent.
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BOOKKIT_MIGRATIONS } from '../../src/migrations-manifest';
import { checkBookkitMigrationsApplied } from '../../src/runtime-context';

interface TestEnv {
  BOOKKIT_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
const db = bindings.BOOKKIT_DB;

// Every table any of the 12 real migrations creates, so each test can tear the schema back to
// nothing before rebuilding exactly the state its scenario needs -- self-contained regardless of
// whether the pool isolates storage per test.
const BOOKKIT_TABLES = ['side_effect_operations', 'refund_operations', 'settings', 'capacity_defaults', 'day_overrides', 'bookings'];

async function resetSchema() {
  for (const table of BOOKKIT_TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await db.prepare('DROP TABLE IF EXISTS d1_migrations').run();
}

describe('checkBookkitMigrationsApplied schema fingerprint against real D1', () => {
  it('passes against a real, fully migrated schema', async () => {
    await resetSchema();
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS, 'd1_migrations');

    await expect(checkBookkitMigrationsApplied(db)).resolves.toBeUndefined();
  });

  it('fails distinctly (not "missing migrations") when the ledger is forged over a bare schema', async () => {
    await resetSchema();
    // d1_migrations is normally created by wrangler's own migration runner; create it directly
    // since no migration is actually being applied in this scenario -- nothing else in the
    // database was ever built, simulating a consumer database bookkit was never really pointed at.
    await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run();
    for (const name of BOOKKIT_MIGRATIONS) await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();

    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkBookkitMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  it('fails distinctly when a real schema stopped before 0013 has a colliding "0013" ledger row', async () => {
    await resetSchema();
    // 0015 must be excluded (and faked) here too -- plan 018's 0015 also rebuilds
    // side_effect_operations (see the file header above), so a REAL 0015 run would otherwise
    // reestablish 'abandoned' on its own and mask the faked 0013 collision this test targets.
    const before0013 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0013_side_effect_operations_abandoned.sql' && migration.name !== '0015_pickup_options.sql');
    await applyD1Migrations(db, before0013, 'd1_migrations');
    // Simulates a consumer's own migration file reusing bookkit's 0013 filename: the ledger row
    // exists, but bookkit's widened `status` CHECK (admitting 'abandoned') never ran, so a
    // fingerprint that only checked for 'calendar_delete' (already present here, from the real
    // 0012 that DID run) would wrongly pass.
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0013_side_effect_operations_abandoned.sql').run();
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0015_pickup_options.sql').run();

    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkBookkitMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  it('fails distinctly when 0011 was skipped even though the later side-effect rebuilds were applied', async () => {
    await resetSchema();
    // 0015 must be excluded (and faked) here too -- it rebuilds `bookings` itself and would
    // otherwise reestablish every one of 0011's CHECKs and the partial index on its own, masking
    // the faked 0011 collision this test targets (same reasoning as the 0013 test above).
    const without0011 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0011_schema_constraints.sql' && migration.name !== '0015_pickup_options.sql');
    await applyD1Migrations(db, without0011, 'd1_migrations');
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0011_schema_constraints.sql').run();
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0015_pickup_options.sql').run();

    // 0012/0013 recreated the latest side-effect shape, but cannot recreate 0011's bookings CHECKs
    // or partial unique payment-intent index.
    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkBookkitMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  // Plan 017 (design decision 6): a consumer migration reusing the '0014_meeting_points.sql'
  // filename without ever running bookkit's ALTER TABLE would otherwise satisfy the ledger while
  // leaving `bookings` without meeting_point_id/meeting_point_label -- REQUIRED_BOOKINGS_COLUMNS
  // (src/runtime-context.ts) must catch that collision the same way it already does for 0008-0010.
  it('fails distinctly when a real schema stopped before 0014 has a colliding "0014" ledger row', async () => {
    await resetSchema();
    // Plan 018: 0015's own INSERT...SELECT reads meeting_point_id/meeting_point_label, so it
    // cannot run for real against a schema where 0014 never really applied -- it must be excluded
    // (and faked) here too, structurally, not just to preserve this test's original intent.
    const before0014 = bindings.TEST_MIGRATIONS.filter((migration) =>
      migration.name !== '0014_meeting_points.sql' && migration.name !== '0015_pickup_options.sql');
    await applyD1Migrations(db, before0014, 'd1_migrations');
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0014_meeting_points.sql').run();
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0015_pickup_options.sql').run();

    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkBookkitMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });

  // Plan 018 (design decision 5): a consumer migration reusing the '0015_pickup_options.sql'
  // filename without ever running bookkit's rebuild would satisfy the ledger while `bookings` still
  // carries 0011's pickup_type CHECK -- bookingsSchemaPresent's negative assertion (it must NOT find
  // that CHECK) must catch this the same way the positive-presence checks catch every other collision.
  it('fails distinctly when a real schema stopped before 0015 has a colliding "0015" ledger row (old pickup_type CHECK still present)', async () => {
    await resetSchema();
    const before0015 = bindings.TEST_MIGRATIONS.filter((migration) => migration.name !== '0015_pickup_options.sql');
    await applyD1Migrations(db, before0015, 'd1_migrations');
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0015_pickup_options.sql').run();

    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkBookkitMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });
});
