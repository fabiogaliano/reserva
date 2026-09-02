export const prerender = false;
import { armNextCalendarFailure } from '../../runtime';
import type { APIRoute } from 'astro';

// Dev-only test seam: arms a one-shot permanent calendar-provider failure for the next
// createEvent call. Never copy into a real reserva site.
export const POST: APIRoute = () => {
  armNextCalendarFailure();
  return Response.json({ armed: true });
};
