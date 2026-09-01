import type { APIContext } from 'astro';
import { handleStatus } from '../handlers';
import { escapeHtml } from '../http';
import { cssAssetHref } from '../ui/asset-hrefs';
import { formatDateParts, formatDateTime, formatPrice, googleCalendarUrl, icsDataUrl } from '../ui/format';
import { factList, pageShell, themeToggle } from '../ui/layout';
import { formatMessage, resolveMessages, type BookkitMessages } from '../ui/messages';
import type { BookkitContext } from '../context';
import { createRouteContext } from './route-context';

export const prerender = false;

interface ConfirmedBooking {
  reference?: string;
  serviceSlug?: string;
  start?: string;
  end?: string;
  quantity?: number;
  pickupType?: string;
  locale?: string;
  priceMinor?: number;
  meetingPoint?: { label?: string; mapsUrl?: string };
  // Plan 024 (design decision 3): see the identical field on ManageBookingPayload
  // (src/components/manage-page.ts) — same shape, same renderer convention.
  metadata?: Array<{ key: string; label: string; value: string | number | boolean }>;
}

function brandLine(context: Pick<BookkitContext, 'config'>): string {
  return `<p class="bk-brand"><a href="${escapeHtml(context.config.business.url)}">${escapeHtml(context.config.business.name)}</a></p>`;
}

function confirmedBody(context: Pick<BookkitContext, 'config'>, messages: BookkitMessages, booking: ConfirmedBooking, locale: string): string {
  const timezone = context.config.business.timezone;
  const start = typeof booking.start === 'string' ? booking.start : '';
  const end = typeof booking.end === 'string' ? booking.end : start;
  const meetingLabel = booking.meetingPoint?.label ?? '';
  const mapsUrl = booking.meetingPoint?.mapsUrl ?? '';
  const quantityLabel = typeof booking.quantity === 'number'
    ? formatMessage(messages[booking.quantity === 1 ? 'widget.person' : 'widget.quantityCount'], { n: booking.quantity })
    : String(booking.quantity ?? '');
  // The textual date fact stays alongside the decorative date block (which is aria-hidden), so
  // screen readers and copy-paste get the full spelled-out datetime.
  const facts: Array<[string, string]> = [
    [messages['common.date'], escapeHtml(start ? formatDateTime(start, locale, timezone) : '')],
    [messages['common.quantity'], escapeHtml(quantityLabel)],
  ];
  if (typeof booking.priceMinor === 'number') {
    facts.push([messages['common.price'], escapeHtml(formatPrice(booking.priceMinor, locale, context.config.business.currency))]);
  }
  if (meetingLabel) {
    const maps = mapsUrl ? ` <a href="${escapeHtml(mapsUrl)}" rel="noopener" target="_blank">${escapeHtml(messages['common.openInMaps'])}</a>` : '';
    facts.push([messages['common.meetingPoint'], `${escapeHtml(meetingLabel)}${maps}`]);
  }
  // Plan 024 (design decision 3): see the identical block in manage-page.ts renderManagePage —
  // boolean -> the existing yes/no copy pair, everything else its plain string form, escaped.
  for (const row of booking.metadata ?? []) {
    const displayValue = typeof row.value === 'boolean'
      ? (row.value ? messages['admin.on'] : messages['admin.off'])
      : String(row.value);
    facts.push([row.label, escapeHtml(displayValue)]);
  }
  const parts = start ? formatDateParts(start, locale, timezone) : null;
  const dateBlock = parts
    ? `<div class="bk-ticket-date" aria-hidden="true"><span class="bk-ticket-month">${escapeHtml(parts.month)}</span><span class="bk-ticket-day">${escapeHtml(parts.day)}</span><span class="bk-ticket-time">${escapeHtml(parts.time)}</span></div>`
    : '';
  let calendar = '';
  if (start) {
    const event = {
      title: `${context.config.business.name} — ${booking.serviceSlug ?? ''}`,
      start,
      end,
      location: meetingLabel,
      description: `${messages['common.reference']}: ${booking.reference ?? ''}`,
    };
    calendar = `<div class="bk-actions"><span class="bk-sub">${escapeHtml(messages['confirmation.addToCalendar'])}</span>`
      + `<a class="bk-btn bk-btn--secondary bk-btn--sm" href="${escapeHtml(googleCalendarUrl(event))}" rel="noopener" target="_blank">${escapeHtml(messages['confirmation.addGoogle'])}</a>`
      + `<a class="bk-btn bk-btn--secondary bk-btn--sm" href="${escapeHtml(icsDataUrl(event))}" download="booking.ics">${escapeHtml(messages['confirmation.addIcs'])}</a></div>`;
  }
  const foot = `<div class="bk-ticket-foot">`
    + `<div class="bk-ticket-ref"><span>${escapeHtml(messages['common.reference'])}</span><span class="bk-mono">${escapeHtml(booking.reference)}</span></div>`
    + calendar
    + `</div>`;
  return `<section class="bk-ticket">`
    + `<div class="bk-ticket-top">${dateBlock}<div class="bk-ticket-body">${factList(facts)}</div></div>`
    + foot
    + `</section>`
    + `<section class="bk-card"><h2>${escapeHtml(messages['confirmation.whatsNextTitle'])}</h2>`
    + `<p>${escapeHtml(messages['confirmation.whatsNextBody'])}</p></section>`;
}

