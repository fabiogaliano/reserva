import type { APIContext } from 'astro';
import { handleFeed } from '../../../handlers';
import { createRouteContext } from '../../route-context';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleFeed(request, await createRouteContext({ request, locals }));
}
