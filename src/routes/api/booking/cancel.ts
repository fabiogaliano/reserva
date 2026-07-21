import type { APIContext } from 'astro';
import { handleCustomerCancel } from '../../../handlers';
import { createRouteContext } from '../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleCustomerCancel(request, await createRouteContext({ request, locals }));
}
