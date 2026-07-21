import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import { handleCustomerReschedule } from '../../../handlers';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleCustomerReschedule(request, await runtime.createContext({ request, locals }));
}
