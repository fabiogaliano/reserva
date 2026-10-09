import type { ReservaContext } from '../context.js';
import { parseUtcInstant } from '../core/time.js';
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

// Expired holds are swept by the reconciliation cron, which is the guarantee; the read paths sweep
// only to keep their own answer fresh, so once a minute per isolate spares D1 an UPDATE per request
// without a customer ever seeing a materially stale picture. Driven by the context clock, not
// Date.now(), so a test can move it.
const HOLD_SWEEP_INTERVAL_MS = 60_000;
let lastHoldSweepMs = 0;

export async function sweepExpiredHoldsThrottled(context: ReservaContext, now: string): Promise<void> {
  const nowMs = parseUtcInstant(now).getTime();
  if (lastHoldSweepMs !== 0 && nowMs - lastHoldSweepMs < HOLD_SWEEP_INTERVAL_MS) return;
  lastHoldSweepMs = nowMs;
  await context.repo.sweepExpiredHolds(now);
}
