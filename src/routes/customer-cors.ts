import type { APIContext } from 'astro';
import virtualConfig from 'virtual:reserva/config';
import { corsPreflight, withCors } from '../cors.js';

// Read from the build's file config, never the admin-merged one: the allowlist is not an admin
// setting, and a preflight must answer without the D1 round-trip createRouteContext costs.
const origins = virtualConfig.config.routes?.cors?.origins;

export function customerPreflight({ request }: APIContext): Response {
  return corsPreflight(request, origins);
}

export function withCustomerCors(request: Request, response: Response): Response {
  return withCors(request, origins, response);
}
