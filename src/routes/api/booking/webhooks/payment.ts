import type { APIContext } from 'astro';
import { handleStripeWebhook } from '../../../../handlers';
import { createRouteContext } from '../../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleStripeWebhook(request, await createRouteContext({ request, locals }));
}
