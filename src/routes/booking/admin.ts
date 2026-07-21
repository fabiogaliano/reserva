import type { APIContext } from 'astro';
import { handleAdminGet, handleAdminPost } from '../../handlers';
import { createRouteContext } from '../route-context';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleAdminGet(request, await createRouteContext({ request, locals }));
}

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleAdminPost(request, await createRouteContext({ request, locals }));
}
