export const prerender = false;
import { emailOutbox } from '../../runtime';
import type { APIRoute } from 'astro';

// Auth-less on purpose: a dev-only fixture so the e2e suite can read emails a real deployment
// would only ever send to an inbox. Never copy into a real reserva site -- a production
// deployment must not expose its outbound-email log over an unauthenticated GET.
export const GET: APIRoute = () => {
  return Response.json(emailOutbox);
};
