import { describe, expect, it } from 'vitest';
import { MANAGE_TOKEN_HEADER } from '../src/core/api';
import { corsPreflight, withCors } from '../src/cors';

const origins = ['https://www.example.com'];

function request(origin?: string, method = 'GET'): Request {
  return new Request('https://booking.example.com/api/booking/availability', {
    method,
    ...(origin ? { headers: { origin } } : {}),
  });
}

describe('corsPreflight', () => {
  it('lets an allowlisted origin send the headers the browser client uses', () => {
    const response = corsPreflight(request('https://www.example.com', 'OPTIONS'), origins);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST');
    const allowedHeaders = response.headers.get('access-control-allow-headers')?.split(',').map((name) => name.trim());
    expect(allowedHeaders).toEqual(expect.arrayContaining(['content-type', MANAGE_TOKEN_HEADER]));
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('answers any other origin without an allow header, so the browser refuses it', () => {
    const response = corsPreflight(request('https://evil.example', 'OPTIONS'), origins);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('adds no CORS headers at all when routes.cors is not configured', () => {
    const response = corsPreflight(request('https://www.example.com', 'OPTIONS'), undefined);
    expect([...response.headers.keys()]).toEqual([]);
  });
});

describe('withCors', () => {
  it('lets an allowlisted origin read the response and keeps status, body and existing headers', async () => {
    const response = withCors(
      request('https://www.example.com'),
      origins,
      new Response('{"error":{}}', { status: 409, headers: { 'content-type': 'application/json', vary: 'Accept-Language' } }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toBe('{"error":{}}');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
    expect(response.headers.get('vary')).toBe('Accept-Language, Origin');
  });

  it('varies on Origin without allowing an unlisted or absent origin', () => {
    for (const origin of ['https://evil.example', undefined]) {
      const response = withCors(request(origin), origins, new Response('{}'));
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('vary')).toBe('Origin');
    }
  });

  it('returns the very same response when routes.cors is not configured', () => {
    const original = new Response('{}');
    expect(withCors(request('https://www.example.com'), undefined, original)).toBe(original);
  });

  it('works on a response whose headers are immutable, like a cache hit', () => {
    const immutable = Response.redirect('https://booking.example.com/', 302);
    expect(() => immutable.headers.set('x-probe', '1')).toThrow();
    const response = withCors(request('https://www.example.com'), origins, immutable);
    expect(response.status).toBe(302);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
  });
});
