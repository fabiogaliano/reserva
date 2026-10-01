import type { APIContext } from 'astro';
import { handleQuote } from '../../../handlers/index.js';
import { customerPreflight, withCustomerCors } from '../../customer-cors.js';
import { createRouteContext } from '../../route-context.js';

export const prerender = false;

export const OPTIONS = customerPreflight;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return withCustomerCors(request, await handleQuote(request, await createRouteContext({ request, locals })));
}
