import { ProviderFailure } from '../../provider-failure.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
export const GOOGLE_JWT_ALGORITHM = 'RSASSA-PKCS1-v1_5';
export const GOOGLE_TOKEN_CACHE_SKEW_MS = 5 * 60 * 1000;

export type GoogleFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type GoogleClock = () => Date | number;

export interface GoogleCrypto {
  subtle: Pick<SubtleCrypto, 'importKey' | 'sign'>;
}

export interface GoogleAuthOptions {
  serviceAccountEmail?: string;
  serviceAccountPrivateKey?: string;
  impersonateEmail?: string;
  googleSaEmail?: string;
  googleSaPrivateKey?: string;
  googleImpersonateEmail?: string;
  saEmail?: string;
  privateKey?: string;
  subject?: string;
  fetch?: GoogleFetch;
  fetchImpl?: GoogleFetch;
  crypto?: GoogleCrypto;
  clock?: GoogleClock;
  now?: GoogleClock;
  tokenUrl?: string;
  scope?: string;
  cacheKey?: string;
}

interface CachedToken {
  accessToken: string;
  refreshAt: number;
}

const tokenCache = new Map<string, CachedToken>();
// Coalesces concurrent cache-miss callers onto one in-flight mint: without this, two requests
// racing on the same cache key each sign a JWT and POST to Google's token endpoint, which is
// redundant (not incorrect) and needlessly burns Google's per-service-account token-issuance rate.
const tokenRequestsInFlight = new Map<string, Promise<string>>();

