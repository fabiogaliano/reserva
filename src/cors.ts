import { MANAGE_TOKEN_HEADER } from './core/api.js';

// Only what the browser client sends: JSON bodies and the reschedule picker's manage token. Both
// make a request non-simple, which is why a cross-origin funnel needs a preflight answer at all.
const ALLOWED_HEADERS = `content-type, ${MANAGE_TOKEN_HEADER}`;
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

function allowedOrigin(request: Request, origins: readonly string[]): string | null {
  const origin = request.headers.get('origin');
  return origin !== null && origins.includes(origin) ? origin : null;
}

// A disallowed origin gets a plain 204 rather than an error: the missing Allow-Origin header is
// what makes the browser refuse, and a non-browser caller was never subject to CORS anyway.
export function corsPreflight(request: Request, origins: readonly string[] | undefined): Response {
  const headers = new Headers();
  if (origins) {
    headers.set('vary', 'Origin');
    const origin = allowedOrigin(request, origins);
    if (origin) {
      headers.set('access-control-allow-origin', origin);
      headers.set('access-control-allow-methods', 'GET, POST');
      headers.set('access-control-allow-headers', ALLOWED_HEADERS);
      headers.set('access-control-max-age', String(PREFLIGHT_MAX_AGE_SECONDS));
    }
  }
  return new Response(null, { status: 204, headers });
}

// `Vary: Origin` goes on every answer once CORS is on, allowed or not, so a cache between the
// browser and the Worker can't hand one origin's answer to another.
export function withCors(request: Request, origins: readonly string[] | undefined, response: Response): Response {
  if (!origins) return response;
  // Rebuilt rather than mutated: a response from a cache or a fetch carries immutable headers.
  const answered = new Response(response.body, response);
  answered.headers.append('vary', 'Origin');
  const origin = allowedOrigin(request, origins);
  if (origin) answered.headers.set('access-control-allow-origin', origin);
  return answered;
}
