import { bookingStatuses, type Booking, type BookingStatus } from '../core/booking.js';
import { adminLocaleFor, type ResolvedClientConfig } from '../core/config.js';
import {
  getOccupancyIntervals,
  maxConcurrentOccupancy,
  type OccupancyBooking,
  type OccupancyInterval,
  type OccupancyService,
} from '../core/occupancy.js';
import {
  SettingParseError,
  SettingsMergeError,
  mergeAndValidateSettings,
  parseSettingForm,
  serializeSettingValue,
  settingDefinitionsFor,
  settingValuesEqual,
  type SettingValue,
} from '../core/settings.js';
import {
  addDaysToDateKey,
  enumerateDateKeys,
  localDateKey,
  localDayStartUtcIso,
  parseUtcInstant,
} from '../core/time.js';
import { adminOriginAllowed, mintAdminCsrfToken, verifyAdminCsrfToken } from '../admin-csrf.js';
import { accessAllowed } from '../admin-access.js';
import { retrySideEffectOperation } from '../confirmation.js';
import { dispatchSettingsChanged } from '../settings-events.js';
import type { SettingsChange } from '../core/events.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import { contentSecurityPolicyHeaders } from '../csp.js';
import type {
  AdminBookingWindow,
  OperationalIncidentSourceType,
  SettingsBatchOperation,
} from '../repo.js';
import { reprojectIncidentAfterAdminRetry, sideEffectIncidentSourceKey } from '../reconciliation.js';
import { attemptRefund } from '../refund-executor.js';
import { resolveMessages } from '../ui/messages.js';
import {
  adminActiveStatuses,
  adminPage,
  adminStatusFilters,
  adminTabs,
  adminTaggedFields,
  buildTagOverview,
  incidentRetryAvailable,
  incidentsSection,
  matchesAdminSearch,
  securityWarningsSection,
  type AdminBookingList,
  type AdminDayLoad,
  type AdminErrorNotice,
  type AdminFilters,
  type AdminGlance,
  type AdminTab,
} from '../ui/pages/admin-page.js';
import { ownerFacingIncidentTitle } from '../reconciliation-helpers.js';
import { securityPosture } from './ops-health.js';
import { settingsPage } from '../ui/pages/settings-page.js';
import {
  html,
  HttpError,
  parseDate,
  requestFormData,
  requireString,
} from '../http.js';
import { run, runAdminPost, sweepExpiredHoldsThrottled } from './shared.js';

const ADMIN_PAGE_SIZE = 50;
// The search matches against config-resolved text (service titles, meeting-point labels, digit-only
// phones), which no SQL predicate can express, so it walks the window+status set in chunks and
// filters each chunk in memory, counting every match and keeping only the requested page. The scan
// cap bounds a runaway walk on a very large deployment; when it cuts a search short the page says
// so, since the count then covers only the rows it looked at.
const ADMIN_SEARCH_CHUNK = 500;
const ADMIN_SEARCH_SCAN_LIMIT = 20_000;
// The calendar island carries a display-ready row per live booking for client-side day selection;
// past this many the remaining days link to their server-rendered panel instead of bloating the page.
const ADMIN_DAY_DETAIL_LIMIT = 500;
const ADMIN_SELECTED_DAY_LIMIT = 200;
const ADMIN_OPEN_INCIDENT_LIMIT = 100;
// Unpaid checkouts are short-lived and few, so the "awaiting payment" figure reads them directly.
const ADMIN_HOLD_SCAN_LIMIT = 200;

function adminFiltersFrom(url: URL): AdminFilters {
  const statusParam = url.searchParams.get('status')?.trim() ?? '';
  const pageParam = Number(url.searchParams.get('page') ?? '');
  return {
    when: url.searchParams.get('when') === 'past' ? 'past' : 'upcoming',
    q: url.searchParams.get('q')?.trim() ?? '',
    status: statusParam === 'all' || (bookingStatuses as readonly string[]).includes(statusParam)
      ? statusParam as BookingStatus | 'all'
      : 'active',
    page: Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1,
  };
}

