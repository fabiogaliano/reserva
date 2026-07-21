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

export interface BookkitRuntimeFactoryOptions {
  config: unknown;
  createContext(input: BookkitRuntimeRequest & { config: ClientConfig }): BookkitContextInput | Promise<BookkitContextInput>;
}

export interface CloudflareRuntimeBindings {
  env: Record<string, unknown>;
  request: Request;
  locals?: unknown;
  config: ClientConfig;
}

export type CloudflareBinding<T> = string | ((bindings: CloudflareRuntimeBindings) => T | undefined);

export interface CloudflareBookkitRuntimeOptions {
  db?: CloudflareBinding<D1Database>;
  cache?: CloudflareBinding<BookkitCache> | null;
  providers: BookkitProviders | ((bindings: CloudflareRuntimeBindings) => BookkitProviders | Promise<BookkitProviders>);
  secretBindings?: readonly string[];
  verifyAccess?: (bindings: CloudflareRuntimeBindings) => boolean | Promise<boolean>;
  logger?: BookkitLogger | ((bindings: CloudflareRuntimeBindings) => BookkitLogger);
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

async function getWorkerEnv(locals: unknown): Promise<Record<string, unknown>> {
  try {
    return getEnv(locals);
  } catch {
    const module = await import('cloudflare:workers');
    return module.env as unknown as Record<string, unknown>;
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

function resolveBinding<T>(binding: CloudflareBinding<T> | undefined, input: CloudflareRuntimeBindings, name: string): T | undefined {
  if (typeof binding === 'function') return binding(input);
  const candidate = input.env[binding ?? name];
  return candidate as T | undefined;
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

export function defineCloudflareBookkitRuntime(configInput: unknown, options: CloudflareBookkitRuntimeOptions): BookkitRuntimeDefinition {
  const config = validateConfig(configInput);
  const secretBindings = new Set(options.secretBindings ?? ['TOURFLOW_SHARED_SECRET']);
  const refundedPayments = new Set<string>();
  const confirmationLocks = new Map<string, Promise<void>>();
  return {
    config,
    async createContext({ request, locals }) {
      const [env, waitUntil] = await Promise.all([getWorkerEnv(locals), getWorkerWaitUntil()]);
      const bindings: CloudflareRuntimeBindings = { env, request, ...(locals === undefined ? {} : { locals }), config };
      const db = resolveBinding(options.db, bindings, 'BOOKKIT_DB');
      if (!db) throw new Error('Cloudflare D1 binding BOOKKIT_DB is not configured');
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
          const value = env[name];
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
