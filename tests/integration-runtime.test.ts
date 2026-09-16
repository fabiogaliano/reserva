import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import config from '../examples/minimal/client-config';
import { defineCloudflareReservaRuntime, getCache, getEnv, type CloudflareReservaRuntimeOptions, type ReservaEnvShape } from '../src/runtime-context';
import { RESERVA_MIGRATIONS, RESERVA_SCHEMA_TABLES } from '../src/generated/schema-fingerprint';

// The factory reads the build-time config from `virtual:reserva/config` instead of taking one
// (plan item 12), so the webhook case swaps what the module reports before defining its runtime.
// A getter, not a frozen object: the factory reads at call time.
const virtual = vi.hoisted(() => ({ config: undefined as unknown }));
vi.mock('virtual:reserva/config', async () => {
  const { resolveRouteConfig } = await import('../src/routes-manifest');
  const routes = resolveRouteConfig();
  return { default: { get config() { return virtual.config; }, routes } };
});

// Mirrors the zero-config overload's own parameter type: `Parameters<>` on an overloaded function
// picks the generic overload, whose `keyof TEnv` collapses to `never` for a bare binding name.
function runtimeFor(candidate: unknown, options: CloudflareReservaRuntimeOptions<ReservaEnvShape & Record<string, unknown>>) {
  virtual.config = candidate;
  return defineCloudflareReservaRuntime(options);
}

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
};

// Needs `prepare` to pass the D1 shape check, and `.all()` must resolve reserva's migrations plus
// a matching schema fingerprint, so context creation doesn't reject the fake as unmigrated. The
// fingerprint answers are derived from the generated table map rather than hand-listed, so a new
// migration cannot silently leave this fake behind.
function migratedD1(): D1Database {
  return {
    prepare: (query: string) => ({
      all: async () => {
        if (query.includes("type='index'")) {
          return {
            results: Object.entries(RESERVA_SCHEMA_TABLES).flatMap(([table, { indexes }]) =>
              indexes.map((name) => ({ name, tbl_name: table }))),
          };
        }
        const pragma = query.match(/^PRAGMA table_info\((\w+)\)$/);
        if (pragma) return { results: (RESERVA_SCHEMA_TABLES[pragma[1]!]?.columns ?? []).map((name) => ({ name })) };
        return { results: RESERVA_MIGRATIONS.map((name) => ({ name })) };
      },
    }),
  } as unknown as D1Database;
}

describe('Cloudflare runtime helpers', () => {
  it('reads injected test bindings without exposing env on context', async () => {
    const db = migratedD1();
    const cache = { match: async () => undefined, put: async () => undefined } as never;
    const definition = runtimeFor(config, { providers: { payments } });
    const request = new Request('https://example.test/api/booking/status');
    const context = await definition.createContext({
      request,
      locals: { env: { RESERVA_DB: db, RESERVA_CACHE: cache, RESERVA_OPERATOR_SECRET: 'secret' } },
    });
    expect(context.config).toStrictEqual(definition.config);
    expect(context.db).toBe(db);
    expect(context.cache).toBe(cache);
    expect('env' in context).toBe(false);
    await expect(context.secrets?.('RESERVA_OPERATOR_SECRET')).resolves.toBe('secret');
    await expect(context.secrets?.('STRIPE_SECRET_KEY')).resolves.toBeUndefined();

    const nextContext = await definition.createContext({
      request,
      locals: { env: { RESERVA_DB: db, RESERVA_CACHE: cache } },
    });
    expect(nextContext.confirmationLocks).toBe(context.confirmationLocks);
  });

  it("reads reserva's own secrets and every declared webhook secretBinding without them being listed", async () => {
    const withWebhook = { ...config, webhooks: [{ name: 'partner', url: 'https://partner.example/hook', secretBinding: 'PARTNER_WEBHOOK_SECRET' }] };
    const definition = runtimeFor(withWebhook, { providers: { payments }, secretBindings: ['MY_OWN_SECRET'] });
    const context = await definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: {
        RESERVA_DB: migratedD1(),
        RESERVA_OPERATOR_SECRET: 'operator',
        RESERVA_CSRF_SECRET: 'csrf',
        RESERVA_TOKEN_ENC_KEY: 'enc',
        PARTNER_WEBHOOK_SECRET: 'partner',
        MY_OWN_SECRET: 'mine',
        UNDECLARED_SECRET: 'nope',
      } },
    });
    for (const [name, value] of [
      ['RESERVA_OPERATOR_SECRET', 'operator'], ['RESERVA_CSRF_SECRET', 'csrf'], ['RESERVA_TOKEN_ENC_KEY', 'enc'],
      ['PARTNER_WEBHOOK_SECRET', 'partner'], ['MY_OWN_SECRET', 'mine'],
    ] as const) {
      await expect(context.secrets?.(name)).resolves.toBe(value);
    }
    // Still a closed allowlist, not a pass-through of the whole env.
    await expect(context.secrets?.('UNDECLARED_SECRET')).resolves.toBeUndefined();
  });

  it('supports direct env locals and worker cache fallback', () => {
    const env = { RESERVA_DB: {} };
    expect(getEnv({ env })).toBe(env);
    expect(getCache({ env })).toBeUndefined();
  });

  it('rejects a missing D1 binding at context-creation time', async () => {
    const definition = runtimeFor(config, { providers: { payments } });
    await expect(definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: {} },
    })).rejects.toThrow('Cloudflare D1 binding RESERVA_DB is not configured');
  });

  it('rejects a misconfigured (non-D1-shaped) binding before it reaches the repository', async () => {
    // Simulates a typo'd binding name resolving to some other binding (e.g. a string secret)
    // rather than the D1 database: it must fail here, not with a later "db.prepare is not a function".
    const definition = runtimeFor(config, { providers: { payments } });
    await expect(definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: { RESERVA_DB: 'not-a-database' } },
    })).rejects.toThrow('Cloudflare D1 binding RESERVA_DB is not configured');
  });
});
