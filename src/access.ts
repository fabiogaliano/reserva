// The admin auth port's identity shape. `subject` is what the admin CSRF token binds to
// (src/admin-csrf.ts) — the default Cloudflare Access implementation below prefers the Access JWT's
// `email` claim over its raw `sub` claim (matching what an operator actually recognizes); a custom
// adminAuth with no per-user identity to bind may return the documented empty-string subject
// instead (see admin-csrf.ts's anonymous-subject fallback).
export interface AdminIdentity {
  subject: string;
  email?: string;
}

export const ACCESS_ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';
const JWKS_PATH = '/cdn-cgi/access/certs';
const DEFAULT_JWKS_TTL_MS = 5 * 60_000;

export type AccessClaims = Record<string, unknown> & { iss: string; aud: string | string[] };

export interface AccessAdminConfig { accessTeamDomain: string; accessAud: string }
type Clock = () => number | Date;
export interface AccessVerifierOptions {
  fetch?: typeof fetch;
  crypto?: Pick<Crypto, 'subtle'>;
  clock?: Clock;
  now?: Clock;
  jwksTtlMs?: number;
  cacheTtlMs?: number;
}

export class AccessVerificationError extends Error {
  readonly status = 403;
  readonly code = 'access_unauthorized';
  constructor(message: string) { super(message); this.name = 'AccessVerificationError'; }
}

interface AccessJwk extends JsonWebKey { kid: string; kty: string; alg?: string; use?: string }
interface AccessJwks { keys: AccessJwk[] }
const cache = new Map<string, { expiresAt: number; value: Promise<AccessJwks> }>();

function decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) throw new AccessVerificationError('malformed access assertion');
  const text = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}
