import type { D1Database } from '@cloudflare/workers-types';
import { cloudflareAccessAdminAuth } from './access';
import type { OpsHealthSchema } from './core/api';
import { createReservaContext, type AdminAuth, type ReservaCache, type ReservaContext, type ReservaContextInput, type ReservaProviders, type ReservaLogger } from './context';
import { validateConfig, type ClientConfig } from './core/config';
import { OPERATOR_SECRET_NAME } from './handlers/booking-actions';
import { validateBookingEventHooks, type BookingEventHook } from './core/events';
import { RESERVA_MIGRATIONS } from './migrations-manifest';

export interface ReservaRuntimeRequest {
  request: Request;
  locals?: unknown;
}

export interface ReservaRuntimeDefinition {
  readonly config: ClientConfig;
  createContext(input: ReservaRuntimeRequest): ReservaContext | Promise<ReservaContext>;
}

// Alias for the shape the injected `virtual:reserva/runtime` type declaration points consumers at.
export type ReservaRuntime = ReservaRuntimeDefinition;

export interface ReservaRuntimeFactoryOptions {
  config: unknown;
  createContext(input: ReservaRuntimeRequest & { config: ClientConfig }): ReservaContextInput | Promise<ReservaContextInput>;
}

// The minimal env surface reserva itself reads (db/cache/secrets). Consumers pass their
// `wrangler types`-generated Env, which structurally satisfies this, as the TEnv type argument
// to get keyof-checked binding names and a typed `env` in provider factories instead of `unknown`.
// No index signature here: a real wrangler-generated Env has none either, and a generic
// constraint with a string index signature would reject any type that lacks one.
export interface ReservaEnvShape {
  RESERVA_DB?: D1Database;
  RESERVA_CACHE?: unknown;
}

// Default TEnv for the zero-config path (no type argument supplied): adds the index signature so
// bare-string binding-name options keep accepting arbitrary names, same as before this change.
type UntypedReservaEnv = ReservaEnvShape & Record<string, unknown>;

export interface CloudflareRuntimeBindings<TEnv extends object = UntypedReservaEnv> {
  env: TEnv;
  request: Request;
  locals?: unknown;
  config: ClientConfig;
}

export type CloudflareBinding<T, TEnv extends object = UntypedReservaEnv> =
  (keyof TEnv & string) | ((bindings: CloudflareRuntimeBindings<TEnv>) => T | undefined);

