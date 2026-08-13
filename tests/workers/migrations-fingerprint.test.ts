// Plan 008 (audit finding #6): checkBookkitMigrationsApplied's filename ledger alone is fooled by
// a consumer migration that happens to reuse one of bookkit's filenames without ever running
// bookkit's SQL. These tests prove the schema fingerprint added on top of the ledger catches
// exactly that, against real D1 -- a real, fully migrated schema passes; a forged ledger over a
// bare schema fails distinctly; and a real schema stopped before 0012 with a colliding "0012"
// ledger row also fails distinctly (not silently passing on the 0008-0011 columns alone).
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

  it('fails distinctly when a real schema stopped before 0012 has a colliding "0012" ledger row', async () => {
    await resetSchema();
    const before0012 = bindings.TEST_MIGRATIONS.filter((migration) => migration.name !== '0012_calendar_delete_outbox.sql');
    await applyD1Migrations(db, before0012, 'd1_migrations');
    // Simulates a consumer's own migration file reusing bookkit's 0012 filename: the ledger row
    // exists, but bookkit's widened `kind` CHECK (admitting 'calendar_delete') never ran, so a
    // fingerprint that only checked 0008-0011 columns (already present here) would wrongly pass.
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0012_calendar_delete_outbox.sql').run();

    await expect(checkBookkitMigrationsApplied(db)).rejects.toThrow(/dedicated D1 database/);
    await expect(checkBookkitMigrationsApplied(db)).rejects.not.toThrow(/is missing/);
  });
});
