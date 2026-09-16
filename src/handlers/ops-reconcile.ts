import type { ReconciliationSummary } from '../core/api.js';
import { accessAllowed } from '../admin-access.js';
import type { ReservaContext } from '../context.js';
import { HttpError, json, requestJson } from '../http.js';
import { runReconciliationWithLease, type ReconciliationOptions } from '../reconciliation.js';
import { operatorBearerAuthorized } from './booking-actions.js';
import { run, withSensitiveHeaders } from './shared.js';

// The manual counterpart to the cron `scheduled` event: same sweep, same lease, so an operator can
// drain debt now without waiting for the next tick — and without racing the tick that is running.

// Only the page-size limits are settable. `requireAlertSink` is a deployment property, not a
// per-request one: a caller must not be able to turn the sink requirement off.
function readLimits(body: Record<string, unknown>): ReconciliationOptions {
  const options: ReconciliationOptions = { requireAlertSink: true };
  if (typeof body.sourceLimit === 'number') options.sourceLimit = body.sourceLimit;
  if (typeof body.alertLimit === 'number') options.alertLimit = body.alertLimit;
  return options;
}

async function authorized(request: Request, context: ReservaContext): Promise<boolean> {
  if (await operatorBearerAuthorized(context, request)) return true;
  return (await accessAllowed(request, context)) !== null;
}

export function handleOpsReconcile(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    if (!(await authorized(request, context))) throw new HttpError(403, 'forbidden', 'Operator authorization required');
    // Reported rather than thrown as a 500: a deployment without an alert sink is a configuration
    // gap the operator can fix, and running the sweep blind would silently drop every alert.
    if (!context.providers.alerts) throw new HttpError(503, 'internal_error', 'operational alert sink not configured');

    const body = request.headers.get('content-type')?.includes('application/json')
      ? await requestJson(request)
      : {};
    const result = await runReconciliationWithLease(context, readLimits(body));
    if (result.kind === 'busy') {
      throw new HttpError(409, 'reconciliation_in_progress', 'A reconciliation sweep is already running; try again shortly');
    }
    return json<ReconciliationSummary>(result.summary);
  }).then(withSensitiveHeaders);
}
