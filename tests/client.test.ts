import { describe, expect, it } from 'vitest';
import { createReservaClient, isReservaApiError, ReservaApiError } from '../src/client/index';
import type { CheckoutRequest } from '../src/core/api';

interface FetchCall {
  url: string;
  init: Record<string, unknown>;
}

interface Reply {
  status?: number;
  body?: unknown;
  // Raw text for the answers that are not JSON at all (a proxy's HTML error page).
  text?: string;
  throws?: Error;
}

function recorder(reply: Reply = {}) {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: unknown, init: Record<string, unknown> = {}) => {
    calls.push({ url: String(input), init });
    if (reply.throws) throw reply.throws;
    return new Response(reply.text ?? JSON.stringify(reply.body ?? { ok: true }), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    calls,
    fetchFn,
    last(): FetchCall {
      const call = calls.at(-1);
      if (!call) throw new Error('no fetch was made');
      return call;
    },
  };
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: FetchCall): unknown {
  return JSON.parse(String(call.init.body));
}

const checkout: CheckoutRequest = {
  serviceSlug: 'vintage',
  start: '2026-06-15T09:00:00.000+01:00',
  quantity: 2,
  locale: 'pt-BR',
  pickup: 'custom',
  metadata: { flight: 'TP123' },
};

// A rejection is the only acceptable outcome for these cases: `.then(unexpectedSuccess, asApiError)`
// narrows to the error type without letting a resolved response masquerade as one.
function unexpectedSuccess(): never { throw new Error('expected the request to reject'); }
function asApiError(thrown: unknown): ReservaApiError { return thrown as ReservaApiError; }

describe('createReservaClient request shapes', () => {
  it('sends the catalog locale as a query parameter and omits the query entirely without one', async () => {
    const withLocale = recorder();
    await createReservaClient({ fetch: withLocale.fetchFn }).catalog({ locale: 'pt-BR' });
    expect(withLocale.last().url).toBe('/api/booking/catalog?locale=pt-BR');
    expect(withLocale.last().init.method).toBe('GET');
    expect(withLocale.last().init.body).toBeUndefined();

    const bare = recorder();
    await createReservaClient({ fetch: bare.fetchFn }).catalog();
    expect(bare.last().url).toBe('/api/booking/catalog');
  });

  it('asks availability for the service and window, and forbids caching the answer', async () => {
    const fake = recorder();
    await createReservaClient({ fetch: fake.fetchFn }).availability({ serviceSlug: 'vintage', from: '2026-06-15', to: '2026-06-30' });
    const url = new URL(fake.last().url, 'https://example.test');
    expect(url.pathname).toBe('/api/booking/availability');
    expect(Object.fromEntries(url.searchParams)).toEqual({ serviceSlug: 'vintage', from: '2026-06-15', to: '2026-06-30' });
    // A slot list read from the bfcache or a shared cache shows seats that are already gone.
    expect(fake.last().init.cache).toBe('no-store');
  });

  it('only sends quantity when the caller asked for a party size', async () => {
    const fake = recorder();
    await createReservaClient({ fetch: fake.fetchFn }).availability({ serviceSlug: 'vintage', quantity: 4, from: '2026-06-15', to: '2026-06-30' });
    expect(new URL(fake.last().url, 'https://example.test').searchParams.get('quantity')).toBe('4');
  });

  it('posts the checkout payload verbatim as JSON', async () => {
    const fake = recorder({ body: { checkoutUrl: 'https://pay.test/c', bookingId: 'b1', reference: 'LVT-1', paymentDeadline: '2026-06-15T08:35:00.000Z' } });
    const response = await createReservaClient({ fetch: fake.fetchFn }).checkout(checkout);
    expect(fake.last().url).toBe('/api/booking/checkout');
    expect(fake.last().init.method).toBe('POST');
    expect(bodyOf(fake.last())).toEqual(checkout);
    expect(headersOf(fake.last())['content-type']).toBe('application/json');
    expect(response.checkoutUrl).toBe('https://pay.test/c');
  });

  it('reads a payment session by sessionId and a booking by token, both uncached', async () => {
    const status = recorder();
    await createReservaClient({ fetch: status.fetchFn }).status({ sessionId: 'cs_1' });
    expect(status.last().url).toBe('/api/booking/status?sessionId=cs_1');
    expect(status.last().init.cache).toBe('no-store');

    const manage = recorder();
    await createReservaClient({ fetch: manage.fetchFn }).manage({ token: 'tok 1/2' });
    expect(manage.last().url).toBe('/api/booking/manage?token=tok+1%2F2');
    expect(manage.last().init.cache).toBe('no-store');
  });

  it('authorizes every operator and ops route with the configured bearer', async () => {
    const fake = recorder();
    const client = createReservaClient({ fetch: fake.fetchFn, bearer: 'op-secret' });
    await client.operator.cancel({ operatorToken: 'op', bookingId: 'b1' });
    expect(fake.last().url).toBe('/api/booking/operator/cancel');
    expect(headersOf(fake.last()).authorization).toBe('Bearer op-secret');

    await client.operator.reschedule({ start: '2026-06-16T09:00:00.000+01:00', bookingId: 'b1' });
    expect(fake.last().url).toBe('/api/booking/operator/reschedule');
    expect(headersOf(fake.last()).authorization).toBe('Bearer op-secret');

    await client.operator.noShow({ bookingId: 'b1' });
    expect(fake.last().url).toBe('/api/booking/operator/no-show');
    expect(headersOf(fake.last()).authorization).toBe('Bearer op-secret');

    await client.opsHealth();
    expect(fake.last().url).toBe('/api/booking/ops/health');
    expect(headersOf(fake.last()).authorization).toBe('Bearer op-secret');

    await client.opsReconcile({ sourceLimit: 10 });
    expect(fake.last().url).toBe('/api/booking/ops/reconcile');
    expect(bodyOf(fake.last())).toEqual({ sourceLimit: 10 });
    expect(headersOf(fake.last()).authorization).toBe('Bearer op-secret');
  });

  it('never leaks the operator secret onto a customer route', async () => {
    const fake = recorder();
    const client = createReservaClient({ fetch: fake.fetchFn, bearer: 'op-secret' });
    await client.cancel({ token: 'cancel-token' });
    expect(fake.last().url).toBe('/api/booking/cancel');
    expect(headersOf(fake.last()).authorization).toBeUndefined();
  });

  it('omits the authorization header when no bearer is configured', async () => {
    const fake = recorder();
    await createReservaClient({ fetch: fake.fetchFn }).opsHealth();
    expect(headersOf(fake.last()).authorization).toBeUndefined();
  });
});

