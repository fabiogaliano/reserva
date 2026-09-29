import type { OpsHealthSecurity } from '../../core/api.js';
import type { Booking, BookingStatus, DisputeStatus } from '../../core/booking.js';
import { adminLocaleFor, meetingPointForBooking, metadataRowsForBooking, pickupOptionFor, pickupPresentationFor, resolveLocalizedText, resolveService, resolveServiceTitle, type MetadataRow, type ResolvedServiceConfig } from '../../core/config.js';
import { formatLocaleFor } from '../../core/locale.js';
import { defaultCapacityForDate, type CapacityDefault } from '../../core/occupancy.js';
import { addDaysToDateKey, enumerateDateKeys, localDateKey, parseUtcInstant } from '../../core/time.js';
import type { ReservaContext } from '../../context.js';
import { escapeHtml } from '../../http.js';
import { ownerFacingIncidentTitle } from '../../reconciliation-helpers.js';
import { isManageableToken, type OperationalIncidentRecord } from '../../repo.js';
import type { ReservaResolvedRouteConfig } from '../../routes-manifest.js';
import { cssAssetHref, jsAssetHref } from '../asset-hrefs.js';
import { formatDayDate, formatPrice } from '../format.js';
import { digitsOf, emailLink, factList, pageShell, phoneLinks, statusToneOf, themeToggle } from '../layout.js';
import { formatMessage, resolveMessages } from '../messages.js';
import { dateTimeFormat, relativeTimeFormat } from '../../core/intl.js';

type Messages = ReturnType<typeof resolveMessages>;

export type AdminWindow = 'upcoming' | 'past';

// 'active' is the default and never appears in a URL; 'all' is every status in the window.
export type AdminStatusFilter = BookingStatus | 'active' | 'all';

export interface AdminFilters {
  when: AdminWindow;
  q: string;
  status: AdminStatusFilter;
  page: number;
}

// One page of the bookings list, already windowed, filtered and sorted by the handler.
export interface AdminBookingList {
  rows: Booking[];
  total: number;
  page: number;
  pageSize: number;
  // Set when a search stopped at its scan cap, so `total` counts only the rows it looked at.
  searchScanLimit: number | null;
  // Rows per status in the current window, for the status chips. Null while a search is active:
  // the counts would then have to come from the same in-memory scan as the list itself.
  statusCounts: Record<BookingStatus, number> | null;
}

export interface AdminDayLoad {
  // The most capacity units in use at any one instant of the day — what checkout's capacity
  // guard compares against, unlike a daily sum.
  peak: number;
  bookings: number;
}

export interface AdminCalendar {
  // Today; days before it render as past.
  fromDate: string;
  // The last day the calendar shows, and the first (today, or the first of a later month).
  toDate: string;
  windowFrom: string;
  // Where the earlier/later links page to (YYYY-MM), or null at either end of the horizon.
  prevMonth: string | null;
  nextMonth: string | null;
  overrides: Awaited<ReturnType<ReservaContext['repo']['listDayOverrides']>>;
  capacityDefaults: CapacityDefault[];
  load: ReadonlyMap<string, AdminDayLoad>;
  // Live bookings for the day panel. Complete for every date before `detailBefore`; from that date
  // on the panel links to the server-rendered day instead (null: complete for the whole range).
  dayBookings: Booking[];
  detailBefore: string | null;
  // The selected day's own bookings, fetched separately so they never depend on the cap above.
  editDayBookings: Booking[];
}

// The totals strip above the tabs. Times are UTC instants; null means "none" (or, for the two
// first-departure times, not known because the day fell past the day-detail cap).
export interface AdminGlance {
  nextToday: string | null;
  firstTomorrow: string | null;
  holds: number;
  holdsExpireFirst: string | null;
}

// What the banner above the tabs says about open incidents. `first` is set only when exactly one
// is open, so the banner can name it instead of counting.
export interface AdminAttention {
  count: number;
  actionRequired: boolean;
  first: { title: string; booking: Booking | null } | null;
}

export interface AdminErrorNotice {
  code: string;
  field: string;
}

export type AdminTab = 'upcoming' | 'availability' | 'tags' | 'attention';

export const adminTabs: readonly AdminTab[] = ['upcoming', 'availability', 'tags', 'attention'];

export interface TagOverviewRow {
  value: string;
  label: string;
  link: string | null;
  upcoming: number;
  past: number;
}

export interface TagOverviewField {
  key: string;
  label: string;
  rows: TagOverviewRow[];
}

// Every select field an operator asked to see as a tag, once per key however many services declare
// it, with its options labelled in the admin locale.
export function adminTaggedFields(config: ReservaContext['config']): Array<{ key: string; label: string; link: string | undefined; options: Map<string, string> }> {
  const locale = adminLocaleFor(config);
  const fields = new Map<string, { key: string; label: string; link: string | undefined; options: Map<string, string> }>();
  for (const service of Object.values(config.services)) {
    for (const field of service.metadataFields ?? []) {
      if (!field.adminBadge || field.type !== 'select') continue;
      const entry = fields.get(field.key)
        ?? { key: field.key, label: resolveLocalizedText(field.label, locale, config.locales.default), link: field.adminOptionLink, options: new Map<string, string>() };
      for (const option of field.options ?? []) {
        if (!entry.options.has(option.value)) entry.options.set(option.value, resolveLocalizedText(option.label, locale, config.locales.default));
      }
      fields.set(field.key, entry);
    }
  }
  return [...fields.values()];
}

// Configured options first, in config order and even with no bookings yet; then any value still on
// bookings after its option was removed, under its raw value, so a payout round never loses one.
export function buildTagOverview(
  fields: ReturnType<typeof adminTaggedFields>,
  counts: ReadonlyArray<ReadonlyArray<{ value: string; upcoming: number; past: number }>>,
): TagOverviewField[] {
  return fields.map((field, index) => {
    const byValue = new Map((counts[index] ?? []).map((count) => [count.value, count] as const));
    const rows: TagOverviewRow[] = [...field.options].map(([value, label]) => ({
      value,
      label,
      link: field.link ? field.link.replaceAll('{value}', encodeURIComponent(value)) : null,
      upcoming: byValue.get(value)?.upcoming ?? 0,
      past: byValue.get(value)?.past ?? 0,
    }));
    for (const count of counts[index] ?? []) {
      if (!field.options.has(count.value)) rows.push({ value: count.value, label: count.value, link: null, upcoming: count.upcoming, past: count.past });
    }
    return { key: field.key, label: field.label, rows };
  });
}

// The statuses the list filter offers, in the order an operator reaches for them.
export const adminStatusFilters: readonly BookingStatus[] = ['confirmed', 'hold', 'expired', 'cancelled', 'no_show'];
// What the list opens on: bookings that are going ahead, may still be paid for, or already happened.
// An expired hold is an abandoned checkout and a cancellation already reached the operator by
// email, so both would bury the day's real bookings if shown by default; All still lists them.
export const adminActiveStatuses: readonly BookingStatus[] = ['confirmed', 'hold', 'no_show'];

// Mirrors the server's refusal in handleAdminPost: there is no operation to re-run for these, so a
// Retry button would only ever come back "unavailable".
export function incidentRetryAvailable(incident: Pick<OperationalIncidentRecord, 'sourceType' | 'bookingId'>): boolean {
  return incident.sourceType !== 'oversell'
    && incident.sourceType !== 'payment_verification'
    && incident.sourceType !== 'reconciliation'
    && incident.bookingId !== null;
}

// Field names come back through the URL, so only a plain key-path shape is ever echoed.
const ERROR_FIELD_PATTERN = /^[\w.:-]{1,200}$/;

export function adminErrorAlert(
  messages: Messages,
  error: AdminErrorNotice | null,
  fieldLabel: (field: string) => string | undefined,
): string {
  if (!error) return '';
  let text: string;
  if (error.code === 'csrf_expired') text = messages['admin.errorExpired'];
  else if (error.code === 'not_found') text = messages['admin.errorNotFound'];
  else if (error.code === 'validation_failed') {
    const field = ERROR_FIELD_PATTERN.test(error.field) ? error.field : '';
    text = field ? formatMessage(messages['admin.errorInvalidField'], { field: fieldLabel(field) ?? field }) : messages['admin.errorInvalid'];
  } else text = messages['admin.errorGeneric'];
  return `<p class="bk-alert bk-alert--danger" role="alert">${escapeHtml(text)}</p>`;
}

const icon = (body: string, size = 16, className = ''): string =>
  `<svg${className ? ` class="${className}"` : ''} aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const icons = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
};

const chevronIcon = `<svg class="bk-booking-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${icons.chevron}</svg>`;

// The operator surfaces have two destinations, so they sit in one dark bar across the top rather
// than a column of chrome beside every page. The dashboard link carries the open-incident count,
// so it stays visible from Settings too.
export function adminTopbar(context: ReservaContext, messages: Messages, active: 'admin' | 'settings', openIncidentCount: number): string {
  const adminPath = escapeHtml(context.routeConfig.paths.adminPage);
  const link = (href: string, iconBody: string, label: string, isActive: boolean, extra = ''): string =>
    `<a href="${href}"${isActive ? ' aria-current="page"' : ''}>${icon(iconBody)} ${escapeHtml(label)}${extra}</a>`;
  const count = openIncidentCount > 0
    ? ` <span class="bk-topbar-count" aria-hidden="true">${openIncidentCount}</span><span class="bk-sr-only">(${escapeHtml(attentionCountText(messages, openIncidentCount))})</span>`
    : '';
  const links = link(adminPath, icons.dashboard, messages['admin.navOverview'], active === 'admin', count)
    + link(`${adminPath}?view=settings`, icons.settings, messages['admin.settings'], active === 'settings');
  return `<p class="bk-topbar-brand"><span>${escapeHtml(context.config.business.name)}</span></p>`
    + `<nav class="bk-topbar-nav" aria-label="${escapeHtml(messages['admin.navigation'])}">${links}</nav>`;
}

