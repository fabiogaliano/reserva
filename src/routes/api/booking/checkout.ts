import type { APIContext } from 'astro';
import { handleCheckout } from '../../../handlers';
import { createRouteContext } from '../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleCheckout(request, await createRouteContext({ request, locals }));
}