export interface CloudflareReservaRuntimeOptions<TEnv extends object = UntypedReservaEnv> {
  db?: CloudflareBinding<D1Database, TEnv>;
  cache?: CloudflareBinding<ReservaCache, TEnv> | null;
  providers: ReservaProviders | ((bindings: CloudflareRuntimeBindings<TEnv>) => ReservaProviders | Promise<ReservaProviders>);
  // Plan 021 (design decision 1): in-process booking-event listeners. Validated eagerly at
  // definition time, not per request, so a bad name or a misspelled event fails the deployment
  // rather than one booking's dispatch.
  hooks?: readonly BookingEventHook[];
  secretBindings?: ReadonlyArray<keyof TEnv & string>;
  // Plan 025 (design decisions 1-2): the custom admin auth strategy's one registration — there is
  // no separate `{ kind: 'custom' }` marker. Auto-overridden by cloudflareAccessAdminAuth whenever
  // `config.admin.access` is configured (validated together, synchronously, at
  // defineCloudflareReservaRuntime call time — see resolveAdminAuth below); supplying both is a
  // build-time error, not a silent precedence rule.
  adminAuth?: AdminAuth;
  logger?: ReservaLogger | ((bindings: CloudflareRuntimeBindings<TEnv>) => ReservaLogger);
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

export function getCache(locals: unknown, binding = 'RESERVA_CACHE'): ReservaCache | undefined {
  try {
    const candidate = getEnv(locals)[binding];
    if (candidate && typeof candidate === 'object' && 'match' in candidate && 'put' in candidate) return candidate as ReservaCache;
  } catch {
    // Cloudflare exposes Cache API globally rather than through Astro locals.
  }
  const workerCaches = (globalThis as typeof globalThis & { caches?: { default?: ReservaCache } }).caches;
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
  return `Reserva's D1 schema is missing ${noun}: ${missing.join(', ')}. Point your D1 binding's `
    + `migrations_dir at reserva's migrations/ directory, then apply them with `
    + '`wrangler d1 migrations apply <database_name> --local` (dev) or '
    + '`wrangler d1 migrations apply <database_name>` (prod) — or run `bunx reserva-migrate --local` '
    + '/ `bunx reserva-migrate` from the project that owns wrangler.jsonc.';
}

// Plan 008 (audit finding #6): the filename ledger alone is fooled by a consumer migration that
// happens to reuse one of reserva's filenames without ever running reserva's SQL — d1_migrations
// only records names, never checksums or content. This is cheap, read-only detection (not a fix:
// a fully namespaced ledger is deferred, see docs/plans/008), spanning the migrations that
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

// Plan 022 (design decision 1): the v2 rebuild renamed or dropped these. A consumer migration that
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
  // Plan 018 (design decision 5): pickup_type's domain moved from a fixed SQL CHECK to
  // config-declared option ids (ServiceConfig.pickupOptions), which the DB can't enumerate.
  // Plan 022: it also stopped being NOT NULL, so a service with no location module can store NULL
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
  // Plan 020 (design decision 5): the reconciliation index and the two nullable backoff columns it
  // supports are additive-only, but a consumer migration colliding with '0016_...sql' without ever
  // running reserva's ALTER TABLE would still satisfy the ledger while leaving both absent — same
  // collision class REQUIRED_BOOKINGS_COLUMNS already guards for `bookings`.
  const reconciliationIndex = result.results.find((row) => row.type === 'index' && row.name === 'idx_side_effect_operations_reconciliation');
  // Plan 021: identity moved from the single `kind` string to family/name/event/discriminator, and
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

// Plan 020 (design decision 7): refund_operations never had a fingerprint check before this plan
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

// Plan 027 (design decision 7): the same check, reported instead of thrown, so the ops-health
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

// Plan 022 (design decision 7): a payment provider's own limits (its supported currencies and
// locales, how long it lets a checkout session stay open) are checked ONCE, before the deployment
// serves anything — not per request, and never as a surprise on the first real checkout. When
// `providers` is a plain object the check runs while the runtime definition is being built; when it
// is a factory (it needs the Worker's env), the first context creation is the earliest the provider
// exists, so it runs there and is remembered.
function validatePaymentProvider(providers: ReservaProviders, config: ClientConfig): void {
  providers.payments.validateConfig?.(config);
}

// Plan 025 (design decisions 2-4): resolves the one admin auth path a deployment actually uses and
// validates the combination synchronously, before defineCloudflareReservaRuntime returns — composing
// with, not replacing, validatePaymentProvider above at the same runtime-definition boundary. When
// neither protected route group (admin/ops) is enabled, whichever path is configured (if any) is
// still wired for defense in depth (a consumer manually rendering the admin page despite disabling
// its route still hits the shared fail-closed gate — src/admin-access.ts), but the combination is
// never validated, since there is no protected route to guard.
function resolveAdminAuth(config: ClientConfig, custom: AdminAuth | undefined): AdminAuth | undefined {
  const access = config.admin.access;
  const resolved: AdminAuth | undefined = access ? cloudflareAccessAdminAuth(access.teamDomain, access.aud) : custom;
  const protectedGroupEnabled = (config.routes?.admin ?? true) || (config.routes?.ops ?? true);
  if (!protectedGroupEnabled) return resolved;
  if (access && custom) {
    throw new Error(
      "Reserva config declares both admin.access and a runtime `adminAuth` callback. Exactly one admin "
      + 'auth path is allowed — remove whichever one this deployment does not use: drop `config.admin.access` '
      + 'to use the custom `adminAuth` callback, or drop the `adminAuth` option to use Cloudflare Access.',
    );
  }
  if (!access && !custom) {
    throw new Error(
      "Reserva's admin dashboard and/or operator routes are enabled (config.routes.admin / config.routes.ops "
      + 'default to true), but no admin auth is configured. Either set `config.admin.access = { teamDomain, aud }` '
      + 'to use Cloudflare Access (the default implementation), or pass an `adminAuth` callback to '
      + 'defineCloudflareReservaRuntime for a custom strategy.',
    );
  }
  return resolved;
}

export function defineReservaRuntime(options: ReservaRuntimeFactoryOptions): ReservaRuntimeDefinition {
  const config = validateConfig(options.config);
  let providerValidated = false;
  return {
    config,
    async createContext(input) {
      const contextInput = await options.createContext({ ...input, config });
      if (!providerValidated) {
        validatePaymentProvider(contextInput.providers, config);
        providerValidated = true;
      }
      return createReservaContext(contextInput);
    },
  };
}

// Two overloads rather than a single `TEnv = UntypedReservaEnv` default: `keyof TEnv` appearing in
// `options` makes TEnv an inference site, and TypeScript resolves an uninferrable-but-present type
// parameter to its constraint rather than its default. Without the plain overload below, an
// untyped call like `{ providers, secretBindings: [...] }` would silently narrow TEnv to the bare
// `ReservaEnvShape` (no index signature) and reject any binding name — the exact "zero-config path
// must not get worse" regression this feature has to avoid.
export function defineCloudflareReservaRuntime(
  configInput: unknown,
  options: CloudflareReservaRuntimeOptions<UntypedReservaEnv>,
): ReservaRuntimeDefinition;
export function defineCloudflareReservaRuntime<TEnv extends object>(
  configInput: unknown,
  options: CloudflareReservaRuntimeOptions<TEnv>,
): ReservaRuntimeDefinition;
export function defineCloudflareReservaRuntime<TEnv extends object>(
  configInput: unknown,
  options: CloudflareReservaRuntimeOptions<TEnv>,
): ReservaRuntimeDefinition {
  const config = validateConfig(configInput);
  validateBookingEventHooks(options.hooks ?? []);
  const adminAuth = resolveAdminAuth(config, options.adminAuth);
  const migrationsTable = requireMigrationsTableName(options.migrationsTable ?? D1_MIGRATIONS_TABLE);
  if (typeof options.providers !== 'function') validatePaymentProvider(options.providers, config);
  let providerValidated = typeof options.providers !== 'function';
  const secretBindings = new Set<string>(options.secretBindings ?? [OPERATOR_SECRET_NAME]);
  const confirmationLocks = new Map<string, Promise<void>>();
  // Memoized across every request this isolate handles: the schema check must run once at
  // first context creation, not on every request (see checkReservaMigrationsApplied above).
  let migrationsChecked: Promise<void> | undefined;
  return {
    config,
    async createContext({ request, locals }) {
      const [env, waitUntil] = await Promise.all([getWorkerEnv<TEnv>(locals), getWorkerWaitUntil()]);
      const bindings: CloudflareRuntimeBindings<TEnv> = { env, request, ...(locals === undefined ? {} : { locals }), config };
      const db = resolveBinding(options.db, bindings, 'RESERVA_DB');
      if (!isD1Like(db)) throw new Error('Cloudflare D1 binding RESERVA_DB is not configured');
      // Cache success (steady-state healthy isolates check only once) but clear the memo on
      // rejection so a transient failure doesn't permanently poison the isolate — the next
      // request retries instead of getting a cached, misleading "run your migrations" error.
      migrationsChecked ??= checkReservaMigrationsApplied(db, migrationsTable).catch((err) => {
        migrationsChecked = undefined;
        throw err;
      });
      await migrationsChecked;
      const providers = typeof options.providers === 'function' ? await options.providers(bindings) : options.providers;
      if (!providerValidated) {
        validatePaymentProvider(providers, config);
        providerValidated = true;
      }
      const cache = options.cache === null ? undefined : options.cache
        ? resolveBinding(options.cache, bindings, 'RESERVA_CACHE')
        : getCache(locals);
      const logger = typeof options.logger === 'function' ? options.logger(bindings) : options.logger;
      const contextInput: ReservaContextInput = {
        config,
        db,
        providers,
        ...(options.hooks ? { hooks: options.hooks } : {}),
        ...(cache ? { cache } : {}),
        secrets: async (name) => {
          if (!secretBindings.has(name)) return undefined;
          const value = (env as Record<string, unknown>)[name];
          return typeof value === 'string' ? value : undefined;
        },
        ...(logger ? { logger } : {}),
        ...(waitUntil ? { waitUntil } : {}),
        confirmationLocks,
        ...(adminAuth ? { adminAuth } : {}),
      };
      return createReservaContext(contextInput);
    },
  };
}

export type { AdminAuth, ReservaContext, ReservaContextInput, ReservaProviders };
