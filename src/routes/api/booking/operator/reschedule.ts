import type { APIContext } from 'astro';
import { handleOperatorReschedule } from '../../../../handlers';
import { createRouteContext } from '../../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleOperatorReschedule(request, await createRouteContext({ request, locals }));
}
