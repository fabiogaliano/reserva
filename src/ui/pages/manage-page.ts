import type { ManageBooking } from '../../core/api.js';
import { escapeHtml } from '../../http.js';
import { toMajorUnits } from '../../core/currency.js';
import { formatDateTime, formatDateTimeRange, formatPrice, googleCalendarUrl, icsDataUrl } from '../format.js';
import { contactBlock, factList, pageShell, statusBadge, themeToggle, type ContactConfig } from '../layout.js';
import { defaultLocale, formatMessage, resolveMessages, type ReservaMessages } from '../messages.js';
import type { ThemePreference } from '../theme.js';

export interface ManagePageOptions {
  messages?: ReservaMessages;
  locale?: string;
  timezone?: string;
  currency?: string;
  cssHref?: string;
  // `config.ui.faviconUrl` / `config.ui.headHtml`, threaded in by the route: this renderer takes a
  // payload rather than a context, so its head extras arrive as options like everything else here.
  favicon?: string | undefined;
  headHtml?: string | undefined;
  // The viewer's forced theme (from the request cookie), set by the manage route so the page can
  // render <html data-theme> up front. Absent/undefined = follow the OS.
  theme?: ThemePreference | undefined;
  businessName?: string;
  // Makes the brand line a link back to the consumer's site.
  businessUrl?: string;
  // Enables the shared contact block on the dead ends this page can render (past the change
  // deadline, invalid link). Absent — a hand-built payload in a test — simply renders no block.
  contactConfig?: ContactConfig;
  // Post-redirect feedback: which action just succeeded, or the error code it failed with.
  notice?: 'rescheduled';
  errorCode?: string;
  // When present, the page loads this module (the assetsJs route) and annotates the reschedule
  // form so the served enhancer can swap the native datetime-local for a calendar + slot picker.
  scriptHref?: string;
  availability?: {
    endpoint: string;
    serviceSlug: string;
    quantity: number;
    from: string;
    to: string;
  };
}

// The manage payload's shape has one declaration — the exported `ManageBooking` wire type — and
// this renderer reads a Partial of it: the page also renders hand-built or empty payloads.
type ManageBookingPayload = Partial<ManageBooking>;