function adminErrorFrom(url: URL): AdminErrorNotice | null {
  const code = url.searchParams.get('error');
  return code ? { code, field: url.searchParams.get('field') ?? '' } : null;
}

async function loadBookingList(context: ReservaContext, filters: AdminFilters, todayStart: string): Promise<AdminBookingList> {
  const period: AdminBookingWindow = filters.when === 'upcoming' ? { from: todayStart } : { before: todayStart };
  const statusWindow: Pick<AdminBookingWindow, 'status' | 'statuses'> = filters.status === 'all'
    ? {}
    : filters.status === 'active' ? { statuses: adminActiveStatuses } : { status: filters.status };
  const window: AdminBookingWindow = { ...period, ...statusWindow };
  const order = filters.when === 'upcoming' ? 'asc' : 'desc';
  const lastPageOf = (total: number): number => Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  if (!filters.q) {
    // The chips count the whole period, whichever status is selected, so switching to a status
    // never hides how many rows the others hold.
    const [total, perStatus] = await Promise.all([
      context.repo.countAdminBookings(window),
      Promise.all(adminStatusFilters.map((status) => context.repo.countAdminBookings({ ...period, status }))),
    ]);
    const statusCounts = Object.fromEntries(adminStatusFilters.map((status, index) => [status, perStatus[index] ?? 0])) as Record<BookingStatus, number>;
    const page = Math.min(filters.page, lastPageOf(total));
    const rows = total === 0
      ? []
      : await context.repo.listAdminBookings(window, { order, limit: ADMIN_PAGE_SIZE, offset: (page - 1) * ADMIN_PAGE_SIZE });
    return { rows, total, page, pageSize: ADMIN_PAGE_SIZE, searchScanLimit: null, statusCounts };
  }
  const scan = async (page: number): Promise<AdminBookingList> => {
    const offset = (page - 1) * ADMIN_PAGE_SIZE;
    const rows: Booking[] = [];
    let total = 0;
    let scanned = 0;
    let capped = false;
    for (;;) {
      const chunk = await context.repo.listAdminBookings(window, { order, limit: ADMIN_SEARCH_CHUNK, offset: scanned });
      for (const booking of chunk) {
        if (!matchesAdminSearch(booking, filters.q, context.config)) continue;
        if (total >= offset && rows.length < ADMIN_PAGE_SIZE) rows.push(booking);
        total += 1;
      }
      scanned += chunk.length;
      if (chunk.length < ADMIN_SEARCH_CHUNK) break;
      if (scanned >= ADMIN_SEARCH_SCAN_LIMIT) {
        capped = await context.repo.countAdminBookings(window) > scanned;
        break;
      }
    }
    return { rows, total, page, pageSize: ADMIN_PAGE_SIZE, searchScanLimit: capped ? ADMIN_SEARCH_SCAN_LIMIT : null, statusCounts: null };
  };
  const result = await scan(filters.page);
  // A page past the end (fewer matches than a stale link assumed) lands on the last real page.
  return filters.page > lastPageOf(result.total) ? scan(lastPageOf(result.total)) : result;
}

