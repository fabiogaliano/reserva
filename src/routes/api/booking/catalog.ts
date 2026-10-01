import type { APIContext } from 'astro';
import { handleCatalog } from '../../../handlers/index.js';
import { customerPreflight, withCustomerCors } from '../../customer-cors.js';
import { createRouteContext } from '../../route-context.js';

export const prerender = false;

export const OPTIONS = customerPreflight;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return withCustomerCors(request, await handleCatalog(request, await createRouteContext({ request, locals })));
}
