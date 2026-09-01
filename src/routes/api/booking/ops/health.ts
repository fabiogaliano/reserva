import type { APIContext } from 'astro';
import { handleOpsHealth } from '../../../../handlers/index.js';
import { createRouteContext } from '../../../route-context.js';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleOpsHealth(request, await createRouteContext({ request, locals }));
}
