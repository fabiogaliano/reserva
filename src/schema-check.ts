import type { OpsHealthSchema } from './core/api.js';
import { RESERVA_MIGRATIONS, RESERVA_SCHEMA_TABLES } from './generated/schema-fingerprint.js';

export const D1_MIGRATIONS_TABLE = 'd1_migrations';
const migrationsTableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function requireMigrationsTableName(migrationsTable: string): string {
  if (!migrationsTableNamePattern.test(migrationsTable)) {
    throw new Error('Cloudflare migrationsTable must be a SQLite identifier containing only letters, numbers, and underscores');
  }
  return migrationsTable;
}

// The minimal D1 surface the migration check needs (rather than the full D1Database type), so it
// can be exercised in tests against a lightweight fake without standing up a real binding.
export interface MigrationsQueryable {
  prepare(query: string): { all<T = unknown>(): Promise<{ results: T[] }> };
}

// Structural presence check rather than catching the SELECT's error: D1 error message text isn't
// a stable contract to sniff, and coalescing every failure (including transient ones) into "zero
// applied" would misreport a real DB error as a missing-migrations problem.
async function migrationsTableExists(db: MigrationsQueryable, migrationsTable: string): Promise<boolean> {
  const result = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${migrationsTable}'`)
    .all<{ name: string }>();
  return result.results.length > 0;
}

async function appliedMigrationNames(db: MigrationsQueryable, migrationsTable: string): Promise<Set<string>> {
  // `wrangler d1 migrations apply` creates d1_migrations on its first run; a database that has
  // never been migrated at all surfaces the same "nothing applied yet" guidance below. Once the
  // table exists, any error from the real query is a genuine DB failure and must propagate as-is.
  const tableExists = await migrationsTableExists(db, migrationsTable);
  if (!tableExists) return new Set();
  const result = await db.prepare(`SELECT name FROM ${migrationsTable}`).all<{ name: string }>();
  return new Set(result.results.map((row) => row.name));
}

function migrationsErrorMessage(missing: readonly string[]): string {
  const noun = missing.length === 1 ? 'migration' : 'migrations';
  return `Reserva's D1 schema is missing ${noun}: ${missing.join(', ')}. Point your D1 binding's `
    + `migrations_dir at reserva's migrations/ directory, then apply them with `
    + '`wrangler d1 migrations apply <database_name> --local` (dev) or '
    + '`wrangler d1 migrations apply <database_name>` (prod) — or run `bunx reserva-migrate --local` '
    + '/ `bunx reserva-migrate` from the project that owns wrangler.jsonc.';
}

// The filename ledger alone is fooled by a consumer migration that reuses one of reserva's
// filenames without running reserva's SQL — d1_migrations only records names, never content. This
// is cheap, read-only detection (not a fix), comparing the live database against the schema
// replayed from migrations/*.sql at build time.

// A consumer migration that collides with reserva's own rename migration without running its SQL
// keeps these columns, and every repo query would then fail against a schema the ledger reports as
// current. Pre-v2 names: this list probes "the old shape is still here," so it must not follow the rename.
const REMOVED_BOOKINGS_COLUMNS = [
  'tour_slug', 'people', 'price_cents', 'stripe_session_id', 'stripe_payment_intent',
  'calendar_synced', 'email_synced', 'tourflow_synced', 'reminded_at', 'review_requested_at',
] as const;

async function tableColumns(db: MigrationsQueryable, table: string): Promise<Set<string>> {
  // Table names come from the generated fingerprint, never from user input, so interpolating them
  // into the PRAGMA (which takes no bound parameters) is safe.
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(result.results.map((row) => row.name));
}

async function indexNamesByTable(db: MigrationsQueryable): Promise<Map<string, Set<string>>> {
  const result = await db
    .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'")
    .all<{ name: string; tbl_name: string }>();
  const byTable = new Map<string, Set<string>>();
  for (const row of result.results) {
    const names = byTable.get(row.tbl_name) ?? new Set<string>();
    names.add(row.name);
    byTable.set(row.tbl_name, names);
  }
  return byTable;
}

async function reservaSchemaFingerprintPresent(db: MigrationsQueryable): Promise<boolean> {
  const tableNames = Object.keys(RESERVA_SCHEMA_TABLES);
  const [indexes, columnSets] = await Promise.all([
    indexNamesByTable(db),
    Promise.all(tableNames.map((table) => tableColumns(db, table))),
  ]);
  for (const [position, table] of tableNames.entries()) {
    const expected = RESERVA_SCHEMA_TABLES[table]!;
    const columns = columnSets[position]!;
    if (columns.size === 0) return false;
    if (!expected.columns.every((column) => columns.has(column))) return false;
    const liveIndexes = indexes.get(table) ?? new Set<string>();
    if (!expected.indexes.every((index) => liveIndexes.has(index))) return false;
  }
  const bookingsColumns = columnSets[tableNames.indexOf('bookings')];
  if (bookingsColumns && REMOVED_BOOKINGS_COLUMNS.some((column) => bookingsColumns.has(column))) return false;
  return true;
}

function migrationCollisionErrorMessage(): string {
  return "Reserva's D1 migration ledger reports every migration applied, but the schema itself "
    + 'doesn\'t match reserva\'s migrations. This usually means one of your own migration files '
    + 'happens to share a filename with one of reserva\'s, so its ledger entry satisfied reserva\'s '
    + "check without reserva's SQL ever running. Use a dedicated D1 database for reserva instead of "
    + 'sharing one with your own migrations.';
}

// Runs once per isolate, never per request: a raw D1 SQL error from a missing column/table is the
// most confusing failure mode for a new consumer, so this turns it into a named list of missing
// migrations and the exact fix. Tolerant of extra, consumer-owned migrations.
export async function checkReservaMigrationsApplied(
  db: MigrationsQueryable,
  migrationsTable = D1_MIGRATIONS_TABLE,
): Promise<void> {
  const status = await reservaMigrationStatus(db, migrationsTable);
  if (status.detail !== null) throw new Error(status.detail);
}

// The same check, reported instead of thrown, so the ops-health
// endpoint can answer "is this deployment current?" with the exact facts (and the exact remediating
// message) the isolate-time guard uses — one code path, two audiences.
export async function reservaMigrationStatus(
  db: MigrationsQueryable,
  migrationsTable = D1_MIGRATIONS_TABLE,
): Promise<OpsHealthSchema> {
  const applied = await appliedMigrationNames(db, requireMigrationsTableName(migrationsTable));
  const missingMigrations = RESERVA_MIGRATIONS.filter((name) => !applied.has(name));
  if (missingMigrations.length > 0) {
    return { ok: false, missingMigrations, fingerprintOk: false, detail: migrationsErrorMessage(missingMigrations) };
  }
  const fingerprintOk = await reservaSchemaFingerprintPresent(db);
  return {
    ok: fingerprintOk,
    missingMigrations: [],
    fingerprintOk,
    detail: fingerprintOk ? null : migrationCollisionErrorMessage(),
  };
}
