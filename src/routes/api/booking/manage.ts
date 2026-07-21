import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import { handleManage } from '../../../handlers';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleManage(request, await runtime.createContext({ request, locals }));
}
