import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import { handleAdminGet, handleAdminPost } from '../../handlers';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleAdminGet(request, await runtime.createContext({ request, locals }));
}

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleAdminPost(request, await runtime.createContext({ request, locals }));
}
