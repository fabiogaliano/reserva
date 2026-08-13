import type { D1Database } from '@cloudflare/workers-types';
import { verifyAccessJwt } from './access';
import { createBookkitContext, type BookkitCache, type BookkitContext, type BookkitContextInput, type BookkitProviders, type BookkitLogger } from './context';
import { validateConfig, type ClientConfig } from './core/config';
import { BOOKKIT_MIGRATIONS } from './migrations-manifest';

export interface BookkitRuntimeRequest {
  request: Request;
  locals?: unknown;
}

export interface BookkitRuntimeDefinition {
  readonly config: ClientConfig;
  createContext(input: BookkitRuntimeRequest): BookkitContext | Promise<BookkitContext>;
}

// Alias for the shape the injected `virtual:bookkit/runtime` type declaration points consumers at.
export type BookkitRuntime = BookkitRuntimeDefinition;

export interface BookkitRuntimeFactoryOptions {
  config: unknown;
  createContext(input: BookkitRuntimeRequest & { config: ClientConfig }): BookkitContextInput | Promise<BookkitContextInput>;
}

// The minimal env surface bookkit itself reads (db/cache/secrets). Consumers pass their
// `wrangler types`-generated Env, which structurally satisfies this, as the TEnv type argument
// to get keyof-checked binding names and a typed `env` in provider factories instead of `unknown`.
// No index signature here: a real wrangler-generated Env has none either, and a generic
// constraint with a string index signature would reject any type that lacks one.
export interface BookkitEnvShape {
  BOOKKIT_DB?: D1Database;
  BOOKKIT_CACHE?: unknown;
}

// Default TEnv for the zero-config path (no type argument supplied): adds the index signature so
// bare-string binding-name options keep accepting arbitrary names, same as before this change.
type UntypedBookkitEnv = BookkitEnvShape & Record<string, unknown>;

export interface CloudflareRuntimeBindings<TEnv extends object = UntypedBookkitEnv> {
  env: TEnv;
  request: Request;
  locals?: unknown;
  config: ClientConfig;
}

export type CloudflareBinding<T, TEnv extends object = UntypedBookkitEnv> =
  (keyof TEnv & string) | ((bindings: CloudflareRuntimeBindings<TEnv>) => T | undefined);

