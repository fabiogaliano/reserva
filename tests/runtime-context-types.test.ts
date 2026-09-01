import type { D1Database } from '@cloudflare/workers-types';
import { describe, expectTypeOf, it } from 'vitest';
import config from '../examples/client-config';
import type { ReservaCache } from '../src/context';
import { defineCloudflareReservaRuntime, type CloudflareRuntimeBindings } from '../src/runtime-context';

// Deliberately no index signature: this stands in for a `wrangler types`-generated Env, which is
// the shape consumers actually pass as the TEnv type argument.
interface TestEnv {
  RESERVA_DB: D1Database;
  RESERVA_CACHE: ReservaCache;
  MY_SECRET: string;
}

interface CustomEnv {
  MY_DB: D1Database;
  MY_SECRET: string;
}

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
};

describe('defineCloudflareReservaRuntime Env typing (compile-time)', () => {
  it('threads an explicit TEnv into bindings.env and constrains binding-name options to its keys', () => {
    defineCloudflareReservaRuntime<TestEnv>(config, {
      providers: (bindings) => {
        expectTypeOf(bindings).toEqualTypeOf<CloudflareRuntimeBindings<TestEnv>>();
        expectTypeOf(bindings.env).toEqualTypeOf<TestEnv>();
        return { payments };
      },
      db: 'RESERVA_DB',
      cache: 'RESERVA_CACHE',
      secretBindings: ['MY_SECRET'],
    });

    defineCloudflareReservaRuntime<TestEnv>(config, {
      providers: { payments },
      // @ts-expect-error 'NOT_A_BINDING' is not a key of TestEnv, catching a typo'd binding name at compile time.
      db: 'NOT_A_BINDING',
    });
  });

  it('accepts a custom-binding-only Env while preserving keyof binding checks', () => {
    defineCloudflareReservaRuntime<CustomEnv>(config, {
      providers: { payments },
      db: 'MY_DB',
      secretBindings: ['MY_SECRET'],
    });

    defineCloudflareReservaRuntime<CustomEnv>(config, {
      providers: { payments },
      // @ts-expect-error 'RESERVA_DB' is not a key of CustomEnv.
      db: 'RESERVA_DB',
    });
  });

  it('keeps the zero-config path (no explicit TEnv) accepting arbitrary binding names', () => {
    defineCloudflareReservaRuntime(config, {
      providers: { payments },
      db: 'ANY_BINDING_NAME',
      secretBindings: ['ANY_SECRET_NAME'],
    });
  });
});
