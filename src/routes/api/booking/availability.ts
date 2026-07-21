import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import { handleAvailability } from '../../../handlers';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleAvailability(request, await runtime.createContext({ request, locals }));
}
