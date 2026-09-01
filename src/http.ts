import { isApiErrorCode, type ApiErrorCode, type ApiErrorEnvelope } from './core/api.js';

// Plan 027 (design decision 2): `code` is the closed API_ERROR_CODES union, not a free string — a
// code that isn't in the catalog no longer compiles, which is what lets a consumer switch
// exhaustively on failure causes.
export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function json<T>(value: T, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers(headers);
  merged.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { status, headers: merged });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json<ApiErrorEnvelope>({ error: { code: error.code, message: error.message } }, error.status);
  }
  // A foreign error that already describes itself as an HTTP failure (a provider error, a caller's
  // own thrown shape) is honored only when its code is in the catalog — otherwise the envelope
  // would carry a code no consumer can enumerate, which is exactly what the closed set forbids.
  if (error instanceof Error && 'status' in error && 'code' in error) {
    const status = Number((error as Error & { status: unknown }).status);
    const code = (error as Error & { code: unknown }).code;
    if (Number.isInteger(status) && status >= 400 && status <= 599 && isApiErrorCode(code)) {
      return json<ApiErrorEnvelope>({ error: { code, message: error.message } }, status);
    }
  }
  return json<ApiErrorEnvelope>({ error: { code: 'internal_error', message: 'An unexpected error occurred' } }, 500);
}

export function badRequest(code: ApiErrorCode, message: string): never {
  throw new HttpError(400, code, message);
}

// Hardening sweep (audit finding #10): nothing in src/ bounded a request body before this — public
// JSON endpoints, both form-POST entrypoints, and the buffered payment webhook body all read
// request.json()/formData()/text() unbounded. One limit per traffic class, chosen for the largest
// legitimate payload each entrypoint actually receives.
export const JSON_BODY_LIMIT_BYTES = 32 * 1024;
export const FORM_BODY_LIMIT_BYTES = 256 * 1024;
export const PAYMENT_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

// Rejects a request whose body exceeds limitBytes: immediately, from a valid (numeric)
// Content-Length header that already overshoots, before a single byte is read off the wire; or
// mid-stream, tracking real bytes read, when the header is absent or understates the true body (a
// client can lie about Content-Length, so the enforced count is always the one actually read).
// Uint8Array<ArrayBuffer> (not the bare, ArrayBufferLike-generic Uint8Array) so the return value is
// directly usable as a Request/Response BodyInit at every call site below without a cast.
async function readBoundedBytes(request: Request, limitBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const declaredLength = Number(declared);
    if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
      throw new HttpError(413, 'payload_too_large', `Request body exceeds the ${limitBytes}-byte limit`);
    }
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'payload_too_large', `Request body exceeds the ${limitBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function requestJson(request: Request, limitBytes = JSON_BODY_LIMIT_BYTES): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBytes(request, limitBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'validation_failed', 'Request body must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'validation_failed', 'Request body must be an object');
  }
  return value as Record<string, unknown>;
}

// Used by both form-POST entrypoints (handleAdminPost, src/routes/booking/manage.ts). FormData has
// no bytes-based constructor, so this rebuilds a Request from the already-bounded bytes (identical
// headers, so multipart/urlencoded parsing still sees the right content-type/boundary) and lets the
// platform's own parser run on it.
export async function requestFormData(request: Request, limitBytes = FORM_BODY_LIMIT_BYTES): Promise<FormData> {
  const bytes = await readBoundedBytes(request, limitBytes);
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes }).formData();
}

// Used by the Stripe webhook path: constructEventAsync needs the exact raw text the signature was
// computed over, so this returns the decoded bytes verbatim -- never re-serialized.
export async function requestText(request: Request, limitBytes: number): Promise<string> {
  const bytes = await readBoundedBytes(request, limitBytes);
  return new TextDecoder().decode(bytes);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'validation_failed', `${field} is required`);
  return value;
}

export function requireInteger(value: unknown, field: string, min = 1): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new HttpError(400, 'validation_failed', `${field} must be an integer of at least ${min}`);
  }
  return value;
}

export function tokenBytes(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// BK-SEC-002: one-way digest used to hash manage/operator tokens at rest (src/repo.ts) so a D1
// dump no longer contains a usable credential. Unsalted SHA-256 is appropriate here specifically
// because the input is always a 256-bit crypto.getRandomValues token (tokenBytes above), never a
// low-entropy secret like a password — there is no dictionary/rainbow-table attack to defend
// against, only "don't hand back the original bytes from the digest", which SHA-256 already
// gives. Same base64url alphabet as tokenBytes so hashes and tokens are visually distinguishable
// only by never having been presented as a token, not by character set.
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) result |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return result === 0;
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization');
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

export function html(value: string, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers(headers);
  merged.set('content-type', 'text/html; charset=utf-8');
  return new Response(value, { status, headers: merged });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export function parseDate(value: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new HttpError(400, 'validation_failed', `${field} must be YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new HttpError(400, 'validation_failed', `${field} must be a valid calendar date`);
  }
  return value;
}
