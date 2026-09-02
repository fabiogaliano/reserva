export const prerender = false;
import type { APIContext, APIRoute } from 'astro';
import { runReconciliation } from '../../../../../src/runtime';
import { createRouteContext } from '../../../../../src/routes/route-context';

// Dev-only test seam: astro dev has no Cron Trigger, so this calls the same runReconciliation a
// real scheduled() handler would, through the same context-construction seam every route uses.
// Never copy into a real reserva site -- see outbox.json.ts's comment for why.
export const POST: APIRoute = async ({ request, locals }: APIContext) => {
  const context = await createRouteContext({ request, locals });
  const summary = await runReconciliation(context);
  return Response.json(summary);
};
