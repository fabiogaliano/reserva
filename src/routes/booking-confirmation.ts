import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import { handleStatus } from '../handlers';
import { escapeHtml } from '../http';

export const prerender = false;

function confirmationPage(payload: Record<string, unknown>, requestUrl: string): string {
  const status = typeof payload.status === 'string' ? payload.status : 'not_found';
  const booking = payload.booking && typeof payload.booking === 'object' ? payload.booking as Record<string, unknown> : {};
  const refresh = status === 'pending' ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(requestUrl)}">` : '';
  const message = status === 'confirmed'
    ? `<h1>Booking confirmed</h1><p>Reference: <strong>${escapeHtml(booking.reference)}</strong></p><p>Start: ${escapeHtml(booking.start)}</p>`
    : status === 'pending'
      ? '<h1>Confirming payment</h1><p>This page will update automatically.</p>'
      : status === 'expired'
        ? '<h1>Checkout expired</h1><p>No confirmed payment was found.</p>'
        : '<h1>Booking not found</h1>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>Booking status</title></head><body><main>${message}</main></body></html>`;
}

export async function GET({ request, locals }: APIContext): Promise<Response> {
  const statusUrl = new URL('/api/booking/status', request.url);
  const sessionId = new URL(request.url).searchParams.get('session_id');
  if (sessionId) statusUrl.searchParams.set('session_id', sessionId);
  const statusRequest = new Request(statusUrl, { headers: request.headers });
  const response = await handleStatus(statusRequest, await runtime.createContext({ request, locals }));
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const payload = await response.json() as Record<string, unknown>;
  return new Response(confirmationPage(payload, request.url), {
    status: response.ok ? 200 : response.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
