import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reserva } from '../src/integration';
import config from '../examples/minimal/client-config';
import { runAstroConfigSetup } from './fixtures';

function setup(options: Record<string, unknown> = { config, runtimeEntrypoint: './examples/minimal/runtime.ts' }) {
  return runAstroConfigSetup(reserva(options as never));
}

describe('Astro integration entry', () => {
  // Pins the generated route's entrypoint to the exact one-line handlePaymentWebhook delegation,
  // not just that some file exists at that path.
  it('pins the generated Stripe webhook route to its one-line handlePaymentWebhook delegation', () => {
    const { routes } = setup();
    const webhookRoute = routes.find((route) => route.pattern === '/api/booking/webhooks/payment');
    if (!webhookRoute) throw new Error('Stripe webhook route was not injected');
    const source = readFileSync(String(webhookRoute.entrypoint), 'utf8');
    expect(source).toContain("import { handlePaymentWebhook } from '../../../../handlers/index.js';");
    expect(source).toContain('return handlePaymentWebhook(request, await createRouteContext({ request, locals }));');
  });

  it('rejects an invalid config during setup', () => {
    expect(() => setup({
      config: { ...config, booking: { holdMinutes: 10 } },
      runtimeEntrypoint: './examples/minimal/runtime.ts',
    })).toThrow(/holdMinutes/i);
  });

  it('rejects a missing runtime entrypoint during setup', () => {
    expect(() => setup({ config, runtimeEntrypoint: resolve('/tmp/no-reserva-runtime.ts') })).toThrow(/runtimeEntrypoint/);
  });
});
