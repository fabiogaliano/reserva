import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import config from '../examples/client-config';
import { defineCloudflareBookkitRuntime, getCache, getEnv } from '../src/runtime-context';

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionId: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => undefined,
};

describe('Cloudflare runtime helpers', () => {
  it('reads injected test bindings without exposing env on context', async () => {
    const db = {} as D1Database;
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
});
