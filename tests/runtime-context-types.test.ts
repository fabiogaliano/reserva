import type { D1Database } from '@cloudflare/workers-types';
import { describe, expectTypeOf, it } from 'vitest';
import config from '../examples/client-config';
import type { BookkitCache } from '../src/context';
import { defineCloudflareBookkitRuntime, type CloudflareRuntimeBindings } from '../src/runtime-context';

// Deliberately no index signature: this stands in for a `wrangler types`-generated Env, which is
// the shape consumers actually pass as the TEnv type argument.
interface TestEnv {
  BOOKKIT_DB: D1Database;
  BOOKKIT_CACHE: BookkitCache;
  MY_SECRET: string;
}

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionId: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => undefined,
};

describe('defineCloudflareBookkitRuntime Env typing (compile-time)', () => {
  it('threads an explicit TEnv into bindings.env and constrains binding-name options to its keys', () => {
    defineCloudflareBookkitRuntime<TestEnv>(config, {
      providers: (bindings) => {
        expectTypeOf(bindings).toEqualTypeOf<CloudflareRuntimeBindings<TestEnv>>();
        expectTypeOf(bindings.env).toEqualTypeOf<TestEnv>();
        return { payments };
      },
      db: 'BOOKKIT_DB',
      cache: 'BOOKKIT_CACHE',
      secretBindings: ['MY_SECRET'],
    });

    defineCloudflareBookkitRuntime<TestEnv>(config, {
      providers: { payments },
      // @ts-expect-error 'NOT_A_BINDING' is not a key of TestEnv, catching a typo'd binding name at compile time.
      db: 'NOT_A_BINDING',
    });
  });

  it('keeps the zero-config path (no explicit TEnv) accepting arbitrary binding names', () => {
    defineCloudflareBookkitRuntime(config, {
      providers: { payments },
      db: 'ANY_BINDING_NAME',
      secretBindings: ['ANY_SECRET_NAME'],
    });
  });
});
