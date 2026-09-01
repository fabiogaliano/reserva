export const prerender = false;
import type { APIContext, APIRoute } from 'astro';
import { nowIso } from '../../../../../src/context';
import { createRouteContext } from '../../../../../src/routes/route-context';

// Dev-only test seam: seeds an 'oversell' incident directly, in exactly the
// shape src/reconciliation.ts's reportUnreportedOversellMarkers persists (bookingId,
// sourceType='oversell', action='oversell', severity='action_required'). Reproducing a genuine
// oversell (an expired hold confirmed after payment past the capacity guard) end-to-end in the
// e2e suite would need precise hold-expiry/capacity-race timing unrelated to what this fixture is
// proving — the admin UI's "no Retry button for oversell" rendering and the server-side rejection
// of a forged retry, both driven from real incident-ledger state. Never copied into a real
// reserva site — see outbox.json.ts's header comment for the same convention.
export const POST: APIRoute = async ({ request, locals }: APIContext) => {
  const context = await createRouteContext({ request, locals });
  // Callers hold the customer-visible reference, not the internal id — resolve it server-side
  // where the repo lives.
  const body = await request.json() as { reference?: unknown };
  const reference = typeof body.reference === 'string' ? body.reference : undefined;
  if (!reference) return new Response('reference is required', { status: 400 });
  const booking = await context.repo.getBookingByReference(reference);
  if (!booking) return new Response(`no booking with reference ${reference}`, { status: 404 });
  const bookingId = booking.id;
  const now = nowIso(context);
  await context.repo.upsertOpenIncident({
    id: crypto.randomUUID(),
    bookingId,
    sourceType: 'oversell',
    sourceKey: bookingId,
    action: 'oversell',
    severity: 'action_required',
    attemptCount: 1,
    sourceUpdatedAt: now,
    now,
    escalate: false,
  });
  return Response.json({ seeded: true });
};
