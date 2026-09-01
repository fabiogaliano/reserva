import type { APIContext } from 'astro';
import { handleQuote } from '../../../handlers';
import { createRouteContext } from '../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleQuote(request, await createRouteContext({ request, locals }));
}
