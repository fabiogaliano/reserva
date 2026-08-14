export const prerender = false;
import { alertOutbox } from '../../runtime';
import type { APIRoute } from 'astro';

// Dev-only test seam (plan 020, step 8): mirrors dev/outbox.json.ts's convention exactly, for the
// independent operator alert sink instead of the confirmation-email provider. Never copied into a
// real bookkit site — see outbox.json.ts's header comment.
export const GET: APIRoute = () => {
  return Response.json(alertOutbox);
};