// Peak concurrent capacity units per local day, measured the way checkout's capacity guard
// measures a slot (turnaround included, a party split across seatsPerUnit), plus how many live
// bookings start that day.
export function calendarLoadByDate(
  config: ResolvedClientConfig,
  bookings: readonly OccupancyBooking[],
  fromDate: string,
  toDate: string,
  now: string,
): Map<string, AdminDayLoad> {
  const timezone = config.business.timezone;
  // A booking whose service has left the config still holds its place, as one unit with no
  // turnaround, rather than failing the whole calendar.
  const fallback: OccupancyService = { turnaroundMin: 0 };
  const intervals = getOccupancyIntervals({
    bookings,
    service: fallback,
    serviceResolver: (serviceSlug) => config.services[serviceSlug] ?? fallback,
    now,
  });
  const intervalsByDate = new Map<string, OccupancyInterval[]>();
  const startsByDate = new Map<string, number>();
  for (const interval of intervals) {
    const firstDate = localDateKey(interval.start, timezone);
    startsByDate.set(firstDate, (startsByDate.get(firstDate) ?? 0) + 1);
    // An interval running past midnight (its turnaround included) also loads the next day.
    const lastDate = localDateKey(new Date(parseUtcInstant(interval.end).getTime() - 1), timezone);
    for (const date of enumerateDateKeys(firstDate, lastDate)) {
      const dayIntervals = intervalsByDate.get(date);
      if (dayIntervals) dayIntervals.push(interval);
      else intervalsByDate.set(date, [interval]);
    }
  }
  const load = new Map<string, AdminDayLoad>();
  for (const date of enumerateDateKeys(fromDate, toDate)) {
    const dayIntervals = intervalsByDate.get(date);
    const peak = dayIntervals
      ? maxConcurrentOccupancy(dayIntervals, localDayStartUtcIso(date, timezone), localDayStartUtcIso(addDaysToDateKey(date, 1), timezone))
      : 0;
    load.set(date, { peak, bookings: startsByDate.get(date) ?? 0 });
  }
  return load;
}

function validDateOrEmpty(value: string): string {
  if (!value) return '';
  try {
    return parseDate(value, 'date');
  } catch {
    return '';
  }
}

