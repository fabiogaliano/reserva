import type { Booking } from '../../core/booking.js';
import { adminLocaleFor, meetingPointForBooking, pickupOptionFor, pickupPresentationFor, resolveService, type ResolvedServiceConfig } from '../../core/config.js';
import { defaultCapacityForDate, occupancyFor, type CapacityDefault } from '../../core/occupancy.js';
import { enumerateDateKeys, localDateKey, utcToLocalIso } from '../../core/time.js';
import type { ReservaContext } from '../../context.js';
import { escapeHtml } from '../../http.js';
import { ownerFacingIncidentTitle } from '../../reconciliation-helpers.js';
import { isManageableToken, type OperationalIncidentRecord } from '../../repo.js';
import type { ReservaResolvedRouteConfig } from '../../routes-manifest.js';
import { cssAssetHref, jsAssetHref } from '../asset-hrefs.js';
import { formatDateTime, formatDayDate, formatPrice } from '../format.js';
import { factList, pageShell, statusBadge, statusToneOf, themeToggle } from '../layout.js';
import { formatMessage, resolveMessages } from '../messages.js';

export interface AdminFilters {
  q: string;
  status: string;
}

export type AdminTab = 'upcoming' | 'availability' | 'attention';

export const adminTabs: readonly AdminTab[] = ['upcoming', 'availability', 'attention'];

