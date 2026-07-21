import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import { handleStripeWebhook } from '../../../../handlers';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleStripeWebhook(request, await runtime.createContext({ request, locals }));
}