export function handleAdminGet(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const access = await accessAllowed(request, context);
    if (!access) throw new HttpError(403, 'forbidden', 'Cloudflare Access authorization required');
    // Minted fresh per render and embedded as a hidden field in every admin form; handleAdminPost
    // verifies it against the same Access-authenticated subject.
    const csrfToken = await mintAdminCsrfToken(context, access.subject, context.clock().getTime());
    const url = new URL(request.url);
    const error = adminErrorFrom(url);
    if (url.searchParams.get('view') === 'settings') {
      const [storedRows, openIncidentCount] = await Promise.all([context.repo.listSettings(), context.repo.countOpenIncidents()]);
      return html(settingsPage(context, storedRows, url.searchParams.get('saved') === '1', url.searchParams.get('section') ?? '', csrfToken, error, openIncidentCount), 200, {
        ...contentSecurityPolicyHeaders(context.config),
        'cache-control': 'no-store',
        // Same referrer-policy reasoning as the dashboard response below.
        'referrer-policy': 'same-origin',
      });
    }
    const now = nowIso(context);
    await sweepExpiredHoldsThrottled(context, now);
    const timezone = context.config.business.timezone;
    const filters = adminFiltersFrom(url);
    const fromDate = localDateKey(now, timezone);
    const toDate = localDateKey(new Date(parseUtcInstant(now).getTime() + context.config.booking.maxHorizonDays * 86_400_000), timezone);
    // Upcoming starts at the business's midnight, not at `now`: a trip already under way is still
    // today's work (a no-show is marked once it has started), so it must not drop into Past.
    const todayStart = localDayStartUtcIso(fromDate, timezone);
    const horizonEnd = localDayStartUtcIso(addDaysToDateKey(toDate, 1), timezone);
    // A booking that started before today can still occupy today's first units.
    const lookbackMinutes = Math.max(0, ...Object.values(context.config.services).map((service) => service.durationMin + service.turnaroundMin));
    const occupancyFrom = new Date(parseUtcInstant(todayStart).getTime() - lookbackMinutes * 60_000).toISOString();
    const editDate = validDateOrEmpty(url.searchParams.get('date')?.trim() ?? '');
    // The day card always shows a day: the one asked for, or today.
    const dayDate = editDate || fromDate;
    const [list, occupancyBookings, detailRows, editDayBookings, overrides, capacityDefaults, holdRows] = await Promise.all([
      loadBookingList(context, filters, todayStart),
      // The calendar's own query: the whole horizon, independent of the list's window, filters and
      // page, so a day's load never depends on what the list happens to show.
      context.repo.listOccupancyBookings(occupancyFrom, horizonEnd),
      context.repo.listLiveBookings(todayStart, horizonEnd, now, ADMIN_DAY_DETAIL_LIMIT + 1),
      context.repo.listLiveBookings(localDayStartUtcIso(dayDate, timezone), localDayStartUtcIso(addDaysToDateKey(dayDate, 1), timezone), now, ADMIN_SELECTED_DAY_LIMIT),
      context.repo.listDayOverrides(fromDate, toDate),
      context.repo.listCapacityDefaults(),
      context.repo.listAdminBookings({ from: todayStart, status: 'hold' }, { order: 'asc', limit: ADMIN_HOLD_SCAN_LIMIT, offset: 0 }),
    ]);
    // Past the cap, the first date whose rows were cut off and every later one get no client-side
    // detail; days before it are complete, because rows arrive in start order.
    const cutoffRow = detailRows[ADMIN_DAY_DETAIL_LIMIT];
    const detailBefore = cutoffRow ? localDateKey(cutoffRow.startsAt, timezone) : null;
    const dayBookings = detailBefore === null
      ? detailRows
      : detailRows.slice(0, ADMIN_DAY_DETAIL_LIMIT).filter((booking) => localDateKey(booking.startsAt, timezone) < detailBefore);
    // Rows arrive in start order, so the first match is the earliest. A sweep that has not run yet
    // can leave a lapsed hold in 'hold', so the strip counts only holds still holding a place.
    const tomorrow = addDaysToDateKey(fromDate, 1);
    const liveHolds = holdRows.filter((booking) => booking.holdExpiresAt !== null && booking.holdExpiresAt > now);
    const glance: AdminGlance = {
      nextToday: dayBookings.find((booking) => localDateKey(booking.startsAt, timezone) === fromDate && booking.startsAt > now)?.startsAt ?? null,
      firstTomorrow: dayBookings.find((booking) => localDateKey(booking.startsAt, timezone) === tomorrow)?.startsAt ?? null,
      holds: liveHolds.length,
      holdsExpireFirst: liveHolds.map((booking) => booking.holdExpiresAt as string).sort()[0] ?? null,
    };
    // Token decryption is per-row AES-GCM, so it happens once, here, for exactly the rows the page
    // can emit a manage link for.
    const emitted = [...new Map(
      [...list.rows, ...dayBookings, ...editDayBookings].map((booking) => [booking.id, booking] as const),
    ).values()];
    const hydratedById = new Map((await context.repo.hydrateBookingTokens(emitted)).map((booking) => [booking.id, booking] as const));
    const withTokens = (rows: Booking[]): Booking[] => rows.map((booking) => hydratedById.get(booking.id) ?? booking);
    const saved = url.searchParams.get('saved') ?? '';
    // An explicit ?tab wins; otherwise the URL's own shape picks the panel, so a day link, a
    // capacity save and an incident action all land the operator where they just acted.
    const requestedTab = url.searchParams.get('tab')?.trim() ?? '';
    const activeTab: AdminTab = adminTabs.includes(requestedTab as AdminTab)
      ? requestedTab as AdminTab
      : saved.startsWith('incident-') ? 'attention'
      : editDate || saved === 'day' || saved === 'default' ? 'availability'
      : 'upcoming';
    const taggedFields = adminTaggedFields(context.config);
    const tagOverview = buildTagOverview(taggedFields, await Promise.all(taggedFields.map((field) => context.repo.countMetadataValues(field.key, now))));
    const messages = resolveMessages(context.config, adminLocaleFor(context.config));
    // incidentsSince is a fixed 30-day lookback from the render clock, not a config option.
    const incidentsSince = new Date(parseUtcInstant(now).getTime() - 30 * 86_400_000).toISOString();
    const [openIncidents, openIncidentCount, resolvedIncidents, incidentCounts] = await Promise.all([
      context.repo.listOpenIncidents(ADMIN_OPEN_INCIDENT_LIMIT),
      context.repo.countOpenIncidents(),
      context.repo.listRecentResolvedIncidents(incidentsSince, 20),
      context.repo.countIncidentsSince(incidentsSince),
    ]);
    // A deployment-wide incident (reconciliation) has no booking, so it contributes no lookup. Only
    // an open incident's card links to its booking, so only those rows pay for token decryption.
    const incidentBookingIds = [...new Set([...openIncidents, ...resolvedIncidents]
      .flatMap((incident) => (incident.bookingId === null ? [] : [incident.bookingId])))];
    const found = (await Promise.all(incidentBookingIds.map((id) => context.repo.getBookingById(id))))
      .filter((booking): booking is Booking => booking !== null);
    const openBookingIds = new Set(openIncidents.map((incident) => incident.bookingId));
    const hydratedIncidentBookings = await context.repo.hydrateBookingTokens(found.filter((booking) => openBookingIds.has(booking.id)));
    const bookingById = new Map<string, Booking>([...found, ...hydratedIncidentBookings].map((booking) => [booking.id, booking] as const));
    const incidentsHtml = securityWarningsSection(messages, await securityPosture(context))
      + incidentsSection(context, messages, openIncidents, openIncidentCount, resolvedIncidents, incidentCounts, bookingById, csrfToken, saved);
    const firstOpen = openIncidentCount === 1 ? openIncidents[0] : undefined;
    return html(adminPage(context, {
      list: { ...list, rows: withTokens(list.rows) },
      filters,
      calendar: {
        fromDate,
        toDate,
        overrides,
        capacityDefaults,
        load: calendarLoadByDate(context.config, occupancyBookings, fromDate, toDate, now),
        dayBookings: withTokens(dayBookings),
        detailBefore,
        editDayBookings: withTokens(editDayBookings),
      },
      editDate,
      saved,
      error,
      csrfToken,
      incidentsHtml,
      attention: {
        count: openIncidentCount,
        actionRequired: openIncidents.some((incident) => incident.severity === 'action_required'),
        first: firstOpen
          ? { title: ownerFacingIncidentTitle(firstOpen.action), booking: firstOpen.bookingId === null ? null : bookingById.get(firstOpen.bookingId) ?? null }
          : null,
      },
      glance,
      activeTab,
      tagOverview,
    }), 200, {
      ...contentSecurityPolicyHeaders(context.config),
      'cache-control': 'no-store',
      // `no-referrer` would null the Origin header on this page's own same-origin POSTs, tripping
      // Astro's checkOrigin default. `same-origin` avoids that while keeping the same token-leak protection.
      'referrer-policy': 'same-origin',
    });
  });
}

