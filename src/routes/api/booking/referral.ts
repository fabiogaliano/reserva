import type { APIContext } from 'astro';
import { handleResolveReferral } from '../../../handlers/index.js';
import { customerPreflight, withCustomerCors } from '../../customer-cors.js';
import { createRouteContext } from '../../route-context.js';

/** Referral resolution is request-specific and must never be prerendered. */
export const prerender = false;

/** The resolver shares the deployment's exact-origin customer CORS policy. */
export const OPTIONS = customerPreflight;

/** Resolve one code through the runtime registry, without publishing a list. */
export async function POST({ request, locals }: APIContext): Promise<Response> {
  return withCustomerCors(request, await handleResolveReferral(request, await createRouteContext({ request, locals })));
}
