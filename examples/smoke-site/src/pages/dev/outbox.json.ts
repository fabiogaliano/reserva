export const prerender = false;
import { emailOutbox } from '../../runtime';
import type { APIRoute } from 'astro';

// Auth-less on purpose: this is a dev-only fixture the e2e suite uses to read emails a real
// deployment would only ever send to an inbox (tests can't read the terminal `console.info` the
// runtime also logs). It exists solely under examples/smoke-site, never ships as part of the
// library, and must never be copied into a real bookkit site — a production deployment must not
// expose its outbound-email log over an unauthenticated GET.
export const GET: APIRoute = () => {
  return Response.json(emailOutbox);
};