// The page a POST came from, minus the one-shot notices of an earlier round trip.
function adminReturnLocation(request: Request): URL {
  const location = new URL(request.url);
  for (const key of ['saved', 'error', 'field']) location.searchParams.delete(key);
  location.hash = '';
  return location;
}

function seeOther(location: URL): Response {
  return new Response(null, { status: 303, headers: { location: location.toString(), 'cache-control': 'no-store' } });
}

// Past the Access and origin gates, a failed action is an operator's mistake or a stale page, not
// an attack, so it goes back to the page it came from with a readable alert rather than raw JSON.
// A refused action wrote nothing: every action validates before its first write.
function adminErrorRedirect(request: Request, context: ReservaContext, form: FormData, action: string, failure: unknown): Response {
  const location = adminReturnLocation(request);
  let code: string;
  let field: string | undefined;
  if (failure === 'csrf_expired') {
    code = 'csrf_expired';
  } else if (failure instanceof HttpError && failure.status < 500) {
    code = failure.code;
    field = failure.details?.field;
  } else {
    code = 'internal_error';
    context.logger.error?.('reserva admin action failed', { action, error: failure instanceof Error ? failure.message : String(failure) });
  }
  location.searchParams.set('error', code);
  if (field) location.searchParams.set('field', field);
  if (action.startsWith('settings-')) {
    location.searchParams.set('view', 'settings');
    const section = form.get('section');
    if (typeof section === 'string' && section) location.searchParams.set('section', section);
  } else {
    location.searchParams.set('tab', action.startsWith('incident-') ? 'attention' : 'availability');
  }
  return seeOther(location);
}

// Number('') is 0, so a blank field would silently close the day; only the Close action means 0.
function capacityFrom(form: FormData): number {
  const raw = form.get('capacity');
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') throw new HttpError(400, 'validation_failed', 'capacity is required', { field: 'capacity' });
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(400, 'validation_failed', 'capacity must be an integer of at least 0', { field: 'capacity' });
  }
  return value;
}

