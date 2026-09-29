import type { ConfirmationBooking, ConfirmationSummary, StatusResponse } from '../../core/api.js';
import type { ReservaContext } from '../../context.js';
import { escapeHtml } from '../../http.js';
import { resolveLocale } from '../../core/locale.js';
import { cssAssetHref, jsAssetHref } from '../asset-hrefs.js';
import { brandMark, customerPageTheme } from '../branding.js';
import { calendarUid, formatDateParts, formatDateTimeRange, formatPrice, googleCalendarUrl, icsDataUrl } from '../format.js';
import { contactBlock, factList, messageHtml, pageShell, themeToggle } from '../layout.js';
import { formatMessage, resolveMessages, type ReservaMessages } from '../messages.js';

// This page renders whatever GET /api/booking/status answers, so it takes that exported response
// type rather than a hand-kept copy — a contract change breaks here at compile time.
type ConfirmedBooking = ConfirmationBooking;

// `metadataRows` is on the full payload only, so it is what tells the two apart without the
// endpoint having to publish a discriminator field nobody else would read.
function isFullBooking(booking: ConfirmationBooking | ConfirmationSummary): booking is ConfirmationBooking {
  return 'metadataRows' in booking;
}

// `statusBadge` is set only when `ui.confirmation.statusPlacement` moves the badge into the ticket.
function confirmedBody(context: Pick<ReservaContext, 'config'>, messages: ReservaMessages, booking: ConfirmedBooking, locale: string, statusBadge: string, generatedAt: Date): string {
  const timezone = context.config.business.timezone;
  const start = typeof booking.start === 'string' ? booking.start : '';
  const end = typeof booking.end === 'string' ? booking.end : start;
  const meetingLabel = booking.meetingPoint?.label ?? '';
  const mapsUrl = booking.meetingPoint?.mapsUrl ?? '';
  const quantityLabel = typeof booking.quantity === 'number'
    ? formatMessage(messages[booking.quantity === 1 ? 'widget.person' : 'widget.quantityCount'], { n: booking.quantity })
    : String(booking.quantity ?? '');
  // Stays alongside the decorative date block (aria-hidden) so screen readers and copy-paste get
  // the full spelled-out datetime.
  const facts: Array<[string, string]> = [
    [messages['common.service'], escapeHtml(booking.serviceTitle)],
    [messages['common.date'], escapeHtml(start ? formatDateTimeRange(start, end, locale, timezone) : '')],
    [messages['common.quantity'], escapeHtml(quantityLabel)],
  ];
  if (typeof booking.priceMinor === 'number') {
    facts.push([messages['common.price'], escapeHtml(formatPrice(booking.priceMinor, locale, booking.currency ?? context.config.business.currency))]);
  }
  if (meetingLabel) {
    const maps = mapsUrl ? ` <a href="${escapeHtml(mapsUrl)}" rel="noopener" target="_blank">${escapeHtml(messages['common.openInMaps'])}</a>` : '';
    facts.push([messages['common.meetingPoint'], `${escapeHtml(meetingLabel)}${maps}`]);
  }
  // Boolean -> the existing yes/no copy pair; everything else its plain string form, escaped.
  for (const row of booking.metadataRows ?? []) {
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
      title: `${context.config.business.name} — ${booking.serviceTitle}`,
      start,
      end,
      location: meetingLabel,
      description: `${messages['common.reference']}: ${booking.reference ?? ''}`,
    };
    calendar = `<div class="bk-actions"><span class="bk-sub">${escapeHtml(messages['confirmation.addToCalendar'])}</span>`
      + `<a class="bk-btn bk-btn--secondary bk-btn--sm" href="${escapeHtml(googleCalendarUrl(event))}" rel="noopener" target="_blank">${escapeHtml(messages['confirmation.addGoogle'])}</a>`
      + `<a class="bk-btn bk-btn--secondary bk-btn--sm" href="${escapeHtml(icsDataUrl(event, { uid: calendarUid(booking.reference, context.config.business.url), generatedAt }))}" download="booking.ics">${escapeHtml(messages['confirmation.addIcs'])}</a></div>`;
  }
  const foot = `<div class="bk-ticket-foot">`
    + `<div class="bk-ticket-ref"><span>${escapeHtml(messages['common.reference'])}</span><span class="bk-mono">${escapeHtml(booking.reference)}</span></div>`
    + calendar
    + `</div>`;
  return `<section class="bk-ticket">`
    + `<div class="bk-ticket-top">${dateBlock}<div class="bk-ticket-body">${statusBadge ? `<div class="bk-ticket-status">${statusBadge}</div>` : ''}${factList(facts)}</div></div>`
    + foot
    + `</section>`
    + `<section class="bk-card bk-whatsnext"><h2>${escapeHtml(messages['confirmation.whatsNextTitle'])}</h2>`
    + `${messageHtml(messages['confirmation.whatsNextBody'])}</section>`;
}

