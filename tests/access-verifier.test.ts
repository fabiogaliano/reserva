import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudflareAccessAdminAuth } from '../src/access';

const aud = 'admin-audience';
const now = Date.parse('2026-07-21T12:00:00.000Z');

// The JWKS cache is module-level and keyed by team domain, so each test gets its own domain
// instead of a cache-reset hook.
let domainCounter = 0;

async function fixture() {
  domainCounter += 1;
  const teamDomain = `https://team-${domainCounter}.cloudflareaccess.com`;
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const key = { ...jwk, kid: 'access-key', alg: 'RS256', use: 'sig' };
  const fetchCalls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify({ keys: [key] }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  const encode = (bytes: Uint8Array) => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const encodeJson = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

  async function token(claims: Record<string, unknown> = {}) {
    const header = encodeJson({ alg: 'RS256', typ: 'JWT', kid: 'access-key' });
    const payload = encodeJson({
      iss: teamDomain,
      aud: ['another-audience', aud],
      exp: Math.floor(now / 1000) + 60,
      sub: 'access-user-id',
      email: 'ops@example.test',
      ...claims,
    });
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      keyPair.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${encode(new Uint8Array(signature))}`;
  }

  return { auth: cloudflareAccessAdminAuth(teamDomain, aud), fetchCalls, token };
}

function requestWithToken(assertion?: string): Request {
  if (!assertion) return new Request('https://example.test/booking/admin');
  return new Request('https://example.test/booking/admin', {
    headers: { 'Cf-Access-Jwt-Assertion': assertion },
  });
}

describe('cloudflareAccessAdminAuth', () => {
  // Only Date is faked: WebCrypto and fetch resolve on real microtasks.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('verifies an RS256 assertion with an audience array and prefers the email claim as subject', async () => {
    const { auth, token } = await fixture();
    await expect(auth(requestWithToken(await token()))).resolves.toEqual({
      subject: 'ops@example.test',
      email: 'ops@example.test',
    });
  });

  it('falls back to sub as the subject when the assertion carries no email', async () => {
    const { auth, token } = await fixture();
    await expect(auth(requestWithToken(await token({ email: undefined })))).resolves.toEqual({
      subject: 'access-user-id',
    });
  });

  it('rejects and warns on an assertion with neither email nor sub, so admins never share one CSRF subject', async () => {
    const { auth, token } = await fixture();
    const warn = vi.fn();
    await expect(auth(requestWithToken(await token({ email: undefined, sub: undefined })), { logger: { warn } }))
      .resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('access assertion carries no email or sub claim', expect.any(Object));
  });

  it('caches the team JWKS for five minutes', async () => {
    const { auth, fetchCalls, token } = await fixture();

    await expect(auth(requestWithToken(await token()))).resolves.not.toBeNull();
    await expect(auth(requestWithToken(await token()))).resolves.not.toBeNull();
    expect(fetchCalls).toHaveLength(1);

    vi.setSystemTime(now + 5 * 60_000 + 1);
    await expect(auth(requestWithToken(await token({ exp: Math.floor(now / 1000) + 3600 })))).resolves.not.toBeNull();
    expect(fetchCalls).toHaveLength(2);
  });

  it('rejects a request with no assertion', async () => {
    const { auth } = await fixture();
    await expect(auth(requestWithToken())).resolves.toBeNull();
  });

  // Every row differs from the accepted baseline token in one claim only, so the null is caused by
  // that claim.
  it.each([
    ['wrong issuer', { iss: 'https://other.cloudflareaccess.com' }],
    ['wrong audience', { aud: 'not-the-admin-app' }],
    ['expired assertion', { exp: Math.floor(now / 1000) - 1 }],
    ['missing expiry', { exp: undefined }],
    ['invalid not-before claim', { nbf: 'later' }],
  ])('rejects an assertion with %s', async (_label, claims) => {
    const { auth, token } = await fixture();
    await expect(auth(requestWithToken(await token(claims)))).resolves.toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const { auth, token } = await fixture();
    const assertion = await token();
    const [header, payload, signature] = assertion.split('.');
    const changedFirstByte = signature![0] === 'A' ? 'B' : 'A';
    const tampered = `${header}.${payload}.${changedFirstByte}${signature!.slice(1)}`;

    await expect(auth(requestWithToken(tampered))).resolves.toBeNull();
  });
});