function attentionCountText(messages: Messages, count: number): string {
  return formatMessage(count === 1 ? messages['admin.attentionCountOne'] : messages['admin.attentionCount'], { n: count });
}

// The meeting-point label the bookings list displays — '' when none. Shared with the search
// haystack so search only matches visible text. `resolveService` throws for a serviceSlug no
// longer in the live config; degrade to no label rather than 500 the whole admin page.
function adminMeetingPointSubLabel(config: ReservaContext['config'], booking: Booking): string {
  try {
    const service = resolveService(config, booking.serviceSlug);
    const presentation = pickupPresentationFor(service, booking);
    if (!presentation?.usesMeetingPoint || (service.location?.meetingPoints?.length ?? 0) <= 1) return '';
    // The operator's own locale, not the customer's: this is the admin's view of the booking.
    return meetingPointForBooking(service, booking.meetingPointId, booking.meetingPointLabel, adminLocaleFor(config), config.locales.default).label;
  } catch {
    return '';
  }
}

// Every declared field the booking has a value for, customer-visible or operator-only, labelled in
// the operator's locale. Shared by the row, its tags and the search, so all three name a value the
// same way. A service no longer declared leaves nothing to label the values with.
function adminMetadataRows(config: ReservaContext['config'], booking: Booking): MetadataRow[] {
  try {
    return metadataRowsForBooking(resolveService(config, booking.serviceSlug), booking.metadata, adminLocaleFor(config), config.locales.default);
  } catch {
    return [];
  }
}

// The status and time window are SQL predicates; only the free-text search runs here, because it
// matches config-resolved text no query can see.
export function matchesAdminSearch(booking: Booking, q: string, config: ReservaContext['config']): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  // adminMeetingPointSubLabel is exactly what the row displays, so a hidden meeting point can
  // never make a booking match.
  // Metadata is operator-declared per service (booth number, flight code…), so whatever an
  // operator put there is exactly what they will later search the dashboard for. A select is
  // stored as its option code but shown by its label, and either one finds it.
  const metadataValues = [
    ...Object.values(booking.metadata ?? {}).map((value) => (value === null || value === undefined ? '' : String(value))),
    ...adminMetadataRows(config, booking).map((row) => String(row.value)),
  ];
  const phone = booking.customerPhone ?? '';
  const haystack = [booking.reference, resolveServiceTitle(config, booking.serviceSlug, adminLocaleFor(config)), booking.pickupType, booking.pickupAddress ?? '', adminMeetingPointSubLabel(config, booking), booking.customerName ?? '', booking.customerEmail ?? '', phone, ...metadataValues].join(' ').toLowerCase();
  if (haystack.includes(needle)) return true;
  // A phone reaches the operator over the phone, written however the caller reads it out, so the
  // search compares digits only: '+351 912 345 678' and '912345678' find the same booking.
  const needleDigits = digitsOf(needle);
  const phoneDigits = digitsOf(phone);
  return needleDigits.length >= 3 && phoneDigits.includes(needleDigits);
}

// Shared by every manage-link render site: returns null for a non-presentable token or a
// disabled manage route, so every caller renders the same "unavailable" fallback.
export function manageLinkHref(routeConfig: ReservaResolvedRouteConfig, token: string): string | null {
  if (!routeConfig.groups.manage) return null;
  return isManageableToken(token) ? `${routeConfig.paths.managePage}?token=${encodeURIComponent(token)}` : null;
}

