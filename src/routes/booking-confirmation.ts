import type { APIContext } from 'astro';
import type { StatusResponse } from '../core/api.js';
import { handleStatus } from '../handlers/index.js';
import { confirmationPage } from '../ui/pages/confirmation-page.js';
import { createRouteContext } from './route-context.js';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  const context = await createRouteContext({ request, locals });
  const statusUrl = new URL(context.routeConfig.paths.status, request.url);
  const requestedLocale = new URL(request.url).searchParams.get('locale');
  const sessionId = new URL(request.url).searchParams.get('session_id');
  if (sessionId) statusUrl.searchParams.set('session_id', sessionId);
  const statusRequest = new Request(statusUrl, { headers: request.headers });
  const response = await handleStatus(statusRequest, context);
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const payload = await response.json() as StatusResponse;
  return new Response(confirmationPage(context, payload, request.url, requestedLocale), {
    status: response.ok ? 200 : response.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
