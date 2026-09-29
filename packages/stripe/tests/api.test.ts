import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  createStripeFetchClient,
  encodeStripeForm,
  STRIPE_API_VERSION,
  StripeAPIError,
  StripeAuthenticationError,
  StripeCardError,
  StripeConnectionError,
  StripeIdempotencyError,
  StripeInvalidRequestError,
  StripePermissionError,
  StripeRateLimitError,
  StripeSignatureVerificationError,
  verifyStripeSignature,
  type StripeCheckoutSessionCreateParams,
} from '../src/api';
import { stripe, type StripeClient } from '../src/index';

// stripe-node stays a dev dependency only to hold this client to the SDK's observable behaviour:
// what goes over the wire and how responses are classified.

interface Captured { url: string; method: string; headers: Record<string, string>; body: string | undefined }

function recordingFetch(respond: (call: number) => Response | Error = () => json({ id: 'obj_1' })) {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : undefined });
    const outcome = respond(calls.length);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const noSleep = async () => undefined;

const checkoutParams: StripeCheckoutSessionCreateParams = {
  mode: 'payment',
  line_items: [{ quantity: 1, price_data: {
    currency: 'eur', unit_amount: 12000,
    product_data: { name: "Alfama & Belém (sunset) — it's *fun*!", description: 'Tuk-tuk · 2h' },
  } }],
  expires_at: 1790650000,
  locale: 'pt',
  excluded_payment_method_types: ['sepa_debit', 'multibanco'],
  submit_type: 'book',
  phone_number_collection: { enabled: true },
  metadata: { bookingId: 'b-1' },
  payment_intent_data: { metadata: { bookingId: 'b-1' } },
  success_url: 'https://example.test/booking-confirmation?sessionId={CHECKOUT_SESSION_ID}&locale=pt-PT',
  cancel_url: 'https://example.test/tours/alfama?ref=casa%20%26%20co',
  custom_fields: [
    { key: 'pickup_address', label: { type: 'custom', custom: 'Pickup address' }, type: 'text' },
    { key: 'guest_count', label: { type: 'custom', custom: 'Exact number of guests' }, type: 'numeric', optional: true, numeric: { maximum_length: 3 } },
  ],
  consent_collection: { terms_of_service: 'required' },
};

describe('form encoding', () => {
  it('encodes nested objects, indexed arrays and reserved characters the way Stripe expects', () => {
    expect(encodeStripeForm({
      a: 'x y', n: 3, t: true, skip: undefined, empty: null,
      meta: { k: "it's (a) *test*!" }, list: ['p', 'q'], rows: [{ x: 1 }, { y: { z: 'w' } }],
    })).toBe("a=x%20y&n=3&t=true&empty=&meta[k]=it%27s%20%28a%29%20%2Atest%2A%21&list[0]=p&list[1]=q&rows[0][x]=1&rows[1][y][z]=w");
  });

  it('sends a checkout session byte-for-byte as stripe-node does, to the same endpoint and API version', async () => {
    const sdk = recordingFetch(() => json({ id: 'cs_1', object: 'checkout.session' }));
    const ours = recordingFetch(() => json({ id: 'cs_1', object: 'checkout.session' }));
    const sdkClient = new Stripe('sk_test_parity', { httpClient: Stripe.createFetchHttpClient(sdk.fetchImpl), maxNetworkRetries: 0 });
    await sdkClient.checkout.sessions.create(checkoutParams as Stripe.Checkout.SessionCreateParams, { idempotencyKey: 'reserva-checkout-b-1' });
    await createStripeFetchClient('sk_test_parity', { fetch: ours.fetchImpl, sleep: noSleep })
      .checkout.sessions.create(checkoutParams, { idempotencyKey: 'reserva-checkout-b-1' });

    const [expected] = sdk.calls;
    const [actual] = ours.calls;
    expect(actual!.url).toBe(expected!.url);
    expect(actual!.method).toBe('POST');
    expect(actual!.body).toBe(expected!.body);
    for (const header of ['authorization', 'stripe-version', 'content-type', 'idempotency-key']) {
      expect(actual!.headers[header], header).toBe(expected!.headers[header]);
    }
    expect(actual!.headers['stripe-version']).toBe(STRIPE_API_VERSION);
  });

  it('pins the API version stripe-node 22 defaults to', () => {
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
  });

  it('sends GET parameters as a query string and the ids escaped in the path', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({ object: 'list', data: [] }));
    const client = createStripeFetchClient('sk_test', { fetch: fetchImpl, sleep: noSleep });
    await client.refunds.list({ payment_intent: 'pi_1', limit: 100 });
    await client.checkout.sessions.retrieve('cs_a/b');
    await client.paymentIntents.cancel('pi_2');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.stripe.com/v1/refunds?payment_intent=pi_1&limit=100',
      'GET https://api.stripe.com/v1/checkout/sessions/cs_a%2Fb',
      'POST https://api.stripe.com/v1/payment_intents/pi_2/cancel',
    ]);
    expect(calls[0]!.body).toBeUndefined();
  });
});