// Past the detail grace window the endpoint answers with a summary, not the full booking: name the
// service and when it is, then say where the rest went.
function summaryBody(context: Pick<ReservaContext, 'config'>, messages: ReservaMessages, summary: ConfirmationSummary, locale: string): string {
  const start = typeof summary.start === 'string' ? summary.start : '';
  const end = typeof summary.end === 'string' ? summary.end : start;
  const facts: Array<[string, string]> = [
    [messages['common.service'], escapeHtml(summary.serviceTitle)],
    [messages['common.date'], escapeHtml(start ? formatDateTimeRange(start, end, locale, context.config.business.timezone) : '')],
    [messages['common.reference'], escapeHtml(summary.reference)],
  ];
  return `<section class="bk-card bk-summary">${factList(facts)}</section>`
    + `<section class="bk-card bk-message">${messageHtml(messages['confirmation.detailsEmailed'], 'bk-lead')}</section>`;
}

function simpleBody(body: string, options: { pending?: boolean; actionHtml?: string; afterHtml?: string; sectionAttrs?: string } = {}): string {
  const spinner = options.pending ? '<div class="bk-spinner" aria-hidden="true"></div>' : '';
  return `<section class="bk-card bk-message"${options.sectionAttrs ?? ''}>${spinner}${messageHtml(body, 'bk-lead')}${options.actionHtml ?? ''}</section>`
    + (options.afterHtml ?? '');
}

// The meta refresh is the polling mechanism that survives script-src 'none', which means the only
// place to keep a count is the URL; the served enhancer takes over from it when script runs and
// keeps the same count. Twenty polls at three seconds is about a minute — past that the webhook is
// late enough that waiting on a browser tab is the wrong thing to ask of the customer.
export const MAX_CONFIRMATION_ATTEMPTS = 20;

function attemptOf(requestUrl: string): number {
  const raw = Number(new URL(requestUrl).searchParams.get('attempt'));
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_CONFIRMATION_ATTEMPTS) : 0;
}

function urlWithAttempt(requestUrl: string, attempt: number): string {
  const url = new URL(requestUrl);
  url.searchParams.set('attempt', String(attempt));
  return url.toString();
}

