import type { APIContext } from 'astro';
import { handleCustomerReschedule } from '../../../handlers';
import { createRouteContext } from '../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleCustomerReschedule(request, await createRouteContext({ request, locals }));
}
