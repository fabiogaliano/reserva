import type { APIContext } from 'astro';
import runtime from 'virtual:bookkit/runtime';
import {
  handleCustomerCancel,
  handleCustomerReschedule,
  handleManage,
  handleOperatorCancel,
  handleOperatorNoShow,
  handleOperatorReschedule,
} from '../../handlers';
import { renderManagePage } from '../../components/manage-page';
import { localDateTimeToUtcIso } from '../../core/time';
import { errorResponse, HttpError } from '../../http';

export const prerender = false;

export async function GET({ request, locals }: APIContext): Promise<Response> {
  const response = await handleManage(request, await runtime.createContext({ request, locals }));
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response;
  const payload = await response.json() as Record<string, unknown>;
  payload.token = new URL(request.url).searchParams.get('token') ?? '';
  return new Response(renderManagePage(payload), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export async function POST({ request, locals }: APIContext): Promise<Response> {
  try {
    const form = await request.formData();
    const action = String(form.get('action') ?? '');
    const token = String(form.get('token') ?? '');
    const operatorToken = String(form.get('operatorToken') ?? '');
    const context = await runtime.createContext({ request, locals });
    let response: Response;
    if (action === 'cancel') {
      response = operatorToken
        ? await handleOperatorCancel(new Request(request, { body: JSON.stringify({ operatorToken, refund: String(form.get('refund') ?? 'none') }), headers: { 'content-type': 'application/json' } }), context)
        : await handleCustomerCancel(new Request(request, { body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' } }), context);
    } else if (action === 'reschedule') {
      const newStart = String(form.get('newStart') ?? '');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(newStart)) throw new HttpError(400, 'validation_failed', 'newStart is required');
      let startsAt: string;
      try {
        startsAt = localDateTimeToUtcIso(newStart, context.config.business.timezone);
      } catch {
        throw new HttpError(400, 'validation_failed', 'newStart is not a valid local time');
      }
      const body = JSON.stringify(operatorToken ? { operatorToken, newStart: startsAt } : { token, newStart: startsAt });
      response = operatorToken
        ? await handleOperatorReschedule(new Request(request, { body, headers: { 'content-type': 'application/json' } }), context)
        : await handleCustomerReschedule(new Request(request, { body, headers: { 'content-type': 'application/json' } }), context);
    } else if (action === 'no-show' && operatorToken) {
      response = await handleOperatorNoShow(new Request(request, { body: JSON.stringify({ operatorToken }), headers: { 'content-type': 'application/json' } }), context);
    } else {
      throw new HttpError(400, 'validation_failed', 'Unknown booking action');
    }
    if (!response.ok) return response;
    const location = new URL('/booking/manage', request.url);
    location.searchParams.set('token', operatorToken || token);
    return new Response(null, { status: 303, headers: { location: location.toString() } });
  } catch (error) {
    return errorResponse(error);
  }
}
