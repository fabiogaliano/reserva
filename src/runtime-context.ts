import type { D1Database } from '@cloudflare/workers-types';
import { cloudflareAccessAdminAuth } from './access.js';
import { createReservaContext, OPERATOR_SECRET_NAME, type AdminAuth, type ReservaCache, type ReservaContext, type ReservaContextInput, type ReservaProviders, type ReservaLogger } from './context.js';
import { validateConfig, type ClientConfig } from './core/config.js';
import { validateBookingEventHooks, type BookingEventHook } from './core/events.js';
import { checkReservaMigrationsApplied, D1_MIGRATIONS_TABLE, requireMigrationsTableName } from './schema-check.js';

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
  // In-process booking-event listeners. Validated eagerly at
  // definition time, not per request, so a bad name or a misspelled event fails the deployment
  // rather than one booking's dispatch.
  hooks?: readonly BookingEventHook[];
  secretBindings?: ReadonlyArray<keyof TEnv & string>;
  // The custom admin auth strategy's one registration — there is
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

// A payment provider's own limits (its supported currencies and
// locales, how long it lets a checkout session stay open) are checked ONCE, before the deployment
// serves anything — not per request, and never as a surprise on the first real checkout. When
// `providers` is a plain object the check runs while the runtime definition is being built; when it
// is a factory (it needs the Worker's env), the first context creation is the earliest the provider
// exists, so it runs there and is remembered.
function validatePaymentProvider(providers: ReservaProviders, config: ClientConfig): void {
  providers.payments.validateConfig?.(config);
}

// Resolves the one admin auth path a deployment actually uses and
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
  // first context creation, not on every request (see checkReservaMigrationsApplied in src/schema-check.ts).
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
