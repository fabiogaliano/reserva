import type { APIContext } from 'astro';
import { handleOperatorCancel } from '../../../../handlers/index.js';
import { createRouteContext } from '../../../route-context.js';

export const prerender = false;

export async function POST({ request, locals }: APIContext): Promise<Response> {
  return handleOperatorCancel(request, await createRouteContext({ request, locals }));
}
