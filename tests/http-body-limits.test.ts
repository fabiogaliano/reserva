// requestJson/requestFormData/requestText share one bounded reader: an under-limit body still
// works exactly as before, an over-limit Content-Length rejects before a byte is read, and a body
// that lies about its length is still caught mid-stream once the real byte count overshoots.
import { describe, expect, it } from 'vitest';
import { FORM_BODY_LIMIT_BYTES, JSON_BODY_LIMIT_BYTES, requestFormData, requestJson, requestText, PAYMENT_WEBHOOK_BODY_LIMIT_BYTES } from '../src/http';

// A tiny actual body with a manually oversized Content-Length header: the early-reject path must
// fire off the header alone, so the assertion that request.bodyUsed stays false afterward proves
// the (tiny, cheap-to-read) body was never touched.
function declaredOverLimitRequest(limitBytes: number, headers: HeadersInit = {}): Request {
  return new Request('https://example.test/body-limit', {
    method: 'POST',
    headers: { ...headers, 'content-length': String(limitBytes + 1) },
    body: 'x',
  });
}

// A real streamed body (backed by an actual buffer, not a hand-rolled `pull()` source) that
// understates its own length via a small declared Content-Length -- the case the mid-stream
// byte-counting check exists for.
function dishonestStreamedOverLimitRequest(limitBytes: number, headers: HeadersInit = {}): Request {
  const bytes = new Uint8Array(limitBytes + 4096).fill(97);
  const stream = new Response(bytes).body as ReadableStream<Uint8Array>;
  return new Request('https://example.test/body-limit', {
    method: 'POST',
    headers: { ...headers, 'content-length': '10' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
}

describe('requestJson (32 KB limit)', () => {
  it('parses an under-limit JSON body normally', async () => {
    const request = new Request('https://example.test/x', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }),
    });
    await expect(requestJson(request)).resolves.toEqual({ ok: true });
  });

  it('rejects a valid Content-Length over the limit with 413, before reading any body bytes', async () => {
    const request = declaredOverLimitRequest(JSON_BODY_LIMIT_BYTES);
    await expect(requestJson(request)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(request.bodyUsed).toBe(false);
  });

  it('rejects an understated-Content-Length body that streams past the limit with 413', async () => {
    const request = dishonestStreamedOverLimitRequest(JSON_BODY_LIMIT_BYTES);
    await expect(requestJson(request)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
  });

  it('still returns the existing 400 for malformed JSON under the limit', async () => {
    const request = new Request('https://example.test/x', { method: 'POST', body: 'not json' });
    await expect(requestJson(request)).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
  });
});

describe('requestFormData (256 KB limit)', () => {
  it('parses an under-limit form body normally', async () => {
    const request = new Request('https://example.test/x', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=cancel&token=abc',
    });
    const form = await requestFormData(request);
    expect(form.get('action')).toBe('cancel');
    expect(form.get('token')).toBe('abc');
  });

  it('rejects a valid Content-Length over the limit with 413, before reading any body bytes', async () => {
    const request = declaredOverLimitRequest(FORM_BODY_LIMIT_BYTES, { 'content-type': 'application/x-www-form-urlencoded' });
    await expect(requestFormData(request)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(request.bodyUsed).toBe(false);
  });

  it('rejects an understated-Content-Length body that streams past the limit with 413', async () => {
    const request = dishonestStreamedOverLimitRequest(FORM_BODY_LIMIT_BYTES, { 'content-type': 'application/x-www-form-urlencoded' });
    await expect(requestFormData(request)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
  });
});

describe('requestText (1 MB payment webhook limit)', () => {
  it('returns an under-limit body exactly, byte-for-byte', async () => {
    const request = new Request('https://example.test/x', { method: 'POST', body: '{"raw":true}' });
    await expect(requestText(request, PAYMENT_WEBHOOK_BODY_LIMIT_BYTES)).resolves.toBe('{"raw":true}');
  });

  it('rejects a valid Content-Length over the limit with 413, before reading any body bytes', async () => {
    const request = declaredOverLimitRequest(PAYMENT_WEBHOOK_BODY_LIMIT_BYTES);
    await expect(requestText(request, PAYMENT_WEBHOOK_BODY_LIMIT_BYTES)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(request.bodyUsed).toBe(false);
  });

  it('rejects an understated-Content-Length body that streams past the limit with 413', async () => {
    const request = dishonestStreamedOverLimitRequest(PAYMENT_WEBHOOK_BODY_LIMIT_BYTES);
    await expect(requestText(request, PAYMENT_WEBHOOK_BODY_LIMIT_BYTES)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
  });
});
