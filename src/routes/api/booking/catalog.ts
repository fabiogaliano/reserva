import type { APIContext } from 'astro';
import { handleCatalog } from '../../../handlers/index.js';
import { createRouteContext } from '../../route-context.js';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleCatalog(request, await createRouteContext({ request, locals }));
}