// "12 minutes ago" rather than a timestamp: how long something has been broken is what makes it
// urgent. The unit grows with the distance so a week-old incident doesn't read in minutes.
function relativeTime(iso: string, now: Date, locale: string): string {
  const seconds = (parseUtcInstant(iso).getTime() - now.getTime()) / 1000;
  const format = relativeTimeFormat(formatLocaleFor(locale), { numeric: 'auto' });
  const distance = Math.abs(seconds);
  if (distance < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (distance < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}

// "Today", "Tomorrow", "Yesterday" for the three days an operator thinks of by name; '' otherwise.
function relativeDayLabel(date: string, today: string, locale: string): string {
  const offset = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (Math.abs(offset) > 1) return '';
  const label = relativeTimeFormat(formatLocaleFor(locale), { numeric: 'auto' }).format(offset, 'day');
  return label.charAt(0).toLocaleUpperCase(formatLocaleFor(locale)) + label.slice(1);
}

function formatLongDate(date: string, locale: string): string {
  return dateTimeFormat(formatLocaleFor(locale), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

// Shared by the bookings list and the day card: the time as the operator reads a departure board,
// with no leading zero and the day period set smaller so the digits line up down the column.
function timeFormatting(locale: string, timezone: string): { text: (iso: string) => string; html: (iso: string) => string } {
  const formatter = dateTimeFormat(formatLocaleFor(locale), { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  return {
    text: (iso) => formatter.format(parseUtcInstant(iso)),
    html: (iso) => formatter.formatToParts(parseUtcInstant(iso))
      .map((part) => part.type === 'dayPeriod' ? `<small>${escapeHtml(part.value)}</small>` : escapeHtml(part.value)).join(''),
  };
}

// The guest figure a row shows. A service that collects the exact headcount sells places "up to" a
// party size, so its `quantity` is a pricing tier; until the payer states the real number, the row
// says it is an upper bound rather than passing the tier off as a headcount.
function guestFigure(config: ReservaContext['config'], booking: Booking, messages: Messages): { value: string; label: string } {
  const people = (n: number): string => formatMessage(n === 1 ? messages['widget.person'] : messages['widget.quantityCount'], { n });
  if (booking.guestCount !== null) {
    const exact = booking.guestCount === 1 ? messages['admin.guestCountOne'] : formatMessage(messages['admin.guestCount'], { n: booking.guestCount });
    return { value: String(booking.guestCount), label: exact };
  }
  let collects = false;
  try {
    collects = resolveService(config, booking.serviceSlug).collectGuestCount === true;
  } catch {
    collects = false;
  }
  if (!collects) return { value: String(booking.quantity), label: people(booking.quantity) };
  const upTo = formatMessage(messages['admin.guestsUpTo'], { n: booking.quantity });
  return { value: `≤${booking.quantity}`, label: upTo };
}

function guestsMarkup(figure: { value: string; label: string }): string {
  return `<span class="bk-booking-guests" title="${escapeHtml(figure.label)}">${icon(icons.users, 14)}<span aria-hidden="true">${escapeHtml(figure.value)}</span><span class="bk-sr-only">${escapeHtml(figure.label)}</span></span>`;
}

// Hidden until the enhancer confirms the clipboard is reachable; a copy button that cannot copy
// would be the one dead control on the page.
function copyButton(value: string, label: string, copiedLabel: string): string {
  // Both icons ship in the markup: the enhancer only toggles a class, and the swap to a checkmark
  // plus the "Copied" bubble are what tell the operator the click did something.
  return `<button type="button" class="bk-copy" data-reserva-copy="${escapeHtml(value)}" data-copied="${escapeHtml(copiedLabel)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" hidden>${icon(icons.copy, 14, 'bk-copy-icon')}${icon(icons.check, 14, 'bk-copy-check')}</button>`;
}

// Sits above the incident cards in the "Attention" panel: an off security layer is silent by
// design at runtime, so the dashboard is the only place an operator finds out.
export function securityWarningsSection(
  messages: Messages,
  security: OpsHealthSecurity,
): string {
  const warnings: string[] = [];
  if (security.csrfTokenLayer === 'off') warnings.push(messages['admin.securityCsrfOff']);
  if (security.tokenEncryption === 'off') warnings.push(messages['admin.securityTokenEncOff']);
  if (warnings.length === 0) return '';
  return `<section id="bk-security" class="bk-card bk-alert bk-alert--warn" role="status">`
    + `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
    + `</section>`;
}

// The "Attention" panel: open incident cards, each saying what broke, which booking it touched and
// what to do about it, with CSRF-protected retry/resolve actions and a technical-details
// disclosure, then the 30-day history. Never renders a Retry button the server would refuse (see
// incidentRetryAvailable).
export function incidentsSection(
  context: ReservaContext,
  messages: Messages,
  openIncidents: OperationalIncidentRecord[],
  // The real open count; `openIncidents` is a bounded page of it.
  openIncidentTotal: number,
  resolvedIncidents: OperationalIncidentRecord[],
  counts: { opened: number; resolved: number },
  // Token-hydrated, so a card can link straight to the booking's manage page.
  bookingById: Map<string, Booking>,
  csrfToken: string | undefined,
  saved: string,
): string {
  // An all-clear dashboard needs no incident UI; the panel becomes useful only after an
  // incident opens and remains visible while there is open work or 30-day history to review.
  if (openIncidents.length === 0 && counts.opened === 0 && counts.resolved === 0) return '';

  const locale = adminLocaleFor(context.config);
  const timezone = context.config.business.timezone;
  const now = context.clock();
  const time = timeFormatting(locale, timezone);
  const catalog = messages as Record<string, string>;
  const csrfField = `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`;
  // The retry POST reports what actually happened, so a retry that changed nothing must not read
  // like a success: only an incident that closed gets the ok tone.
  const savedNotice: Record<string, { key: keyof typeof messages; tone: string }> = {
    'incident-resolved': { key: 'admin.incidentResolved', tone: 'ok' },
    'incident-retry-failed': { key: 'admin.incidentRetryFailed', tone: 'warn' },
    'incident-retry-unavailable': { key: 'admin.incidentRetryNotAvailable', tone: 'warn' },
  };
  const notice = savedNotice[saved];
  const savedAlert = notice
    ? `<p class="bk-alert bk-alert--${notice.tone}" role="status">${escapeHtml(messages[notice.key])}</p>`
    : '';
  const hiddenSource = (incident: OperationalIncidentRecord): string =>
    `<input type="hidden" name="source_type" value="${escapeHtml(incident.sourceType)}">`
    + `<input type="hidden" name="source_key" value="${escapeHtml(incident.sourceKey)}">`;
  // A deployment-wide incident (reconciliation) carries no booking, and a booking deleted since has
  // nothing left to show but its id.
  const aboutLine = (incident: OperationalIncidentRecord): string => {
    if (incident.bookingId === null) return '';
    const booking = bookingById.get(incident.bookingId);
    if (!booking) return `<p class="bk-incident-about"><span class="bk-mono">${escapeHtml(incident.bookingId)}</span></p>`;
    const when = `${formatDayDate(localDateKey(booking.startsAt, timezone), locale, now)}, ${time.text(booking.startsAt)}`;
    const detail = [resolveServiceTitle(context.config, booking.serviceSlug, locale), when, guestFigure(context.config, booking, messages).label].join(' · ');
    const href = manageLinkHref(context.routeConfig, booking.operatorToken);
    return `<p class="bk-incident-about"><span class="bk-mono">${escapeHtml(booking.reference)}</span>`
      + (booking.customerName || booking.customerEmail ? `<span>${escapeHtml(booking.customerName ?? booking.customerEmail ?? '')}</span>` : '')
      + `<span class="bk-sub">${escapeHtml(detail)}</span>`
      + (href ? `<a class="bk-link" href="${escapeHtml(href)}">${escapeHtml(messages['admin.openBooking'])} ${icon(icons.arrow, 13)}</a>` : '')
      + `</p>`;
  };
  const cards = openIncidents.map((incident) => {
    const title = ownerFacingIncidentTitle(incident.action);
    const severityLabel = incident.severity === 'action_required' ? messages['admin.incidentSeverityActionRequired'] : messages['admin.incidentSeverityDelayed'];
    const severityTone = incident.severity === 'action_required' ? ' bk-badge--danger' : ' bk-badge--warn';
    const detected = formatMessage(messages['admin.incidentDetected'], { when: relativeTime(incident.firstDetectedAt, now, locale) });
    const attempts = incident.attemptCount > 0
      ? ` · ${formatMessage(incident.attemptCount === 1 ? messages['admin.incidentAttemptsOne'] : messages['admin.incidentAttempts'], { n: incident.attemptCount })}`
      : '';
    const exactly = dateTimeFormat(formatLocaleFor(locale), { dateStyle: 'full', timeStyle: 'short', timeZone: timezone }).format(parseUtcInstant(incident.firstDetectedAt));
    const todo = catalog[`admin.incidentTodo.${incident.action}`];
    const canRetry = incidentRetryAvailable(incident);
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
      + `<button type="submit" class="bk-btn bk-btn--sm" name="action" value="incident-resolve">${escapeHtml(messages['admin.incidentResolveSubmit'])}</button></form>`;
    const details = `<details class="bk-disclosure bk-disclosure--bare"><summary>${escapeHtml(messages['admin.incidentDetails'])}</summary><div>`
      + `<p class="bk-mono bk-sub">${escapeHtml(incident.action)} · ${escapeHtml(incident.sourceType)} · attempt ${incident.attemptCount}</p>`
      + `</div></details>`;
    return `<li class="bk-card bk-incident-card">`
      + `<h3>${escapeHtml(title)} <span class="bk-badge${severityTone}">${escapeHtml(severityLabel)}</span>`
      + `<span class="bk-incident-when" title="${escapeHtml(exactly)}">${escapeHtml(detected + attempts)}</span></h3>`
      + aboutLine(incident)
      + (todo ? `<p class="bk-incident-todo">${escapeHtml(todo)}</p>` : '')
      + `<div class="bk-incident-foot">${details}<div class="bk-actions">${retryForm}${resolveForm}</div></div>`
      + `</li>`;
  }).join('');

  const historyItems = resolvedIncidents.map((incident) => {
    const reference = incident.bookingId === null
      ? incident.sourceType
      : bookingById.get(incident.bookingId)?.reference ?? incident.bookingId;
    const resolution = incident.resolutionKind === 'manual'
      ? formatMessage(messages['admin.incidentHistoryManual'], { who: incident.resolvedBy ?? '' })
      : messages['admin.incidentHistoryAutomatic'];
    return `<li><span class="bk-mono">${escapeHtml(reference)}</span> — ${escapeHtml(ownerFacingIncidentTitle(incident.action))}`
      + `<span class="bk-sub">${escapeHtml(resolution)}</span></li>`;
  }).join('');
  // The 30-day counts are history, not news, so they ride on the history disclosure's summary
  // rather than sitting above the cards that need action now.
  const countsLine = formatMessage(messages['admin.incidentCounts30d'], { opened: counts.opened, resolved: counts.resolved });
  const history = `<details class="bk-disclosure" id="bk-incidents-history">`
    + `<summary>${escapeHtml(messages['admin.incidentHistory'])}<span class="bk-disclosure-meta">${escapeHtml(countsLine)}</span></summary><div>`
    + (historyItems ? `<ul class="bk-incident-history">${historyItems}</ul>` : `<p class="bk-hint">${escapeHtml(messages['admin.incidentHistoryNone'])}</p>`)
    + `</div></details>`;

  const truncatedLine = openIncidentTotal > openIncidents.length
    ? `<p class="bk-hint">${escapeHtml(formatMessage(messages['admin.incidentsTruncated'], { shown: openIncidents.length, total: openIncidentTotal }))}</p>`
    : '';

  return `<section id="bk-incidents">`
    + savedAlert
    + truncatedLine
    + (cards ? `<ul class="bk-incident-list">${cards}</ul>` : `<p class="bk-lead">${escapeHtml(messages['admin.incidentsNone'])}</p>`)
    + history
    + `</section>`;
}

export interface AdminPageInput {
  list: AdminBookingList;
  filters: AdminFilters;
  calendar: AdminCalendar;
  // The ?date the operator asked for ('' when none): it rides along in every link the page builds.
  // The day card shows it, or today when it is empty.
  editDate: string;
  saved: string;
  error: AdminErrorNotice | null;
  // undefined when CSRF isn't configured — the field below renders empty and verification is a
  // no-op on the POST side.
  csrfToken: string | undefined;
  incidentsHtml: string;
  attention: AdminAttention;
  glance: AdminGlance;
  activeTab: AdminTab;
  tagOverview: TagOverviewField[];
}

// Every link the dashboard generates is rebuilt from this state, never copied from the request
// URL, so one-shot parameters (saved, error) never ride along into the next page.
function adminStateParams(filters: AdminFilters, options: { page?: number; date?: string; tab: AdminTab }): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.when === 'past') params.set('when', 'past');
  if (filters.q) params.set('q', filters.q);
  if (filters.status !== 'active') params.set('status', filters.status);
  const page = options.page ?? filters.page;
  if (page > 1) params.set('page', String(page));
  if (options.date) params.set('date', options.date);
  params.set('tab', options.tab);
  return params;
}

const adminFieldMessageKeys: Record<string, 'admin.capacity' | 'common.date' | 'admin.overrideTo' | 'admin.reason' | 'admin.incidentResolveNoteLabel'> = {
  capacity: 'admin.capacity',
  date: 'common.date',
  toDate: 'admin.overrideTo',
  reason: 'admin.reason',
  note: 'admin.incidentResolveNoteLabel',
};

// The load bar's fill, in tenths: a class hook rather than a width, because a style attribute is
// blocked under the strict style-src CSP. Any load at all shows at least one tenth.
function meterFill(peak: number, capacity: number): number {
  if (capacity <= 0 || peak <= 0) return 0;
  return Math.min(10, Math.max(1, Math.round((peak / capacity) * 10))) * 10;
}

function meterMarkup(peak: number, capacity: number, className = 'bk-meter'): string {
  return `<span class="${className}${peak >= capacity && capacity > 0 ? ' bk-meter--full' : ''}" data-fill="${meterFill(peak, capacity)}" aria-hidden="true"><i></i></span>`;
}

// A tag or badge ahead of the status in a row's status slot: its text, its bk-badge modifier and
// its hover title. Short keys because the day panel's JSON island carries it per booking, and the
// enhancer rebuilds the same markup from it.
interface AdminRowBadge {
  t: string;
  m?: 'field' | 'warn' | 'danger';
  h?: string;
}

function rowBadgeMarkup(badge: AdminRowBadge): string {
  return `<span class="bk-badge${badge.m ? ` bk-badge--${badge.m}` : ''}"${badge.h ? ` title="${escapeHtml(badge.h)}"` : ''}>${escapeHtml(badge.t)}</span>`;
}

export function adminPage(context: ReservaContext, input: AdminPageInput): string {
  const { list, filters, calendar, editDate, saved, csrfToken, incidentsHtml, attention, glance, activeTab } = input;
  const { fromDate, toDate, overrides, capacityDefaults } = calendar;
  const locale = adminLocaleFor(context.config);
  const messages = resolveMessages(context.config, locale);
  const timezone = context.config.business.timezone;
  // The render clock, not the host's: formatDayDate names the year only when it differs from
  // "now", and a test or a replayed request must see the same dates the request's clock implies.
  const now = context.clock();
  const time = timeFormatting(locale, timezone);
  const bookingCountText = (n: number): string =>
    formatMessage(n === 1 ? messages['admin.bookingCountOne'] : messages['admin.bookingCount'], { n });
  const serviceOf = (booking: Booking): ResolvedServiceConfig | undefined => {
    // resolveService throws for a renamed/removed serviceSlug; degrade to undefined rather than
    // 500 the row — every gate below falls back to the pickupType-keyed check.
    try {
      return resolveService(context.config, booking.serviceSlug);
    } catch {
      return undefined;
    }
  };
  const isVoid = (booking: Booking): boolean => booking.status === 'cancelled' || booking.status === 'expired';
  // Confirmed is the expected state and reads as noise on every row, so only the states an
  // operator might act on get a badge. A hold is the one with a deadline of its own: it releases
  // the spot unattended, so its badge carries the expiry.
  const statusMarkup = (booking: Booking): string => {
    if (booking.status === 'confirmed') return '';
    const label = messages[`status.${booking.status}` as keyof typeof messages] ?? booking.status;
    const text = booking.status === 'hold' && booking.holdExpiresAt
      ? `${label} · ${formatMessage(messages['admin.holdUntil'], { time: time.text(booking.holdExpiresAt) })}`
      : label;
    const tone = statusToneOf(booking.status);
    return `<span class="bk-badge${tone ? ` bk-badge--${tone}` : ''}">${escapeHtml(text)}</span>`;
  };
  // In the booking's own currency, so a later change to business.currency never re-denominates money already taken.
  const formatAmount = (booking: Booking, amountMinor: number): string => formatPrice(amountMinor, locale, booking.currency);
  // A won dispute kept the money, so only open and lost ones carry the danger tone.
  const disputeBadges: Record<DisputeStatus, AdminRowBadge> = {
    open: { t: messages['admin.disputeOpen'], m: 'danger' },
    won: { t: messages['admin.disputeWon'] },
    lost: { t: messages['admin.disputeLost'], m: 'danger' },
  };
  const disputeFactKeys: Record<DisputeStatus, 'admin.disputeOpenSince' | 'admin.disputeWonOpened' | 'admin.disputeLostOpened'> = {
    open: 'admin.disputeOpenSince',
    won: 'admin.disputeWonOpened',
    lost: 'admin.disputeLostOpened',
  };
  // What precedes the status in a row, in one order for the list and the day panel: the fields the
  // operator opted to see at a glance (declaration order), then what happened to the money.
  const leadingBadges = (booking: Booking, metadataRows: MetadataRow[]): AdminRowBadge[] => {
    const tagged = new Set((serviceOf(booking)?.metadataFields ?? []).filter((field) => field.adminBadge === true).map((field) => field.key));
    const badges: AdminRowBadge[] = metadataRows
      .filter((row) => tagged.has(row.key))
      .map((row) => ({ t: String(row.value), m: 'field', h: row.label }));
    if (booking.amountRefundedMinor > 0) {
      badges.push({ t: formatMessage(messages['admin.refundedBadge'], { amount: formatAmount(booking, booking.amountRefundedMinor) }), m: 'warn' });
    }
    if (booking.disputeStatus) badges.push(disputeBadges[booking.disputeStatus]);
    return badges;
  };

  // A booking row states what an operator scans by — when, who, what, where, how many — and keeps
  // reference, contact details and money inside the disclosure, where they are one click away on
  // the one booking in twenty that needs them.
  const bookingRow = (booking: Booking): string => {
    const who = booking.customerName ?? booking.customerEmail ?? '—';
    const rowService = serviceOf(booking);
    const serviceLabel = resolveServiceTitle(context.config, booking.serviceSlug, locale);
    const option = rowService ? pickupOptionFor(rowService, booking.pickupType) : undefined;
    // Gate on the row's own data, not config — a location-less booking (pickupType null) shows no
    // pickup. A stored id the service no longer declares has nothing left to name it but itself.
    const pickupLabel = booking.pickupType === null
      ? ''
      : option
        ? (option.label ? resolveLocalizedText(option.label, locale, context.config.locales.default) : messages['pickup.meetingPoint'])
        : booking.pickupType;
    // Ids are opaque, so the address row keys off the resolved option's own flag; an unknown option
    // shows the raw id and no address.
    const requiresAddress = option?.requiresAddress ?? false;
    const meetingPointLabel = adminMeetingPointSubLabel(context.config, booking);
    // The summary names one place: the meeting point when there is a choice of them, otherwise the
    // pickup option itself. The exact street address stays in the disclosure.
    const place = meetingPointLabel || pickupLabel;
    const summaryParts = [serviceLabel, place].filter(Boolean);
    // No row action on terminal rows: "Manage" would open a page with no actions left.
    const isTerminal = isVoid(booking) || booking.status === 'no_show';
    const manageHref = isTerminal ? null : manageLinkHref(context.routeConfig, booking.operatorToken);
    const manageMarkup = isTerminal
      ? ''
      : manageHref
        ? `<div class="bk-row-actions"><a class="bk-btn bk-btn--secondary bk-btn--sm bk-booking-open" href="${escapeHtml(manageHref)}">${escapeHtml(messages['admin.manageBooking'])} ${icon(icons.arrow, 14)}</a></div>`
        : `<div class="bk-row-actions"><span class="bk-sub bk-booking-open">${escapeHtml(messages['admin.manageUnavailable'])}</span></div>`;
    const facts: Array<[string, string]> = [[messages['common.reference'], `<span class="bk-mono">${escapeHtml(booking.reference)}</span>${copyButton(booking.reference, messages['admin.copyReference'], messages['admin.copied'])}`]];
    // Reaching the customer is the reason this disclosure gets opened at all, so the details are
    // one tap rather than a copy-paste into another app — and one click into the clipboard for the
    // mail client that isn't the default one.
    if (booking.customerEmail) facts.push([messages['common.email'], `${emailLink(booking.customerEmail)}${copyButton(booking.customerEmail, messages['admin.copyEmail'], messages['admin.copied'])}`]);
    if (booking.customerPhone) facts.push([messages['common.phone'], phoneLinks(booking.customerPhone, messages)]);
    facts.push([messages['common.price'], escapeHtml(formatAmount(booking, booking.priceMinor))]);
    // Every declared field, whoever else may see it: a terminal row has no Manage link, so this
    // is the only place its values can be read. Boolean copy matches the manage page's.
    const metadataRows = adminMetadataRows(context.config, booking);
    for (const row of metadataRows) {
      const value = typeof row.value === 'boolean' ? (row.value ? messages['admin.on'] : messages['admin.off']) : String(row.value);
      facts.push([row.label, escapeHtml(value)]);
    }
    if (booking.amountRefundedMinor > 0) facts.push([messages['admin.refunded'], escapeHtml(formatAmount(booking, booking.amountRefundedMinor))]);
    if (booking.disputeStatus) {
      const opened = booking.disputedAt ? formatDayDate(localDateKey(booking.disputedAt, timezone), locale, now) : null;
      const outcome = opened
        ? formatMessage(messages[disputeFactKeys[booking.disputeStatus]], { date: opened })
        : disputeBadges[booking.disputeStatus].t;
      facts.push([messages['admin.dispute'], escapeHtml(outcome)]);
    }
    if (requiresAddress && booking.pickupAddress) facts.push([messages['common.pickupAddress'], escapeHtml(booking.pickupAddress)]);
    if (meetingPointLabel && pickupLabel) facts.push([messages['common.pickup'], escapeHtml(pickupLabel)]);
    facts.push([messages['admin.bookedOn'], escapeHtml(formatDayDate(localDateKey(booking.createdAt, timezone), locale, now))]);
    return `<details class="bk-booking${isVoid(booking) ? ' bk-booking--void' : ''}">`
      + `<summary>`
      + `<span class="bk-booking-time">${time.html(booking.startsAt)}</span>`
      + `<span><span class="bk-booking-who">${escapeHtml(who)}</span><span class="bk-booking-sub">${escapeHtml(summaryParts.join(' · '))}</span></span>`
      + guestsMarkup(guestFigure(context.config, booking, messages))
      + `<span class="bk-booking-status">${leadingBadges(booking, metadataRows).map(rowBadgeMarkup).join('')}${statusMarkup(booking)}</span>`
      + chevronIcon
      + `</summary>`
      + `<div class="bk-booking-detail">${factList(facts)}${manageMarkup}</div>`
      + `</details>`;
  };

  const byStart = (a: Booking, b: Booking): number => a.startsAt.localeCompare(b.startsAt);
  // Grouping by day gives the list its only headings; without them a flat list of times reads as
  // one undifferentiated column. The rows arrive in the window's own order (Past runs newest
  // first), so grouping keeps that order rather than re-sorting.
  const groupByDay = (rows: Booking[]): Array<[string, Booking[]]> => {
    const groups = new Map<string, Booking[]>();
    for (const booking of rows) {
      const date = localDateKey(booking.startsAt, timezone);
      const existing = groups.get(date);
      if (existing) existing.push(booking);
      else groups.set(date, [booking]);
    }
    return [...groups];
  };
  // A day heading names the day the way an operator says it ("Tomorrow") and counts what is going
  // ahead, keeping cancelled and expired rows out of that figure. No guest total: a party size can
  // be a pricing tier rather than a headcount, so a sum of them would overstate the day.
  const dayHeading = (date: string, rows: Booking[]): string => {
    const relative = relativeDayLabel(date, fromDate, locale);
    const absolute = formatDayDate(date, locale, now);
    const live = rows.filter((row) => !isVoid(row)).length;
    const cancelled = rows.filter((row) => row.status === 'cancelled').length;
    const expired = rows.filter((row) => row.status === 'expired').length;
    const totals = [
      live > 0 ? bookingCountText(live) : '',
      cancelled > 0 ? formatMessage(messages['admin.dayCancelled'], { n: cancelled }) : '',
      expired > 0 ? formatMessage(messages['admin.dayExpired'], { n: expired }) : '',
    ].filter(Boolean).join(' · ');
    return `<h3>${relative ? `<span class="bk-day-rel">${escapeHtml(relative)}</span><span class="bk-day-abs">${escapeHtml(absolute)}</span>` : `<span class="bk-day-rel">${escapeHtml(absolute)}</span>`}`
      + `<span class="bk-day-totals">${escapeHtml(totals)}</span></h3>`;
  };
  const bookingList = groupByDay(list.rows).map(([date, rows]) =>
    `<div class="bk-daygroup">${dayHeading(date, rows)}${rows.map(bookingRow).join('')}</div>`).join('');

  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));
  const bookingsByDate = new Map<string, Booking[]>();
  for (const booking of calendar.dayBookings) {
    const date = localDateKey(booking.startsAt, timezone);
    const rows = bookingsByDate.get(date);
    if (rows) rows.push(booking);
    else bookingsByDate.set(date, [booking]);
  }
  const loadOn = (date: string): AdminDayLoad => calendar.load.get(date) ?? { peak: 0, bookings: 0 };
  const defaultOn = (date: string): number => defaultCapacityForDate(date, context.config.capacity.default, capacityDefaults);
  const capacityOn = (date: string): number => overridesByDate.get(date)?.capacity ?? defaultOn(date);
  const dayLoad = (date: string, capacity: number): string => {
    const load = loadOn(date);
    return formatMessage(messages['admin.dayLoad'], { peak: load.peak, capacity, bookings: bookingCountText(load.bookings) });
  };

  // --- totals strip: how busy the next days are, without counting rows ---
  const tomorrow = addDaysToDateKey(fromDate, 1);
  const weekDates = enumerateDateKeys(fromDate, addDaysToDateKey(fromDate, 6)).filter((date) => date <= toDate);
  const weekBookings = weekDates.reduce((sum, date) => sum + loadOn(date).bookings, 0);
  const busiest = weekDates.reduce<string | null>((best, date) => (loadOn(date).bookings > (best ? loadOn(best).bookings : 0) ? date : best), null);
  const dayHref = (date: string): string => `?${adminStateParams(filters, { date, tab: 'availability' })}#bk-override`;
  const glanceCard = (href: string, label: string, value: string, sub: string, tone = ''): string =>
    `<a href="${escapeHtml(href)}"${tone ? ` data-tone="${tone}"` : ''}><span class="bk-glance-label">${escapeHtml(label)}</span>`
    + `<span class="bk-glance-value">${escapeHtml(value)}</span><span class="bk-glance-sub">${escapeHtml(sub)}</span></a>`;
  const todayBookings = loadOn(fromDate).bookings;
  const todaySub = todayBookings === 0
    ? messages['admin.glanceNothing']
    : glance.nextToday ? formatMessage(messages['admin.glanceNext'], { time: time.text(glance.nextToday) }) : messages['admin.glanceDone'];
  const tomorrowBookings = loadOn(tomorrow).bookings;
  const tomorrowSub = tomorrowBookings === 0
    ? messages['admin.glanceNothing']
    : glance.firstTomorrow ? formatMessage(messages['admin.glanceFirst'], { time: time.text(glance.firstTomorrow) }) : '';
  const holdsHref = `?${new URLSearchParams({ status: 'hold', tab: 'upcoming' })}#bk-upcoming`;
  const glanceStrip = `<div class="bk-glance" data-reserva-tab-only="upcoming"${currentTabFor(activeTab, incidentsHtml, input.tagOverview.length > 0) === 'upcoming' ? '' : ' hidden'}>`
    + glanceCard(dayHref(fromDate), messages['admin.glanceToday'], bookingCountText(todayBookings), todaySub)
    + glanceCard(dayHref(tomorrow), messages['admin.glanceTomorrow'], bookingCountText(tomorrowBookings), tomorrowSub)
    + glanceCard(`?${new URLSearchParams({ tab: 'upcoming' })}#bk-upcoming`, messages['admin.glanceWeek'], bookingCountText(weekBookings),
      busiest ? formatMessage(messages['admin.glanceBusiest'], { day: formatDayDate(busiest, locale, now) }) : messages['admin.glanceNothing'])
    + glanceCard(holdsHref, messages['admin.glanceHolds'], String(glance.holds),
      glance.holdsExpireFirst ? formatMessage(messages['admin.glanceHoldsExpire'], { time: time.text(glance.holdsExpireFirst) }) : messages['admin.glanceHoldsNone'],
      glance.holds > 0 ? 'warn' : '')
    + `</div>`;

  // --- availability calendar ---
  // A month grid rather than a day-per-row list: an operator's mental model of availability is a
  // calendar. The first grid starts on this week's Monday so it never opens as a lone row of
  // today; the days already gone stay as plain numbers, since nothing about them can change.
  const dowLabels = Array.from({ length: 7 }, (_, index) =>
    // 2024-01-01 is a Monday; formatting it +index yields locale weekday names, Monday-first.
    dateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index))));
  const windowFrom = calendar.windowFrom;
  const weekStart = addDaysToDateKey(windowFrom, -((new Date(`${windowFrom}T00:00:00Z`).getUTCDay() + 6) % 7));
  // Built once: every day link shares the page's filters and differs only in its date.
  const dayLinkBase = String(adminStateParams(filters, { tab: 'availability' }));
  const byMonth = new Map<string, string[]>();
  for (const date of enumerateDateKeys(weekStart, toDate)) {
    const month = date.slice(0, 7);
    const dates = byMonth.get(month);
    if (dates) dates.push(date);
    else byMonth.set(month, [date]);
  }
  const dayDate = editDate || fromDate;
  const monthGrids = [...byMonth.values()].map((dates, monthIndex) => {
    const first = new Date(`${dates[0]}T00:00:00Z`);
    const monthTitle = dateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
    const header = dowLabels.map((label) => `<span class="bk-dow">${escapeHtml(label)}</span>`).join('');
    const blanks = '<span class="bk-day bk-day--empty"></span>'.repeat((first.getUTCDay() + 6) % 7);
    let flagged = 0;
    let containsSelected = false;
    const cells = dates.map((date) => {
      const dayNumber = `<span class="bk-day-num">${Number(date.slice(8, 10))}</span>`;
      if (date < fromDate) return `<span class="bk-day bk-day--past">${dayNumber}</span>`;
      // Day links keep the active booking filters so selecting a day never resets the search.
      const override = overridesByDate.get(date);
      const capacity = capacityOn(date);
      const load = loadOn(date);
      const tone = capacity === 0 ? ' bk-day--closed' : override ? ' bk-day--adjusted' : load.bookings > 0 ? ' bk-day--booked' : '';
      if (override || capacity === 0) flagged += 1;
      const selected = date === dayDate;
      if (selected) containsSelected = true;
      // The cell shows the day and a load bar; the exact figures travel in its accessible name and
      // tooltip, and the day card spells them out once the day is selected.
      const stateWord = capacity === 0 ? messages['widget.closed'] : override ? messages['admin.stateOverride'] : load.bookings > 0 ? messages['admin.legendBooked'] : '';
      const loadText = load.bookings > 0 || capacity === 0 || override ? dayLoad(date, capacity) : '';
      const label = [formatDayDate(date, locale, now), stateWord, loadText].filter(Boolean).join(' — ');
      const tooltip = [override?.reason, loadText].filter(Boolean).join(' · ');
      const title = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
      // data-* carries each day's effective values so the enhancer can prefill the form without a
      // page load; the href stays as the no-JS path.
      const dayData = ` data-date="${date}" data-capacity="${capacity}"${override?.reason ? ` data-reason="${escapeHtml(override.reason)}"` : ''}`;
      return `<a class="bk-day${tone}${date === fromDate ? ' bk-day--today' : ''}${selected ? ' bk-day--selected' : ''}"${selected ? ' aria-current="date"' : ''} href="?${escapeHtml(`${dayLinkBase}&date=${date}`)}#bk-override" aria-label="${escapeHtml(label)}"${title}${dayData}>`
        + dayNumber + (capacity > 0 ? meterMarkup(load.peak, capacity) : '') + `</a>`;
    }).join('');
    const grid = `<div class="bk-monthgrid">${header}${blanks}${cells}</div>`;
    // Near months stay expanded; later mostly-quiet months collapse. A collapsed month auto-opens
    // when it holds signal (adjusted/closed days, or the day being edited).
    const monthKey = ` data-month="${dates[0]?.slice(0, 7) ?? ''}"`;
    if (monthIndex < 2) return `<div class="bk-month"${monthKey} data-label="${escapeHtml(monthTitle)}"><h3>${escapeHtml(monthTitle)}</h3>${grid}</div>`;
    const flaggedBadge = flagged > 0
      ? ` <span class="bk-badge bk-badge--warn">${escapeHtml(formatMessage(messages['admin.monthFlagged'], { n: flagged }))}</span>`
      : '';
    return `<details class="bk-month bk-disclosure"${monthKey} data-label="${escapeHtml(monthTitle)}"${flagged > 0 || containsSelected ? ' open' : ''}>`
      + `<summary>${escapeHtml(monthTitle)}${flaggedBadge}</summary><div>${grid}</div></details>`;
  }).join('');

  // --- bookings toolbar: period switch, search, status chips ---
  // Every status a row can carry: 'expired' rows exist (a hold nobody paid) and were unreachable
  // from the filter, so the only way to see one was to know its reference.
  const statusFilterLabels: Record<AdminStatusFilter, string> = {
    active: messages['admin.filterActive'],
    all: messages['admin.filterAll'],
    confirmed: messages['admin.filterConfirmed'],
    hold: messages['admin.filterHold'],
    expired: messages['admin.filterExpired'],
    cancelled: messages['admin.filterCancelled'],
    no_show: messages['admin.filterNoShow'],
  };
  const listHref = (next: AdminFilters): string => `?${adminStateParams(next, { page: 1, date: editDate, tab: 'upcoming' })}#bk-upcoming`;
  const counts = list.statusCounts;
  const sumOf = (statuses: readonly BookingStatus[]): number => statuses.reduce((sum, status) => sum + (counts?.[status] ?? 0), 0);
  const chips = (['active', 'all', ...adminStatusFilters] as const).map((value) => {
    const count = counts
      ? (value === 'active' ? sumOf(adminActiveStatuses) : value === 'all' ? sumOf(adminStatusFilters) : counts[value])
      : null;
    const current = filters.status === value;
    return `<a class="bk-chip${count === 0 && !current ? ' bk-chip--empty' : ''}" href="${escapeHtml(listHref({ ...filters, status: value }))}"${current ? ' aria-current="true"' : ''}>`
      + `${escapeHtml(statusFilterLabels[value])}${count === null ? '' : ` <b>${count}</b>`}</a>`;
  }).join('');
  const periods = (['upcoming', 'past'] as const).map((value) =>
    `<a href="${escapeHtml(listHref({ ...filters, when: value }))}"${filters.when === value ? ' aria-current="true"' : ''}>${escapeHtml(messages[value === 'upcoming' ? 'admin.whenUpcoming' : 'admin.whenPast'])}</a>`).join('');
  // Both carry tab=upcoming explicitly: with a date in play the handler would otherwise infer the
  // availability tab and move the operator off the list they were filtering.
  const clearParams = new URLSearchParams();
  if (editDate) clearParams.set('date', editDate);
  clearParams.set('tab', 'upcoming');
  const clearHref = `?${clearParams}#bk-upcoming`;
  const filtersActive = Boolean(filters.q || filters.status !== 'active' || filters.when === 'past');
  // The period and status are links, so they apply on click; the search box submits on Enter,
  // carrying the rest of the state as hidden fields. No page field: a changed filter starts at 1.
  const filterForm = `<form method="get" class="bk-filterbar" role="search">`
    + `<input type="hidden" name="tab" value="upcoming">`
    + (editDate ? `<input type="hidden" name="date" value="${escapeHtml(editDate)}">` : '')
    + (filters.when === 'past' ? `<input type="hidden" name="when" value="past">` : '')
    + (filters.status !== 'active' ? `<input type="hidden" name="status" value="${escapeHtml(filters.status)}">` : '')
    + `<div class="bk-filterbar-row">`
    + `<nav class="bk-segmented" aria-label="${escapeHtml(messages['admin.whenLabel'])}">${periods}</nav>`
    + `<label class="bk-search">${icon(icons.search)}<span class="bk-sr-only">${escapeHtml(messages['admin.searchLabel'])}</span>`
    + `<input class="bk-input" type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="${escapeHtml(messages['admin.searchPlaceholder'])}" data-reserva-search>`
    + `<kbd class="bk-kbd" aria-hidden="true" hidden>/</kbd></label>`
    + `</div>`
    + `<nav class="bk-chips" aria-label="${escapeHtml(messages['common.status'])}">${chips}`
    + (filtersActive ? `<a class="bk-filter-clear" href="${escapeHtml(clearHref)}">${escapeHtml(messages['admin.clearFilters'])}</a>` : '')
    + `</nav></form>`;

  const pageHref = (page: number): string => `?${adminStateParams(filters, { page, date: editDate, tab: 'upcoming' })}#bk-upcoming`;
  const firstShown = (list.page - 1) * list.pageSize + 1;
  const lastShown = firstShown + list.rows.length - 1;
  const hasNext = lastShown < list.total;
  const pager = list.total > 0
    ? `<nav class="bk-actions" aria-label="${escapeHtml(messages['admin.pagination'])}">`
      + `<p class="bk-sub">${escapeHtml(formatMessage(messages['admin.pageRange'], { from: firstShown, to: lastShown, total: list.total }))}</p>`
      + (list.page > 1 ? `<a class="bk-btn bk-btn--secondary bk-btn--sm" rel="prev" href="${escapeHtml(pageHref(list.page - 1))}">${escapeHtml(messages['admin.pagePrev'])}</a>` : '')
      + (hasNext ? `<a class="bk-btn bk-btn--secondary bk-btn--sm" rel="next" href="${escapeHtml(pageHref(list.page + 1))}">${escapeHtml(messages['admin.pageNext'])}</a>` : '')
      + `</nav>`
    : '';
  const truncatedNote = list.searchScanLimit !== null
    ? `<p class="bk-hint">${escapeHtml(formatMessage(messages['admin.searchTruncated'], { n: list.searchScanLimit }))}</p>`
    : '';
  const emptyText = filters.q || (filters.status !== 'active' && filters.status !== 'all')
    ? messages['admin.noMatchingBookings']
    : filters.when === 'past' ? messages['admin.noPastBookings'] : messages['admin.noBookings'];
  const upcomingPanel = filterForm
    + truncatedNote
    + (list.rows.length === 0
      ? `<div class="bk-empty-state"><p>${escapeHtml(emptyText)}</p></div>`
      : bookingList + pager);

  // --- day card: the selected day's state, its bookings, and the controls that change it ---
  // Explicit post-save confirmation inside whichever form was just submitted — the POST redirects
  // back with saved=day|default plus a hash so the operator lands on the form and sees it.
  const savedAlert = (which: string): string => saved === which
    ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['admin.saved'])}</p>`
    : '';
  // Per-day booking rows, display-ready (times and labels formatted here so the enhancer renders
  // them without duplicating locale logic). Bounded by the handler's detail cap.
  const dayRow = (entry: Booking): { t: string; c: string; v: string; g: string; gl: string; b?: AdminRowBadge[]; s?: string; sc?: string; u?: string } => {
    const figure = guestFigure(context.config, entry, messages);
    const manageHref = manageLinkHref(context.routeConfig, entry.operatorToken);
    const tone = statusToneOf(entry.status);
    const badges = leadingBadges(entry, adminMetadataRows(context.config, entry));
    return {
      t: time.text(entry.startsAt),
      c: entry.customerName ?? entry.customerEmail ?? '—',
      v: resolveServiceTitle(context.config, entry.serviceSlug, locale),
      g: figure.value,
      gl: figure.label,
      ...(badges.length > 0 ? { b: badges } : {}),
      // Confirmed needs no badge; omitted keys keep the island small.
      ...(entry.status === 'confirmed' ? {} : { s: messages[`status.${entry.status}` as keyof typeof messages] ?? entry.status, ...(tone ? { sc: tone } : {}) }),
      // Omitted (not a dead-link href) when the token isn't presentable — the enhancer renders
      // the "unavailable" fallback when `u` is absent.
      ...(manageHref ? { u: manageHref } : {}),
    };
  };
  const daySummaries: Record<string, Array<ReturnType<typeof dayRow>>> = {};
  for (const [date, rows] of bookingsByDate) daySummaries[date] = [...rows].sort(byStart).map(dayRow);
  // Every calendar day's figures as [capacity, default, peak, bookings, adjusted, reason?], so a
  // client-side selection shows the same card the server would render for that day.
  const dayMeta: Record<string, Array<number | string>> = {};
  for (const date of enumerateDateKeys(windowFrom > fromDate ? windowFrom : fromDate, toDate)) {
    const override = overridesByDate.get(date);
    const load = loadOn(date);
    dayMeta[date] = [capacityOn(date), defaultOn(date), load.peak, load.bookings, override ? 1 : 0, ...(override?.reason ? [override.reason] : [])];
  }
  // Strings + day data the admin enhancer needs at runtime, shipped as a non-executable JSON
  // island (same CSP-safe pattern as the manage page's reschedule island).
  const adminIsland = `<script type="application/json" data-reserva-i18n>${JSON.stringify({
    locale: formatLocaleFor(locale),
    today: fromDate,
    selectedDays: messages['admin.selectedDays'],
    close: messages['admin.close'],
    closeMany: messages['admin.closeMany'],
    clearTo: messages['admin.clear'],
    clearMany: messages['admin.clearMany'],
    title: messages['admin.overrideTitle'],
    noBookings: messages['admin.dayNoBookings'],
    manage: messages['admin.manage'],
    manageUnavailable: messages['admin.manageUnavailable'],
    prevMonth: messages['admin.prevMonth'],
    nextMonth: messages['admin.nextMonth'],
    todayLabel: messages['admin.today'],
    selectHint: messages['admin.selectHint'],
    selectHintTouch: messages['admin.selectHintTouch'],
    dayOpen: messages['admin.dayOpen'],
    openBadge: messages['admin.dayOpenBadge'],
    adjustedBadge: messages['admin.dayAdjustedBadge'],
    closedBadge: messages['admin.dayClosedBadge'],
    closedReason: messages['admin.dayClosedReason'],
    peak: messages['admin.dayPeak'],
    bookingOne: messages['admin.bookingCountOne'],
    bookingMany: messages['admin.bookingCount'],
    reopenHint: messages['admin.reopenHint'],
    days: daySummaries,
    meta: dayMeta,
    detailBefore: calendar.detailBefore,
  }).replace(/</g, '\\u003c')}</script>`;

  const dayOverride = overridesByDate.get(dayDate);
  const dayDefault = defaultOn(dayDate);
  const dayCapacity = dayOverride?.capacity ?? dayDefault;
  const dayState = dayCapacity === 0 ? 'closed' : dayOverride ? 'adjusted' : 'open';
  const dayBadge = dayState === 'closed'
    ? `<span class="bk-badge bk-badge--danger" data-reserva-day-badge>${escapeHtml(dayOverride?.reason ? formatMessage(messages['admin.dayClosedReason'], { reason: dayOverride.reason }) : messages['admin.dayClosedBadge'])}</span>`
    : dayState === 'adjusted'
      ? `<span class="bk-badge bk-badge--warn" data-reserva-day-badge>${escapeHtml(formatMessage(messages['admin.dayAdjustedBadge'], { n: dayCapacity, d: dayDefault }))}</span>`
      : `<span class="bk-badge bk-badge--ok" data-reserva-day-badge>${escapeHtml(formatMessage(messages['admin.dayOpenBadge'], { n: dayCapacity }))}</span>`;
  const dayLoadNow = loadOn(dayDate);
  const loadLine = dayCapacity > 0
    ? `<div class="bk-loadline"><div class="bk-loadline-top"><span>${escapeHtml(formatMessage(messages['admin.dayPeak'], { peak: dayLoadNow.peak, capacity: dayCapacity }))}</span>`
      + `<span>${escapeHtml(bookingCountText(dayLoadNow.bookings))}</span></div>${meterMarkup(dayLoadNow.peak, dayCapacity, 'bk-meter bk-meter--bar')}</div>`
    : '';
  // The day panel answers "what does this day actually have" — rendered here for the no-JS path
  // and rebuilt client-side from the island on selection.
  const dayBookingItem = (entry: Booking): string => {
    const row = dayRow(entry);
    const manage = row.u
      ? `<a class="bk-link" href="${escapeHtml(row.u)}">${escapeHtml(messages['admin.manage'])}</a>`
      : `<span class="bk-sub">${escapeHtml(messages['admin.manageUnavailable'])}</span>`;
    return `<li><time>${escapeHtml(row.t)}</time><span><strong>${escapeHtml(row.c)}</strong><span class="bk-sub">${escapeHtml(row.v)}</span></span>`
      + guestsMarkup({ value: row.g, label: row.gl })
      + `<span class="bk-daylist-end">${(row.b ?? []).map(rowBadgeMarkup).join('')}${row.s ? `<span class="bk-badge${row.sc ? ` bk-badge--${row.sc}` : ''}">${escapeHtml(row.s)}</span>` : ''}${manage}</span></li>`;
  };
  const dayBookings = [...calendar.editDayBookings].sort(byStart);
  const dayDetail = `<div class="bk-day-detail" data-reserva-day-detail>${loadLine}`
    + (dayBookings.length
      ? `<ul class="bk-daylist">${dayBookings.map(dayBookingItem).join('')}</ul>`
      : `<p class="bk-hint">${escapeHtml(messages['admin.dayNoBookings'])}</p>`)
    + `</div>`;
  const relative = relativeDayLabel(dayDate, fromDate, locale);
  const csrfField = `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">`;
  const hiddenUnless = (visible: boolean): string => (visible ? '' : ' hidden');
  // The controls follow the day's state: a closed day offers Reopen and nothing to type; an
  // adjusted day offers its way back to the default; a plain day offers neither. The date comes
  // from the calendar selection, so it travels as a hidden field.
  const overrideForm = `<form method="post" id="bk-override" class="bk-daycard">${csrfField}${adminIsland}`
    + `<input type="hidden" name="date" value="${escapeHtml(dayDate)}">`
    + `<div class="bk-daycard-head"><div>`
    // The heading stays a heading; the enhancer announces selection changes through the separate
    // live region beside it, since a live region role would strip the heading from the outline.
    + `<h2 data-reserva-day-title>${escapeHtml(formatLongDate(dayDate, locale))}</h2>`
    + `<span class="bk-sub" data-reserva-day-rel${hiddenUnless(Boolean(relative))}>${escapeHtml(relative)}</span></div>${dayBadge}</div>`
    + `<p class="bk-sr-only" role="status" data-reserva-day-announce></p>`
    + `<div class="bk-daycard-body">`
    + savedAlert('day')
    + dayDetail
    + `<div class="bk-editrow" data-reserva-day-edit${hiddenUnless(dayState !== 'closed' || !dayOverride)}>`
    + `<div class="bk-field"><label for="bk-capacity">${escapeHtml(messages['admin.dayCapacity'])}</label>`
    // Required because a blank capacity is not "0": only Close closes a day, and it (like Reset)
    // skips validation so it never needs a capacity typed first.
    + `<span class="bk-stepper"><button type="button" data-step="-1" aria-label="${escapeHtml(messages['admin.stepDown'])}" hidden>−</button>`
    + `<input class="bk-input" id="bk-capacity" name="capacity" type="number" min="0" step="1" required value="${dayCapacity}">`
    + `<button type="button" data-step="1" aria-label="${escapeHtml(messages['admin.stepUp'])}" hidden>+</button></span></div>`
    + `<label class="bk-field bk-field--grow"><span>${escapeHtml(messages['admin.reasonOptional'])}</span><input class="bk-input" name="reason" value="${escapeHtml(dayOverride?.reason ?? '')}"></label>`
    // The no-JS bulk path: the POST expands the range server-side. The enhancer swaps it for
    // calendar multi-select.
    + `<label class="bk-field" data-reserva-to-date><span>${escapeHtml(messages['admin.overrideTo'])}</span><input class="bk-input" name="toDate" type="date"></label>`
    + `</div>`
    + `<div class="bk-editfoot" data-reserva-day-actions${hiddenUnless(dayState !== 'closed' || !dayOverride)}>`
    + `<button type="submit" class="bk-btn" name="action" value="set">${escapeHtml(messages['admin.save'])}</button>`
    + `<button type="submit" class="bk-btn bk-btn--outline-danger" name="action" value="close" formnovalidate>${escapeHtml(messages['admin.close'])}</button>`
    + `<button type="submit" class="bk-linkbtn" name="action" value="clear" formnovalidate data-reserva-day-reset${hiddenUnless(dayState === 'adjusted')}>${escapeHtml(formatMessage(messages['admin.clear'], { n: dayDefault }))}</button>`
    + `</div>`
    + `<div class="bk-editfoot" data-reserva-day-reopen${hiddenUnless(dayState === 'closed' && Boolean(dayOverride))}>`
    + `<button type="submit" class="bk-btn" name="action" value="clear" formnovalidate>${escapeHtml(messages['admin.reopen'])}</button>`
    + `<span class="bk-hint" data-reserva-day-reopen-hint>${escapeHtml(formatMessage(messages['admin.reopenHint'], { n: dayDefault }))}</span>`
    + `</div>`
    + `</div></form>`;

  // Capacity-level changes ("a van broke down") apply from a date onwards, so operators never
  // click 30 day cells one by one. Each scheduled change can be removed independently.
  const defaultEntryText = (entry: CapacityDefault): string =>
    formatMessage(messages['admin.defaultEntry'], { n: entry.capacity, date: formatDayDate(entry.fromDate, locale, now) });
  const defaultEntries = capacityDefaults.map((entry) =>
    `<li><span>${escapeHtml(defaultEntryText(entry))}`
    + (entry.reason ? `<span class="bk-sub">${escapeHtml(entry.reason)}</span>` : '')
    + `</span><form method="post">${csrfField}<input type="hidden" name="date" value="${escapeHtml(entry.fromDate)}">`
    + `<button type="submit" class="bk-btn bk-btn--secondary bk-btn--sm" name="action" value="default-clear">${escapeHtml(messages['admin.remove'])}</button></form></li>`).join('');
  // The capacity-default form is the rare, high-blast-radius task, so it sits behind a collapsed
  // disclosure. Opens after its own POST so the saved confirmation is visible; the summary names
  // what is already scheduled so active rules stay discoverable while collapsed.
  const scheduledMeta = capacityDefaults.length > 0 && capacityDefaults[0]
    ? `<span class="bk-disclosure-meta">${escapeHtml(`${formatMessage(messages['admin.defaultScheduled'], { n: capacityDefaults.length })} · ${defaultEntryText(capacityDefaults[0])}`)}</span>`
    : '';
  const defaultForm = `<details class="bk-disclosure" id="bk-default"${saved === 'default' ? ' open' : ''}>`
    + `<summary>${escapeHtml(messages['admin.defaultTitle'])}${scheduledMeta}</summary><div>`
    + `<form method="post" class="bk-day-form">${csrfField}`
    + savedAlert('default')
    + `<p class="bk-hint">${escapeHtml(messages['admin.defaultHint'])}</p>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.defaultFrom'])}</span><input class="bk-input" name="date" type="date" required></label>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.capacity'])}</span><input class="bk-input" name="capacity" type="number" min="0" required></label>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.reason'])}</span><input class="bk-input" name="reason"></label>`
    + `<div class="bk-actions"><button type="submit" class="bk-btn" name="action" value="default-set">${escapeHtml(messages['admin.save'])}</button></div></form>`
    + (defaultEntries ? `<ul class="bk-defaults">${defaultEntries}</ul>` : '')
    + `</div></details>`;

  // One line under the grid, drawn with the same marks the cells use.
  const legend = `<p class="bk-legend">`
    + `<span><i class="bk-legend-swatch"></i>${escapeHtml(messages['admin.legendLoad'])}</span>`
    + `<span><i class="bk-legend-swatch bk-legend-swatch--full"></i>${escapeHtml(messages['admin.legendFull'])}</span>`
    + `<span><i class="bk-legend-ring"></i>${escapeHtml(messages['admin.stateOverride'])}</span>`
    + `<span><i class="bk-legend-strike">12</i>${escapeHtml(messages['widget.closed'])}</span></p>`;
  const monthLink = (month: string | null, label: string): string => month
    ? `<a class="bk-link" href="?${escapeHtml(String(adminStateParams(filters, { tab: 'availability' })))}&amp;month=${month}">${escapeHtml(label)}</a>`
    : '';
  const monthNav = calendar.prevMonth || calendar.nextMonth
    ? `<nav class="bk-monthnav">${monthLink(calendar.prevMonth, messages['admin.calendarEarlier'])}${monthLink(calendar.nextMonth, messages['admin.calendarLater'])}</nav>`
    : '';
  const availabilityPanel = `<div class="bk-days-layout"><div class="bk-calendar"><div class="bk-months">${monthGrids}</div>${monthNav}${legend}</div>`
    + `<div class="bk-day-editor">${overrideForm}${defaultForm}</div></div>`;

  // --- page chrome: header, attention banner, tabs ---
  // The enhancer's in-place tab switch replaceState()s to these hrefs, so they must carry every
  // piece of list state or a switch would silently reset the list.
  const tabParams = (tab: AdminTab): string => `?${adminStateParams(filters, { date: editDate, tab })}`;
  const tagOverview = input.tagOverview;
  // One tagged field names its own tab ("Partner"); several share a generic one.
  const tabLabels: Record<AdminTab, string> = {
    upcoming: messages['admin.tabUpcoming'],
    availability: messages['admin.tabAvailability'],
    tags: tagOverview.length === 1 ? tagOverview[0]!.label : messages['admin.tabTags'],
    attention: messages['admin.tabAttention'],
  };
  const hasIncidents = Boolean(incidentsHtml);
  const visibleTabs: AdminTab[] = [
    'upcoming', 'availability',
    ...(tagOverview.length > 0 ? ['tags' as const] : []),
    ...(hasIncidents ? ['attention' as const] : []),
  ];
  // Each count opens the bookings list searched by the stored value, which the search matches.
  const tagCountLink = (value: string, count: number, when: 'upcoming' | 'past'): string => {
    if (count === 0) return '0';
    const params = new URLSearchParams({ q: value, tab: 'upcoming' });
    if (when === 'past') params.set('when', 'past');
    return `<a class="bk-link" href="?${escapeHtml(params.toString())}">${count}</a>`;
  };
  const tagsPanel = tagOverview.map((field) => {
    const rows = field.rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th>`
      + `<td>${row.link ? `<span class="bk-taglink"><a class="bk-link" href="${escapeHtml(row.link)}" rel="noopener" target="_blank">${escapeHtml(row.link)}</a>${copyButton(row.link, messages['admin.tagCopyLink'], messages['admin.copied'])}</span>` : ''}</td>`
      + `<td class="bk-num">${tagCountLink(row.value, row.upcoming, 'upcoming')}</td>`
      + `<td class="bk-num">${tagCountLink(row.value, row.past, 'past')}</td></tr>`).join('');
    const hasLinks = field.rows.some((row) => row.link);
    return `<section class="bk-tagsection"><h2>${escapeHtml(field.label)}</h2>`
      + `<table class="bk-tagtable"><thead><tr><th scope="col">${escapeHtml(field.label)}</th><th scope="col">${hasLinks ? escapeHtml(messages['admin.tagLink']) : ''}</th>`
      + `<th scope="col" class="bk-num">${escapeHtml(messages['admin.tagUpcoming'])}</th><th scope="col" class="bk-num">${escapeHtml(messages['admin.tagPast'])}</th></tr></thead>`
      + `<tbody>${rows}</tbody></table>`
      + `<p class="bk-hint">${escapeHtml(messages['admin.tagCountsHint'])}</p></section>`;
  }).join('');
  const currentTab = currentTabFor(activeTab, incidentsHtml, tagOverview.length > 0);
  const tabLink = (tab: AdminTab): string => {
    const count = tab === 'attention' && attention.count > 0
      ? ` <span class="bk-tab-count">${attention.count}</span>`
      : '';
    return `<a href="${escapeHtml(tabParams(tab))}" data-reserva-admin-tab="${tab}"${tab === currentTab ? ' aria-current="page"' : ''}>${escapeHtml(tabLabels[tab])}${count}</a>`;
  };
  const tabs = `<nav class="bk-tabs" aria-label="${escapeHtml(messages['admin.title'])}">${visibleTabs.map(tabLink).join('')}</nav>`;
  const panel = (tab: AdminTab, id: string, content: string): string =>
    `<section class="bk-panel" id="${id}"${tab === currentTab ? '' : ' hidden'}>${content}</section>`;

  // Names the problem and, for a single incident, the booking it touched, so the operator knows
  // whether to drop everything before opening the Attention tab. Hidden on that tab itself.
  const bannerText = (): string => {
    const first = attention.first;
    if (attention.count !== 1 || !first) return `<strong>${escapeHtml(attentionCountText(messages, attention.count))}</strong>`;
    const booking = first.booking;
    const about = booking
      ? ` · ${escapeHtml(formatMessage(messages['admin.bannerBooking'], { reference: booking.reference, when: `${formatDayDate(localDateKey(booking.startsAt, timezone), locale, now)}, ${time.text(booking.startsAt)}` }))}`
      : '';
    return `<strong>${escapeHtml(first.title)}</strong>${about}`;
  };
  const banner = attention.count > 0
    ? `<div class="bk-banner${attention.actionRequired ? '' : ' bk-banner--warn'}" role="status" data-reserva-tab-except="attention"${currentTab === 'attention' ? ' hidden' : ''}>`
      + `${icon(icons.alert, 18)}<p>${bannerText()}</p>`
      + `<a href="${escapeHtml(tabParams('attention'))}" data-reserva-attention-link>${escapeHtml(messages['admin.bannerReview'])}</a></div>`
    : '';
  const errorFieldLabel = (field: string): string | undefined => {
    const key = adminFieldMessageKeys[field];
    return key ? messages[key] : undefined;
  };
  const todayLong = dateTimeFormat(formatLocaleFor(locale), { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone }).format(now);
  const adminHeader = `<header class="bk-admin-header"><div><h1>${escapeHtml(messages['admin.title'])}</h1><p class="bk-admin-date">${escapeHtml(todayLong)}</p></div></header>`
    + adminErrorAlert(messages, input.error, errorFieldLabel);

  return pageShell({
    lang: locale,
    page: 'admin',
    title: `${messages['admin.title']} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss, context.config.ui?.branding),
    favicon: context.config.ui?.faviconUrl,
    headHtml: context.config.ui?.headHtml,
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    topbar: adminTopbar(context, messages, 'admin', attention.count),
    skipLabel: messages['common.skipContent'],
    theme: context.viewerTheme,
    themeToggle: themeToggle(messages, context.viewerTheme),
    body: `${adminHeader}${glanceStrip}${banner}${tabs}<div class="bk-panels">`
      + panel('upcoming', 'bk-upcoming', upcomingPanel)
      + panel('availability', 'bk-availability', availabilityPanel)
      + (tagOverview.length > 0 ? panel('tags', 'bk-tags', tagsPanel) : '')
      + (hasIncidents ? panel('attention', 'bk-attention', incidentsHtml) : '')
      + `</div>`,
  });
}

// `activeTab` is already narrowed by the caller, but a tab that no longer exists (the last incident
// cleared between the click and the render, a tagged field removed from config) must not leave
// every panel hidden.
function currentTabFor(activeTab: AdminTab, incidentsHtml: string, hasTags: boolean): AdminTab {
  if (activeTab === 'attention' && !incidentsHtml) return 'upcoming';
  if (activeTab === 'tags' && !hasTags) return 'upcoming';
  return activeTab;
}
