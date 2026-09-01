import { describe, expect, it } from 'vitest';
import { ADMIN_CSRF_TOKEN_TTL_MS, adminOriginAllowed, mintAdminCsrfToken, verifyAdminCsrfToken } from '../src/admin-csrf';

const ADMIN_URL = 'https://example.test/api/booking/admin';
const now = Date.parse('2026-06-14T08:00:00.000Z');

// RESERVA_CSRF_SECRET configured: this is the "layer 2 active" fixture used by most of this file —
// production deployments must set this secret for the token to actually protect anything (see
// src/admin-csrf.ts csrfSecret).
const secrets = async (name: string) => (name === 'RESERVA_CSRF_SECRET' ? 'unit-test-secret' : undefined);
const context = { config: { admin: { access: { aud: 'test-audience' } } }, secrets };

function requestWith(headers: HeadersInit): Request {
  return new Request(ADMIN_URL, { method: 'POST', headers });
}

// Mirrors admin-csrf.ts's private base64url + HMAC-SHA256 signing, only so this file can forge a
// token exactly the way an attacker who knows a piece of key material (but not the real secret)
// would, to prove verifyAdminCsrfToken rejects it. Not exported from src/admin-csrf.ts on purpose —
// signing is an implementation detail, not part of its public surface.
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function forgeToken(key: string, sub: string, exp: number): Promise<string> {
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub, exp })));
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(payloadPart));
  return `${payloadPart}.${base64UrlEncode(new Uint8Array(signature))}`;
}

