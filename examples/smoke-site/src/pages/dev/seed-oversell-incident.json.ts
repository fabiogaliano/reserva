export const prerender = false;
import type { APIContext, APIRoute } from 'astro';
import { nowIso } from '../../../../../src/context';
import { createRouteContext } from '../../../../../src/routes/route-context';

// Dev-only test seam: seeds an 'oversell' incident directly (the shape
// reportUnreportedOversellMarkers persists) so the e2e suite can exercise the admin UI's
// oversell rendering without reproducing a real hold-expiry race. Never copy into a real site.
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