const navIcons = {
  dashboard: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  settings: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

const chevronIcon = '<svg class="bk-booking-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

// The dark shell contains only destinations that replace the page; the dashboard's own tab strip
// lives beside its content so switching panels is never mistaken for leaving the page.
export function adminSidebar(context: ReservaContext, messages: ReturnType<typeof resolveMessages>, active: 'admin' | 'settings'): string {
  const adminPath = escapeHtml(context.routeConfig.paths.adminPage);
  const link = (href: string, icon: string, label: string, isActive: boolean): string =>
    `<a href="${href}"${isActive ? ' class="bk-active" aria-current="page"' : ''}>${icon} ${escapeHtml(label)}</a>`;
  const links = link(adminPath, navIcons.dashboard, messages['admin.navOverview'], active === 'admin')
    + link(`${adminPath}?view=settings`, navIcons.settings, messages['admin.settings'], active === 'settings');
  return `<p class="bk-sidebar-brand">${escapeHtml(context.config.business.name)}</p><div class="bk-sidebar-links">${links}</div>`;
}

// The meeting-point label the bookings list displays — '' when none. Shared with the search
// haystack so search only matches visible text. `resolveService` throws for a serviceSlug no
// longer in the live config; degrade to no label rather than 500 the whole admin page.
function adminMeetingPointSubLabel(config: ReservaContext['config'], booking: Booking): string {
  try {
    const service = resolveService(config, booking.serviceSlug);
    const presentation = pickupPresentationFor(service, booking);
    if (!presentation?.usesMeetingPoint || (service.location?.meetingPoints?.length ?? 0) <= 1) return '';
    return meetingPointForBooking(service, booking.meetingPointId, booking.meetingPointLabel).label;
  } catch {
    return '';
  }
}

export function matchesAdminFilters(booking: Booking, filters: AdminFilters, config: ReservaContext['config']): boolean {
  if (filters.status && booking.status !== filters.status) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    // adminMeetingPointSubLabel is exactly what the row displays, so a hidden meeting point can
    // never make a booking match.
    const haystack = [booking.reference, booking.serviceSlug, booking.pickupType, booking.pickupAddress ?? '', adminMeetingPointSubLabel(config, booking), booking.customerName ?? '', booking.customerEmail ?? ''].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

// Shared by every manage-link render site: returns null for a non-presentable token or a
// disabled manage route, so every caller renders the same "unavailable" fallback.
export function manageLinkHref(routeConfig: ReservaResolvedRouteConfig, token: string): string | null {
  if (!routeConfig.groups.manage) return null;
  return isManageableToken(token) ? `${routeConfig.paths.managePage}?token=${encodeURIComponent(token)}` : null;
}

// Relative "how long ago" phrasing for a card's first-detected timestamp — reads as urgency where
// a plain locale date/time wouldn't.
function formatIncidentSince(iso: string, locale: string, timezone: string): string {
  return formatDateTime(utcToLocalIso(iso, timezone), locale, timezone);
}

// The "Attention" panel: open incident cards with a technical-details disclosure and
// CSRF-protected retry/resolve actions, plus 30-day counts and a resolved history. Never renders
// a Retry button for an 'oversell' incident, mirroring the server's own not-retryable rule.
export function incidentsSection(
  context: ReservaContext,
  messages: ReturnType<typeof resolveMessages>,
  openIncidents: OperationalIncidentRecord[],
  resolvedIncidents: OperationalIncidentRecord[],
  counts: { opened: number; resolved: number },
  referenceByBookingId: Map<string, string>,
  csrfToken: string | undefined,
  saved: string,
): string {
  // An all-clear dashboard needs no incident UI; the panel becomes useful only after an
  // incident opens and remains visible while there is open work or 30-day history to review.
  if (openIncidents.length === 0 && counts.opened === 0 && counts.resolved === 0) return '';

  const locale = adminLocaleFor(context.config);
  const timezone = context.config.business.timezone;
  const csrfField = `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`;
  const savedAlert = saved === 'incident-retried'
    ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['admin.incidentRetried'])}</p>`
    : saved === 'incident-resolved'
      ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['admin.incidentResolved'])}</p>`
      : '';
  const hiddenSource = (incident: OperationalIncidentRecord): string =>
    `<input type="hidden" name="source_type" value="${escapeHtml(incident.sourceType)}">`
    + `<input type="hidden" name="source_key" value="${escapeHtml(incident.sourceKey)}">`;
  const cards = openIncidents.map((incident) => {
    const reference = referenceByBookingId.get(incident.bookingId) ?? incident.bookingId;
    const title = ownerFacingIncidentTitle(incident.action);
    const severityLabel = incident.severity === 'action_required' ? messages['admin.incidentSeverityActionRequired'] : messages['admin.incidentSeverityDelayed'];
    const severityTone = incident.severity === 'action_required' ? ' bk-badge--danger' : ' bk-badge--warn';
    const canRetry = incident.action !== 'oversell';
    const isMultiRecipientish = incident.action === 'confirmation_email' || incident.action === 'customer_notification' || incident.action === 'operations_sync';
    const retryForm = canRetry
      ? `<form method="post" class="bk-incident-action">${csrfField}${hiddenSource(incident)}`
        + (isMultiRecipientish ? `<p class="bk-hint">${escapeHtml(messages['admin.incidentRetryDuplicateWarning'])}</p>` : '')
        + `<button type="submit" class="bk-btn bk-btn--secondary bk-btn--sm" name="action" value="incident-retry">${escapeHtml(messages['admin.incidentRetry'])}</button></form>`
      : `<p class="bk-hint">${escapeHtml(messages['admin.incidentNoRetry'])}</p>`;
    // data-reserva-resolve-note marks the field the enhancer collapses until the operator has
    // actually chosen to resolve; with scripting off it stays a plain visible textarea.
    const resolveForm = `<form method="post" class="bk-incident-action">${csrfField}${hiddenSource(incident)}`
      + `<label class="bk-field" data-reserva-resolve-note><span>${escapeHtml(messages['admin.incidentResolveNoteLabel'])}</span>`
      + `<textarea class="bk-input" name="note" required minlength="1" maxlength="500"></textarea>`
      + `<span class="bk-hint">${escapeHtml(messages['admin.incidentResolveNoteHint'])}</span></label>`
      + `<button type="submit" class="bk-btn bk-btn--outline-danger bk-btn--sm" name="action" value="incident-resolve">${escapeHtml(messages['admin.incidentResolveSubmit'])}</button></form>`;
    const details = `<details class="bk-disclosure bk-disclosure--bare"><summary>${escapeHtml(messages['admin.incidentDetails'])}</summary><div>`
      + `<p class="bk-mono bk-sub">${escapeHtml(incident.action)} · ${escapeHtml(incident.sourceType)} · attempt ${incident.attemptCount}</p>`
      + `</div></details>`;
    return `<li class="bk-card bk-incident-card">`
      + `<h3>${escapeHtml(title)} <span class="bk-badge${severityTone}">${escapeHtml(severityLabel)}</span></h3>`
      + `<p class="bk-sub"><span class="bk-mono">${escapeHtml(reference)}</span> · ${escapeHtml(formatMessage(messages['admin.incidentSince'], { date: formatIncidentSince(incident.firstDetectedAt, locale, timezone) }))} · ${escapeHtml(formatMessage(messages['admin.incidentAttempts'], { n: incident.attemptCount }))}</p>`
      + details
      + `<div class="bk-actions">${retryForm}${resolveForm}</div>`
      + `</li>`;
  }).join('');

  const historyItems = resolvedIncidents.map((incident) => {
    const reference = referenceByBookingId.get(incident.bookingId) ?? incident.bookingId;
    const resolution = incident.resolutionKind === 'manual'
      ? formatMessage(messages['admin.incidentHistoryManual'], { who: incident.resolvedBy ?? '' })
      : messages['admin.incidentHistoryAutomatic'];
    return `<li><span class="bk-mono">${escapeHtml(reference)}</span> — ${escapeHtml(ownerFacingIncidentTitle(incident.action))}`
      + `<span class="bk-sub">${escapeHtml(resolution)}</span></li>`;
  }).join('');
  const history = `<details class="bk-disclosure" id="bk-incidents-history">`
    + `<summary>${escapeHtml(messages['admin.incidentHistory'])}</summary><div>`
    + (historyItems ? `<ul class="bk-incident-history">${historyItems}</ul>` : `<p class="bk-hint">${escapeHtml(messages['admin.incidentHistoryNone'])}</p>`)
    + `</div></details>`;

  const countsLine = `<p class="bk-hint">${escapeHtml(formatMessage(messages['admin.incidentCounts30d'], { opened: counts.opened, resolved: counts.resolved }))}</p>`;

  return `<section id="bk-incidents">`
    + savedAlert
    + countsLine
    + (cards ? `<ul class="bk-incident-list">${cards}</ul>` : `<p class="bk-lead">${escapeHtml(messages['admin.incidentsNone'])}</p>`)
    + history
    + `</section>`;
}

