import type { APIContext } from 'astro';
import {
  handleCustomerCancel,
  handleCustomerReschedule,
  handleManage,
  handleOperatorCancel,
  handleOperatorNoShow,
  handleOperatorReschedule,
} from '../../handlers/index.js';
import { renderManageErrorPage, renderManagePage, type ManagePageOptions } from '../../ui/pages/manage-page.js';
import { nowIso } from '../../context.js';
import { resolveLocale } from '../../core/locale.js';
import { localDateKey, localDateTimeToUtcIso, parseUtcInstant } from '../../core/time.js';
import { errorResponse, HttpError, requestFormData } from '../../http.js';
import { cssAssetHref, jsAssetHref } from '../../ui/asset-hrefs.js';
import { resolveMessages } from '../../ui/messages.js';
import { createRouteContext } from '../route-context.js';

export const prerender = false;

const htmlHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // `strict-origin` trims Referer to the origin alone (no path, no token) while still sending a
  // real Origin header on same-origin POSTs below — `no-referrer` would null Origin per the Fetch
  // spec and trip Astro's checkOrigin default; `strict-origin` avoids that without leaking the token.
  'referrer-policy': 'strict-origin',
};

export async function GET({ request, locals }: APIContext): Promise<Response> {
  const context = await createRouteContext({ request, locals });
  const response = await handleManage(request, context);
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const payload = await response.json() as Record<string, unknown>;
  const booking = payload.booking && typeof payload.booking === 'object' ? payload.booking as Record<string, unknown> : {};
  // The booking's own stored locale wins (it was negotiated at
  // checkout); the error page, which has no booking, negotiates the `?locale=` hint instead of
  // trusting it verbatim.
  const locale = typeof booking.locale === 'string'
    ? booking.locale
    : resolveLocale(context.config.locales, new URL(request.url).searchParams.get('locale'));
  const options: ManagePageOptions = {
    messages: resolveMessages(context.config, locale),
    locale,
    timezone: context.config.business.timezone,
    currency: context.config.business.currency,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss),
    theme: context.viewerTheme,
    businessName: context.config.business.name,
    businessUrl: context.config.business.url,
  };
  const params = new URL(request.url).searchParams;
  if (params.get('done') === 'reschedule') options.notice = 'rescheduled';
  const errorCode = params.get('error');
  if (errorCode) options.errorCode = errorCode;
  // A missing/invalid token comes back as an error payload — render a recoverable page (with a
  // token entry form) instead of surfacing raw JSON, but preserve the status code.
  if (!response.ok) {
    return new Response(renderManageErrorPage(context.routeConfig.paths.managePage, options), {
      status: response.status,
      headers: htmlHeaders,
    });
  }
  payload.token = new URL(request.url).searchParams.get('token') ?? '';
  if (typeof booking.serviceSlug === 'string' && typeof booking.quantity === 'number') {
    const now = nowIso(context);
    const timezone = context.config.business.timezone;
    const from = localDateKey(now, timezone);
    const horizonEnd = localDateKey(
      new Date(parseUtcInstant(now).getTime() + context.config.booking.maxHorizonDays * 86_400_000).toISOString(),
      timezone,
    );
    // Availability bounds requests by maxHorizonDays, so the reschedule picker can ask for the
    // whole horizon.
    const to = horizonEnd;
    options.scriptHref = jsAssetHref(context.routeConfig.paths.assetsJs);
    options.availability = {
      endpoint: context.routeConfig.paths.availability,
      serviceSlug: booking.serviceSlug,
      quantity: booking.quantity,
      from,
      to,
    };
  }
  return new Response(renderManagePage(payload, context.routeConfig.paths.managePage, options), {
    status: 200,
    headers: htmlHeaders,
  });
}

export async function POST({ request, locals }: APIContext): Promise<Response> {
  try {
    const form = await requestFormData(request);
    const action = String(form.get('action') ?? '');
    const token = String(form.get('token') ?? '');
    const operatorToken = String(form.get('operatorToken') ?? '');
    const context = await createRouteContext({ request, locals });
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
    const location = new URL(context.routeConfig.paths.managePage, request.url);
    location.searchParams.set('token', operatorToken || token);
    // A failed action must land the browser back on the manage page with a readable alert, not on
    // a raw JSON error body. The code travels as a query param and maps to copy in the renderer;
    // an invalid token simply falls through to the styled recovery page on the next GET.
    if (!response.ok) {
      let code = '';
      try {
        const errorPayload = await response.json() as { error?: { code?: string } };
        code = errorPayload.error?.code ?? '';
      } catch {
        // Non-JSON failure — the generic message covers it.
      }
      location.searchParams.set('error', code || 'unknown');
      return new Response(null, { status: 303, headers: { location: location.toString() } });
    }
    if (action === 'reschedule') location.searchParams.set('done', 'reschedule');
    return new Response(null, { status: 303, headers: { location: location.toString() } });
  } catch (error) {
    return errorResponse(error);
  }
}