describe('idempotency keys', () => {
  it('sends the caller key, and a generated one on a keyless POST so a retry cannot act twice', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({ id: 're_1', amount: 100, status: 'succeeded' }));
    const client = createStripeFetchClient('sk_test', { fetch: fetchImpl, sleep: noSleep });
    await client.refunds.create({ payment_intent: 'pi_1', amount: 100 }, { idempotencyKey: 'reserva-refund-pi_1' });
    await client.paymentIntents.cancel('pi_1');
    await client.checkout.sessions.retrieve('cs_1');
    expect(calls[0]!.headers['idempotency-key']).toBe('reserva-refund-pi_1');
    expect(calls[1]!.headers['idempotency-key']).toMatch(/^reserva-retry-[0-9a-f-]{36}$/);
    expect(calls[2]!.headers['idempotency-key']).toBeUndefined();
  });

  it('retries a transient failure with the same key and the same body', async () => {
    const { calls, fetchImpl } = recordingFetch((call) => (call === 1 ? json({ error: { type: 'api_error', message: 'boom' } }, 500) : json({ id: 're_1' })));
    const client = createStripeFetchClient('sk_test', { fetch: fetchImpl, sleep: noSleep });
    await client.refunds.create({ payment_intent: 'pi_1', amount: 100 }, { idempotencyKey: 'k-1' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['idempotency-key']).toBe('k-1');
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });
});

describe('retries', () => {
  it('retries connection errors, 409 and 5xx up to twice, as stripe-node does on Workers', async () => {
    for (const failure of [() => new TypeError('network'), () => json({ error: { type: 'invalid_request_error' } }, 409), () => json({ error: { type: 'api_error' } }, 503)]) {
      const { calls, fetchImpl } = recordingFetch((call) => (call < 3 ? failure() : json({ id: 'cs_1' })));
      await createStripeFetchClient('sk_test', { fetch: fetchImpl, sleep: noSleep }).checkout.sessions.retrieve('cs_1');
      expect(calls).toHaveLength(3);
    }
  });

  it('stops after two retries and reports a connection failure as StripeConnectionError', async () => {
    const { calls, fetchImpl } = recordingFetch(() => new TypeError('network down'));
    const promise = createStripeFetchClient('sk_test', { fetch: fetchImpl, sleep: noSleep }).checkout.sessions.retrieve('cs_1');
    await expect(promise).rejects.toBeInstanceOf(StripeConnectionError);
    await expect(promise).rejects.toMatchObject({ type: 'StripeConnectionError', message: 'An error occurred with our connection to Stripe. Request was retried 2 times.' });
    expect(calls).toHaveLength(3);
  });

  it('honours stripe-should-retry in both directions and never retries a definitive 4xx', async () => {
    const noRetry = recordingFetch(() => json({ error: { type: 'api_error' } }, 500, { 'stripe-should-retry': 'false' }));
    await expect(createStripeFetchClient('sk_test', { fetch: noRetry.fetchImpl, sleep: noSleep }).checkout.sessions.retrieve('cs_1')).rejects.toBeInstanceOf(StripeAPIError);
    expect(noRetry.calls).toHaveLength(1);

    const forced = recordingFetch((call) => (call === 1 ? json({ error: { type: 'invalid_request_error', code: 'lock_timeout' } }, 400, { 'stripe-should-retry': 'true' }) : json({ id: 'cs_1' })));
    await createStripeFetchClient('sk_test', { fetch: forced.fetchImpl, sleep: noSleep }).checkout.sessions.retrieve('cs_1');
    expect(forced.calls).toHaveLength(2);

    const definitive = recordingFetch(() => json({ error: { type: 'invalid_request_error', message: 'No such session' } }, 404));
    await expect(createStripeFetchClient('sk_test', { fetch: definitive.fetchImpl, sleep: noSleep }).checkout.sessions.retrieve('cs_1')).rejects.toBeInstanceOf(StripeInvalidRequestError);
    expect(definitive.calls).toHaveLength(1);
  });
});