export function adminPage(
  context: ReservaContext,
  bookings: Booking[],
  // The list's source set — same as `bookings` but widened to include cancelled/expired/past
  // rows when a filter is applied. Kept separate so the occupancy calendar counts only live rows.
  tableBookings: Booking[],
  overrides: Awaited<ReturnType<ReservaContext['repo']['listDayOverrides']>>,
  fromDate: string,
  toDate: string,
  filters: AdminFilters,
  editDate: string,
  capacityDefaults: CapacityDefault[],
  saved: string,
  // undefined when CSRF isn't configured — the field below renders empty and verification is a
  // no-op on the POST side.
  csrfToken: string | undefined,
  incidentsHtml: string,
  openIncidentCount: number,
  activeTab: AdminTab,
): string {
  const locale = adminLocaleFor(context.config);
  const messages = resolveMessages(context.config, locale);
  const timezone = context.config.business.timezone;
  const filtered = tableBookings.filter((booking) => matchesAdminFilters(booking, filters, context.config));
  const formatTime = (startsAt: string): string =>
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(startsAt));
  const quantityText = (quantity: number): string =>
    formatMessage(quantity === 1 ? messages['widget.person'] : messages['widget.quantityCount'], { n: quantity });

  // A booking row states the five things an operator scans by — when, who, what, how many, where —
  // and keeps reference, contact details and money inside the disclosure, where they are one click
  // away on the one booking in twenty that needs them.
  const bookingRow = (booking: Booking): string => {
    const who = booking.customerName ?? booking.customerEmail ?? '—';
    // resolveService throws for a renamed/removed serviceSlug; degrade to undefined rather than
    // 500 the row — every gate below falls back to the pickupType-keyed check.
    let rowService: ResolvedServiceConfig | undefined;
    try {
      rowService = resolveService(context.config, booking.serviceSlug);
    } catch {
      rowService = undefined;
    }
    const serviceLabel = rowService?.title ?? booking.serviceSlug;
    const option = rowService ? pickupOptionFor(rowService, booking.pickupType) : undefined;
    // Gate on the row's own data, not config — a location-less booking (pickupType null) shows no
    // pickup. A non-null pickupType falls back to the declared option, then the message-catalog
    // key for 'default'/'custom', then the raw id.
    const pickupLabel = booking.pickupType === null
      ? ''
      : option?.label
        ?? (booking.pickupType === 'default' ? messages['widget.pickupDefault']
          : booking.pickupType === 'custom' ? messages['widget.pickupCustom']
          : booking.pickupType);
    const requiresAddress = option ? option.requiresAddress : booking.pickupType === 'custom';
    const meetingPointLabel = adminMeetingPointSubLabel(context.config, booking);
    // The summary names one place: the meeting point when there is a choice of them, otherwise the
    // pickup option itself. The exact street address stays in the disclosure.
    const place = meetingPointLabel || pickupLabel;
    const summaryParts = [serviceLabel, quantityText(booking.quantity), place].filter(Boolean);
    // Confirmed is the expected state and reads as noise on every row, so only the states an
    // operator might act on are spelled out.
    const tone = statusToneOf(booking.status);
    const statusText = booking.status === 'confirmed'
      ? ''
      : escapeHtml(messages[`status.${booking.status}` as keyof typeof messages] ?? booking.status);
    const statusClass = tone === 'danger' ? ' bk-booking-status--danger' : tone === 'warn' ? ' bk-booking-status--warn' : '';
    // No row action on terminal rows (reachable since the filter widening): "Manage" would open a
    // page with no actions left.
    const isTerminal = booking.status === 'cancelled' || booking.status === 'expired' || booking.status === 'no_show';
    const manageHref = isTerminal ? null : manageLinkHref(context.routeConfig, booking.operatorToken);
    const manageMarkup = isTerminal
      ? ''
      : manageHref
        ? `<a class="bk-btn bk-btn--secondary bk-btn--sm bk-booking-open" href="${escapeHtml(manageHref)}">${escapeHtml(messages['admin.manage'])}</a>`
        : `<span class="bk-sub bk-booking-open">${escapeHtml(messages['admin.manageUnavailable'])}</span>`;
    const facts: Array<[string, string]> = [[messages['common.reference'], `<span class="bk-mono">${escapeHtml(booking.reference)}</span>`]];
    if (booking.customerEmail) facts.push([messages['common.email'], escapeHtml(booking.customerEmail)]);
    if (booking.customerPhone) facts.push([messages['common.phone'], escapeHtml(booking.customerPhone)]);
    facts.push([messages['common.price'], escapeHtml(formatPrice(booking.priceMinor, locale, context.config.business.currency))]);
    if (requiresAddress && booking.pickupAddress) facts.push([messages['common.pickupAddress'], escapeHtml(booking.pickupAddress)]);
    if (meetingPointLabel && pickupLabel) facts.push([messages['common.pickup'], escapeHtml(pickupLabel)]);
    facts.push([messages['admin.bookedOn'], escapeHtml(formatDayDate(localDateKey(booking.createdAt, timezone), locale))]);
    return `<details class="bk-booking">`
      + `<summary>`
      + `<span class="bk-booking-time">${escapeHtml(formatTime(booking.startsAt))}</span>`
      + `<span><span class="bk-booking-who">${escapeHtml(who)}</span><span class="bk-booking-sub">${escapeHtml(summaryParts.join(' · '))}</span></span>`
      + `<span class="bk-booking-status${statusClass}">${statusText}</span>`
      + chevronIcon
      + `</summary>`
      + `<div class="bk-booking-detail">${factList(facts)}${manageMarkup}</div>`
      + `</details>`;
  };

  const byStart = (a: Booking, b: Booking): number => a.startsAt.localeCompare(b.startsAt);
  // Grouping by day gives the list its only headings; without them a flat list of times reads as
  // one undifferentiated column.
  const groupByDay = (list: Booking[]): Array<[string, Booking[]]> => {
    const groups = new Map<string, Booking[]>();
    for (const booking of [...list].sort(byStart)) {
      const date = localDateKey(booking.startsAt, timezone);
      const existing = groups.get(date);
      if (existing) existing.push(booking);
      else groups.set(date, [booking]);
    }
    return [...groups];
  };
  const bookingList = groupByDay(filtered).map(([date, list]) =>
    `<div class="bk-daygroup"><h3>${escapeHtml(formatDayDate(date, locale))}</h3>${list.map(bookingRow).join('')}</div>`).join('');

  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));
  const bookingsByDate = new Map<string, Booking[]>();
  for (const booking of bookings) {
    const date = localDateKey(booking.startsAt, timezone);
    const list = bookingsByDate.get(date);
    if (list) list.push(booking);
    else bookingsByDate.set(date, [booking]);
  }
  // Capacity units consumed per day, not raw booking counts: a 5-person booking on a 4-seat
  // vehicle occupies 2 vans, so the admin calendar must count in the same unit checkout does.
  // resolveService throws for a serviceSlug no longer in the live config; a stale row degrades to
  // counting itself as one unit rather than 500ing the whole calendar.
  const unitsByDate = new Map([...bookingsByDate].map(([date, list]) => [
    date,
    list.reduce((total, entry) => {
      try {
        return total + occupancyFor(resolveService(context.config, entry.serviceSlug), entry.quantity);
      } catch {
        return total + 1;
      }
    }, 0),
  ]));
  const unitsLoad = (date: string, capacity: number): string =>
    formatMessage(messages['admin.unitsLoad'], { booked: unitsByDate.get(date) ?? 0, capacity });
  // Rendered as month calendar grids instead of a day-per-row list: an operator's mental model of
  // availability is a calendar. Each day links to the adjust form — still no JS.
  const dowLabels = Array.from({ length: 7 }, (_, index) =>
    // 2024-01-01 is a Monday; formatting it +index yields locale weekday names, Monday-first.
    new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index))));
  const byMonth = new Map<string, string[]>();
  for (const date of enumerateDateKeys(fromDate, toDate)) {
    const month = date.slice(0, 7);
    const dates = byMonth.get(month);
    if (dates) dates.push(date);
    else byMonth.set(month, [date]);
  }
  const monthGrids = [...byMonth.values()].map((dates, monthIndex) => {
    const first = new Date(`${dates[0]}T00:00:00Z`);
    const monthTitle = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
    const header = dowLabels.map((label) => `<span class="bk-dow">${escapeHtml(label)}</span>`).join('');
    const blanks = '<span class="bk-day bk-day--empty"></span>'.repeat((first.getUTCDay() + 6) % 7);
    let flagged = 0;
    let containsSelected = false;
    const cells = dates.map((date) => {
      // Day links keep the active booking filters so selecting a day never resets the search.
      const dayParams = new URLSearchParams();
      if (filters.q) dayParams.set('q', filters.q);
      if (filters.status) dayParams.set('status', filters.status);
      dayParams.set('tab', 'availability');
      dayParams.set('date', date);
      const override = overridesByDate.get(date);
      const dayDefault = defaultCapacityForDate(date, context.config.capacity.default, capacityDefaults);
      const capacity = override?.capacity ?? dayDefault;
      const booked = unitsByDate.get(date) ?? 0;
      const tone = capacity === 0 ? ' bk-day--closed' : override ? ' bk-day--adjusted' : booked > 0 ? ' bk-day--booked' : '';
      if (override || capacity === 0) flagged += 1;
      const selected = date === editDate;
      if (selected) containsSelected = true;
      // Printing "units 2/4" under all thirty numbers turned the month into a table to decode, so
      // the grid shows a dot and the load travels in the cell's accessible name and tooltip —
      // still one hover or one screen-reader stop away, and spelled out in the panel on selection.
      const stateWord = capacity === 0 ? messages['widget.closed'] : override ? messages['admin.stateOverride'] : booked > 0 ? messages['admin.legendBooked'] : '';
      const load = booked > 0 || capacity === 0 || override ? ` — ${unitsLoad(date, capacity)}` : '';
      const label = `${formatDayDate(date, locale)}${stateWord ? ` — ${stateWord}` : ''}${load}`;
      const tooltip = [override?.reason, load ? unitsLoad(date, capacity) : ''].filter(Boolean).join(' · ');
      const title = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
      // data-* carries each day's effective values so the enhancer can prefill the form without a
      // page load; the href stays as the no-JS path.
      const dayData = ` data-date="${date}" data-capacity="${capacity}"${override?.reason ? ` data-reason="${escapeHtml(override.reason)}"` : ''}`;
      return `<a class="bk-day${tone}${selected ? ' bk-day--selected' : ''}"${selected ? ' aria-current="date"' : ''} href="?${dayParams}#bk-override" aria-label="${escapeHtml(label)}"${title}${dayData}>`
        + `<span class="bk-day-num">${Number(date.slice(8, 10))}</span></a>`;
    }).join('');
    const grid = `<div class="bk-monthgrid">${header}${blanks}${cells}</div>`;
    // Near months stay expanded; later mostly-quiet months collapse. A collapsed month auto-opens
    // when it holds signal (adjusted/closed days, or the day being edited).
    if (monthIndex < 2) return `<div class="bk-month" data-label="${escapeHtml(monthTitle)}"><h3>${escapeHtml(monthTitle)}</h3>${grid}</div>`;
    const flaggedBadge = flagged > 0
      ? ` <span class="bk-badge bk-badge--warn">${escapeHtml(formatMessage(messages['admin.monthFlagged'], { n: flagged }))}</span>`
      : '';
    return `<details class="bk-month bk-disclosure" data-label="${escapeHtml(monthTitle)}"${flagged > 0 || containsSelected ? ' open' : ''}>`
      + `<summary>${escapeHtml(monthTitle)}${flaggedBadge}</summary><div>${grid}</div></details>`;
  }).join('');

  const statusOptions = ['', 'confirmed', 'hold', 'cancelled', 'no_show'].map((value) => {
    const label = value === '' ? messages['admin.all'] : (messages[`status.${value}` as keyof typeof messages] ?? value);
    const selected = filters.status === value ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');

  // Keeps the selected day when filters are (re)applied — the two workflows share one URL.
  const clearParams = new URLSearchParams();
  if (editDate) clearParams.set('date', editDate);
  const clearHref = `${clearParams.size ? `?${clearParams}` : context.routeConfig.paths.adminPage}#bk-upcoming`;
  // Drops the "pickup" mention from the search hint when no service declares a location module.
  const hasLocationService = Object.values(context.config.services).some((candidate) => candidate.location);
  const searchPlaceholder = hasLocationService ? messages['admin.searchPlaceholder'] : messages['admin.searchPlaceholderNoPickup'];
  // One row of controls with no field labels: the placeholder names what the box searches and the
  // select's own options name what it filters.
  const filterForm = `<form method="get" class="bk-searchbar" role="search">`
    + (editDate ? `<input type="hidden" name="date" value="${escapeHtml(editDate)}">` : '')
    + `<input class="bk-input" type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="${escapeHtml(searchPlaceholder)}" aria-label="${escapeHtml(messages['admin.searchLabel'])}">`
    + `<select class="bk-select" name="status" aria-label="${escapeHtml(messages['common.status'])}">${statusOptions}</select>`
    + `<button type="submit" class="bk-btn bk-btn--secondary">${escapeHtml(messages['admin.apply'])}</button>`
    + (filters.q || filters.status ? `<a class="bk-filter-clear" href="${escapeHtml(clearHref)}">${escapeHtml(messages['admin.clearFilters'])}</a>` : '')
    + `</form>`;

  const upcomingPanel = filterForm
    + (filtered.length === 0
      ? `<div class="bk-empty-state"><p>${escapeHtml(messages['admin.noBookings'])}</p></div>`
      : bookingList);

  // Row "Edit" links land here with ?date=…, prefilling the form — no script needed.
  const editOverride = editDate ? overridesByDate.get(editDate) : undefined;
  const editDefault = defaultCapacityForDate(editDate || fromDate, context.config.capacity.default, capacityDefaults);
  // Explicit post-save confirmation inside whichever form was just submitted — the POST redirects
  // back with saved=day|default plus a hash so the operator lands on the form and sees it.
  const savedAlert = (which: string): string => saved === which
    ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['admin.saved'])}</p>`
    : '';
  // Per-day booking summaries, display-ready (times/labels formatted server-side so the enhancer
  // renders them without duplicating locale logic). Small: admin only lists upcoming bookings.
  const daySummaries: Record<string, Array<Record<string, string>>> = {};
  for (const [date, list] of bookingsByDate) {
    daySummaries[date] = [...list].sort(byStart).map((entry) => {
      const tone = statusToneOf(entry.status);
      // Omitted (not a dead-link href) when the token isn't presentable — the enhancer renders
      // the "unavailable" fallback when `u` is absent.
      const manageHref = manageLinkHref(context.routeConfig, entry.operatorToken);
      return {
        t: formatTime(entry.startsAt),
        c: entry.customerName ?? entry.customerEmail ?? '—',
        p: quantityText(entry.quantity),
        s: messages[`status.${entry.status}` as keyof typeof messages] ?? entry.status,
        ...(tone ? { sc: tone } : {}),
        ...(manageHref ? { u: manageHref } : {}),
      };
    });
  }
  // Strings + day data the admin enhancer needs at runtime, shipped as a non-executable JSON
  // island (same CSP-safe pattern as the manage page's reschedule island).
  const adminIsland = `<script type="application/json" data-reserva-i18n>${JSON.stringify({
    selectedDays: messages['admin.selectedDays'],
    close: messages['admin.close'],
    closeMany: messages['admin.closeMany'],
    title: messages['admin.overrideTitle'],
    noBookings: messages['admin.dayNoBookings'],
    manage: messages['admin.manage'],
    manageUnavailable: messages['admin.manageUnavailable'],
    prevMonth: messages['admin.prevMonth'],
    nextMonth: messages['admin.nextMonth'],
    selectHint: messages['admin.selectHint'],
    days: daySummaries,
  }).replace(/</g, '\\u003c')}</script>`;
  // The day panel answers "what does this day actually have" — the bookings on the selected day,
  // rendered server-side for the no-JS path and rebuilt client-side from the island on selection.
  const dayBookingItem = (entry: Booking): string => {
    const manageHref = manageLinkHref(context.routeConfig, entry.operatorToken);
    const manageMarkup = manageHref
      ? `<a href="${escapeHtml(manageHref)}">${escapeHtml(messages['admin.manage'])}</a>`
      : `<span class="bk-sub">${escapeHtml(messages['admin.manageUnavailable'])}</span>`;
    return `<li><span class="bk-mono">${escapeHtml(formatTime(entry.startsAt))}</span> <strong>${escapeHtml(entry.customerName ?? entry.customerEmail ?? '—')}</strong>`
      + `<span class="bk-sub">${escapeHtml(quantityText(entry.quantity))}</span>${statusBadge(entry.status, messages)}`
      + `${manageMarkup}</li>`;
  };
  const editDayBookings = editDate ? [...bookingsByDate.get(editDate) ?? []].sort(byStart) : [];
  const editCapacity = editOverride?.capacity ?? editDefault;
  const dayDetail = `<div class="bk-day-detail" data-reserva-day-detail>`
    + (editDate
      ? `<p class="bk-hint">${escapeHtml(unitsLoad(editDate, editCapacity))}</p>`
      : '')
    + (editDate
      ? editDayBookings.length
        ? `<ul class="bk-day-bookings">${editDayBookings.map(dayBookingItem).join('')}</ul>`
        : `<p class="bk-hint">${escapeHtml(messages['admin.dayNoBookings'])}</p>`
      : '')
    + `</div>`;
  // Capacity prefills with the day's effective value (override, else its default) so the operator
  // sees what they're changing from. The optional To date is the no-JS bulk path — the POST expands
  // the range server-side; the enhancer hides it and uses multi-select with repeated date inputs.
  const editReason = editOverride?.reason ?? '';
  const csrfField = `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`;
  const overrideForm = `<form method="post" id="bk-override" class="bk-day-form">${csrfField}${adminIsland}`
    // role="status" makes this a live region: once the enhancer starts rewriting this text on
    // selection changes, a screen reader announces it without focus moving. Inert without JS.
    + `<h2 data-reserva-day-title role="status">${escapeHtml(editDate ? formatDayDate(editDate, locale) : messages['admin.overrideTitle'])}</h2>`
    + savedAlert('day')
    + dayDetail
    + `<label class="bk-field"><span>${escapeHtml(messages['common.date'])}</span><input class="bk-input" name="date" type="date" required value="${escapeHtml(editDate)}"></label>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.overrideTo'])}</span><input class="bk-input" name="toDate" type="date"></label>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.capacity'])}</span><input class="bk-input" name="capacity" type="number" min="0" value="${editOverride ? editOverride.capacity : editDate ? editDefault : ''}"></label>`
    + `<details class="bk-disclosure bk-disclosure--bare"${editReason ? ' open' : ''}><summary>${escapeHtml(messages['admin.addReason'])}</summary><div>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.reason'])}</span><input class="bk-input" name="reason" value="${escapeHtml(editReason)}"></label>`
    + `</div></details>`
    + `<div class="bk-actions">`
    + `<button type="submit" class="bk-btn" name="action" value="set">${escapeHtml(messages['admin.save'])}</button>`
    + `<button type="submit" class="bk-btn bk-btn--outline-danger" name="action" value="close">${escapeHtml(messages['admin.close'])}</button>`
    + `<button type="submit" class="bk-btn bk-btn--secondary" name="action" value="clear">${escapeHtml(messages['admin.clear'])}</button>`
    + `</div>`
    + `<p class="bk-hint">${escapeHtml(formatMessage(messages['admin.overrideDefault'], { n: editDefault }))}</p>`
    + `</form>`;

  // Capacity-level changes ("a van broke down") apply from a date onwards, so operators never
  // click 30 day cells one by one. Each scheduled change can be removed independently.
  const defaultEntries = capacityDefaults.map((entry) =>
    `<li><span>${escapeHtml(formatMessage(messages['admin.defaultEntry'], { n: entry.capacity, date: formatDayDate(entry.fromDate, locale) }))}`
    + (entry.reason ? `<span class="bk-sub">${escapeHtml(entry.reason)}</span>` : '')
    + `</span><form method="post">${csrfField}<input type="hidden" name="date" value="${escapeHtml(entry.fromDate)}">`
    + `<button type="submit" class="bk-btn bk-btn--secondary bk-btn--sm" name="action" value="default-clear">${escapeHtml(messages['admin.remove'])}</button></form></li>`).join('');
  // The capacity-default form is the rare, high-blast-radius task, so it sits behind a collapsed
  // disclosure. Opens after its own POST so the saved confirmation is visible; the
  // scheduled-change count keeps active rules discoverable while collapsed.
  const scheduledBadge = capacityDefaults.length > 0
    ? ` <span class="bk-badge">${escapeHtml(formatMessage(messages['admin.defaultScheduled'], { n: capacityDefaults.length }))}</span>`
    : '';
  const defaultForm = `<details class="bk-disclosure" id="bk-default"${saved === 'default' ? ' open' : ''}>`
    + `<summary>${escapeHtml(messages['admin.defaultTitle'])}${scheduledBadge}</summary><div>`
    + `<form method="post" class="bk-day-form">${csrfField}`
    + savedAlert('default')
    + `<p class="bk-hint">${escapeHtml(messages['admin.defaultHint'])}</p>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.defaultFrom'])}</span><input class="bk-input" name="date" type="date" required></label>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.capacity'])}</span><input class="bk-input" name="capacity" type="number" min="0" required></label>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.reason'])}</span><input class="bk-input" name="reason"></label>`
    + `<div class="bk-actions"><button type="submit" class="bk-btn" name="action" value="default-set">${escapeHtml(messages['admin.save'])}</button></div></form>`
    + (defaultEntries ? `<ul class="bk-defaults">${defaultEntries}</ul>` : '')
    + `</div></details>`;

  const legendRow = (color: string, label: string): string =>
    `<span><i style="background:var(--bk-${color})"></i>${escapeHtml(label)}</span>`;
  const legend = `<p class="bk-legend">${legendRow('accent', messages['admin.legendBooked'])}`
    + `${legendRow('warning', messages['admin.stateOverride'])}`
    + `${legendRow('danger', messages['widget.closed'])}</p>`;
  const availabilityPanel = `<div class="bk-days-layout"><div><div class="bk-months">${monthGrids}</div>${legend}</div>`
    + `<div class="bk-day-editor">${overrideForm}${defaultForm}</div></div>`;

  const tabParams = (tab: AdminTab): string => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.status) params.set('status', filters.status);
    if (editDate) params.set('date', editDate);
    params.set('tab', tab);
    return `?${params}`;
  };
  const tabLabels: Record<AdminTab, string> = {
    upcoming: messages['admin.tabUpcoming'],
    availability: messages['admin.tabAvailability'],
    attention: messages['admin.tabAttention'],
  };
  const hasIncidents = Boolean(incidentsHtml);
  const visibleTabs: AdminTab[] = hasIncidents ? ['upcoming', 'availability', 'attention'] : ['upcoming', 'availability'];
  // `activeTab` is already narrowed by the caller, but an attention tab that no longer exists
  // (the last incident cleared between the click and the render) must not leave every panel hidden.
  const currentTab: AdminTab = visibleTabs.includes(activeTab) ? activeTab : 'upcoming';
  const tabLink = (tab: AdminTab): string => {
    const count = tab === 'attention' && openIncidentCount > 0
      ? ` <span class="bk-tab-count">${openIncidentCount}</span>`
      : '';
    return `<a href="${escapeHtml(tabParams(tab))}" data-reserva-admin-tab="${tab}"${tab === currentTab ? ' aria-current="page"' : ''}>${escapeHtml(tabLabels[tab])}${count}</a>`;
  };
  const tabs = `<nav class="bk-tabs" aria-label="${escapeHtml(messages['admin.title'])}">${visibleTabs.map(tabLink).join('')}</nav>`;
  const panel = (tab: AdminTab, id: string, content: string): string =>
    `<section class="bk-panel" id="${id}"${tab === currentTab ? '' : ' hidden'}>${content}</section>`;

  const attentionLink = openIncidentCount > 0
    ? `<a class="bk-admin-attention" href="${escapeHtml(tabParams('attention'))}">${escapeHtml(formatMessage(messages['admin.attentionCount'], { n: openIncidentCount }))}</a>`
    : '';
  const adminHeader = `<header class="bk-admin-header"><h1>${escapeHtml(messages['admin.title'])}</h1>${attentionLink}</header>`;

  return pageShell({
    lang: locale,
    title: `${messages['admin.title']} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss),
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    sidebar: adminSidebar(context, messages, 'admin'),
    sidebarLabel: messages['admin.navigation'],
    skipLabel: messages['common.skipContent'],
    theme: context.viewerTheme,
    themeToggle: themeToggle(messages, context.viewerTheme),
    body: `${adminHeader}${tabs}<div class="bk-panels">`
      + panel('upcoming', 'bk-upcoming', upcomingPanel)
      + panel('availability', 'bk-availability', availabilityPanel)
      + (hasIncidents ? panel('attention', 'bk-attention', incidentsHtml) : '')
      + `</div>`,
  });
}
