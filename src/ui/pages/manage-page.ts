import type { ManageBooking } from '../../core/api.js';
import { escapeHtml } from '../../http.js';
import { formatDateTime, formatPrice } from '../format.js';
import { factList, pageShell, statusBadge, themeToggle } from '../layout.js';
import { defaultLocale, formatMessage, resolveMessages, type ReservaMessages } from '../messages.js';
import type { ThemePreference } from '../theme.js';

export interface ManagePageOptions {
  messages?: ReservaMessages;
  locale?: string;
  timezone?: string;
  currency?: string;
  cssHref?: string;
  // The viewer's forced theme (from the request cookie), set by the manage route so the page can
  // render <html data-theme> up front. Absent/undefined = follow the OS.
  theme?: ThemePreference | undefined;
  businessName?: string;
  // Makes the brand line a link back to the consumer's site.
  businessUrl?: string;
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
  const deadline = typeof payload.deadline === 'string' ? payload.deadline : '';
  const status = typeof booking.status === 'string' ? booking.status : '';
  const action = escapeHtml(managePagePath);
  const tokenField = role === 'operator' ? 'operatorToken' : 'token';
  const hiddenToken = `<input type="hidden" name="${tokenField}" value="${escapeHtml(token)}">`;

  const start = typeof booking.start === 'string' ? booking.start : '';
  const displayStart = start && options.timezone ? formatDateTime(start, locale, options.timezone) : start;
  const displayDeadline = deadline && options.timezone ? formatDateTime(deadline, locale, options.timezone) : deadline;

  const quantityLabel = typeof booking.quantity === 'number'
    ? formatMessage(messages[booking.quantity === 1 ? 'widget.person' : 'widget.quantityCount'], { n: booking.quantity })
    : String(booking.quantity ?? '');
  const facts: Array<[string, string]> = [
    [messages['common.service'], escapeHtml(booking.serviceSlug)],
    [messages['common.date'], escapeHtml(displayStart)],
    [messages['common.quantity'], escapeHtml(quantityLabel)],
  ];
  if (typeof booking.priceMinor === 'number' && options.currency) {
    facts.push([messages['common.price'], escapeHtml(formatPrice(booking.priceMinor, locale, options.currency))]);
  }
  // Both facts key off the chosen option's flags independently — a both-flags option shows its
  // address AND its meeting point. A payload predating the flags falls back to the literal
  // 'custom' id for address, and any resolved point for the meeting-point row.
  const requiresAddress = typeof booking.pickupRequiresAddress === 'boolean'
    ? booking.pickupRequiresAddress
    : booking.pickupType === 'custom';
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
  const errorKeyByCode: Record<string, keyof ReservaMessages> = {
    past_cutoff: 'manage.pastCutoff',
    slot_unavailable: 'manage.errorSlotTaken',
    invalid_transition: 'manage.errorNotChangeable',
  };
  const errorNotice = options.errorCode
    ? `<p class="bk-alert bk-alert--danger" role="alert">${escapeHtml(messages[errorKeyByCode[options.errorCode] ?? 'manage.actionFailed'])}</p>`
    : '';

  const cancelledNotice = status === 'cancelled' ? `<p class="bk-alert bk-alert--danger" role="status">${escapeHtml(messages['manage.cancelled'])}</p>` : '';
  const cutoffNotice = status === 'confirmed' && role === 'customer' && !canCancel && !canReschedule
    ? `<p class="bk-alert bk-alert--warn">${escapeHtml(messages['manage.pastCutoff'])}</p>`
    : '';
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
      + `<label class="bk-field" data-reserva-native-start><span>${escapeHtml(messages['manage.newStart'])}</span><input class="bk-input" name="newStart" type="datetime-local" required></label>`
      + `<button type="submit" class="bk-btn">${escapeHtml(messages['manage.rescheduleSubmit'])}</button></form></section>`
    : '';

  const refundControl = role === 'operator'
    ? `<label class="bk-field"><span>${escapeHtml(messages['manage.refund'])}</span><select class="bk-select" name="refund"><option value="none">${escapeHtml(messages['manage.refundNone'])}</option><option value="full">${escapeHtml(messages['manage.refundFull'])}</option></select></label>`
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
  const summaryCard = `<section class="bk-card${hasActions ? ' bk-col-side' : ''}" aria-label="${escapeHtml(messages['manage.yourBooking'])}"><h2>${escapeHtml(messages['manage.yourBooking'])}</h2>${factList(facts)}</section>`;
  const actionsColumn = `<div class="bk-col-main">${rescheduleForm}<section aria-label="${escapeHtml(messages['manage.title'])}">${cancelForm}${noShowForm}</section></div>`;
  const body = successNotice
    + errorNotice
    + cancelledNotice
    + cutoffNotice
    + (hasActions ? `<div class="bk-cols">${summaryCard}${actionsColumn}</div>` : summaryCard);

  return pageShell({
    lang: locale,
    title: `${messages['manage.title']} ${String(booking.reference ?? '')}${options.businessName ? ` — ${options.businessName}` : ''}`,
    cssHref: options.cssHref ?? '',
    ...(canReschedule && options.scriptHref ? { scriptHref: options.scriptHref } : {}),
    header,
    theme: options.theme,
    themeToggle: themeToggle(messages, options.theme),
    width: 'mid',
    body,
  });
}

// Rendered when the token is missing/invalid: an explanation plus a token entry form, so a
// customer with a mangled link can still recover without seeing raw JSON.
export function renderManageErrorPage(managePagePath: string, options: ManagePageOptions = {}): string {
  const locale = options.locale ?? defaultLocale;
  const messages = options.messages ?? resolveMessages(undefined, locale);
  const brand = options.businessName ? `<p class="bk-brand">${escapeHtml(options.businessName)}</p>` : '';
  const header = brand
    + `<h1>${escapeHtml(messages['manage.invalidTitle'])}</h1>`
    + `<p class="bk-lead">${escapeHtml(messages['manage.invalidBody'])}</p>`;
  const body = `<section class="bk-card">`
    + `<form method="get" action="${escapeHtml(managePagePath)}">`
    + `<label class="bk-field"><span>${escapeHtml(messages['manage.entryToken'])}</span><input class="bk-input" name="token" autocomplete="off" required></label>`
    + `<button type="submit" class="bk-btn">${escapeHtml(messages['manage.entryOpen'])}</button></form></section>`;
  return pageShell({
    lang: locale,
    title: `${messages['manage.invalidTitle']}${options.businessName ? ` — ${options.businessName}` : ''}`,
    cssHref: options.cssHref ?? '',
    header,
    theme: options.theme,
    themeToggle: themeToggle(messages, options.theme),
    body,
  });
}
