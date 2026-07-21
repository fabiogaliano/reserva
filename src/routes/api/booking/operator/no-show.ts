import type { APIContext } from 'astro';
import { handleOperatorNoShow } from '../../../../handlers';
import { createRouteContext } from '../../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleOperatorNoShow(request, await createRouteContext({ request, locals }));
}