function simpleBody(body: string, options: { pending?: boolean; actionHtml?: string } = {}): string {
  const spinner = options.pending ? '<div class="bk-spinner" aria-hidden="true"></div>' : '';
  return `<section class="bk-card">${spinner}<p class="bk-lead">${escapeHtml(body)}</p>${options.actionHtml ?? ''}</section>`;
}

export function confirmationPage(
  context: Pick<BookkitContext, 'config' | 'routeConfig' | 'viewerTheme'>,
  payload: Record<string, unknown>,
  requestUrl: string,
  requestedLocale: string | null,
): string {
  const status = typeof payload.status === 'string' ? payload.status : 'not_found';
  const booking: ConfirmedBooking = payload.booking && typeof payload.booking === 'object' ? payload.booking : {};
  const hasConfirmedBooking = typeof booking.reference === 'string' && booking.reference.length > 0;
  const locale = booking.locale ?? requestedLocale ?? context.config.locales.default;
  const messages = resolveMessages(context.config, locale);
  // Meta refresh (not script polling) keeps the pending→confirmed webhook race handled without
  // any inline script, so the page works under script-src 'none'.
  const refresh = status === 'pending' ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(requestUrl)}">` : '';
  // Both dead-end states tell the visitor to start over, so give them the button that does it.
  const startOver = `<div class="bk-actions"><a class="bk-btn" href="${escapeHtml(context.config.business.url)}">${escapeHtml(messages['confirmation.startOver'])}</a></div>`;
  const body = status === 'confirmed'
    ? hasConfirmedBooking
      ? confirmedBody(context, messages, booking, locale)
      : simpleBody(messages['confirmation.detailsEmailed'])
    : status === 'pending'
      ? simpleBody(messages['confirmation.pendingBody'], { pending: true })
      : status === 'expired'
        ? simpleBody(messages['confirmation.expiredBody'], { actionHtml: startOver })
        : status === 'cancelled'
          ? simpleBody(messages['confirmation.cancelledBody'], { actionHtml: startOver })
          : simpleBody(messages['confirmation.notFoundBody'], { actionHtml: startOver });
  const title = status === 'confirmed'
    ? messages['confirmation.title']
    : status === 'pending'
      ? messages['confirmation.pendingTitle']
      : status === 'expired'
        ? messages['confirmation.expiredTitle']
        : status === 'cancelled'
          ? messages['confirmation.cancelledTitle']
          : messages['confirmation.notFoundTitle'];
  const badge = status === 'confirmed'
    ? `<span class="bk-badge bk-badge--ok">${escapeHtml(messages['status.confirmed'])}</span>`
    : status === 'pending'
      ? `<span class="bk-badge bk-badge--warn">${escapeHtml(messages['status.hold'])}</span>`
      : '';
  const header = brandLine(context)
    + badge
    + `<h1>${escapeHtml(title)}</h1>`
    + (status === 'confirmed' ? `<p class="bk-lead">${escapeHtml(messages['confirmation.lead'])}</p>` : '');
  return pageShell({
    lang: locale,
    title: `${title} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss),
    headExtra: refresh,
    header,
    theme: context.viewerTheme,
    themeToggle: themeToggle(messages, context.viewerTheme),
    body,
  });
}

export async function GET({ request, locals }: APIContext): Promise<Response> {
  const context = await createRouteContext({ request, locals });
  const statusUrl = new URL(context.routeConfig.paths.status, request.url);
  const requestedLocale = new URL(request.url).searchParams.get('locale');
  const sessionId = new URL(request.url).searchParams.get('session_id');
  if (sessionId) statusUrl.searchParams.set('session_id', sessionId);
  const statusRequest = new Request(statusUrl, { headers: request.headers });
  const response = await handleStatus(statusRequest, context);
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  const payload = await response.json() as Record<string, unknown>;
  return new Response(confirmationPage(context, payload, request.url, requestedLocale), {
    status: response.ok ? 200 : response.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
