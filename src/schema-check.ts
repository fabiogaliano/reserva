import type { OpsHealthSchema } from './core/api.js';
import { RESERVA_MIGRATIONS } from './migrations-manifest.js';

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

// The filename ledger alone is fooled by a consumer migration that
// happens to reuse one of reserva's filenames without ever running reserva's SQL — d1_migrations
// only records names, never checksums or content. This is cheap, read-only detection (not a fix —
// a fully namespaced ledger would need more), spanning the migrations that
// introduced reserva's current shape: required `bookings` columns, migration 0018's v2 domain
// CHECKs and partial unique payment-ref index, plus the `side_effect_operations` table/index and
// its current identity/`status` CHECKs.
const REQUIRED_BOOKINGS_COLUMNS = [
  'occupancy_units', // 0008
  'cancel_token_hash', 'operator_token_hash', 'cancel_token_revoked_at', // 0009
  'reschedule_transition_version', // 0010
  'meeting_point_id', // 0014
  'currency', 'metadata', // 0018
] as const;

// The v2 rebuild renamed or dropped these. A consumer migration that
// collides with '0018_v2_domain_rename.sql' without running its SQL keeps them, and every repo
// query would then fail against a schema the ledger reports as current.
// Pre-v2 column names on purpose: this list is the "the old shape is still here" probe, so it must
// not follow the rename.
const REMOVED_BOOKINGS_COLUMNS = [
  'tour_slug', 'people', 'price_cents', 'stripe_session_id', 'stripe_payment_intent',
  'calendar_synced', 'email_synced', 'tourflow_synced', 'reminded_at', 'review_requested_at',
] as const;

async function bookingsSchemaPresent(db: MigrationsQueryable): Promise<boolean> {
  const [columnsResult, schemaResult] = await Promise.all([
    db.prepare('PRAGMA table_info(bookings)').all<{ name: string }>(),
    db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name IN ('bookings', 'idx_bookings_payment_ref')`)
      .all<{ type: string; name: string; sql: string | null }>(),
  ]);
  const columns = new Set(columnsResult.results.map((row) => row.name));
  if (!REQUIRED_BOOKINGS_COLUMNS.every((column) => columns.has(column))) return false;
  if (REMOVED_BOOKINGS_COLUMNS.some((column) => columns.has(column))) return false;

  const table = schemaResult.results.find((row) => row.type === 'table' && row.name === 'bookings');
  const paymentIndex = schemaResult.results.find((row) => row.type === 'index' && row.name === 'idx_bookings_payment_ref');
  const tableSql = table?.sql?.toLowerCase().replace(/\s+/g, '') ?? '';
  const indexSql = paymentIndex?.sql?.toLowerCase().replace(/\s+/g, '') ?? '';
  const requiredChecks = [
    'check(quantity>0)',
    'check(ends_at>starts_at)',
    'check(price_minor>=0)',
    "check(statusin('hold','confirmed','cancelled','expired','no_show'))",
    "check(cancelled_byin('customer','operator')orcancelled_byisnull)",
  ];
  const paymentIndexSql = 'createuniqueindexidx_bookings_payment_refonbookings(payment_ref)wherepayment_refisnotnull';
  // pickup_type's domain moved from a fixed SQL CHECK to
  // config-declared option ids (ServiceConfig.pickupOptions), which the DB can't enumerate.
  // It also stopped being NOT NULL, so a service with no location module can store NULL
  // instead of a sentinel id. Both are NEGATIVE assertions — a colliding consumer migration leaves
  // the old CHECK (rejecting every declared id) or the old NOT NULL (rejecting the location-less
  // row), and neither shows up as a missing column.
  const hasPickupTypeCheck = tableSql.includes("check(pickup_typein(");
  const hasPickupTypeNotNull = tableSql.includes('pickup_typetextnotnull');
  return requiredChecks.every((check) => tableSql.includes(check))
    && !hasPickupTypeCheck && !hasPickupTypeNotNull && indexSql.includes(paymentIndexSql);
}

async function sideEffectOperationsSchemaPresent(db: MigrationsQueryable): Promise<boolean> {
  const [result, columnsResult] = await Promise.all([
    db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name IN ('side_effect_operations', 'idx_side_effect_operations_pending', 'idx_side_effect_operations_reconciliation', 'idx_side_effect_operations_identity')`)
      .all<{ type: string; name: string; sql: string | null }>(),
    db.prepare('PRAGMA table_info(side_effect_operations)').all<{ name: string }>(),
  ]);
  const table = result.results.find((row) => row.type === 'table' && row.name === 'side_effect_operations');
  const index = result.results.find((row) => row.type === 'index' && row.name === 'idx_side_effect_operations_pending');
  // The reconciliation index and the two nullable backoff columns it
  // supports are additive-only, but a consumer migration colliding with '0016_...sql' without ever
  // running reserva's ALTER TABLE would still satisfy the ledger while leaving both absent — same
  // collision class REQUIRED_BOOKINGS_COLUMNS already guards for `bookings`.
  const reconciliationIndex = result.results.find((row) => row.type === 'index' && row.name === 'idx_side_effect_operations_reconciliation');
  // Identity moved from the single `kind` string to family/name/event/discriminator, and
  // dedupe now depends on the COALESCE expression index (SQLite treats NULLs in a plain UNIQUE as
  // distinct, so without this exact index every enqueue would insert a duplicate row instead of
  // hitting ON CONFLICT DO NOTHING) — a 0017 filename collision has to fail loudly here.
  const identityIndex = result.results.find((row) => row.type === 'index' && row.name === 'idx_side_effect_operations_identity');
  const tableSql = table?.sql?.toLowerCase().replace(/\s+/g, '') ?? '';
  const columns = new Set(columnsResult.results.map((row) => row.name));
  return Boolean(index) && Boolean(reconciliationIndex) && Boolean(identityIndex)
    && tableSql.includes("familyin('calendar_create','calendar_delete','email_confirmation','oversell','email','hook','webhook')")
    && tableSql.includes('abandoned')
    && columns.has('family') && columns.has('name') && columns.has('event') && columns.has('discriminator')
    && columns.has('event_payload_json') && !columns.has('kind')
    && columns.has('failure_started_at') && columns.has('next_attempt_at');
}

