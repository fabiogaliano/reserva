import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { defineCloudflareReservaRuntime } from '../../src/runtime-context';

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
};

describe('Cloudflare runtime bindings', () => {
  it('resolves D1 and caches.default from cloudflare:workers when no Astro locals or RESERVA_CACHE binding is given', async () => {
    const runtime = defineCloudflareReservaRuntime({ providers: { payments } });
    const context = await runtime.createContext({
      request: new Request('https://example.test/api/booking/status'),
    });

    expect(context.db).toBe((env as unknown as { RESERVA_DB: D1Database }).RESERVA_DB);
    // The repo's DOM lib types `caches` as browser CacheStorage, which has no Workers `default`.
    const workerCaches = caches as unknown as { default: unknown };
    expect(context.cache).toBeDefined();
    expect(context.cache).toBe(workerCaches.default);
  });
});
