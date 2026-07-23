export interface ErrorBody {
  error: { code: string; message: string };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
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
    return json<ErrorBody>({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof Error && 'status' in error && 'code' in error) {
    const status = Number((error as Error & { status: unknown }).status);
    const code = (error as Error & { code: unknown }).code;
    if (Number.isInteger(status) && status >= 400 && status <= 599 && typeof code === 'string') {
      return json<ErrorBody>({ error: { code, message: error.message } }, status);
    }
  }
  return json<ErrorBody>({ error: { code: 'internal_error', message: 'An unexpected error occurred' } }, 500);
}

export function badRequest(code: string, message: string): never {
  throw new HttpError(400, code, message);
}

export async function requestJson(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, 'validation_failed', 'Request body must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'validation_failed', 'Request body must be an object');
  }
  return value as Record<string, unknown>;
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
