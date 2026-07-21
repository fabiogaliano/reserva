import type { APIContext } from 'astro';
import { handleOperatorCancel } from '../../../../handlers';
import { createRouteContext } from '../../../route-context';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleOperatorCancel(request, await createRouteContext({ request, locals }));
}
