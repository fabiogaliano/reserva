import type { APIContext } from 'astro';
import { handleAvailability } from '../../../handlers';
import { createRouteContext } from '../../route-context';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  return handleAvailability(request, await createRouteContext({ request, locals }));
}
