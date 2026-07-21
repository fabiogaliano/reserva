import type { D1Database } from '@cloudflare/workers-types';
import { verifyAccessJwt } from './access';
import { createBookkitContext, type BookkitCache, type BookkitContext, type BookkitContextInput, type BookkitProviders, type BookkitLogger } from './context';
import { validateConfig, type ClientConfig } from './core/config';

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

export interface CloudflareRuntimeBindings<TEnv extends BookkitEnvShape = UntypedBookkitEnv> {
  env: TEnv;
  request: Request;
  locals?: unknown;
  config: ClientConfig;
}

export type CloudflareBinding<T, TEnv extends BookkitEnvShape = UntypedBookkitEnv> =
  (keyof TEnv & string) | ((bindings: CloudflareRuntimeBindings<TEnv>) => T | undefined);

export interface CloudflareBookkitRuntimeOptions<TEnv extends BookkitEnvShape = UntypedBookkitEnv> {
  db?: CloudflareBinding<D1Database, TEnv>;
  cache?: CloudflareBinding<BookkitCache, TEnv> | null;
  providers: BookkitProviders | ((bindings: CloudflareRuntimeBindings<TEnv>) => BookkitProviders | Promise<BookkitProviders>);
  secretBindings?: ReadonlyArray<keyof TEnv & string>;
  verifyAccess?: (bindings: CloudflareRuntimeBindings<TEnv>) => boolean | Promise<boolean>;
  logger?: BookkitLogger | ((bindings: CloudflareRuntimeBindings<TEnv>) => BookkitLogger);
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

async function getWorkerEnv<TEnv extends BookkitEnvShape>(locals: unknown): Promise<TEnv> {
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

function resolveBinding<T, TEnv extends BookkitEnvShape>(
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
export function defineCloudflareBookkitRuntime<TEnv extends BookkitEnvShape>(
  configInput: unknown,
  options: CloudflareBookkitRuntimeOptions<TEnv>,
): BookkitRuntimeDefinition;
export function defineCloudflareBookkitRuntime<TEnv extends BookkitEnvShape>(
  configInput: unknown,
  options: CloudflareBookkitRuntimeOptions<TEnv>,
): BookkitRuntimeDefinition {
  const config = validateConfig(configInput);
  const secretBindings = new Set<string>(options.secretBindings ?? ['TOURFLOW_SHARED_SECRET']);
  const refundedPayments = new Set<string>();
  const confirmationLocks = new Map<string, Promise<void>>();
  return {
    config,
    async createContext({ request, locals }) {
      const [env, waitUntil] = await Promise.all([getWorkerEnv<TEnv>(locals), getWorkerWaitUntil()]);
      const bindings: CloudflareRuntimeBindings<TEnv> = { env, request, ...(locals === undefined ? {} : { locals }), config };
      const db = resolveBinding(options.db, bindings, 'BOOKKIT_DB');
      if (!isD1Like(db)) throw new Error('Cloudflare D1 binding BOOKKIT_DB is not configured');
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
        refundedPayments,
        confirmationLocks,
        verifyAccess: options.verifyAccess
          ? () => options.verifyAccess?.(bindings) ?? false
          : (requestToVerify) => verifyAccessJwt(requestToVerify, config).then(() => true),
      };
      return createBookkitContext(contextInput);
    },
  };
}

export type { BookkitContext, BookkitContextInput, BookkitProviders };