describe('error mapping', () => {
  const cases: Array<[number, Record<string, string>, new (...args: never[]) => Error, string]> = [
    [402, { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' }, StripeCardError, 'StripeCardError'],
    [400, { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Charge has already been refunded.' }, StripeInvalidRequestError, 'StripeInvalidRequestError'],
    [404, { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' }, StripeInvalidRequestError, 'StripeInvalidRequestError'],
    [400, { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters' }, StripeIdempotencyError, 'StripeIdempotencyError'],
    [401, { type: 'invalid_request_error', message: 'Invalid API Key provided' }, StripeAuthenticationError, 'StripeAuthenticationError'],
    [403, { type: 'invalid_request_error', message: 'The provided key does not have access' }, StripePermissionError, 'StripePermissionError'],
    [429, { type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests' }, StripeRateLimitError, 'StripeRateLimitError'],
    [500, { type: 'api_error', message: 'Something went wrong' }, StripeAPIError, 'StripeAPIError'],
  ];

  it.each(cases)('HTTP %i %o becomes the class stripe-node would throw', async (status, body, ErrorClass, typeName) => {
    const respond = () => json({ error: body }, status, { 'request-id': 'req_123', 'stripe-should-retry': 'false' });
    const sdk = recordingFetch(respond);
    const sdkError = await new Stripe('sk_test', { httpClient: Stripe.createFetchHttpClient(sdk.fetchImpl), maxNetworkRetries: 0 })
      .refunds.create({ payment_intent: 'pi_1' }).then(
        () => { throw new Error('stripe-node accepted an error response'); },
        (error: unknown) => error as { type: string; code?: string },
      );

    const ours = recordingFetch(respond);
    const error = await createStripeFetchClient('sk_test', { fetch: ours.fetchImpl, sleep: noSleep })
      .refunds.create({ payment_intent: 'pi_1' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error).toMatchObject({
      type: typeName, rawType: body.type, statusCode: status, requestId: 'req_123', message: body.message, ...(body.code ? { code: body.code } : {}),
    });
    expect(sdkError.type).toBe(typeName);
    expect((error as { code?: string }).code).toBe(sdkError.code);
  });

  it('reports a body that is not JSON as an API error', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('<html>bad gateway</html>', { status: 200 }));
    await expect(createStripeFetchClient('sk_test', { fetch: fetchImpl, sleep: noSleep }).checkout.sessions.retrieve('cs_1'))
      .rejects.toMatchObject({ type: 'StripeAPIError', message: 'Invalid JSON received from the Stripe API' });
  });

  it('keeps the provider treating a declined or rejected refund as definitive and an outage as retryable', async () => {
    const declined = recordingFetch(() => json({ error: { type: 'card_error', message: 'declined' } }, 402));
    const provider = stripe({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client: createStripeFetchClient('sk_test', { fetch: declined.fetchImpl, sleep: noSleep }) as StripeClient });
    await expect(provider.refund!('pi_1', 100)).rejects.toBeInstanceOf(StripeCardError);
    // Definitive: no reconciliation list call follows the create.
    expect(declined.calls.map((call) => call.method)).toEqual(['POST']);

    const outage = recordingFetch(() => json({ error: { type: 'api_error' } }, 500));
    const outageProvider = stripe({ secretKey: 'sk_test', webhookSecret: 'whsec_test', client: createStripeFetchClient('sk_test', { fetch: outage.fetchImpl, sleep: noSleep }) as StripeClient });
    await expect(outageProvider.refund!('pi_1', 100)).rejects.toBeInstanceOf(StripeAPIError);
    // Ambiguous: three create attempts, then the reconciliation list (retried too).
    expect(outage.calls.map((call) => call.method)).toEqual(['POST', 'POST', 'POST', 'GET', 'GET', 'GET']);
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const signer = new Stripe('sk_test_signing_helper');
  const sign = (body: string, options: { timestamp?: number; secret?: string } = {}) => signer.webhooks.generateTestHeaderStringAsync({
    payload: body, secret: options.secret ?? secret, cryptoProvider: Stripe.createSubtleCryptoProvider(),
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
  });

  it('accepts a header stripe-node signed, and returns the parsed event', async () => {
    const header = await sign(payload);
    const client = createStripeFetchClient('sk_test');
    await expect(client.webhooks.constructEventAsync(payload, header, secret, 300)).resolves.toMatchObject({ id: 'evt_1', type: 'checkout.session.completed' });
  });

  it('rejects a tampered payload, a wrong secret and a header without a v1 signature', async () => {
    const header = await sign(payload);
    await expect(verifyStripeSignature(payload.replace('cs_1', 'cs_2'), header, secret)).rejects.toBeInstanceOf(StripeSignatureVerificationError);
    await expect(verifyStripeSignature(payload, header, 'whsec_other')).rejects.toBeInstanceOf(StripeSignatureVerificationError);
    const timestamp = header.split(',')[0]!;
    await expect(verifyStripeSignature(payload, `${timestamp},v0=abc`, secret)).rejects.toThrow('No signatures found with expected scheme');
    await expect(verifyStripeSignature(payload, 'v1=abc', secret)).rejects.toThrow('Unable to extract timestamp and signatures from header');
    await expect(verifyStripeSignature(payload, `${timestamp},v1=not-hex`, secret)).rejects.toBeInstanceOf(StripeSignatureVerificationError);
  });

  it('rejects an event older than the tolerance but not a fresh one', async () => {
    const signedAt = 1_790_000_000;
    const header = await sign(payload, { timestamp: signedAt });
    await expect(verifyStripeSignature(payload, header, secret, 300, (signedAt + 299) * 1000)).resolves.toBeUndefined();
    await expect(verifyStripeSignature(payload, header, secret, 300, (signedAt + 301) * 1000)).rejects.toThrow('Timestamp outside the tolerance zone');
  });

  it('accepts any matching v1 entry, as Stripe sends two while a secret is being rolled', async () => {
    const header = await sign(payload);
    const [timestamp, v1] = header.split(',');
    const otherSignature = (await sign(payload, { secret: 'whsec_old' })).split(',')[1]!;
    await expect(verifyStripeSignature(payload, `${timestamp},${otherSignature},${v1}`, secret)).resolves.toBeUndefined();
  });

  it('turns any verification failure into the provider\'s 400 error', async () => {
    const provider = stripe({ secretKey: 'sk_test', webhookSecret: secret });
    const header = await sign(payload);
    const tampered = new Request('https://example.test/webhook', { method: 'POST', headers: { 'stripe-signature': header }, body: payload.replace('cs_1', 'cs_9') });
    await expect(provider.parseWebhook(tampered)).rejects.toMatchObject({ name: 'StripeWebhookVerificationError', status: 400 });
    const valid = new Request('https://example.test/webhook', { method: 'POST', headers: { 'stripe-signature': header }, body: payload });
    await expect(provider.parseWebhook(valid)).resolves.toMatchObject({ id: 'evt_1', type: 'checkout_completed', sessionRef: 'cs_1' });
  });
});
