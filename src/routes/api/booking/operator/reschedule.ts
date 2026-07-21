import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import { handleOperatorReschedule } from '../../../../handlers';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleOperatorReschedule(request, await runtime.createContext({ request, locals }));
}