// Saves and resets both run the whole merged config through validateConfig, since a reset can
// break a cross-field rule as easily as a save (clearing one side of a pair the other still needs).
function assertMergedSettingsValid(base: ResolvedClientConfig, rows: Record<string, string>): void {
  try {
    mergeAndValidateSettings(base, rows);
  } catch (error) {
    if (error instanceof SettingsMergeError) {
      const path = error.issues[0]?.path.join('.');
      throw new HttpError(400, 'validation_failed', error.message, path ? { field: path } : undefined);
    }
    throw error;
  }
}

export function handleAdminPost(request: Request, context: ReservaContext): Promise<Response> {
  return runAdminPost(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const access = await accessAllowed(request, context);
    if (!access) throw new HttpError(403, 'forbidden', 'Cloudflare Access authorization required');
    // Layer 1: Fetch-Metadata / Origin enforcement, wired only on this admin mutation route, never the public booking API.
    if (!adminOriginAllowed(request)) throw new HttpError(403, 'forbidden', 'Cross-origin admin requests are not allowed');
    const form = await requestFormData(request);
    const actionValue = form.get('action');
    const action = typeof actionValue === 'string' ? actionValue : '';
    // Layer 2: per-session CSRF token, bound to the same Access-authenticated subject
    // the request was just verified against. The origin check above already stopped a cross-site
    // forgery, so a token that fails here is a page left open past the token's lifetime: the
    // operator is told to retry, and nothing ran.
    const csrfToken = form.get('csrf_token');
    const csrfOk = await verifyAdminCsrfToken(context, typeof csrfToken === 'string' ? csrfToken : null, access.subject, context.clock().getTime());
    if (!csrfOk) return adminErrorRedirect(request, context, form, action, 'csrf_expired');
    try {
      return await performAdminAction(request, context, form, action, access.subject);
    } catch (error) {
      return adminErrorRedirect(request, context, form, action, error);
    }
  });
}