export interface CloudflareBookkitRuntimeOptions<TEnv extends object = UntypedBookkitEnv> {
  db?: CloudflareBinding<D1Database, TEnv>;
  cache?: CloudflareBinding<BookkitCache, TEnv> | null;
  providers: BookkitProviders | ((bindings: CloudflareRuntimeBindings<TEnv>) => BookkitProviders | Promise<BookkitProviders>);
  secretBindings?: ReadonlyArray<keyof TEnv & string>;
  verifyAccess?: (bindings: CloudflareRuntimeBindings<TEnv>) => boolean | Promise<boolean>;
  logger?: BookkitLogger | ((bindings: CloudflareRuntimeBindings<TEnv>) => BookkitLogger);
  migrationsTable?: string;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

export function getEnv(locals: unknown): Record<string, unknown> {
  const root = objectRecord(locals);
  const directEnv = objectRecord(root?.env);
  if (directEnv) return directEnv;
  throw new Error('Cloudflare environment bindings are unavailable in locals');
}

async function getWorkerEnv<TEnv extends object>(locals: unknown): Promise<TEnv> {
  try {
    return getEnv(locals) as unknown as TEnv;
  } catch {
    const module = await import('cloudflare:workers');
    return module.env as unknown as TEnv;
  }
}

async function getWorkerWaitUntil(): Promise<((promise: Promise<unknown>) => void) | undefined> {
  try {
    const module = await import('cloudflare:workers');
    return module.waitUntil;
  } catch {
    return undefined;
  }
}

export function getCache(locals: unknown, binding = 'BOOKKIT_CACHE'): BookkitCache | undefined {
  try {
    const candidate = getEnv(locals)[binding];
    if (candidate && typeof candidate === 'object' && 'match' in candidate && 'put' in candidate) return candidate as BookkitCache;
  } catch {
    // Cloudflare exposes Cache API globally rather than through Astro locals.
  }
  const workerCaches = (globalThis as typeof globalThis & { caches?: { default?: BookkitCache } }).caches;
  return workerCaches?.default;
}

function resolveBinding<T, TEnv extends object>(
  binding: CloudflareBinding<T, TEnv> | undefined,
  input: CloudflareRuntimeBindings<TEnv>,
  name: string,
): T | undefined {
  if (typeof binding === 'function') return binding(input);
  // Binding names are keyof-checked at the options call site; this remains the low-level, unchecked escape hatch.
  const candidate = (input.env as Record<string, unknown>)[binding ?? name];
  return candidate as T | undefined;
}

// Validates the D1 shape at context-creation time so a misconfigured/mistyped binding fails with
// this descriptive error immediately, instead of surfacing as "db.prepare is not a function" on first query.
function isD1Like(value: unknown): value is D1Database {
  return typeof value === 'object' && value !== null && typeof (value as { prepare?: unknown }).prepare === 'function';
}

const D1_MIGRATIONS_TABLE = 'd1_migrations';
const migrationsTableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireMigrationsTableName(migrationsTable: string): string {
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
  return `Bookkit's D1 schema is missing ${noun}: ${missing.join(', ')}. Point your D1 binding's `
    + `migrations_dir at bookkit's migrations/ directory, then apply them with `
    + '`wrangler d1 migrations apply <database_name> --local` (dev) or '
    + '`wrangler d1 migrations apply <database_name>` (prod) — or run `bunx bookkit-migrate --local` '
    + '/ `bunx bookkit-migrate` from the project that owns wrangler.jsonc.';
}

// Plan 008 (audit finding #6): the filename ledger alone is fooled by a consumer migration that
// happens to reuse one of bookkit's filenames without ever running bookkit's SQL — d1_migrations
// only records names, never checksums or content. This is cheap, read-only detection (not a fix:
// a fully namespaced ledger is deferred, see docs/plans/008), spanning the migrations that
// introduced bookkit's current shape (0008-0013): required `bookings` columns, migration 0011's
// domain CHECKs and partial unique payment-intent index, plus the `side_effect_operations`
// table/index and its current `kind`/`status` CHECKs. The 0011 artifacts matter independently:
// later side-effect table rebuilds can make 0012/0013 look current even when 0011 was skipped.
const REQUIRED_BOOKINGS_COLUMNS = [
  'occupancy_units', // 0008
  'cancel_token_hash', 'operator_token_hash', 'cancel_token_revoked_at', // 0009
  'reschedule_transition_version', // 0010
  'meeting_point_id', // 0014
] as const;

async function bookingsSchemaPresent(db: MigrationsQueryable): Promise<boolean> {
  const [columnsResult, schemaResult] = await Promise.all([
    db.prepare('PRAGMA table_info(bookings)').all<{ name: string }>(),
    db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name IN ('bookings', 'idx_bookings_payment_intent')`)
      .all<{ type: string; name: string; sql: string | null }>(),
  ]);
  const columns = new Set(columnsResult.results.map((row) => row.name));
  if (!REQUIRED_BOOKINGS_COLUMNS.every((column) => columns.has(column))) return false;

  const table = schemaResult.results.find((row) => row.type === 'table' && row.name === 'bookings');
  const paymentIndex = schemaResult.results.find((row) => row.type === 'index' && row.name === 'idx_bookings_payment_intent');
  const tableSql = table?.sql?.toLowerCase().replace(/\s+/g, '') ?? '';
  const indexSql = paymentIndex?.sql?.toLowerCase().replace(/\s+/g, '') ?? '';
  const requiredChecks = [
    'check(people>0)',
    "check(pickup_typein('default','custom'))",
    'check(ends_at>starts_at)',
    'check(price_cents>=0)',
    "check(statusin('hold','confirmed','cancelled','expired','no_show'))",
    'check(calendar_syncedin(0,1))',
    'check(email_syncedin(0,1))',
    'check(tourflow_syncedin(0,1))',
    "check(cancelled_byin('customer','operator')orcancelled_byisnull)",
  ];
  const paymentIndexSql = 'createuniqueindexidx_bookings_payment_intentonbookings(stripe_payment_intent)wherestripe_payment_intentisnotnull';
  return requiredChecks.every((check) => tableSql.includes(check)) && indexSql.includes(paymentIndexSql);
}

async function sideEffectOperationsSchemaPresent(db: MigrationsQueryable): Promise<boolean> {
  const result = await db
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE name IN ('side_effect_operations', 'idx_side_effect_operations_pending')`)
    .all<{ type: string; name: string; sql: string | null }>();
  const table = result.results.find((row) => row.type === 'table' && row.name === 'side_effect_operations');
  const index = result.results.find((row) => row.type === 'index' && row.name === 'idx_side_effect_operations_pending');
  return Boolean(index) && Boolean(table?.sql?.includes('calendar_delete')) && Boolean(table?.sql?.includes('abandoned'));
}

async function bookkitSchemaFingerprintPresent(db: MigrationsQueryable): Promise<boolean> {
  const [bookingsOk, sideEffectOk] = await Promise.all([
    bookingsSchemaPresent(db),
    sideEffectOperationsSchemaPresent(db),
  ]);
  return bookingsOk && sideEffectOk;
}

function migrationCollisionErrorMessage(): string {
  return "Bookkit's D1 migration ledger reports every migration applied, but the schema itself "
    + 'doesn\'t match bookkit\'s migrations. This usually means one of your own migration files '
    + 'happens to share a filename with one of bookkit\'s, so its ledger entry satisfied bookkit\'s '
    + "check without bookkit's SQL ever running. Use a dedicated D1 database for bookkit instead of "
    + 'sharing one with your own migrations.';
}

// Runs once per isolate (the caller memoizes this), never per request: a raw D1 SQL error from a
// missing column/table is the single most confusing failure mode for a new consumer, so this turns
// it into a named list of missing migrations and the exact command to fix it. Tolerant of extra,
// consumer-owned migrations — only bookkit's own filenames are asserted present.
export async function checkBookkitMigrationsApplied(
  db: MigrationsQueryable,
  migrationsTable = D1_MIGRATIONS_TABLE,
): Promise<void> {
  const applied = await appliedMigrationNames(db, requireMigrationsTableName(migrationsTable));
  const missing = BOOKKIT_MIGRATIONS.filter((name) => !applied.has(name));
  if (missing.length > 0) throw new Error(migrationsErrorMessage(missing));
  if (!(await bookkitSchemaFingerprintPresent(db))) throw new Error(migrationCollisionErrorMessage());
}

export function defineBookkitRuntime(options: BookkitRuntimeFactoryOptions): BookkitRuntimeDefinition {
  const config = validateConfig(options.config);
  return {
    config,
    async createContext(input) {
      return createBookkitContext(await options.createContext({ ...input, config }));
    },
  };
}

// Two overloads rather than a single `TEnv = UntypedBookkitEnv` default: `keyof TEnv` appearing in
// `options` makes TEnv an inference site, and TypeScript resolves an uninferrable-but-present type
// parameter to its constraint rather than its default. Without the plain overload below, an
// untyped call like `{ providers, secretBindings: [...] }` would silently narrow TEnv to the bare
// `BookkitEnvShape` (no index signature) and reject any binding name — the exact "zero-config path
// must not get worse" regression this feature has to avoid.
export function defineCloudflareBookkitRuntime(
  configInput: unknown,
  options: CloudflareBookkitRuntimeOptions<UntypedBookkitEnv>,
): BookkitRuntimeDefinition;
export function defineCloudflareBookkitRuntime<TEnv extends object>(
  configInput: unknown,
  options: CloudflareBookkitRuntimeOptions<TEnv>,
): BookkitRuntimeDefinition;
export function defineCloudflareBookkitRuntime<TEnv extends object>(
  configInput: unknown,
  options: CloudflareBookkitRuntimeOptions<TEnv>,
): BookkitRuntimeDefinition {
  const config = validateConfig(configInput);
  const migrationsTable = requireMigrationsTableName(options.migrationsTable ?? D1_MIGRATIONS_TABLE);
  const secretBindings = new Set<string>(options.secretBindings ?? ['TOURFLOW_SHARED_SECRET']);
  const confirmationLocks = new Map<string, Promise<void>>();
  // Memoized across every request this isolate handles: the schema check must run once at
  // first context creation, not on every request (see checkBookkitMigrationsApplied above).
  let migrationsChecked: Promise<void> | undefined;
  return {
    config,
    async createContext({ request, locals }) {
      const [env, waitUntil] = await Promise.all([getWorkerEnv<TEnv>(locals), getWorkerWaitUntil()]);
      const bindings: CloudflareRuntimeBindings<TEnv> = { env, request, ...(locals === undefined ? {} : { locals }), config };
      const db = resolveBinding(options.db, bindings, 'BOOKKIT_DB');
      if (!isD1Like(db)) throw new Error('Cloudflare D1 binding BOOKKIT_DB is not configured');
      // Cache success (steady-state healthy isolates check only once) but clear the memo on
      // rejection so a transient failure doesn't permanently poison the isolate — the next
      // request retries instead of getting a cached, misleading "run your migrations" error.
      migrationsChecked ??= checkBookkitMigrationsApplied(db, migrationsTable).catch((err) => {
        migrationsChecked = undefined;
        throw err;
      });
      await migrationsChecked;
      const providers = typeof options.providers === 'function' ? await options.providers(bindings) : options.providers;
      const cache = options.cache === null ? undefined : options.cache
        ? resolveBinding(options.cache, bindings, 'BOOKKIT_CACHE')
        : getCache(locals);
      const logger = typeof options.logger === 'function' ? options.logger(bindings) : options.logger;
      const contextInput: BookkitContextInput = {
        config,
        db,
        providers,
        ...(cache ? { cache } : {}),
        secrets: async (name) => {
          if (!secretBindings.has(name)) return undefined;
          const value = (env as Record<string, unknown>)[name];
          return typeof value === 'string' ? value : undefined;
        },
        ...(logger ? { logger } : {}),
        ...(waitUntil ? { waitUntil } : {}),
        confirmationLocks,
        verifyAccess: options.verifyAccess
          ? () => options.verifyAccess?.(bindings) ?? false
          // verifyAccessJwt resolves to the verified claims (throws on failure); passing them
          // through (instead of collapsing to `true`) lets the admin CSRF token bind to the
          // Access-authenticated subject — see src/admin-csrf.ts.
          : (requestToVerify) => verifyAccessJwt(requestToVerify, config),
      };
      return createBookkitContext(contextInput);
    },
  };
}

export type { BookkitContext, BookkitContextInput, BookkitProviders };
