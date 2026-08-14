export const prerender = false;
import type { APIContext, APIRoute } from 'astro';
import { runReconciliation } from '../../../../../src/runtime';
import { createRouteContext } from '../../../../../src/routes/route-context';

// Dev-only test seam (plan 020, step 8): the e2e suite runs against `astro dev`
// (playwright.config.ts's webServer), which has no Cron Trigger and cannot dispatch a real
// scheduled() event the way scripts/smoke-scheduled-test.ts's standalone cron Worker does (see
// that script's header comment for why local workerd's /__scheduled route is the only supported
// dispatch boundary, and why it lives on a separate Worker rather than this Astro site). This
// route calls the exact same exported `runReconciliation` a real scheduled() handler calls,
// through the exact same context-construction seam every other route uses
// (createRouteContext) — the only thing missing compared to a real cron tick is the
// Cron-Trigger-to-invocation wiring itself, which scripts/smoke-scheduled-test.ts already proves
// against real workerd/D1. Never copied into a real bookkit site — see outbox.json.ts's header
// comment for the same convention; a production deployment must never expose an unauthenticated
// route that runs the reconciliation sweep on demand.
export const POST: APIRoute = async ({ request, locals }: APIContext) => {
  const context = await createRouteContext({ request, locals });
  const summary = await runReconciliation(context);
  return Response.json(summary);
};
