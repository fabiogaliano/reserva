import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAccessJwksCache,
  AccessVerificationError,
  verifyAccessJwt,
} from '../src/access';

const teamDomain = 'https://team.cloudflareaccess.com';
const admin = { accessTeamDomain: teamDomain, accessAud: 'admin-audience' };
const now = Date.parse('2026-07-21T12:00:00.000Z');

async function fixture() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const key = { ...jwk, kid: 'access-key', alg: 'RS256', use: 'sig' };
  const fetchCalls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify({ keys: [key] }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  async function token(claims: Record<string, unknown> = {}) {
    const encode = (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'access-key' });
    const payload = encode({
      iss: teamDomain,
      aud: ['another-audience', admin.accessAud],
      exp: Math.floor(now / 1000) + 60,
      ...claims,
    });
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      keyPair.privateKey,
      new TextEncoder().encode(input),
    );
    const bytes = new Uint8Array(signature);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encodedSignature = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${input}.${encodedSignature}`;
  }

  return { fetchCalls, fetcher, token };
}

function requestWithToken(assertion?: string): Request {
  if (!assertion) return new Request('https://example.test/booking/admin');
  return new Request('https://example.test/booking/admin', {
    headers: { 'Cf-Access-Jwt-Assertion': assertion },
  });
}

describe('Cloudflare Access JWT verification', () => {
  beforeEach(() => clearAccessJwksCache());

  it('verifies an RS256 assertion and accepts an audience array', async () => {
    const { fetcher, token } = await fixture();
    const claims = await verifyAccessJwt(requestWithToken(await token()), admin, {
      fetch: fetcher,
      clock: () => now,
    });

    expect(claims.iss).toBe(teamDomain);
    expect(claims.aud).toEqual(['another-audience', admin.accessAud]);
  });

  it('caches the team JWKS until the injected TTL expires', async () => {
    const { fetchCalls, fetcher, token } = await fixture();
    let currentTime = now;
    const options = { fetch: fetcher, clock: () => currentTime, jwksTtlMs: 1_000 };

    await verifyAccessJwt(requestWithToken(await token()), admin, options);
    await verifyAccessJwt(requestWithToken(await token()), admin, options);
    expect(fetchCalls).toHaveLength(1);

    currentTime += 1_001;
    await verifyAccessJwt(requestWithToken(await token()), admin, options);
    expect(fetchCalls).toHaveLength(2);
  });

  it('rejects a missing assertion with a 403 error', async () => {
    await expect(verifyAccessJwt(requestWithToken(), admin)).rejects.toMatchObject({
      name: 'AccessVerificationError',
      status: 403,
    });
  });

  it.each([
    ['wrong issuer', { iss: 'https://other.cloudflareaccess.com' }],
    ['wrong audience', { aud: 'not-the-admin-app' }],
    ['expired assertion', { exp: Math.floor(now / 1000) - 1 }],
    ['missing expiry', { exp: undefined }],
    ['invalid not-before claim', { nbf: 'later' }],
  ])('rejects an assertion with %s', async (_label, claims) => {
    const { fetcher, token } = await fixture();
    await expect(verifyAccessJwt(requestWithToken(await token(claims)), admin, {
      fetch: fetcher,
      clock: () => now,
    })).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it('rejects a tampered signature', async () => {
    const { fetcher, token } = await fixture();
    const assertion = await token();
    const [header, payload, signature] = assertion.split('.');
    const changedFirstByte = signature![0] === 'A' ? 'B' : 'A';
    const tampered = `${header}.${payload}.${changedFirstByte}${signature!.slice(1)}`;

    await expect(verifyAccessJwt(requestWithToken(tampered), admin, {
      fetch: fetcher,
      clock: () => now,
    })).rejects.toThrow('signature mismatch');
  });
});
