import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import config from '../../examples/client-config';
import { defineCloudflareReservaRuntime } from '../../src/runtime-context';

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
};

describe('Cloudflare runtime bindings', () => {
  it('loads D1 from cloudflare:workers without legacy Astro locals', async () => {
    const runtime = defineCloudflareReservaRuntime(config, { providers: { payments } });
    const context = await runtime.createContext({
      request: new Request('https://example.test/api/booking/status'),
    });

    expect(context.db).toBe((env as unknown as { RESERVA_DB: D1Database }).RESERVA_DB);
    expect(context.repo).toBeDefined();
  });
});
