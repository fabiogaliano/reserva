import type { APIContext } from 'astro';
import {
  handleCustomerCancel,
  handleCustomerReschedule,
  handleManage,
  handleOperatorCancel,
  handleOperatorNoShow,
  handleOperatorReschedule,
} from '../../handlers/index.js';
import { renderCancelledPage, renderManageErrorPage, renderManagePage, type ManagePageOptions } from '../../ui/pages/manage-page.js';
import type { ReservaContext } from '../../context.js';
import { nowIso } from '../../context.js';
import { resolveLocale } from '../../core/locale.js';
import { minorUnitFactor } from '../../core/currency.js';
import { addDaysToDateKey, localDateKey, localDateTimeToUtcIso } from '../../core/time.js';
import type { Booking } from '../../core/booking.js';
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

function pageOptions(context: ReservaContext, locale: string): ManagePageOptions {
  return {
    messages: resolveMessages(context.config, locale),
    locale,
    timezone: context.config.business.timezone,
    currency: context.config.business.currency,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss, context.config.ui?.branding),
    // Every manage page, the invalid-link and cancelled ones included, reveals its theme toggle
    // (and the booking pages their enhancer) through this one script.
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    favicon: context.config.ui?.faviconUrl,
    headHtml: context.config.ui?.headHtml,
    theme: context.viewerTheme,
    branding: context.config.ui?.branding,
    businessName: context.config.business.name,
    businessUrl: context.config.business.url,
    contactConfig: context.config,
    rescheduleEnabled: context.config.booking.reschedule.enabled,
    now: context.clock(),
  };
}

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
  const options = pageOptions(context, locale);
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
    const from = localDateKey(nowIso(context), context.config.business.timezone);
    // Availability bounds requests by maxHorizonDays counted in calendar days from `from`, so the
    // picker counts the same way — adding 24-hour blocks to an instant drifts a day across a DST
    // change and the whole request is refused as over the horizon.
    const to = addDaysToDateKey(from, context.config.booking.maxHorizonDays);
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

// The operator form takes major units ("15.00") because that is what an operator reads off a
// receipt; the API takes minor ones. Rounding rather than truncating so a currency's own smallest
// unit is reachable from a decimal input. Sent only for refund=partial — the handler rejects an
// amount alongside any other choice, and the no-script form always submits this field.
//
// The factor comes from the BOOKING's own stored currency, never today's configured one: a
// deployment that changed business.currency between currencies with different decimal counts (a
// 3-decimal KWD booking cancelled after a move to 2-decimal EUR) would otherwise scale what the
// operator typed by the wrong factor and silently refund a tenth of the intended amount. The
// lookup is read-only and advisory — an unresolvable token falls through to the handler, which
// owns the canonical 403.
async function refundAmountBody(
  context: ReservaContext,
  form: FormData,
  refund: string,
  operatorToken: string,
): Promise<{ refundAmountMinor?: number }> {
  if (refund !== 'partial') return {};
  const raw = String(form.get('refundAmount') ?? '').trim();
  const major = Number(raw);
  if (raw === '' || !Number.isFinite(major)) {
    throw new HttpError(400, 'validation_failed', 'refundAmount is required for a partial refund');
  }
  const booking = await context.repo.getBookingByOperatorTokenForRefundRecovery(operatorToken, nowIso(context));
  return { refundAmountMinor: Math.round(major * minorUnitFactor(booking?.currency ?? context.config.business.currency)) };
}

export async function POST({ request, locals }: APIContext): Promise<Response> {
  let form: FormData;
  let context: ReservaContext;
  try {
    form = await requestFormData(request);
    context = await createRouteContext({ request, locals });
  } catch (error) {
    return errorResponse(error);
  }
  const action = String(form.get('action') ?? '');
  const token = String(form.get('token') ?? '');
  const operatorToken = String(form.get('operatorToken') ?? '');
  const location = new URL(context.routeConfig.paths.managePage, request.url);
  location.searchParams.set('token', operatorToken || token);
  // A failed action must land the browser back on the manage page with a readable alert, not on
  // a raw JSON error body. The code travels as a query param and maps to copy in the renderer;
  // an invalid token simply falls through to the styled recovery page on the next GET.
  const bounce = (code: string): Response => {
    location.searchParams.set('error', code);
    return new Response(null, { status: 303, headers: { location: location.toString() } });
  };
  let response: Response;
  // Read before the cancel, which revokes the token it is found by in the same write.
  let cancelling: Booking | null = null;
  try {
    if (action === 'cancel') {
      const refund = String(form.get('refund') ?? 'none');
      if (operatorToken) {
        response = await handleOperatorCancel(new Request(request, { body: JSON.stringify({ operatorToken, refund, ...await refundAmountBody(context, form, refund, operatorToken) }), headers: { 'content-type': 'application/json' } }), context);
      } else {
        cancelling = token ? await context.repo.getBookingByCancelToken(token, nowIso(context)) : null;
        response = await handleCustomerCancel(new Request(request, { body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' } }), context);
      }
    } else if (action === 'reschedule') {
      const start = String(form.get('start') ?? '');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) throw new HttpError(400, 'validation_failed', 'start is required');
      let startsAt: string;
      try {
        startsAt = localDateTimeToUtcIso(start, context.config.business.timezone);
      } catch {
        throw new HttpError(400, 'validation_failed', 'start is not a valid local time');
      }
      const body = JSON.stringify(operatorToken ? { operatorToken, start: startsAt } : { token, start: startsAt });
      response = operatorToken
        ? await handleOperatorReschedule(new Request(request, { body, headers: { 'content-type': 'application/json' } }), context)
        : await handleCustomerReschedule(new Request(request, { body, headers: { 'content-type': 'application/json' } }), context);
    } else if (action === 'no-show' && operatorToken) {
      response = await handleOperatorNoShow(new Request(request, { body: JSON.stringify({ operatorToken }), headers: { 'content-type': 'application/json' } }), context);
    } else {
      throw new HttpError(400, 'validation_failed', 'Unknown booking action');
    }
  } catch (error) {
    // The form's own validation (a partial refund with no amount, a local time the business
    // timezone skips) is as much a failed action as a handler's refusal, so it bounces the same way.
    return bounce(error instanceof HttpError ? error.code : 'internal_error');
  }
  if (!response.ok) {
    let code = '';
    try {
      const errorPayload = await response.json() as { error?: { code?: string } };
      code = errorPayload.error?.code ?? '';
    } catch {
      // Non-JSON failure — the generic message covers it.
    }
    return bounce(code || 'unknown');
  }
  // Rendered from this response rather than redirected: the link the customer came in on stopped
  // working with the cancel, and a tokenless "done" URL could be forged to tell anyone their booking
  // is gone. A reload re-POSTs a revoked token and lands on the invalid-link page, which is what
  // that URL now is. An operator's link survives the cancel, so they go back to the manage page.
  if (action === 'cancel' && !operatorToken) {
    const options = pageOptions(context, cancelling?.locale ?? context.config.locales.default);
    return new Response(renderCancelledPage({ reference: cancelling?.reference ?? '', priceMinor: cancelling?.priceMinor ?? 0 }, options), {
      status: 200,
      headers: htmlHeaders,
    });
  }
  if (action === 'reschedule') location.searchParams.set('done', 'reschedule');
  return new Response(null, { status: 303, headers: { location: location.toString() } });
}