describe('adminOriginAllowed (BK-SEC-001 layer 1: Fetch-Metadata / Origin enforcement)', () => {
  it('accepts Sec-Fetch-Site: same-origin', () => {
    expect(adminOriginAllowed(requestWith({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  it('rejects Sec-Fetch-Site: cross-site', () => {
    expect(adminOriginAllowed(requestWith({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('rejects Sec-Fetch-Site: same-site (deliberate — a sibling/subdomain is not this origin\'s trust boundary)', () => {
    expect(adminOriginAllowed(requestWith({ 'sec-fetch-site': 'same-site' }))).toBe(false);
  });

  it('rejects Sec-Fetch-Site: none', () => {
    expect(adminOriginAllowed(requestWith({ 'sec-fetch-site': 'none' }))).toBe(false);
  });

  it('ignores a mismatched Origin header when Sec-Fetch-Site is present and trusted', () => {
    // Sec-Fetch-Site is browser-set and authoritative; a request can't actually carry contradictory
    // values in practice, but the guard must not accidentally consult Origin once Sec-Fetch-Site is
    // present.
    expect(adminOriginAllowed(requestWith({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.test' }))).toBe(true);
  });

  it('falls back to Origin when Sec-Fetch-Site is absent, and accepts a matching same-origin value', () => {
    expect(adminOriginAllowed(requestWith({ origin: 'https://example.test' }))).toBe(true);
  });

  it('falls back to Origin and rejects a foreign origin', () => {
    expect(adminOriginAllowed(requestWith({ origin: 'https://evil.test' }))).toBe(false);
  });

  it('rejects a malformed Origin header', () => {
    expect(adminOriginAllowed(requestWith({ origin: 'not-a-url' }))).toBe(false);
  });

  it('rejects a request with neither Sec-Fetch-Site nor Origin present', () => {
    expect(adminOriginAllowed(requestWith({}))).toBe(false);
  });
});

describe('mintAdminCsrfToken / verifyAdminCsrfToken (BK-SEC-001 layer 2: per-session CSRF token, RESERVA_CSRF_SECRET configured)', () => {
  it('verifies a freshly minted token for the same subject', async () => {
    const token = await mintAdminCsrfToken(context, 'ops@example.test', now);
    await expect(verifyAdminCsrfToken(context, token, 'ops@example.test', now)).resolves.toBe(true);
  });

  it('verifies a token bound to an empty subject (no Access claims available)', async () => {
    const token = await mintAdminCsrfToken(context, '', now);
    await expect(verifyAdminCsrfToken(context, token, '', now)).resolves.toBe(true);
  });

  it('rejects a token still within a millisecond of expiry, and accepts it a millisecond before', async () => {
    const token = await mintAdminCsrfToken(context, 'ops@example.test', now);
    await expect(verifyAdminCsrfToken(context, token, 'ops@example.test', now + ADMIN_CSRF_TOKEN_TTL_MS - 1)).resolves.toBe(true);
    await expect(verifyAdminCsrfToken(context, token, 'ops@example.test', now + ADMIN_CSRF_TOKEN_TTL_MS)).resolves.toBe(false);
  });

  it('rejects a token minted for a different subject', async () => {
    const token = await mintAdminCsrfToken(context, 'ops@example.test', now);
    await expect(verifyAdminCsrfToken(context, token, 'someone-else@example.test', now)).resolves.toBe(false);
  });

  it('rejects a token minted under a different RESERVA_CSRF_SECRET (different key material)', async () => {
    const otherSecretContext = { config: context.config, secrets: async (name: string) => (name === 'RESERVA_CSRF_SECRET' ? 'a-different-secret' : undefined) };
    const token = await mintAdminCsrfToken(otherSecretContext, 'ops@example.test', now);
    await expect(verifyAdminCsrfToken(context, token, 'ops@example.test', now)).resolves.toBe(false);
  });

  it('rejects a token minted under a different Access audience but the same secret (the aud is mixed in for domain separation)', async () => {
    const otherAudContext = { config: { admin: { access: { aud: 'a-different-audience' } } }, secrets };
    const token = await mintAdminCsrfToken(otherAudContext, 'ops@example.test', now);
    await expect(verifyAdminCsrfToken(context, token, 'ops@example.test', now)).resolves.toBe(false);
  });

  // A deployment with no `config.admin.access` at all (a custom `adminAuth`) derives the literal
  // 'custom' instead of an aud — proves it gets genuinely distinct key material from an Access
  // deployment sharing the same RESERVA_CSRF_SECRET, not an accidental collision (e.g. both
  // resolving to the empty string).
  it('derives a distinct key for a custom (no admin.access) deployment than for an Access deployment sharing the same secret', async () => {
    const customContext = { config: { admin: {} }, secrets };
    const token = await mintAdminCsrfToken(customContext, 'ops@example.test', now);
    await expect(verifyAdminCsrfToken(context, token, 'ops@example.test', now)).resolves.toBe(false);
    await expect(verifyAdminCsrfToken(customContext, token, 'ops@example.test', now)).resolves.toBe(true);
  });

  it('rejects a tampered payload even when the signature part is left untouched', async () => {
    const token = await mintAdminCsrfToken(context, 'ops@example.test', now);
    const [payloadPart, signaturePart] = token!.split('.');
    const tampered = `${payloadPart}x.${signaturePart}`;
    await expect(verifyAdminCsrfToken(context, tampered, 'ops@example.test', now)).resolves.toBe(false);
  });

  it('rejects garbage tokens without throwing', async () => {
    await expect(verifyAdminCsrfToken(context, 'not-a-token', 'ops@example.test', now)).resolves.toBe(false);
    await expect(verifyAdminCsrfToken(context, '...', 'ops@example.test', now)).resolves.toBe(false);
    await expect(verifyAdminCsrfToken(context, '', 'ops@example.test', now)).resolves.toBe(false);
    await expect(verifyAdminCsrfToken(context, null, 'ops@example.test', now)).resolves.toBe(false);
    await expect(verifyAdminCsrfToken(context, undefined, 'ops@example.test', now)).resolves.toBe(false);
  });

  // The token used to be HMAC'd with accessAud alone whenever RESERVA_CSRF_SECRET was unset.
  // accessAud is not secret (it's the Access JWT `aud` claim, visible to anyone who has ever
  // completed an Access login), so that key was forgeable by any attacker who could read a JWT.
  // This proves a token forged that way — signed using ONLY the (public) accessAud as the HMAC
  // key — is rejected once a real secret is configured, i.e. the real verifier's key material is
  // never reducible to public information alone.
  it('is unforgeable from accessAud alone: a token HMAC-signed with only the public accessAud as key is rejected', async () => {
    const forged = await forgeToken(context.config.admin.access.aud, 'ops@example.test', now + ADMIN_CSRF_TOKEN_TTL_MS);
    await expect(verifyAdminCsrfToken(context, forged, 'ops@example.test', now)).resolves.toBe(false);
  });
});

describe('mintAdminCsrfToken / verifyAdminCsrfToken without RESERVA_CSRF_SECRET (BK-SEC-001 finding 1 fix: layer 2 fails open, layer 1 does not)', () => {
  const noSecretContext = { config: { admin: { access: { aud: 'test-audience' } } } };

  it('mintAdminCsrfToken returns undefined — no real secret means no token is emitted', async () => {
    await expect(mintAdminCsrfToken(noSecretContext, 'ops@example.test', now)).resolves.toBeUndefined();
  });

  it('verifyAdminCsrfToken passes unconditionally — with no secret, a missing/garbage/foreign-subject token is not distinguishable from a "real" one, so it isn\'t treated as a failure', async () => {
    await expect(verifyAdminCsrfToken(noSecretContext, null, 'ops@example.test', now)).resolves.toBe(true);
    await expect(verifyAdminCsrfToken(noSecretContext, undefined, 'ops@example.test', now)).resolves.toBe(true);
    await expect(verifyAdminCsrfToken(noSecretContext, 'garbage', 'ops@example.test', now)).resolves.toBe(true);
    await expect(verifyAdminCsrfToken(noSecretContext, 'garbage', 'someone-else@example.test', now)).resolves.toBe(true);
  });

  it('a token minted while a secret WAS configured is also accepted once verified without one (the check is skipped entirely, not just weakened)', async () => {
    const token = await mintAdminCsrfToken(context, 'ops@example.test', now);
    await expect(verifyAdminCsrfToken(noSecretContext, token, 'a-completely-different-subject', now)).resolves.toBe(true);
  });
});
