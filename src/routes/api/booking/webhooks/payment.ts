import type { APIContext } from 'astro';
import { handlePaymentWebhook } from '../../../../handlers';
import { createRouteContext } from '../../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handlePaymentWebhook(request, await createRouteContext({ request, locals }));
}
