import type { APIContext } from 'astro';
import { handleStatus } from '../../../handlers';
import { createRouteContext } from '../../route-context';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleStatus(request, await createRouteContext({ request, locals }));
}
