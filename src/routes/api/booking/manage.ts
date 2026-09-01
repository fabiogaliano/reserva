import type { APIContext } from 'astro';
import { handleManage } from '../../../handlers/index.js';
import { createRouteContext } from '../../route-context.js';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleManage(request, await createRouteContext({ request, locals }));
}
