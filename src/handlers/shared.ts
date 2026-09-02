import { errorResponse } from '../http.js';

export function run(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch(errorResponse);
}

export function withSensitiveHeaders(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

// The successful admin POST redirects already set Cache-Control: no-store, but a thrown HttpError
// went through plain errorResponse, which sets none — a shared cache could then serve a stale admin
// error page. Scoped to admin POST only; the public booking API is unaffected.
export function runAdminPost(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    const response = errorResponse(error);
    response.headers.set('cache-control', 'no-store');
    return response;
  });
}