describe('createReservaClient route resolution', () => {
  it('hangs the default patterns off `base` for a cross-origin funnel', async () => {
    const fake = recorder();
    await createReservaClient({ fetch: fake.fetchFn, base: 'https://booking.example.com' }).catalog();
    expect(fake.last().url).toBe('https://booking.example.com/api/booking/catalog');
  });

  it('uses the deployment route table, falling back to the default for a path it does not carry', async () => {
    const fake = recorder();
    const client = createReservaClient({ fetch: fake.fetchFn, paths: { catalog: '/reservas/api/booking/catalog' } });
    await client.catalog();
    expect(fake.last().url).toBe('/reservas/api/booking/catalog');
    await client.checkout(checkout);
    expect(fake.last().url).toBe('/api/booking/checkout');
  });

  it('refuses a mount described twice, rather than silently picking one', () => {
    expect(() => createReservaClient({ paths: { catalog: '/c' }, base: '' })).toThrow(/either `paths` or `base`/);
  });
});

describe('createReservaClient failures', () => {
  it('turns an error envelope into a ReservaApiError carrying status, code and details', async () => {
    const fake = recorder({ status: 400, body: { error: { code: 'validation_failed', message: 'quantity is above the maximum', details: { field: 'quantity', allowed: ['1', '2'] } } } });
    const error = await createReservaClient({ fetch: fake.fetchFn }).checkout(checkout).catch((thrown: unknown) => thrown);
    expect(isReservaApiError(error)).toBe(true);
    const api = error as ReservaApiError;
    expect(api.status).toBe(400);
    expect(api.code).toBe('validation_failed');
    expect(api.message).toBe('quantity is above the maximum');
    expect(api.details).toEqual({ field: 'quantity', allowed: ['1', '2'] });
  });

  it('reports a non-envelope failure as internal_error, keeping the transport status', async () => {
    const html = recorder({ status: 503, text: '<html>edge is down</html>' });
    const gateway = await createReservaClient({ fetch: html.fetchFn }).catalog().then(unexpectedSuccess, asApiError);
    expect(gateway.code).toBe('internal_error');
    expect(gateway.status).toBe(503);

    // JSON, but not Reserva's shape: still not a code a caller may branch on.
    const foreign = recorder({ status: 404, body: { message: 'no route here' } });
    const missing = await createReservaClient({ fetch: foreign.fetchFn }).catalog().then(unexpectedSuccess, asApiError);
    expect(missing.code).toBe('internal_error');
    expect(missing.status).toBe(404);

    // An envelope whose code is not in the published catalog is equally untrustworthy.
    const unknownCode = recorder({ status: 418, body: { error: { code: 'teapot', message: 'nope' } } });
    const teapot = await createReservaClient({ fetch: unknownCode.fetchFn }).catalog().then(unexpectedSuccess, asApiError);
    expect(teapot.code).toBe('internal_error');
    expect(teapot.status).toBe(418);
  });

  it('reports a request that never reached the server with status 0', async () => {
    const fake = recorder({ throws: new TypeError('Failed to fetch') });
    const error = await createReservaClient({ fetch: fake.fetchFn }).catalog().then(unexpectedSuccess, asApiError);
    expect(isReservaApiError(error)).toBe(true);
    expect(error.status).toBe(0);
    expect(error.code).toBe('internal_error');
    expect(error.message).toBe('Failed to fetch');
  });

  it('rejects a 2xx body that is not JSON instead of returning a broken value', async () => {
    const fake = recorder({ status: 200, text: 'not json' });
    const error = await createReservaClient({ fetch: fake.fetchFn }).catalog().then(unexpectedSuccess, asApiError);
    expect(error.status).toBe(200);
    expect(error.code).toBe('internal_error');
  });

  it('does not claim unrelated throwables as its own', () => {
    expect(isReservaApiError(new Error('boom'))).toBe(false);
    expect(isReservaApiError({ status: 400, code: 'not_found' })).toBe(false);
    expect(isReservaApiError(null)).toBe(false);
  });
});
