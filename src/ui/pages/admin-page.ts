import type { Booking } from '../../core/booking';
import { adminLocaleFor, meetingPointForBooking, pickupOptionFor, resolveTour, type TourConfig } from '../../core/config';
import { defaultCapacityForDate, occupancyFor, type CapacityDefault } from '../../core/occupancy';
import { enumerateDateKeys, localDateKey, utcToLocalIso } from '../../core/time';
import type { BookkitContext } from '../../context';
import { escapeHtml } from '../../http';
import { isManageableToken } from '../../providers/brevo';
import { ownerFacingIncidentTitle } from '../../reconciliation-helpers';
import type { OperationalIncidentRecord } from '../../repo';
import { cssAssetHref, jsAssetHref } from '../asset-hrefs';
import { formatDateTime, formatDayDate, formatPrice } from '../format';
import { pageShell, statusBadge, statusToneOf, themeToggle } from '../layout';
import { formatMessage, resolveMessages } from '../messages';

export interface AdminFilters {
  q: string;
  status: string;
}

const navIcons = {
  dashboard: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  settings: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

// The dark shell contains only destinations that replace the page; in-page section links live
// beside the dashboard content so their scrolling behavior is not mistaken for page navigation.
export function adminSidebar(context: BookkitContext, messages: ReturnType<typeof resolveMessages>, active: 'admin' | 'settings'): string {
  const adminPath = escapeHtml(context.routeConfig.paths.adminPage);
  const link = (href: string, icon: string, label: string, isActive: boolean): string =>
    `<a href="${href}"${isActive ? ' class="bk-active" aria-current="page"' : ''}>${icon} ${escapeHtml(label)}</a>`;
  const links = link(adminPath, navIcons.dashboard, messages['admin.navOverview'], active === 'admin')
    + link(`${adminPath}?view=settings`, navIcons.settings, messages['admin.settings'], active === 'settings');
  return `<p class="bk-sidebar-brand">${escapeHtml(context.config.business.name)}</p><div class="bk-sidebar-links">${links}</div>`;
}

function adminSectionNav(messages: ReturnType<typeof resolveMessages>, hasIncidents: boolean, openIncidentCount: number): string {
  const link = (id: string, label: string, count?: number): string =>
    `<a href="#${id}" data-bookkit-section-link>${escapeHtml(label)}${count ? ` <span class="bk-section-nav-count">${count}</span>` : ''}</a>`;
  const links = (hasIncidents ? link('bk-incidents', messages['admin.navIncidents'], openIncidentCount) : '')
    + link('bk-bookings', messages['admin.navBookings'])
    + link('bk-days', messages['admin.navDays']);
  return `<nav class="bk-section-nav" aria-label="${escapeHtml(messages['admin.onThisPage'])}" data-bookkit-section-nav>`
    + `<p class="bk-section-nav-title">${escapeHtml(messages['admin.onThisPage'])}</p>`
    + `<div class="bk-section-nav-links">${links}</div></nav>`;
}

// Plan 017 (design decision 4) / Plan 018 (design decision 8): the meeting-point label the
// bookings-table row actually displays — '' when the row shows none. Shared by the row renderer
// and the search haystack so search can only ever match visible text: only an option that starts
// at a meeting point surfaces a choice, and only when the tour declares more than one (a
// single-point tour's sub-line would just repeat what "Meeting point" implies). resolveTour throws
// for a tourSlug no longer in the live config (renamed/removed since the booking was made) —
// degrade to no label rather than 500 the whole admin page, the same tolerance the day-calendar
// unit aggregation below already applies.
function adminMeetingPointSubLabel(config: BookkitContext['config'], booking: Booking): string {
  try {
    const tour = resolveTour(config, booking.tourSlug);
    const option = pickupOptionFor(tour, booking.pickupType);
    const usesMeetingPoint = option ? option.usesMeetingPoint : booking.pickupType === 'default';
    if (!usesMeetingPoint || (tour.meetingPoints?.length ?? 0) <= 1) return '';
    return meetingPointForBooking(tour, booking.meetingPointId, booking.meetingPointLabel).label;
  } catch {
    return '';
  }
}

export function matchesAdminFilters(booking: Booking, filters: AdminFilters, config: BookkitContext['config']): boolean {
  if (filters.status && booking.status !== filters.status) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    // adminMeetingPointSubLabel is exactly what the row displays (it is the renderer's own
    // source), so a hidden meeting point can never make a booking match.
    const haystack = [booking.reference, booking.tourSlug, booking.pickupType, booking.pickupAddress ?? '', adminMeetingPointSubLabel(config, booking), booking.customerName ?? '', booking.customerEmail ?? ''].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

// BK-SEC-002 (patch-11-r1 LOW 1): shared by every admin manage-link render site below (the
// bookings table, the day-detail island, and its server-rendered fallback) — never build an href
// from a token that isn't presentable (see isManageableToken, src/providers/brevo.ts: a
// `nohash:`-prefixed placeholder, meaning no decryptable blob exists to regenerate the real link
// from). null tells each call site to render the "unavailable" fallback instead of a dead link.
export function manageLinkHref(managePagePath: string, token: string): string | null {
  return isManageableToken(token) ? `${managePagePath}?token=${encodeURIComponent(token)}` : null;
}

// Plan 020 (design decision 12): relative "how long ago" phrasing for a card's first-detected
// timestamp — plain locale date/time is precise but doesn't read as urgency the way "since" does,
// and this is the one place on the admin page that needs it.
function formatIncidentSince(iso: string, locale: string, timezone: string): string {
  return formatDateTime(utcToLocalIso(iso, timezone), locale, timezone);
}

// Plan 020 (design decisions 12/13/14): the "Attention required" section — open incident cards
// (already sorted action-required-then-delayed-then-oldest by listOpenIncidents), each with a
// collapsed technical-details disclosure and two CSRF-protected actions (retry, manual resolve),
// plus a 30-day counts line and a short recently-resolved history distinguishing automatic from
// manual resolutions. Never renders the internal word "abandoned" (ownerFacingIncidentTitle/plain
// severity labels only) and never renders a Retry button for an 'oversell' incident — the STOP
// condition in src/confirmation.ts's retrySideEffectOperation ('oversell' -> 'not_retryable') is
// mirrored here so the UI never offers an action the server would refuse anyway.
export function incidentsSection(
  context: BookkitContext,
  messages: ReturnType<typeof resolveMessages>,
  openIncidents: OperationalIncidentRecord[],
  resolvedIncidents: OperationalIncidentRecord[],
  counts: { opened: number; resolved: number },
  referenceByBookingId: Map<string, string>,
  csrfToken: string | undefined,
  saved: string,
): string {
  // An all-clear dashboard needs no incident UI; the section becomes useful only after an
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
    const resolveForm = `<form method="post" class="bk-incident-action">${csrfField}${hiddenSource(incident)}`
      + `<label class="bk-field"><span>${escapeHtml(messages['admin.incidentResolveNoteLabel'])}</span>`
      + `<textarea class="bk-input" name="note" required minlength="1" maxlength="500"></textarea>`
      + `<span class="bk-hint">${escapeHtml(messages['admin.incidentResolveNoteHint'])}</span></label>`
      + `<button type="submit" class="bk-btn bk-btn--outline-danger bk-btn--sm" name="action" value="incident-resolve">${escapeHtml(messages['admin.incidentResolveSubmit'])}</button></form>`;
    const details = `<details class="bk-disclosure bk-disclosure--bare"><summary>${escapeHtml(messages['admin.incidentDetails'])}</summary><div>`
      + `<p class="bk-mono bk-sub">${escapeHtml(incident.action)} · ${escapeHtml(incident.sourceType)} · attempt ${incident.attemptCount}</p>`
      + `</div></details>`;
    return `<li class="bk-card bk-incident-card">`
      + `<h3>${escapeHtml(title)} <span class="bk-badge${severityTone}">${escapeHtml(severityLabel)}</span></h3>`
      + `<p class="bk-sub">${escapeHtml(messages['common.reference'])}: <span class="bk-mono">${escapeHtml(reference)}</span></p>`
      + `<p class="bk-sub">${escapeHtml(formatMessage(messages['admin.incidentSince'], { date: formatIncidentSince(incident.firstDetectedAt, locale, timezone) }))} · ${escapeHtml(formatMessage(messages['admin.incidentAttempts'], { n: incident.attemptCount }))}</p>`
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

  const countsLine = `<p class="bk-sub">${escapeHtml(formatMessage(messages['admin.incidentCounts30d'], { opened: counts.opened, resolved: counts.resolved }))}</p>`;

  return `<section class="bk-card" id="bk-incidents"><h2>${escapeHtml(messages['admin.incidentsTitle'])}</h2>`
    + `<p class="bk-hint">${escapeHtml(messages['admin.incidentsHint'])}</p>`
    + savedAlert
    + countsLine
    + (cards ? `<ul class="bk-incident-list">${cards}</ul>` : `<p class="bk-lead">${escapeHtml(messages['admin.incidentsNone'])}</p>`)
    + history
    + `</section>`;
}

export function adminPage(
  context: BookkitContext,
  bookings: Booking[],
  // The table's source set — same as `bookings` with no filters active, widened to include
  // cancelled/expired/past rows when a search or status filter is applied. Separate from
  // `bookings` because the occupancy calendar and stats below must keep counting only live rows.
  tableBookings: Booking[],
  overrides: Awaited<ReturnType<BookkitContext['repo']['listDayOverrides']>>,
  fromDate: string,
  toDate: string,
  filters: AdminFilters,
  editDate: string,
  capacityDefaults: CapacityDefault[],
  saved: string,
  // undefined when BOOKKIT_CSRF_SECRET isn't configured (src/admin-csrf.ts mintAdminCsrfToken) — the
  // field below then renders empty and verifyAdminCsrfToken is a deliberate no-op on the POST side.
  csrfToken: string | undefined,
  incidentsHtml: string,
  openIncidentCount: number,
): string {
  const locale = adminLocaleFor(context.config);
  const messages = resolveMessages(context.config, locale);
  const timezone = context.config.business.timezone;
  const managePagePath = context.routeConfig.paths.managePage;
  const filtered = tableBookings.filter((booking) => matchesAdminFilters(booking, filters, context.config));

  // Operators scan by when → who → what, so the row leads with date and customer; secondary
  // detail (reference, email, party size, pickup address) stacks as sub-lines instead of
  // spreading into ever more columns.
  const rows = filtered.map((booking) => {
    const customerPrimary = booking.customerName ?? booking.customerEmail ?? '—';
    const customerSub = booking.customerName && booking.customerEmail
      ? `<span class="bk-sub">${escapeHtml(booking.customerEmail)}</span>`
      : '';
    const people = formatMessage(booking.people === 1 ? messages['widget.person'] : messages['widget.peopleCount'], { n: booking.people });
    const price = formatPrice(booking.priceCents, locale, context.config.business.currency);
    // Plan 018 (design decision 8): resolveTour throws for a renamed/removed tourSlug (see
    // adminMeetingPointLabel above) — degrade option to undefined rather than 500 the row; every
    // gate below then falls back to the pre-018 pickupType-keyed check, so a legacy default/custom
    // booking (or a booking whose tour disappeared) renders exactly as it did before this plan.
    let rowTour: TourConfig | undefined;
    try {
      rowTour = resolveTour(context.config, booking.tourSlug);
    } catch {
      rowTour = undefined;
    }
    const option = rowTour ? pickupOptionFor(rowTour, booking.pickupType) : undefined;
    // Fallback chain (decision 8): a declared option's own label, else the message-catalog key for
    // the 'default'/'custom' ids (unchanged copy for every config that predates this plan), else
    // the raw id verbatim for a declared-but-uncataloged one.
    const pickupLabel = option?.label
      ?? (booking.pickupType === 'default' ? messages['widget.pickupDefault']
        : booking.pickupType === 'custom' ? messages['widget.pickupCustom']
        : booking.pickupType);
    const requiresAddress = option ? option.requiresAddress : booking.pickupType === 'custom';
    const pickupSub = requiresAddress && booking.pickupAddress
      ? `<span class="bk-sub">${escapeHtml(booking.pickupAddress)}</span>`
      : '';
    // The same helper the search haystack uses (see matchesAdminFilters above), so the two can
    // never disagree about which meeting points are visible.
    const meetingPointLabel = adminMeetingPointSubLabel(context.config, booking);
    const meetingPointSub = meetingPointLabel ? `<span class="bk-sub">${escapeHtml(meetingPointLabel)}</span>` : '';
    // No row action on terminal rows (reachable since the filter widening): "Manage" would open
    // a page with no actions left, so cancelled/expired/no_show rows get an empty cell instead.
    const isTerminal = booking.status === 'cancelled' || booking.status === 'expired' || booking.status === 'no_show';
    const manageHref = isTerminal ? null : manageLinkHref(managePagePath, booking.operatorToken);
    const manageCell = isTerminal
      ? ''
      : manageHref
        ? `<a href="${escapeHtml(manageHref)}">${escapeHtml(messages['admin.manage'])}</a>`
        : `<span class="bk-sub">${escapeHtml(messages['admin.manageUnavailable'])}</span>`;
    return `<tr>`
      + `<td data-label="${escapeHtml(messages['common.date'])}">${escapeHtml(formatDateTime(utcToLocalIso(booking.startsAt, timezone), locale, timezone))}<span class="bk-sub bk-mono">${escapeHtml(booking.reference)}</span></td>`
      + `<td data-label="${escapeHtml(messages['common.customer'])}"><strong>${escapeHtml(customerPrimary)}</strong>${customerSub}</td>`
      + `<td data-label="${escapeHtml(messages['common.tour'])}">${escapeHtml(booking.tourSlug)}<span class="bk-sub">${escapeHtml(people)} · ${escapeHtml(price)}</span></td>`
      + `<td data-label="${escapeHtml(messages['common.pickup'])}">${escapeHtml(pickupLabel)}${pickupSub}${meetingPointSub}</td>`
      + `<td data-label="${escapeHtml(messages['common.status'])}">${statusBadge(booking.status, messages)}</td>`
      + `<td class="bk-table-action" data-label="${escapeHtml(messages['admin.manage'])}">${manageCell}</td>`
      + `</tr>`;
  }).join('');

  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));
  const bookingsByDate = new Map<string, Booking[]>();
  for (const booking of bookings) {
    const date = localDateKey(booking.startsAt, timezone);
    const list = bookingsByDate.get(date);
    if (list) list.push(booking);
    else bookingsByDate.set(date, [booking]);
  }
  // Fleet units consumed per day, not raw booking-row counts: a single 5-person booking on a
  // 4-seat vehicle occupies 2 vans (occupancyFor), and checkout enforces capacity in units, so the
  // admin calendar must count in the same unit or a day can read "1/2" while it is actually full.
  // resolveTour throws for a tourSlug no longer in the live config (e.g. renamed/removed since the
  // booking was made) — unlike a single-booking lookup, this aggregates every booking in the
  // rendered horizon, so one stale row must degrade to counting itself as one unit, not 500 the
  // whole admin calendar.
  const unitsByDate = new Map([...bookingsByDate].map(([date, list]) => [
    date,
    list.reduce((total, b) => {
      try {
        return total + occupancyFor(resolveTour(context.config, b.tourSlug), b.people);
      } catch {
        return total + 1;
      }
    }, 0),
  ]));
  const formatDayTime = (startsAt: string): string =>
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(startsAt));
  const peopleText = (people: number): string =>
    formatMessage(people === 1 ? messages['widget.person'] : messages['widget.peopleCount'], { n: people });
  // The horizon rendered as month calendar grids instead of a day-per-row list: an operator's
  // mental model of availability is a calendar, and 30 rows collapse into a screenful of cells
  // where only exceptional days carry color. Each day links to the adjust form — still no JS.
  const dowLabels = Array.from({ length: 7 }, (_, index) =>
    // 2024-01-01 is a Monday; formatting it +index yields locale weekday names, Monday-first.
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index))));
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
      dayParams.set('date', date);
      const override = overridesByDate.get(date);
      const dayDefault = defaultCapacityForDate(date, context.config.fleet.defaultCapacity, capacityDefaults);
      const capacity = override?.capacity ?? dayDefault;
      const booked = unitsByDate.get(date) ?? 0;
      const tone = capacity === 0 ? ' bk-day--closed' : override ? ' bk-day--adjusted' : booked > 0 ? ' bk-day--booked' : ' bk-day--quiet';
      if (override || capacity === 0) flagged += 1;
      const selected = date === editDate;
      if (selected) containsSelected = true;
      // A changed fleet default is the "new normal" — no warning tint, but do show the numbers.
      // Labelled "units" so this reads unambiguously against fleet capacity, not a booking count.
      const load = booked > 0 || override || dayDefault !== context.config.fleet.defaultCapacity
        ? `<span class="bk-day-load">${escapeHtml(formatMessage(messages['admin.unitsLoad'], { booked, capacity }))}</span>`
        : '';
      const title = override?.reason ? ` title="${escapeHtml(override.reason)}"` : '';
      // data-* carries each day's effective values so the enhancer can prefill the form without a
      // page load; the href stays as the no-JS path.
      const dayData = ` data-date="${date}" data-capacity="${capacity}"${override?.reason ? ` data-reason="${escapeHtml(override.reason)}"` : ''}`;
      return `<a class="bk-day${tone}${selected ? ' bk-day--selected' : ''}"${selected ? ' aria-current="date"' : ''} href="?${dayParams}#bk-override" aria-label="${escapeHtml(formatDayDate(date, locale))}"${title}${dayData}>`
        + `<span class="bk-day-num">${Number(date.slice(8, 10))}</span>${load}</a>`;
    }).join('');
    const grid = `<div class="bk-monthgrid">${header}${blanks}${cells}</div>`;
    // Near months stay expanded; later mostly-quiet months collapse so ~90 day cells don't all
    // compete at once. A collapsed month auto-opens when it holds signal (adjusted/closed days or
    // the day being edited), so disclosure never hides anything the operator needs to see.
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

  // The hidden date field keeps the selected day when filters are (re)applied — the two workflows
  // share one URL, so neither form may silently drop the other's state.
  const clearParams = new URLSearchParams();
  if (editDate) clearParams.set('date', editDate);
  const clearHref = `${clearParams.size ? `?${clearParams}` : context.routeConfig.paths.adminPage}#bk-bookings`;
  const filterActions = `<div class="bk-filter-actions"><button type="submit" class="bk-btn bk-btn--secondary">${escapeHtml(messages['admin.apply'])}</button>`
    + (filters.q || filters.status ? `<a class="bk-filter-clear" href="${escapeHtml(clearHref)}">${escapeHtml(messages['admin.clearFilters'])}</a>` : '')
    + `</div>`;
  const filterForm = `<form method="get" class="bk-filters" role="search">`
    + (editDate ? `<input type="hidden" name="date" value="${escapeHtml(editDate)}">` : '')
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.search'])}</span><input class="bk-input" type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="${escapeHtml(messages['admin.searchPlaceholder'])}"></label>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.filterStatus'])}</span><select class="bk-select" name="status">${statusOptions}</select></label>`
    + filterActions + `</form>`;

  const resultsBadge = formatMessage(messages[filtered.length === 1 ? 'admin.resultsOne' : 'admin.results'], { n: filtered.length });
  const bookingsSection = `<section class="bk-admin-panel" id="bk-bookings"><header class="bk-section-head"><h2>${escapeHtml(messages['admin.bookings'])}</h2><span class="bk-badge">${escapeHtml(resultsBadge)}</span></header>`
    + filterForm
    + (filtered.length === 0
      ? `<div class="bk-empty-state"><p>${escapeHtml(messages['admin.noBookings'])}</p></div>`
      : `<div class="bk-table-wrap"><table class="bk-table"><thead><tr><th>${escapeHtml(messages['common.date'])}</th><th>${escapeHtml(messages['common.customer'])}</th><th>${escapeHtml(messages['common.tour'])}</th><th>${escapeHtml(messages['common.pickup'])}</th><th>${escapeHtml(messages['common.status'])}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`)
    + `</section>`;

  // Row "Edit" links land here with ?date=…, prefilling the form with that day's current values —
  // the whole edit flow stays plain GET/POST, no script.
  const editOverride = editDate ? overridesByDate.get(editDate) : undefined;
  const editDefault = defaultCapacityForDate(editDate || fromDate, context.config.fleet.defaultCapacity, capacityDefaults);
  // Explicit post-save confirmation inside whichever form was just submitted — the POST redirects
  // back with saved=day|default plus a hash so the operator lands on the form and sees it.
  const savedAlert = (which: string): string => saved === which
    ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['admin.saved'])}</p>`
    : '';
  // Per-day booking summaries, display-ready (times/labels formatted server-side so the enhancer
  // renders them without duplicating locale logic). Small: admin only lists upcoming bookings.
  const byStart = (a: Booking, b: Booking): number => a.startsAt.localeCompare(b.startsAt);
  const daySummaries: Record<string, Array<Record<string, string>>> = {};
  for (const [date, list] of bookingsByDate) {
    daySummaries[date] = [...list].sort(byStart).map((entry) => {
      const tone = statusToneOf(entry.status);
      // BK-SEC-002 (patch-11-r1 LOW 1): omitted (not a dead-link href) when the token isn't
      // presentable — admin-enhancer.ts renders the "unavailable" fallback when `u` is absent.
      const manageHref = manageLinkHref(managePagePath, entry.operatorToken);
      return {
        t: formatDayTime(entry.startsAt),
        c: entry.customerName ?? entry.customerEmail ?? '—',
        p: peopleText(entry.people),
        s: messages[`status.${entry.status}` as keyof typeof messages] ?? entry.status,
        ...(tone ? { sc: tone } : {}),
        ...(manageHref ? { u: manageHref } : {}),
      };
    });
  }
  // Strings + day data the admin enhancer needs at runtime, shipped as a non-executable JSON
  // island (same CSP-safe pattern as the manage page's reschedule island).
  const adminIsland = `<script type="application/json" data-bookkit-i18n>${JSON.stringify({
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
    const manageHref = manageLinkHref(managePagePath, entry.operatorToken);
    const manageMarkup = manageHref
      ? `<a href="${escapeHtml(manageHref)}">${escapeHtml(messages['admin.manage'])}</a>`
      : `<span class="bk-sub">${escapeHtml(messages['admin.manageUnavailable'])}</span>`;
    return `<li><span class="bk-mono">${escapeHtml(formatDayTime(entry.startsAt))}</span> <strong>${escapeHtml(entry.customerName ?? entry.customerEmail ?? '—')}</strong>`
      + `<span class="bk-sub">${escapeHtml(peopleText(entry.people))}</span>${statusBadge(entry.status, messages)}`
      + `${manageMarkup}</li>`;
  };
  const editDayBookings = editDate ? [...bookingsByDate.get(editDate) ?? []].sort(byStart) : [];
  const dayDetail = `<div class="bk-day-detail" data-bookkit-day-detail>`
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
    // role="status" makes this an accessible live region: once the enhancer (src/ui/
    // admin-enhancer.ts) starts rewriting this text on selection changes, a screen reader
    // announces "N days selected" etc. without focus ever needing to move there. Inert without
    // JS — a static heading whose text only ever changes via a full page reload.
    + `<h2 data-bookkit-day-title role="status">${escapeHtml(editDate ? formatDayDate(editDate, locale) : messages['admin.overrideTitle'])}</h2>`
    + savedAlert('day')
    + dayDetail
    + `<p class="bk-hint">${escapeHtml(messages['admin.overrideHint'])} ${escapeHtml(formatMessage(messages['admin.overrideDefault'], { n: editDefault }))}</p>`
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
    + `</div></form>`;

  // Fleet-level changes ("a van broke down") apply from a date onwards, so operators never
  // click 30 day cells one by one. Each scheduled change can be removed independently.
  const defaultEntries = capacityDefaults.map((entry) =>
    `<li><span>${escapeHtml(formatMessage(messages['admin.defaultEntry'], { n: entry.capacity, date: formatDayDate(entry.fromDate, locale) }))}`
    + (entry.reason ? `<span class="bk-sub">${escapeHtml(entry.reason)}</span>` : '')
    + `</span><form method="post">${csrfField}<input type="hidden" name="date" value="${escapeHtml(entry.fromDate)}">`
    + `<button type="submit" class="bk-btn bk-btn--secondary bk-btn--sm" name="action" value="default-clear">${escapeHtml(messages['admin.remove'])}</button></form></li>`).join('');
  // The fleet-default form is the rare, high-blast-radius task, so it sits behind a collapsed
  // disclosure — one visible form (the day exception) instead of two near-identical ones. It must
  // be open after its own POST so the saved confirmation is visible; the scheduled-change count in
  // the summary keeps active rules discoverable while collapsed.
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

  const legend = `<span class="bk-badge bk-badge--danger">${escapeHtml(messages['widget.closed'])}</span> `
    + `<span class="bk-badge bk-badge--warn">${escapeHtml(messages['admin.stateOverride'])}</span>`;
  const daysSection = `<section class="bk-admin-panel" id="bk-days"><header class="bk-section-head bk-section-head--availability"><div><h2>${escapeHtml(messages['admin.days'])}</h2>`
    + `<p class="bk-hint">${escapeHtml(messages['admin.daysHint'])}</p></div><p class="bk-legend">${legend}</p></header>`
    + `<div class="bk-days-layout"><div class="bk-months">${monthGrids}</div><aside class="bk-day-editor" aria-label="${escapeHtml(messages['admin.overrideTitle'])}">${overrideForm}${defaultForm}</aside></div>`
    + `</section>`;

  const confirmedCount = bookings.filter((booking) => booking.status === 'confirmed').length;
  const holdCount = bookings.filter((booking) => booking.status === 'hold').length;
  const metric = (label: string, value: number, tone = ''): string => `<div class="bk-stat${tone}"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  const stats = `<dl class="bk-admin-stats">${metric(messages['admin.metricUpcoming'], bookings.length)}${metric(messages['admin.metricConfirmed'], confirmedCount)}${metric(messages['admin.metricHolds'], holdCount)}${metric(messages['admin.metricAttention'], openIncidentCount, openIncidentCount ? ' bk-stat--attention' : '')}</dl>`;
  const adminHeader = `<header class="bk-admin-header"><div><p class="bk-eyebrow">${escapeHtml(messages['admin.workspace'])}</p><h1>${escapeHtml(messages['admin.title'])}</h1><p class="bk-lead">${escapeHtml(messages['admin.pageHint'])}</p></div></header>`;
  const sectionNav = adminSectionNav(messages, Boolean(incidentsHtml), openIncidentCount);

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
    body: `${adminHeader}${stats}<div class="bk-admin-body">${sectionNav}<div class="bk-admin-stack">${incidentsHtml}${bookingsSection}${daysSection}</div></div>`,
  });
}
