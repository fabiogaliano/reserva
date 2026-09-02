// The signature contract is verified against the Standard Webhooks spec's own library, an
// independent implementation, so a drift in signing string, headers, or key decoding fails here.
import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { describe, expect, it, vi } from 'vitest';
import { WEBHOOK_USER_AGENT, WebhookResponseError, deliverWebhook } from '../src/webhooks';

const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const now = new Date('2026-09-01T12:00:00.000Z');

function capture(response = new Response(null, { status: 204 })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

// The spec library reads the wall clock to enforce its 300-second timestamp tolerance, so every
// verification here happens at a pinned instant rather than whenever the suite happens to run.
function verifyAt(instant: Date, body: string, headers: Record<string, string>): unknown {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(instant);
    return new Webhook(secret).verify(body, {
      'webhook-id': headers['webhook-id'] ?? '',
      'webhook-timestamp': headers['webhook-timestamp'] ?? '',
      'webhook-signature': headers['webhook-signature'] ?? '',
    });
  } finally {
    vi.useRealTimers();
  }
}

describe('outbound webhook delivery', () => {
  it('sends a Standard Webhooks-verifiable request the spec library accepts', async () => {
    const { calls, fetchImpl } = capture();
    const body = JSON.stringify({ apiVersion: 1, id: 'booking-1/webhook:ops:booking.confirmed', event: 'booking.confirmed' });

    await deliverWebhook({
      name: 'ops', url: 'https://example.test/hooks', secret,
      id: 'booking-1/webhook:ops:booking.confirmed', body, now, fetchImpl,
    });

    const call = calls[0];
    if (!call) throw new Error('no request was made');
    expect(call.url).toBe('https://example.test/hooks');
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe(body);
    const headers = headersOf(call.init);
    expect(headers['user-agent']).toBe(WEBHOOK_USER_AGENT);
    expect(headers['webhook-id']).toBe('booking-1/webhook:ops:booking.confirmed');
    expect(headers['webhook-timestamp']).toBe(String(Math.floor(now.getTime() / 1000)));

    expect(verifyAt(now, body, headers)).toEqual(JSON.parse(body));
  });

  it('produces a signature the spec library rejects when the body is tampered with in transit', async () => {
    const { calls, fetchImpl } = capture();
    const body = JSON.stringify({ apiVersion: 1, id: 'booking-2/webhook:ops:booking.no_show' });
    await deliverWebhook({ name: 'ops', url: 'https://example.test/hooks', secret, id: 'booking-2/webhook:ops:booking.no_show', body, now, fetchImpl });
    const headers = headersOf(calls[0]?.init ?? {});

    expect(() => verifyAt(now, body.replace('booking-2', 'booking-3'), headers)).toThrow(WebhookVerificationError);
    expect(verifyAt(now, body, headers)).toEqual(JSON.parse(body));
  });

  it('stamps a fresh timestamp per attempt, so a retry outside the spec tolerance is rejected while the same bytes signed now pass', async () => {
    const body = JSON.stringify({ apiVersion: 1, id: 'booking-4/webhook:ops:booking.confirmed' });
    const stale = capture();
    await deliverWebhook({
      name: 'ops', url: 'https://example.test/hooks', secret, id: 'booking-4/webhook:ops:booking.confirmed', body,
      now: new Date(now.getTime() - 10 * 60_000), fetchImpl: stale.fetchImpl,
    });
    const fresh = capture();
    await deliverWebhook({ name: 'ops', url: 'https://example.test/hooks', secret, id: 'booking-4/webhook:ops:booking.confirmed', body, now, fetchImpl: fresh.fetchImpl });

    const staleHeaders = headersOf(stale.calls[0]?.init ?? {});
    const freshHeaders = headersOf(fresh.calls[0]?.init ?? {});
    expect(freshHeaders['webhook-timestamp']).not.toBe(staleHeaders['webhook-timestamp']);
    expect(freshHeaders['webhook-signature']).not.toBe(staleHeaders['webhook-signature']);

    expect(() => verifyAt(now, body, staleHeaders)).toThrow(WebhookVerificationError);
    expect(verifyAt(now, body, freshHeaders)).toEqual(JSON.parse(body));
  });

  it('signs an unprefixed base64 secret identically to the whsec_ form', async () => {
    const body = JSON.stringify({ apiVersion: 1, id: 'booking-5/webhook:ops:booking.confirmed' });
    const prefixed = capture();
    const bare = capture();
    await deliverWebhook({ name: 'ops', url: 'https://example.test/hooks', secret, id: 'booking-5/webhook:ops:booking.confirmed', body, now, fetchImpl: prefixed.fetchImpl });
    await deliverWebhook({ name: 'ops', url: 'https://example.test/hooks', secret: secret.slice('whsec_'.length), id: 'booking-5/webhook:ops:booking.confirmed', body, now, fetchImpl: bare.fetchImpl });

    expect(headersOf(bare.calls[0]?.init ?? {})['webhook-signature'])
      .toBe(headersOf(prefixed.calls[0]?.init ?? {})['webhook-signature']);
  });

  it('abandons a malformed secret permanently instead of retrying it', async () => {
    const { fetchImpl } = capture();
    await expect(deliverWebhook({
      name: 'ops', url: 'https://example.test/hooks', secret: 'whsec_not base64!!', id: 'booking-6/webhook:ops:booking.confirmed',
      body: '{}', now, fetchImpl,
    })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('Standard Webhooks key') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a non-2xx response by status with a bounded body', async () => {
    const { fetchImpl } = capture(new Response('x'.repeat(500), { status: 503 }));
    const failure = await deliverWebhook({
      name: 'ops', url: 'https://example.test/hooks', secret, id: 'booking-7/webhook:ops:booking.confirmed', body: '{}', now, fetchImpl,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WebhookResponseError);
    expect(failure).toMatchObject({ status: 503, retryable: true });
    expect((failure as Error).message.length).toBeLessThan(300);

    const permanent = capture(new Response('nope', { status: 404 }));
    await expect(deliverWebhook({
      name: 'ops', url: 'https://example.test/hooks', secret, id: 'booking-8/webhook:ops:booking.confirmed', body: '{}', now, fetchImpl: permanent.fetchImpl,
    })).rejects.toMatchObject({ status: 404, retryable: false });
  });
});
