export const prerender = false;
import { armNextCalendarFailure } from '../../runtime';
import type { APIRoute } from 'astro';

// Dev-only test seam (plan 020, step 8): arms a one-shot permanent calendar-provider failure for
// the next createEvent call. See runtime.ts's armNextCalendarFailure doc comment for why the
// failure is permanent rather than merely retryable. Never copied into a real reserva site — see
// dev/outbox.json.ts's header comment for the same convention.
export const POST: APIRoute = () => {
  armNextCalendarFailure();
  return Response.json({ armed: true });
};
