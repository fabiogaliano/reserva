// The payment webhook route the integration injects, executed: the entrypoint mounted at the
// webhook pattern must hand the payment provider the exact bytes and signature header the provider
// signed, and answer with what the handler makes of the provider's verdict. Needs the component
// Vite pipeline because createRouteContext resolves virtual:reserva/runtime and
// virtual:reserva/config.
import { resolve } from 'node:path';
import type { APIContext } from 'astro';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http';
import { reserva } from '../../src/integration';
import { booking, config, runAstroConfigSetup } from '../fixtures';
import { fakeRepository, providers } from '../fakes';
import { componentState, FIXED_NOW } from './fixtures/runtime';

type RouteHandler = (context: APIContext) => Promise<Response>;

async function injectedWebhookPOST(): Promise<RouteHandler> {
  const { routes } = runAstroConfigSetup(reserva({ config, runtimeEntrypoint: resolve(import.meta.dirname, 'fixtures/runtime.ts') }));
  const route = routes.find((entry) => entry.pattern === '/api/booking/webhooks/payment');
  if (!route) throw new Error('payment webhook route was not injected');
  const module = await import(/* @vite-ignore */ String(route.entrypoint)) as { POST: RouteHandler };
  return module.POST;
}

function webhookRequest(body: string): Request {
  return new Request('https://example.test/api/booking/webhooks/payment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=route-signature' },
    body,
  });
}

// Whitespace and key order a re-serialization would lose, so only the untouched bytes match.
const RAW_BODY = '{ "id":"evt_route" ,\n  "type": "checkout.session.completed" }';

afterEach(() => {
  componentState.repo = fakeRepository();
  componentState.now = FIXED_NOW;
  componentState.providers = providers();
});

describe('injected payment webhook route', () => {
  it('passes the raw body and signature header to parseWebhook and confirms the booking its event names', async () => {
    componentState.repo = fakeRepository([booking({ status: 'hold', holdExpiresAt: '2026-06-14T08:30:00.000Z', paymentRef: null })]);
    const stock = providers();
    const seen: Array<{ body: string; signature: string | null }> = [];
    componentState.providers = {
      ...stock,
      payments: {
        ...stock.payments,
        parseWebhook: async (request) => {
          seen.push({ body: await request.text(), signature: request.headers.get('stripe-signature') });
          return stock.payments.parseWebhook(request);
        },
      },
    };

    const POST = await injectedWebhookPOST();
    const response = await POST({ request: webhookRequest(RAW_BODY), locals: {} } as unknown as APIContext);

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ body: RAW_BODY, signature: 't=1,v1=route-signature' }]);
    expect(componentState.repo.rows.get('booking-1')).toMatchObject({ status: 'confirmed', paymentRef: 'pi_1' });
  });

  it('answers with the status of a provider that rejects the signature, and changes nothing', async () => {
    componentState.repo = fakeRepository([booking({ status: 'hold', holdExpiresAt: '2026-06-14T08:30:00.000Z', paymentRef: null })]);
    componentState.providers = {
      ...componentState.providers,
      payments: {
        ...componentState.providers.payments,
        parseWebhook: async () => { throw new HttpError(400, 'invalid_payment_signature', 'signature rejected'); },
      },
    };

    const POST = await injectedWebhookPOST();
    const response = await POST({ request: webhookRequest(RAW_BODY), locals: {} } as unknown as APIContext);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_payment_signature' } });
    expect(componentState.repo.rows.get('booking-1')).toMatchObject({ status: 'hold' });
  });
});