export function confirmationPage(
  context: Pick<ReservaContext, 'config' | 'routeConfig' | 'viewerTheme'> & Partial<Pick<ReservaContext, 'clock'>>,
  payload: StatusResponse,
  requestUrl: string,
  requestedLocale: string | null,
): string {
  const status = payload.status;
  const booking = payload.booking;
  // The hint is negotiated, never trusted verbatim: `?locale=pt` must land on the deployment's
  // `pt-PT` copy, and an unsupported tag must not end up in <html lang>.
  const locale = booking?.locale ?? resolveLocale(context.config.locales, requestedLocale);
  const messages = resolveMessages(context.config, locale);
  const attempt = attemptOf(requestUrl);
  const pendingTimedOut = status === 'pending' && attempt >= MAX_CONFIRMATION_ATTEMPTS;
  // The meta refresh handles the pending→confirmed webhook race with no script at all, so the page
  // still works under script-src 'none'; the enhancer cancels it when it can poll instead.
  const polling = status === 'pending' && !pendingTimedOut;
  const refresh = polling
    ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(urlWithAttempt(requestUrl, attempt + 1))}">`
    : '';
  // What the enhancer needs to poll the status API in place of the refresh. The session id is
  // already in this page's own URL, so carrying it here exposes nothing new.
  const query = new URL(requestUrl).searchParams;
  const sessionId = query.get('sessionId') ?? query.get('session_id') ?? '';
  const pollAttrs = polling && sessionId
    ? ` data-reserva-status-poll data-endpoint="${escapeHtml(context.routeConfig.paths.status)}" data-session-id="${escapeHtml(sessionId)}"`
      + ` data-attempt="${attempt}" data-max="${MAX_CONFIRMATION_ATTEMPTS}"`
      + ` data-l-checking="${escapeHtml(messages['confirmation.pollChecking'])}" data-l-updated="${escapeHtml(messages['confirmation.pollUpdated'])}"`
    : '';
  const liveRegion = pollAttrs ? '<p class="bk-sub" role="status" aria-live="polite" data-reserva-poll-live></p>' : '';
  // Both dead-end states tell the visitor to start over, so give them the button that does it.
  const startOver = `<div class="bk-actions"><a class="bk-btn" href="${escapeHtml(context.config.business.url)}">${escapeHtml(messages['confirmation.startOver'])}</a></div>`;
  // Restarting the count rather than reloading the current URL, so the link polls afresh instead
  // of rendering the timeout page again immediately.
  const checkAgain = `<div class="bk-actions"><a class="bk-btn bk-btn--secondary" href="${escapeHtml(urlWithAttempt(requestUrl, 0))}">${escapeHtml(messages['confirmation.checkAgain'])}</a></div>`;
  const contact = contactBlock(context.config, messages);
  const branding = context.config.ui?.branding;
  const confirmedBadge = `<span class="bk-badge bk-badge--ok">${escapeHtml(messages['status.confirmed'])}</span>`;
  // The ticket only exists for a full booking, so every other state keeps the masthead badge.
  const badgeInTicket = status === 'confirmed' && booking !== null && booking.reference.length > 0 && isFullBooking(booking)
    && context.config.ui?.confirmation?.statusPlacement === 'ticket';
  const body = status === 'confirmed'
    ? booking !== null && booking.reference.length > 0
      ? isFullBooking(booking)
        ? confirmedBody(context, messages, booking, locale, badgeInTicket ? confirmedBadge : '', context.clock ? context.clock() : new Date())
        : summaryBody(context, messages, booking, locale)
      : simpleBody(messages['confirmation.detailsEmailed'])
    : status === 'pending'
      ? pendingTimedOut
        ? simpleBody(messages['confirmation.pendingTimeoutBody'], { actionHtml: checkAgain, afterHtml: contact })
        : simpleBody(messages['confirmation.pendingBody'], { pending: true, sectionAttrs: pollAttrs, actionHtml: liveRegion })
      : status === 'failed'
        ? simpleBody(messages['confirmation.failedBody'], { afterHtml: contact })
        : status === 'expired'
          ? simpleBody(messages['confirmation.expiredBody'], { actionHtml: startOver, afterHtml: contact })
          : status === 'cancelled'
            ? simpleBody(messages['confirmation.cancelledBody'], { actionHtml: startOver })
            : simpleBody(messages['confirmation.notFoundBody'], { actionHtml: startOver });
  const title = status === 'confirmed'
    ? messages['confirmation.title']
    : status === 'pending'
      ? pendingTimedOut ? messages['confirmation.pendingTimeoutTitle'] : messages['confirmation.pendingTitle']
      : status === 'failed'
        ? messages['confirmation.failedTitle']
        : status === 'expired'
          ? messages['confirmation.expiredTitle']
          : status === 'cancelled'
            ? messages['confirmation.cancelledTitle']
            : messages['confirmation.notFoundTitle'];
  const badge = status === 'confirmed'
    ? badgeInTicket ? '' : confirmedBadge
    : status === 'pending'
      ? `<span class="bk-badge bk-badge--warn">${escapeHtml(messages['status.hold'])}</span>`
      : '';
  // Past the detail grace window the visit is a return trip, not the moment of payment, so the
  // lead no longer promises an email that went out hours ago.
  const lead = status !== 'confirmed'
    ? ''
    : booking !== null && booking.reference.length > 0 && !isFullBooking(booking)
      ? messages['confirmation.summaryLead']
      : messages['confirmation.lead'];
  const header = brandMark(context.config.business.name, context.config.business.url, branding)
    + badge
    + `<h1>${escapeHtml(title)}</h1>`
    + (lead ? `<p class="bk-lead">${escapeHtml(lead)}</p>` : '');
  const { theme, pinned } = customerPageTheme(branding, context.viewerTheme);
  return pageShell({
    lang: locale,
    page: 'confirmation',
    status,
    title: `${title} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss, branding),
    favicon: context.config.ui?.faviconUrl,
    headHtml: context.config.ui?.headHtml,
    headExtra: refresh,
    // Every state, not just pending: the theme toggle in the header is script-revealed too.
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    skipLabel: messages['common.skipContent'],
    header,
    theme,
    ...(pinned ? {} : { themeToggle: themeToggle(messages, theme) }),
    body,
  });
}