// Defaults keep the original two-argument call shape working; the manage route passes resolved options.
export function renderManagePage(payload: Record<string, unknown>, managePagePath: string, options: ManagePageOptions = {}): string {
  const locale = options.locale ?? defaultLocale;
  const messages = options.messages ?? resolveMessages(undefined, locale);
  const booking: ManageBookingPayload = payload.booking && typeof payload.booking === 'object' ? payload.booking : {};
  const role = payload.role === 'operator' ? 'operator' : 'customer';
  const canCancel = payload.canCancel === true;
  const canReschedule = payload.canReschedule === true;
  const canNoShow = payload.canNoShow === true;
  const token = typeof payload.token === 'string' ? payload.token : '';
  // `cancelDeadline` is the name; `deadline` is its alias for one minor, and a hand-built test
  // payload may carry either.
  const deadline = typeof payload.cancelDeadline === 'string'
    ? payload.cancelDeadline
    : typeof payload.deadline === 'string' ? payload.deadline : '';
  const status = typeof booking.status === 'string' ? booking.status : '';
  const action = escapeHtml(managePagePath);
  const tokenField = role === 'operator' ? 'operatorToken' : 'token';
  const hiddenToken = `<input type="hidden" name="${tokenField}" value="${escapeHtml(token)}">`;

  const start = typeof booking.start === 'string' ? booking.start : '';
  const end = typeof booking.end === 'string' ? booking.end : start;
  const displayStart = start && options.timezone ? formatDateTimeRange(start, end, locale, options.timezone) : start;
  const displayDeadline = deadline && options.timezone ? formatDateTime(deadline, locale, options.timezone) : deadline;

  const quantityLabel = typeof booking.quantity === 'number'
    ? formatMessage(messages[booking.quantity === 1 ? 'widget.person' : 'widget.quantityCount'], { n: booking.quantity })
    : String(booking.quantity ?? '');
  const facts: Array<[string, string]> = [
    [messages['common.service'], escapeHtml(booking.serviceTitle)],
    [messages['common.date'], escapeHtml(displayStart)],
    [messages['common.quantity'], escapeHtml(quantityLabel)],
  ];
  if (typeof booking.priceMinor === 'number' && options.currency) {
    facts.push([messages['common.price'], escapeHtml(formatPrice(booking.priceMinor, locale, options.currency))]);
  }
  // Both facts key off the chosen option's flags independently — a both-flags option shows its
  // address AND its meeting point. Pickup ids are opaque, so a payload carrying no flag shows no
  // address rather than guessing from the id.
  const requiresAddress = booking.pickupRequiresAddress === true;
  if (requiresAddress && booking.pickupAddress) {
    facts.push([messages['common.pickupAddress'], escapeHtml(booking.pickupAddress)]);
  }
  // Contact details are operator-only: the customer token page shouldn't echo PII back.
  if (role === 'operator') {
    if (booking.customerName) facts.push([messages['common.customer'], escapeHtml(booking.customerName)]);
    if (booking.customerEmail) {
      facts.push([messages['common.email'], `<a href="mailto:${escapeHtml(booking.customerEmail)}">${escapeHtml(booking.customerEmail)}</a>`]);
    }
    if (booking.customerPhone) {
      facts.push([messages['common.phone'], `<a href="tel:${escapeHtml(booking.customerPhone)}">${escapeHtml(booking.customerPhone)}</a>`]);
    }
  }
  if (booking.pickupUsesMeetingPoint !== false && booking.meetingPoint?.label) {
    const maps = booking.meetingPoint.mapsUrl
      ? ` <a href="${escapeHtml(booking.meetingPoint.mapsUrl)}" rel="noopener" target="_blank">${escapeHtml(messages['common.openInMaps'])}</a>`
      : '';
    facts.push([messages['common.meetingPoint'], `${escapeHtml(booking.meetingPoint.label)}${maps}`]);
  }
  // Boolean -> the app's existing yes/no copy pair; everything else its plain string form. Every
  // value is attacker-controlled free text, escaped like every other fact here.
  for (const row of booking.metadataRows ?? []) {
    const displayValue = typeof row.value === 'boolean'
      ? (row.value ? messages['admin.on'] : messages['admin.off'])
      : String(row.value);
    facts.push([row.label, escapeHtml(displayValue)]);
  }

  const operatorBadge = role === 'operator' ? ` <span class="bk-badge bk-badge--accent">${escapeHtml(messages['manage.operatorBadge'])}</span>` : '';
  const brandName = options.businessName ? escapeHtml(options.businessName) : '';
  const brand = brandName
    ? `<p class="bk-brand">${options.businessUrl ? `<a href="${escapeHtml(options.businessUrl)}">${brandName}</a>` : brandName}</p>`
    : '';
  const header = brand
    + `<h1>${escapeHtml(messages['manage.title'])} <strong>${escapeHtml(booking.reference)}</strong></h1>`
    + `<p class="bk-lead">${status ? statusBadge(status, messages) : ''}${operatorBadge}</p>`;

  // An action either just succeeded or bounced back with an error code — both stated in words.
  const successNotice = options.notice === 'rescheduled'
    ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['manage.rescheduled'])}</p>`
    : '';
  // Every code a manage action can bounce back with is named in words. The three transient ones
  // (hold contention, calendar outage, unexpected failure) share the "try again in a minute" copy
  // because the customer's next step is the same for all three.
  const errorKeyByCode: Record<string, keyof ReservaMessages> = {
    past_cutoff: 'manage.pastCutoff',
    slot_unavailable: 'manage.errorSlotTaken',
    invalid_transition: 'manage.errorNotChangeable',
    // The booking IS cancelled — only the automatic refund failed, so this reads as an outcome
    // rather than as a failed action.
    refund_failed: 'manage.cancelledRefundPending',
    refund_conflict: 'manage.errorConflict',
    // A rejected field value (a partial-refund amount, a malformed reschedule time): the fix is in
    // the form, not in waiting, so it must not read as a transient failure.
    validation_failed: 'manage.errorInvalidInput',
    forbidden: 'manage.errorInvalidLink',
    too_many_holds: 'manage.actionFailed',
    calendar_unavailable: 'manage.actionFailed',
    internal_error: 'manage.actionFailed',
  };
  const errorNotice = options.errorCode
    ? `<p class="bk-alert bk-alert--danger" role="alert">${escapeHtml(messages[errorKeyByCode[options.errorCode] ?? 'manage.actionFailed'])}</p>`
    : '';

  const cancelledNotice = status === 'cancelled' ? `<p class="bk-alert bk-alert--danger" role="status">${escapeHtml(messages['manage.cancelled'])}</p>` : '';
  const pastCutoff = status === 'confirmed' && role === 'customer' && !canCancel && !canReschedule;
  // "Contact us if you need help" is only useful next to the actual contact details.
  const cutoffNotice = pastCutoff
    ? `<p class="bk-alert bk-alert--warn">${escapeHtml(messages['manage.pastCutoff'])}</p>`
    : '';
  const cutoffContact = pastCutoff && options.contactConfig ? contactBlock(options.contactConfig, messages) : '';
  const policyNote = canCancel && displayDeadline && role === 'customer'
    ? `<p class="bk-hint">${escapeHtml(formatMessage(messages['manage.cancelPolicy'], { deadline: displayDeadline }))}</p>`
    : '';

  const availability = options.availability;
  const rescheduleData = availability
    ? ` data-endpoint="${escapeHtml(availability.endpoint)}" data-service="${escapeHtml(availability.serviceSlug)}" data-quantity="${escapeHtml(availability.quantity)}" data-from="${escapeHtml(availability.from)}" data-to="${escapeHtml(availability.to)}" data-locale="${escapeHtml(locale)}"`
    : '';
  const rescheduleIsland = availability
    ? `<script type="application/json" data-reserva-i18n>${JSON.stringify({
      loading: messages['widget.loadingSlots'],
      noSlots: messages['widget.noSlots'],
      limited: messages['widget.limited'],
      pickDate: messages['widget.date'],
      pickTime: messages['widget.time'],
      time: messages['widget.time'],
    }).replace(/</g, '\\u003c')}</script>`
    : '';
  // The native datetime-local stays as the no-JS fallback; the enhancer hides it and swaps in the
  // calendar + slot chips when availability loads.
  const rescheduleForm = canReschedule
    ? `<section class="bk-card"><h2>${escapeHtml(messages['manage.rescheduleTitle'])}</h2>`
      + `<p class="bk-hint">${escapeHtml(messages['manage.rescheduleHint'])}</p>`
      + `<form method="post" action="${action}" data-reserva-reschedule${rescheduleData}>${rescheduleIsland}<input type="hidden" name="action" value="reschedule">${hiddenToken}`
      + `<label class="bk-field" data-reserva-native-start><span>${escapeHtml(messages['manage.newStart'])}</span><input class="bk-input" name="start" type="datetime-local" required></label>`
      + `<button type="submit" class="bk-btn">${escapeHtml(messages['manage.rescheduleSubmit'])}</button></form></section>`
    : '';

  // Major units, not the minor ones the API takes: an operator types "15.00", and the manage route
  // converts. The page carries no script, so the amount field cannot be revealed by the select —
  // it is always visible and simply ignored unless "partial" is chosen, which the hint states.
  const refundCurrency = options.currency;
  const partialRefundControl = typeof booking.priceMinor === 'number' && refundCurrency && booking.priceMinor > 1
    ? `<label class="bk-field"><span>${escapeHtml(messages['manage.refundAmount'])}</span>`
      + `<input class="bk-input" name="refundAmount" type="number" inputmode="decimal"`
      + ` min="${toMajorUnits(1, refundCurrency)}" max="${toMajorUnits(booking.priceMinor - 1, refundCurrency)}" step="${toMajorUnits(1, refundCurrency)}"></label>`
      + `<p class="bk-hint">${escapeHtml(formatMessage(messages['manage.refundAmountHint'], {
        max: formatPrice(booking.priceMinor - 1, locale, refundCurrency),
      }))}</p>`
    : '';
  const refundControl = role === 'operator'
    ? `<label class="bk-field"><span>${escapeHtml(messages['manage.refund'])}</span><select class="bk-select" name="refund">`
      + `<option value="none">${escapeHtml(messages['manage.refundNone'])}</option>`
      + `<option value="full">${escapeHtml(messages['manage.refundFull'])}</option>`
      + (partialRefundControl ? `<option value="partial">${escapeHtml(messages['manage.refundPartial'])}</option>` : '')
      + `</select></label>${partialRefundControl}`
    : '<input type="hidden" name="refund" value="none">';
  // A disclosure makes the destructive action two-step without any script.
  const cancelForm = canCancel
    ? `<details class="bk-disclosure bk-card--danger"><summary>${escapeHtml(messages['manage.cancelTitle'])}</summary><div>`
      + `<p>${escapeHtml(messages['manage.cancelWarning'])}</p>${policyNote}`
      + `<form method="post" action="${action}"><input type="hidden" name="action" value="cancel">${hiddenToken}${refundControl}`
      + `<button type="submit" class="bk-btn bk-btn--danger">${escapeHtml(messages['manage.cancelConfirm'])}</button></form></div></details>`
    : '';

  // No-show is as irreversible as cancel, so it gets the same two-step disclosure treatment
  // instead of a bare one-click button.
  const noShowForm = canNoShow
    ? `<details class="bk-disclosure"><summary>${escapeHtml(messages['manage.noShowSubmit'])}</summary><div>`
      + `<p>${escapeHtml(messages['manage.noShowWarning'])}</p>`
      + `<form method="post" action="${action}"><input type="hidden" name="action" value="no-show"><input type="hidden" name="operatorToken" value="${escapeHtml(token)}"><button type="submit" class="bk-btn bk-btn--secondary">${escapeHtml(messages['manage.noShowSubmit'])}</button></form></div></details>`
    : '';

  // The booking summary sits as a sticky side column beside the actions on wide screens, stacking
  // on mobile. With no actions available, the summary takes the full width instead.
  const hasActions = Boolean(rescheduleForm || cancelForm || noShowForm);
  // The same two calendar buttons the confirmation page offers: a customer who lost the original
  // mail lands here, and this is the only other place the booking is shown in full.
  const calendar = status === 'confirmed' && start
    ? (() => {
      const event = {
        title: options.businessName ? `${options.businessName} — ${booking.serviceTitle ?? ''}` : String(booking.serviceTitle ?? ''),
        start,
        end,
        // Same gate as the meeting-point fact row above: a pickup that does not use the meeting
        // point must not put one in the customer's calendar entry.
        location: booking.pickupUsesMeetingPoint !== false ? booking.meetingPoint?.label ?? '' : '',
        description: `${messages['common.reference']}: ${booking.reference ?? ''}`,
      };
      return `<div class="bk-actions"><span class="bk-sub">${escapeHtml(messages['confirmation.addToCalendar'])}</span>`
        + `<a class="bk-btn bk-btn--secondary bk-btn--sm" href="${escapeHtml(googleCalendarUrl(event))}" rel="noopener" target="_blank">${escapeHtml(messages['confirmation.addGoogle'])}</a>`
        + `<a class="bk-btn bk-btn--secondary bk-btn--sm" href="${escapeHtml(icsDataUrl(event))}" download="booking.ics">${escapeHtml(messages['confirmation.addIcs'])}</a></div>`;
    })()
    : '';
  const summaryCard = `<section class="bk-card${hasActions ? ' bk-col-side' : ''}" aria-label="${escapeHtml(messages['manage.yourBooking'])}"><h2>${escapeHtml(messages['manage.yourBooking'])}</h2>${factList(facts)}${calendar}</section>`;
  const actionsColumn = `<div class="bk-col-main">${rescheduleForm}<section aria-label="${escapeHtml(messages['manage.title'])}">${cancelForm}${noShowForm}</section></div>`;
  const body = successNotice
    + errorNotice
    + cancelledNotice
    + cutoffNotice
    + (hasActions ? `<div class="bk-cols">${summaryCard}${actionsColumn}</div>` : summaryCard)
    + cutoffContact;

  return pageShell({
    lang: locale,
    title: `${messages['manage.title']} ${String(booking.reference ?? '')}${options.businessName ? ` — ${options.businessName}` : ''}`,
    cssHref: options.cssHref ?? '',
    favicon: options.favicon,
    headHtml: options.headHtml,
    ...(canReschedule && options.scriptHref ? { scriptHref: options.scriptHref } : {}),
    header,
    theme: options.theme,
    themeToggle: themeToggle(messages, options.theme),
    width: 'mid',
    body,
  });
}

// Rendered when the token is missing/invalid: an explanation and how to reach a human. There is no
// token entry form — the token is a link the customer has in their inbox, never something they
// read off a screen and retype.
export function renderManageErrorPage(managePagePath: string, options: ManagePageOptions = {}): string {
  const locale = options.locale ?? defaultLocale;
  const messages = options.messages ?? resolveMessages(undefined, locale);
  const brand = options.businessName ? `<p class="bk-brand">${escapeHtml(options.businessName)}</p>` : '';
  const header = brand
    + `<h1>${escapeHtml(messages['manage.invalidTitle'])}</h1>`
    + `<p class="bk-lead">${escapeHtml(messages['manage.invalidBody'])}</p>`;
  const body = `<section class="bk-card"><p class="bk-lead">${escapeHtml(messages['manage.invalidUseEmailLink'])}</p></section>`
    + (options.contactConfig ? contactBlock(options.contactConfig, messages) : '');
  return pageShell({
    lang: locale,
    title: `${messages['manage.invalidTitle']}${options.businessName ? ` — ${options.businessName}` : ''}`,
    cssHref: options.cssHref ?? '',
    favicon: options.favicon,
    headHtml: options.headHtml,
    header,
    theme: options.theme,
    themeToggle: themeToggle(messages, options.theme),
    body,
  });
}
