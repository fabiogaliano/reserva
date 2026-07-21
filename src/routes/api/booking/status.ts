import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import { handleStatus } from '../../../handlers';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleStatus(request, await runtime.createContext({ request, locals }));
}