function required(options: GoogleAuthOptions, names: string[], value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${names.join(' or ')} is required`);
  return trimmed;
}

function credentials(options: GoogleAuthOptions): {
  serviceAccountEmail: string;
  serviceAccountPrivateKey: string;
  impersonateEmail: string;
} {
  const serviceAccountEmail = required(
    options,
    ['serviceAccountEmail'],
    options.serviceAccountEmail ?? options.googleSaEmail ?? options.saEmail,
  );
  const serviceAccountPrivateKey = required(
    options,
    ['serviceAccountPrivateKey'],
    options.serviceAccountPrivateKey ?? options.googleSaPrivateKey ?? options.privateKey,
  );
  const impersonateEmail = required(
    options,
    ['impersonateEmail'],
    options.impersonateEmail ?? options.googleImpersonateEmail ?? options.subject,
  );
  return { serviceAccountEmail, serviceAccountPrivateKey, impersonateEmail };
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function defaultCrypto(): GoogleCrypto {
  return crypto;
}

function defaultClock(): number {
  return Date.now();
}

function nowMilliseconds(clock: GoogleClock): number {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) throw new Error('Google auth clock must return a finite timestamp');
  return milliseconds;
}

function bytesFromBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('Invalid base64 in Google service-account private key');
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const unpadded = normalized.slice(0, normalized.length - padding);
  const output = new Uint8Array(Math.floor(unpadded.length * 6 / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of unpadded) {
    const code = character.charCodeAt(0);
    const valueForCharacter = code >= 65 && code <= 90
      ? code - 65
      : code >= 97 && code <= 122
        ? code - 71
        : code >= 48 && code <= 57
          ? code + 4
          : character === '+'
            ? 62
            : 63;
    buffer = (buffer << 6) | valueForCharacter;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return output;
}

function privateKeyBytes(pem: string): ArrayBuffer {
  const body = pem.replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bytes = bytesFromBase64(body);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? '=' : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? '=' : alphabet[third & 63];
  }
  return output.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function jsonSegment(value: unknown): string {
  return base64Url(utf8(JSON.stringify(value)));
}

function cacheKeyFor(options: GoogleAuthOptions, values: ReturnType<typeof credentials>, tokenUrl: string, scope: string): string {
  return options.cacheKey ?? `${tokenUrl}|${scope}|${values.serviceAccountEmail}|${values.impersonateEmail}|${values.serviceAccountPrivateKey}`;
}

// A structured ProviderFailure (status in hand, from the response
// itself) rather than a plain Error whose status only ever lived in the message text — a bad
// service-account credential (401) must classify as permanent, not retry forever through the
// outbox attempt cap (src/confirmation.ts).
async function responseError(response: Response, operation: string): Promise<Error> {
  const body = await response.text();
  return new ProviderFailure({ status: response.status, message: `${operation} failed (${response.status})${body ? `: ${body}` : ''}` });
}

export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}

export class GoogleServiceAccountAuth {
  readonly serviceAccountEmail: string;
  readonly serviceAccountPrivateKey: string;
  readonly impersonateEmail: string;
  readonly tokenUrl: string;
  readonly scope: string;
  private readonly request: GoogleFetch;
  private readonly webCrypto: GoogleCrypto;
  private readonly clock: GoogleClock;
  private readonly cacheKey: string;

  constructor(options: GoogleAuthOptions) {
    const values = credentials(options);
    this.serviceAccountEmail = values.serviceAccountEmail;
    this.serviceAccountPrivateKey = values.serviceAccountPrivateKey;
    this.impersonateEmail = values.impersonateEmail;
    this.tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
    this.scope = options.scope ?? GOOGLE_CALENDAR_SCOPE;
    this.request = options.fetchImpl ?? options.fetch ?? defaultFetch;
    this.webCrypto = options.crypto ?? defaultCrypto();
    this.clock = options.clock ?? options.now ?? defaultClock;
    this.cacheKey = cacheKeyFor(options, values, this.tokenUrl, this.scope);
  }

  async getAccessToken(): Promise<string> {
    const now = nowMilliseconds(this.clock);
    const cached = tokenCache.get(this.cacheKey);
    if (cached && now < cached.refreshAt) return cached.accessToken;

    const inFlight = tokenRequestsInFlight.get(this.cacheKey);
    if (inFlight) return inFlight;

    const request = this.mintAndCacheToken(now).finally(() => {
      tokenRequestsInFlight.delete(this.cacheKey);
    });
    tokenRequestsInFlight.set(this.cacheKey, request);
    return request;
  }

  private async mintAndCacheToken(now: number): Promise<string> {
    const issuedAt = Math.floor(now / 1000);
    const header = jsonSegment({ alg: 'RS256', typ: 'JWT' });
    const claims = jsonSegment({
      iss: this.serviceAccountEmail,
      sub: this.impersonateEmail,
      scope: this.scope,
      aud: this.tokenUrl,
      iat: issuedAt,
      exp: issuedAt + 3600,
    });
    const unsignedToken = `${header}.${claims}`;
    const key = await this.webCrypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes(this.serviceAccountPrivateKey),
      { name: GOOGLE_JWT_ALGORITHM, hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await this.webCrypto.subtle.sign(GOOGLE_JWT_ALGORITHM, key, utf8(unsignedToken).buffer as ArrayBuffer);
    const assertion = `${unsignedToken}.${base64Url(new Uint8Array(signature))}`;
    const response = await this.request(this.tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!response.ok) throw await responseError(response, 'Google token request');
    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new Error('Google token response did not include access_token');
    }
    const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? Math.max(0, payload.expires_in * 1000)
      : 3600 * 1000;
    tokenCache.set(this.cacheKey, {
      accessToken: payload.access_token,
      refreshAt: now + Math.max(0, expiresIn - GOOGLE_TOKEN_CACHE_SKEW_MS),
    });
    return payload.access_token;
  }
}

export function createGoogleServiceAccountAuth(options: GoogleAuthOptions): GoogleServiceAccountAuth {
  return new GoogleServiceAccountAuth(options);
}

export async function getGoogleAccessToken(options: GoogleAuthOptions): Promise<string> {
  return new GoogleServiceAccountAuth(options).getAccessToken();
}

export function createGoogleServiceAccountJwt(
  options: GoogleAuthOptions,
  now: GoogleClock = options.clock ?? options.now ?? defaultClock,
): Promise<string> {
  const values = credentials(options);
  const webCrypto = options.crypto ?? defaultCrypto();
  const issuedAt = Math.floor(nowMilliseconds(now) / 1000);
  const unsignedToken = `${jsonSegment({ alg: 'RS256', typ: 'JWT' })}.${jsonSegment({
    iss: values.serviceAccountEmail,
    sub: values.impersonateEmail,
    scope: options.scope ?? GOOGLE_CALENDAR_SCOPE,
    aud: options.tokenUrl ?? GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  })}`;
  return webCrypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes(values.serviceAccountPrivateKey),
    { name: GOOGLE_JWT_ALGORITHM, hash: 'SHA-256' },
    false,
    ['sign'],
  ).then((key) => webCrypto.subtle.sign(GOOGLE_JWT_ALGORITHM, key, utf8(unsignedToken).buffer as ArrayBuffer))
    .then((signature) => `${unsignedToken}.${base64Url(new Uint8Array(signature))}`);
}