// refund_operations previously had no fingerprint check
// (only the filename ledger guarded it) — migration 0016 is the first rebuild of this table, so it
// needs the same "does the schema actually match, not just the ledger" guard every other rebuilt
// table already has.
async function refundOperationsSchemaPresent(db: MigrationsQueryable): Promise<boolean> {
  const [result, columnsResult] = await Promise.all([
    db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name IN ('refund_operations', 'idx_refund_operations_status', 'idx_refund_operations_reconciliation')`)
      .all<{ type: string; name: string; sql: string | null }>(),
    db.prepare('PRAGMA table_info(refund_operations)').all<{ name: string }>(),
  ]);
  const table = result.results.find((row) => row.type === 'table' && row.name === 'refund_operations');
  const statusIndex = result.results.find((row) => row.type === 'index' && row.name === 'idx_refund_operations_status');
  const reconciliationIndex = result.results.find((row) => row.type === 'index' && row.name === 'idx_refund_operations_reconciliation');
  const columns = new Set(columnsResult.results.map((row) => row.name));
  const tableSql = table?.sql?.toLowerCase().replace(/\s+/g, '') ?? '';
  return Boolean(statusIndex) && Boolean(reconciliationIndex)
    && tableSql.includes("statusin('requested','in_flight','succeeded','failed','abandoned')")
    && columns.has('execution_claim_token') && columns.has('execution_claim_until')
    && columns.has('attempt_count') && columns.has('attempted_at')
    && columns.has('failure_started_at') && columns.has('next_attempt_at');
}

async function operationalIncidentsSchemaPresent(db: MigrationsQueryable): Promise<boolean> {
  const result = await db
    .prepare(`SELECT type, name FROM sqlite_master WHERE name IN ('operational_incidents', 'idx_operational_incidents_open', 'idx_operational_incidents_alert')`)
    .all<{ type: string; name: string }>();
  return ['operational_incidents', 'idx_operational_incidents_open', 'idx_operational_incidents_alert']
    .every((name) => result.results.some((row) => row.name === name));
}

async function reservaSchemaFingerprintPresent(db: MigrationsQueryable): Promise<boolean> {
  const [bookingsOk, sideEffectOk, refundOk, incidentsOk] = await Promise.all([
    bookingsSchemaPresent(db),
    sideEffectOperationsSchemaPresent(db),
    refundOperationsSchemaPresent(db),
    operationalIncidentsSchemaPresent(db),
  ]);
  return bookingsOk && sideEffectOk && refundOk && incidentsOk;
}

function migrationCollisionErrorMessage(): string {
  return "Reserva's D1 migration ledger reports every migration applied, but the schema itself "
    + 'doesn\'t match reserva\'s migrations. This usually means one of your own migration files '
    + 'happens to share a filename with one of reserva\'s, so its ledger entry satisfied reserva\'s '
    + "check without reserva's SQL ever running. Use a dedicated D1 database for reserva instead of "
    + 'sharing one with your own migrations.';
}

// Runs once per isolate (the caller memoizes this), never per request: a raw D1 SQL error from a
// missing column/table is the single most confusing failure mode for a new consumer, so this turns
// it into a named list of missing migrations and the exact command to fix it. Tolerant of extra,
// consumer-owned migrations — only reserva's own filenames are asserted present.
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
