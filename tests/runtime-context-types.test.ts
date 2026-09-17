import type { D1Database } from '@cloudflare/workers-types';
import { describe, expectTypeOf, it, vi } from 'vitest';
import type { ReservaCache } from '../src/context';
import type { ClientConfig } from '../src/core/config';
import { defineCloudflareReservaRuntime, type CloudflareRuntimeBindings } from '../src/runtime-context';

// The factory no longer takes a config argument (plan item 12): it reads the build-time config from
// `virtual:reserva/config`. Kept pointed at the published minimal example so these compile-time
// assertions run against a config a consumer could actually ship.
vi.mock('virtual:reserva/config', async () => {
  const [{ default: config }, { resolveRouteConfig }] = await Promise.all([
    import('../examples/minimal/client-config'),
    import('../src/routes-manifest'),
  ]);
  return { default: { config, routes: resolveRouteConfig() } };
});

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
    defineCloudflareReservaRuntime<TestEnv>({
      providers: (bindings) => {
        expectTypeOf(bindings).toEqualTypeOf<CloudflareRuntimeBindings<TestEnv>>();
        expectTypeOf(bindings.env).toEqualTypeOf<TestEnv>();
        return { payments };
      },
      db: 'RESERVA_DB',
      cache: 'RESERVA_CACHE',
      secretBindings: ['MY_SECRET'],
    });

    defineCloudflareReservaRuntime<TestEnv>({
      providers: { payments },
      // @ts-expect-error 'NOT_A_BINDING' is not a key of TestEnv, catching a typo'd binding name at compile time.
      db: 'NOT_A_BINDING',
    });
  });

  it('accepts a custom-binding-only Env while preserving keyof binding checks', () => {
    defineCloudflareReservaRuntime<CustomEnv>({
      providers: { payments },
      db: 'MY_DB',
      secretBindings: ['MY_SECRET'],
    });

    defineCloudflareReservaRuntime<CustomEnv>({
      providers: { payments },
      // @ts-expect-error 'RESERVA_DB' is not a key of CustomEnv.
      db: 'RESERVA_DB',
    });
  });

  it('keeps the zero-config path (no explicit TEnv) accepting arbitrary binding names', () => {
    defineCloudflareReservaRuntime({
      providers: { payments },
      db: 'ANY_BINDING_NAME',
      secretBindings: ['ANY_SECRET_NAME'],
    });
  });
});

// A pickup option without a label is a compile error for the consumer, not only a runtime one.
type _LabelRequired = ClientConfig['services'][string]['location'];
const _missingLabel: NonNullable<_LabelRequired> = {
  // @ts-expect-error label is required on a declared pickup option
  pickupOptions: [{ id: 'hotel', requiresAddress: true, usesMeetingPoint: false }],
};
void _missingLabel;