async function performAdminAction(request: Request, context: ReservaContext, form: FormData, action: string, subject: string): Promise<Response> {
  // Records who changed it atomically with the change. subject is '' when adminAuth exposes
  // no per-user identity; normalized to null so an anonymous-verifier deployment records "no known actor", not empty string.
  const audit = { actor: subject || null, changedAt: nowIso(context) };
  requireString(action, 'action');
  if (action === 'incident-retry' || action === 'incident-resolve') {
    const sourceType = requireString(form.get('source_type'), 'source_type') as OperationalIncidentSourceType;
    const sourceKey = requireString(form.get('source_key'), 'source_key');
    const incident = await context.repo.getIncidentBySource(sourceType, sourceKey);
    if (!incident || incident.status !== 'open') throw new HttpError(400, 'validation_failed', 'Incident not found or already resolved');
    const location = adminReturnLocation(request);
    location.hash = 'bk-incidents';
    if (action === 'incident-resolve') {
      // Never falsifies the underlying provider/refund row: this only calls resolveIncidentManual,
      // nothing that touches bookings/side_effect_operations/refund_operations.
      const noteValue = form.get('note');
      const note = typeof noteValue === 'string' ? noteValue.trim() : '';
      if (note.length < 1 || note.length > 500) throw new HttpError(400, 'validation_failed', 'note must be between 1 and 500 characters', { field: 'note' });
      await context.repo.resolveIncidentManual({
        sourceType, sourceKey, resolvedAt: nowIso(context), resolvedBy: subject || 'admin', resolutionNote: note,
      });
      location.searchParams.set('saved', 'incident-resolved');
      return seeOther(location);
    }
    // 'oversell' has no safe one-shot retry (retrySideEffectOperation already enforces the STOP
    // condition) — refuse it server-side too, so the UI's omitted button isn't the only guard.
    // 'payment_verification' joins it for the same reason: there is no operation to re-run, only
    // a record that a payment was refused.
    // 'reconciliation' likewise: a stopped cron is fixed by deploying a trigger, not by a retry.
    const bookingId = incident.bookingId;
    if (!incidentRetryAvailable(incident) || bookingId === null) {
      // Told, not errored: the UI omits the button for these, so a request that gets here is
      // stale rather than malicious and an error page would tell the operator nothing useful.
      location.searchParams.set('saved', 'incident-retry-unavailable');
      return seeOther(location);
    }
    const booking = await context.repo.getBookingById(bookingId);
    if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');
    if (sourceType === 'side_effect') {
      // source_key is a rendering of an operation's identity, not a parseable encoding of it —
      // find the row by rebuilding each candidate's key and comparing, not by slicing the string.
      const operations = await context.repo.listSideEffectOperations(bookingId);
      const operation = operations.find((candidate) => sideEffectIncidentSourceKey(candidate) === sourceKey);
      if (!operation) throw new HttpError(404, 'not_found', 'Operation not found');
      await retrySideEffectOperation(context, booking, operation);
    } else {
      const refundOperation = await context.repo.getRefundOperationByBookingId(bookingId);
      if (refundOperation) {
        const attemptNumber = await context.repo.claimRefundExecutionForRetry(refundOperation.id, nowIso(context));
        if (attemptNumber !== null) {
          await attemptRefund(context, booking, {
            operationId: refundOperation.id,
            choice: refundOperation.choice,
            requestedAmountCents: refundOperation.requestedAmountCents,
            paymentRef: refundOperation.paymentIntent,
          }, { attemptNumber });
        }
      }
    }
    // An admin retry happens outside any reconciliation pass — reproject this incident directly so
    // a successful retry can auto-resolve without waiting for a scan that won't revisit this booking.
    const outcome = await reprojectIncidentAfterAdminRetry(context, sourceType, sourceKey, bookingId);
    location.searchParams.set('saved', outcome === 'resolved'
      ? 'incident-resolved'
      : outcome === 'still_open' ? 'incident-retry-failed' : 'incident-retry-unavailable');
    return seeOther(location);
  }
  if (action.startsWith('settings-')) {
    // Redirect target carries saved=1 so the settings page can confirm the change visibly.
    const location = adminReturnLocation(request);
    location.searchParams.set('saved', '1');
    // Compare against the file config, not the merged one: a value equal to the file default deletes
    // the row, keeping "follow the config" the resting state. It also fixes which services (and so
    // which hours keys) exist.
    const base = context.baseConfig ?? context.config;
    const allDefinitions = settingDefinitionsFor(base);
    // candidateRows starts from every currently stored override (not just this section) so the
    // merge-then-validate check below sees the config the way a request would actually merge it,
    // catching cross-field rules that no single field's SettingKind bound can.
    const candidateRows = await context.repo.listSettings();
    if (action.startsWith('settings-reset:')) {
      const key = action.slice('settings-reset:'.length);
      const definition = allDefinitions.find((entry) => entry.key === key);
      if (!definition) throw new HttpError(400, 'validation_failed', 'Unknown setting');
      delete candidateRows[definition.key];
      assertMergedSettingsValid(base, candidateRows);
      await context.repo.deleteSetting(definition.key, audit);
      dispatchSettingsChanged(context, [{ domain: 'setting', key: definition.key, action: 'delete', actor: audit.actor }]);
      return seeOther(location);
    }
    if (action !== 'settings-save' && action !== 'settings-reset') throw new HttpError(400, 'validation_failed', 'Unknown admin action');
    const section = requireString(form.get('section'), 'section');
    const definitions = allDefinitions.filter((definition) => definition.section === section);
    if (definitions.length === 0) throw new HttpError(400, 'validation_failed', 'Unknown settings section');
    const operations: SettingsBatchOperation[] = [];
    for (const definition of definitions) {
      if (action === 'settings-reset') {
        delete candidateRows[definition.key];
        operations.push({ type: 'delete', key: definition.key });
        continue;
      }
      let value: SettingValue;
      try {
        value = parseSettingForm(definition, form);
      } catch (error) {
        if (error instanceof SettingParseError) throw new HttpError(400, 'validation_failed', error.message, { field: definition.key });
        throw error;
      }
      if (settingValuesEqual(value, definition.get(base))) {
        delete candidateRows[definition.key];
        operations.push({ type: 'delete', key: definition.key });
      } else {
        const serialized = serializeSettingValue(value);
        candidateRows[definition.key] = serialized;
        operations.push({ type: 'upsert', key: definition.key, value: serialized });
      }
    }
    assertMergedSettingsValid(base, candidateRows);
    if (operations.length > 0) {
      await context.repo.applySettingsBatch(operations, audit);
      // The same rows the batch just wrote to admin_change_history — a rebuild receiver learns
      // which domains moved, and reads the new values back from the catalog.
      dispatchSettingsChanged(context, operations.map((operation): SettingsChange => ({
        domain: 'setting', key: operation.key, action: operation.type === 'upsert' ? 'upsert' : 'delete', actor: audit.actor,
      })));
    }
    return seeOther(location);
  }
  // Day actions may target several days at once: repeated date fields (the enhancer's
  // multi-select) and/or an optional toDate expanding to the contiguous range (the no-JS bulk
  // path). Default-capacity actions always take a single date.
  const dates = form.getAll('date').map((value) => parseDate(requireString(value, 'date'), 'date'));
  const firstDate = dates[0];
  if (firstDate === undefined) throw new HttpError(400, 'validation_failed', 'date is required', { field: 'date' });
  const isDefault = action.startsWith('default-');
  let dayDates = [...new Set(dates)].sort();
  const earliest = dayDates[0] ?? firstDate;
  if (!isDefault) {
    const toRaw = form.get('toDate');
    if (typeof toRaw === 'string' && toRaw.trim()) {
      const toDate = parseDate(toRaw.trim(), 'toDate');
      if (toDate < earliest) throw new HttpError(400, 'validation_failed', 'toDate must not be before date', { field: 'toDate' });
      dayDates = [...new Set([...dayDates, ...enumerateDateKeys(earliest, toDate)])].sort();
    }
    if (dayDates.length > 366) throw new HttpError(400, 'validation_failed', 'Too many days in one request', { field: 'toDate' });
  }
  const reasonValue = form.get('reason');
  const reason = typeof reasonValue === 'string' && reasonValue.trim() ? reasonValue.trim() : null;
  const dayChanges = (changeAction: 'upsert' | 'delete'): SettingsChange[] =>
    dayDates.map((date) => ({ domain: 'day_override', key: date, action: changeAction, actor: audit.actor }));
  if (action === 'clear') {
    await context.repo.deleteDayOverrides(dayDates, audit);
    dispatchSettingsChanged(context, dayChanges('delete'));
  } else if (action === 'set' || action === 'close') {
    const capacity = action === 'close' ? 0 : capacityFrom(form);
    await context.repo.upsertDayOverrides(dayDates, capacity, reason, audit);
    dispatchSettingsChanged(context, dayChanges('upsert'));
  } else if (action === 'default-clear') {
    await context.repo.deleteCapacityDefault(firstDate, audit);
    dispatchSettingsChanged(context, [{ domain: 'capacity_default', key: firstDate, action: 'delete', actor: audit.actor }]);
  } else if (action === 'default-set') {
    const capacity = capacityFrom(form);
    await context.repo.upsertCapacityDefault(firstDate, capacity, reason, audit);
    dispatchSettingsChanged(context, [{ domain: 'capacity_default', key: firstDate, action: 'upsert', actor: audit.actor }]);
  } else throw new HttpError(400, 'validation_failed', 'Unknown admin action');
  // saved=day|default renders a confirmation inside the submitted form; the hash lands there.
  // Day actions also pin ?date= to the first edited day so the form reflects what was just saved.
  const location = adminReturnLocation(request);
  location.searchParams.set('saved', isDefault ? 'default' : 'day');
  if (!isDefault) location.searchParams.set('date', earliest);
  location.hash = isDefault ? 'bk-default' : 'bk-override';
  return seeOther(location);
}
