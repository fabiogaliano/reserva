import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import config from '../examples/client-config';
import { defineCloudflareBookkitRuntime, getCache, getEnv } from '../src/runtime-context';
import { BOOKKIT_MIGRATIONS } from '../src/migrations-manifest';

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionId: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => undefined,
};

describe('Cloudflare runtime helpers', () => {
  it('reads injected test bindings without exposing env on context', async () => {
    // Needs a `prepare` function so it passes the D1 shape check `defineCloudflareBookkitRuntime` runs at
    // context-creation time, and `.all()` must resolve bookkit's own migrations so the isolate-time
    // schema check (also run at context creation) doesn't reject this fake as an unmigrated database.
    const db = {
      prepare: () => ({ all: async () => ({ results: BOOKKIT_MIGRATIONS.map((name) => ({ name })) }) }),
    } as unknown as D1Database;
    const cache = { match: async () => undefined, put: async () => undefined } as never;
    const definition = defineCloudflareBookkitRuntime(config, { providers: { payments } });
    const request = new Request('https://example.test/api/booking/status');
    const context = await definition.createContext({
      request,
      locals: { env: { BOOKKIT_DB: db, BOOKKIT_CACHE: cache, TOURFLOW_SHARED_SECRET: 'secret' } },
    });
    expect(context.config).toStrictEqual(definition.config);
    expect(context.db).toBe(db);
    expect(context.cache).toBe(cache);
    expect('env' in context).toBe(false);
    await expect(context.secrets?.('TOURFLOW_SHARED_SECRET')).resolves.toBe('secret');
    await expect(context.secrets?.('STRIPE_SECRET_KEY')).resolves.toBeUndefined();

    const nextContext = await definition.createContext({
      request,
      locals: { env: { BOOKKIT_DB: db, BOOKKIT_CACHE: cache } },
    });
    expect(nextContext.refundedPayments).toBe(context.refundedPayments);
    expect(nextContext.confirmationLocks).toBe(context.confirmationLocks);
  });

  it('supports direct env locals and worker cache fallback', () => {
    const env = { BOOKKIT_DB: {} };
    expect(getEnv({ env })).toBe(env);
    expect(getCache({ env })).toBeUndefined();
  });

  it('rejects a missing D1 binding at context-creation time', async () => {
    const definition = defineCloudflareBookkitRuntime(config, { providers: { payments } });
    await expect(definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: {} },
    })).rejects.toThrow('Cloudflare D1 binding BOOKKIT_DB is not configured');
  });

  it('rejects a misconfigured (non-D1-shaped) binding before it reaches the repository', async () => {
    // Simulates a typo'd binding name resolving to some other binding (e.g. a string secret)
    // rather than the D1 database: it must fail here, not with a later "db.prepare is not a function".
    const definition = defineCloudflareBookkitRuntime(config, { providers: { payments } });
    await expect(definition.createContext({
      request: new Request('https://example.test/api/booking/status'),
      locals: { env: { BOOKKIT_DB: 'not-a-database' } },
    })).rejects.toThrow('Cloudflare D1 binding BOOKKIT_DB is not configured');
  });
});
