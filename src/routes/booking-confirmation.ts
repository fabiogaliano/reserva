import type { APIContext } from 'astro';
import type { StatusResponse } from '../core/api.js';
import { handleStatus } from '../handlers/index.js';
import { confirmationPage } from '../ui/pages/confirmation-page.js';
import { createRouteContext } from './route-context.js';
import { contentSecurityPolicyHeaders } from '../csp.js';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  const context = await createRouteContext({ request, locals });
  const statusUrl = new URL(context.routeConfig.paths.status, request.url);
  const requestedLocale = new URL(request.url).searchParams.get('locale');
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (sessionId) statusUrl.searchParams.set('sessionId', sessionId);
  const statusRequest = new Request(statusUrl, { headers: request.headers });
  const response = await handleStatus(statusRequest, context);
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  // A server error (a provider or D1 outage mid-poll) says nothing about the booking, so it keeps
  // the page waiting within the same attempt budget rather than claiming the booking doesn't
  // exist. A 4xx (no session id at all) is about the link itself and still reads as not found.
  const payload: StatusResponse = response.ok
    ? await response.json() as StatusResponse
    : { status: response.status >= 500 ? 'pending' : 'not_found', booking: null };
  return new Response(confirmationPage(context, payload, request.url, requestedLocale), {
    status: response.ok ? 200 : response.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...contentSecurityPolicyHeaders(context.config),
    },
  });
}