function json<T>(part: string): T { try { return JSON.parse(new TextDecoder().decode(decode(part))) as T; } catch { throw new AccessVerificationError('malformed access assertion'); } }
function configOf(config: AccessAdminConfig | { admin: AccessAdminConfig }): AccessAdminConfig { return 'admin' in config ? config.admin : config; }
function jwksUrl(domain: string): string { return `${domain.replace(/\/+$/, '')}${JWKS_PATH}`; }
function audienceMatches(aud: unknown, expected: string): boolean { return aud === expected || (Array.isArray(aud) && aud.includes(expected)); }
function assertionParts(assertion: string): { header: { alg?: unknown; kid?: unknown }; claims: AccessClaims; input: Uint8Array; signature: Uint8Array } {
  const parts = assertion.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new AccessVerificationError('malformed access assertion');
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  const header = json<{ alg?: unknown; kid?: unknown }>(headerPart);
  const claims = json<Partial<AccessClaims>>(claimsPart);
  if (!claims || typeof claims.iss !== 'string' || !('aud' in claims)) throw new AccessVerificationError('access assertion is missing required claims');
  return { header, claims: claims as AccessClaims, input: new TextEncoder().encode(`${headerPart}.${claimsPart}`), signature: decode(signaturePart) };
}
async function fetchJwks(domain: string, options: AccessVerifierOptions): Promise<AccessJwks> {
  const response = await (options.fetch ?? globalThis.fetch)(jwksUrl(domain), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Access JWKS request failed with status ${response.status}`);
  const body = await response.json() as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error('invalid Access JWKS response');
  const keys = body.keys.filter((key): key is AccessJwk => typeof key === 'object' && key !== null && typeof (key as { kid?: unknown }).kid === 'string' && typeof (key as { kty?: unknown }).kty === 'string');
  if (keys.length === 0) throw new Error('invalid Access JWKS response');
  return { keys };
}
async function getJwks(domain: string, options: AccessVerifierOptions, refresh = false): Promise<AccessJwks> {
  const clock = options.clock ?? options.now;
  const clockValue = clock?.() ?? Date.now();
  const now = clockValue instanceof Date ? clockValue.getTime() : clockValue;
  const cached = cache.get(domain);
  if (!refresh && cached && cached.expiresAt > now) return cached.value;
  const value = fetchJwks(domain, options);
  cache.set(domain, { expiresAt: now + (options.jwksTtlMs ?? options.cacheTtlMs ?? DEFAULT_JWKS_TTL_MS), value });
  try { return await value; } catch (error) { if (cache.get(domain)?.value === value) cache.delete(domain); throw error; }
}
async function verify(parts: ReturnType<typeof assertionParts>, jwk: AccessJwk, crypto: Pick<Crypto, 'subtle'>): Promise<boolean> {
  if (jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      new Uint8Array(parts.signature).buffer as ArrayBuffer,
      new Uint8Array(parts.input).buffer as ArrayBuffer,
    );
  } catch { return false; }
}

export function clearAccessJwksCache(): void { cache.clear(); }
export async function verifyAccessJwt(request: Request, config: AccessAdminConfig | { admin: AccessAdminConfig }, options: AccessVerifierOptions = {}): Promise<AccessClaims> {
  const admin = configOf(config);
  const assertion = request.headers.get(ACCESS_ASSERTION_HEADER);
  if (!assertion) throw new AccessVerificationError('missing access assertion');
  const parts = assertionParts(assertion);
  if (parts.header.alg !== 'RS256' || typeof parts.header.kid !== 'string') throw new AccessVerificationError('unsupported access assertion');
  if (parts.claims.iss !== admin.accessTeamDomain) throw new AccessVerificationError('access assertion issuer mismatch');
  if (!audienceMatches(parts.claims.aud, admin.accessAud)) throw new AccessVerificationError('access assertion audience mismatch');
  const clock = options.clock ?? options.now;
  const clockValue = clock?.() ?? Date.now();
  const now = clockValue instanceof Date ? clockValue.getTime() : clockValue;
  const nowSeconds = Math.floor(now / 1000);
  if (typeof parts.claims.exp !== 'number') throw new AccessVerificationError('access assertion is missing a valid expiry');
  if (nowSeconds >= parts.claims.exp) throw new AccessVerificationError('access assertion has expired');
  if (parts.claims.nbf !== undefined && typeof parts.claims.nbf !== 'number') throw new AccessVerificationError('access assertion has an invalid not-before claim');
  if (typeof parts.claims.nbf === 'number' && nowSeconds < parts.claims.nbf) throw new AccessVerificationError('access assertion is not yet valid');
  const crypto = options.crypto ?? globalThis.crypto;
  let jwks = await getJwks(admin.accessTeamDomain, options);
  let jwk = jwks.keys.find((key) => key.kid === parts.header.kid);
  if (!jwk) { jwks = await getJwks(admin.accessTeamDomain, options, true); jwk = jwks.keys.find((key) => key.kid === parts.header.kid); }
  if (!jwk || !(await verify(parts, jwk, crypto))) throw new AccessVerificationError('access assertion signature mismatch');
  return parts.claims;
}
// The admin auth port's default implementation. Auto-wired by
// defineCloudflareReservaRuntime only when `config.admin.access` is configured — never both this
// and a consumer-supplied `adminAuth` at once (validated once, synchronously, at runtime-definition
// initialization; see src/runtime-context.ts). A single-argument `(request) => ...` function is
// assignable everywhere the two-argument `AdminAuth` port type (src/context.ts) is expected: this
// implementation never needs the ReservaContext argument, since Access verification is pure JWT
// verification against `teamDomain`/`aud`.
export function cloudflareAccessAdminAuth(teamDomain: string, aud: string): (request: Request) => Promise<AdminIdentity | null> {
  return async (request) => {
    let claims: AccessClaims;
    try {
      claims = await verifyAccessJwt(request, { accessTeamDomain: teamDomain, accessAud: aud });
    } catch {
      return null;
    }
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
    return { subject: email ?? sub ?? '', ...(email ? { email } : {}) };
  };
}
