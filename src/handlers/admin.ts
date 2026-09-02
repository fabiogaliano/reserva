import { adminLocaleFor } from '../core/config.js';
import {
  SettingParseError,
  SettingsMergeError,
  mergeAndValidateSettings,
  parseSettingForm,
  serializeSettingValue,
  settingDefinitions,
  settingValuesEqual,
  type SettingValue,
} from '../core/settings.js';
import { enumerateDateKeys, localDateKey, parseUtcInstant } from '../core/time.js';
import { adminOriginAllowed, mintAdminCsrfToken, verifyAdminCsrfToken } from '../admin-csrf.js';
import { accessAllowed } from '../admin-access.js';
import { retrySideEffectOperation } from '../confirmation.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import type {
  OperationalIncidentSourceType,
  SettingsBatchOperation,
} from '../repo.js';
import { reprojectIncidentAfterAdminRetry, sideEffectIncidentSourceKey } from '../reconciliation.js';
import { attemptRefund } from '../refund-executor.js';
import { resolveMessages } from '../ui/messages.js';
import { adminPage, incidentsSection, type AdminFilters } from '../ui/pages/admin-page.js';
import { settingsPage } from '../ui/pages/settings-page.js';
import {
  html,
  HttpError,
  parseDate,
  requestFormData,
  requireInteger,
  requireString,
} from '../http.js';
import { run, runAdminPost } from './shared.js';

export function handleAdminGet(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const access = await accessAllowed(request, context);
    if (!access) throw new HttpError(403, 'forbidden', 'Cloudflare Access authorization required');
    // Minted fresh per render and embedded as a hidden field in every admin form; handleAdminPost
    // verifies it against the same Access-authenticated subject.
    const csrfToken = await mintAdminCsrfToken(context, access.subject, context.clock().getTime());
    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.get('view') === 'settings') {
      return html(settingsPage(context, await context.repo.listSettings(), requestUrl.searchParams.get('saved') === '1', requestUrl.searchParams.get('section') ?? '', csrfToken), 200, {
        'cache-control': 'no-store',
        // Same referrer-policy reasoning as the dashboard response below.
        'referrer-policy': 'same-origin',
      });
    }
    const now = nowIso(context);
    await context.repo.sweepExpiredHolds(now);
    const end = new Date(parseUtcInstant(now).getTime() + context.config.booking.maxHorizonDays * 86_400_000).toISOString();
    const bookings = await context.repo.listUpcoming(now);
    const fromDate = localDateKey(now, context.config.business.timezone);
    const toDate = localDateKey(end, context.config.business.timezone);
    const overrides = await context.repo.listDayOverrides(fromDate, toDate);
    const capacityDefaults = await context.repo.listCapacityDefaults();
    const url = new URL(request.url);
    const filters: AdminFilters = {
      q: url.searchParams.get('q')?.trim() ?? '',
      status: url.searchParams.get('status')?.trim() ?? '',
    };
    // A search/status filter widens the table's source to every booking (any status, past year
    // included), since listUpcoming can't return cancelled/expired/past rows. The unfiltered
    // `bookings` set still backs the occupancy calendar and stat counts, where cancelled rows must not consume capacity.
    const tableBookings = filters.q || filters.status
      ? await context.repo.listAllFrom(new Date(parseUtcInstant(now).getTime() - 365 * 86_400_000).toISOString())
      : bookings;
    const editDate = url.searchParams.get('date')?.trim() ?? '';
    const saved = url.searchParams.get('saved') ?? '';
    const messages = resolveMessages(context.config, adminLocaleFor(context.config));
    // incidentsSince is a fixed 30-day lookback from the render clock, not a config option.
    const incidentsSince = new Date(parseUtcInstant(now).getTime() - 30 * 86_400_000).toISOString();
    const [openIncidents, resolvedIncidents, incidentCounts] = await Promise.all([
      context.repo.listOpenIncidents(100),
      context.repo.listRecentResolvedIncidents(incidentsSince, 20),
      context.repo.countIncidentsSince(incidentsSince),
    ]);
    const incidentBookingIds = [...new Set([...openIncidents, ...resolvedIncidents].map((incident) => incident.bookingId))];
    const incidentBookings = await Promise.all(incidentBookingIds.map((id) => context.repo.getBookingById(id)));
    const referenceByBookingId = new Map<string, string>();
    incidentBookingIds.forEach((id, index) => {
      const found = incidentBookings[index];
      referenceByBookingId.set(id, found?.reference ?? id);
    });
    const incidentsHtml = incidentsSection(context, messages, openIncidents, resolvedIncidents, incidentCounts, referenceByBookingId, csrfToken, saved);
    return html(adminPage(
      context,
      bookings,
      tableBookings,
      overrides,
      fromDate,
      toDate,
      filters,
      editDate,
      capacityDefaults,
      saved,
      csrfToken,
      incidentsHtml,
      openIncidents.length,
    ), 200, {
      'cache-control': 'no-store',
      // `no-referrer` would null the Origin header on this page's own same-origin POSTs, tripping
      // Astro's checkOrigin default. `same-origin` avoids that while keeping the same token-leak protection.
      'referrer-policy': 'same-origin',
    });
  });
}

export function handleAdminPost(request: Request, context: ReservaContext): Promise<Response> {
  return runAdminPost(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const access = await accessAllowed(request, context);
    if (!access) throw new HttpError(403, 'forbidden', 'Cloudflare Access authorization required');
    // Layer 1: Fetch-Metadata / Origin enforcement, wired only on this admin mutation route, never the public booking API.
    if (!adminOriginAllowed(request)) throw new HttpError(403, 'forbidden', 'Cross-origin admin requests are not allowed');
    const form = await requestFormData(request);
    // Layer 2: per-session CSRF token, bound to the same Access-authenticated subject
    // the request was just verified against.
    const csrfToken = form.get('csrf_token');
    const csrfOk = await verifyAdminCsrfToken(context, typeof csrfToken === 'string' ? csrfToken : null, access.subject, context.clock().getTime());
    if (!csrfOk) throw new HttpError(403, 'forbidden', 'Invalid or expired CSRF token');
    // Records who changed it atomically with the change. access.subject is '' when adminAuth exposes
    // no per-user identity; normalized to null so an anonymous-verifier deployment records "no known actor", not empty string.
    const audit = { actor: access.subject || null, changedAt: nowIso(context) };
    const action = requireString(form.get('action'), 'action');
    if (action === 'incident-retry' || action === 'incident-resolve') {
      const sourceType = requireString(form.get('source_type'), 'source_type') as OperationalIncidentSourceType;
      const sourceKey = requireString(form.get('source_key'), 'source_key');
      const incident = await context.repo.getIncidentBySource(sourceType, sourceKey);
      if (!incident || incident.status !== 'open') throw new HttpError(400, 'validation_failed', 'Incident not found or already resolved');
      const location = new URL(request.url);
      location.hash = 'bk-incidents';
      if (action === 'incident-resolve') {
        // Never falsifies the underlying provider/refund row: this only calls resolveIncidentManual,
        // nothing that touches bookings/side_effect_operations/refund_operations.
        const note = requireString(form.get('note'), 'note').trim();
        if (note.length < 1 || note.length > 500) throw new HttpError(400, 'validation_failed', 'note must be between 1 and 500 characters');
        await context.repo.resolveIncidentManual({
          sourceType, sourceKey, resolvedAt: nowIso(context), resolvedBy: access.subject || 'admin', resolutionNote: note,
        });
        location.searchParams.set('saved', 'incident-resolved');
        return new Response(null, { status: 303, headers: { location: location.toString(), 'cache-control': 'no-store' } });
      }
      // 'oversell' has no safe one-shot retry (retrySideEffectOperation already enforces the STOP
      // condition) — reject it server-side too, so the UI's omitted button isn't the only guard.
      if (sourceType === 'oversell') throw new HttpError(400, 'validation_failed', 'This incident cannot be retried automatically');
      const booking = await context.repo.getBookingById(incident.bookingId);
      if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');
      if (sourceType === 'side_effect') {
        // source_key is a rendering of an operation's identity, not a parseable encoding of it —
        // find the row by rebuilding each candidate's key and comparing, not by slicing the string.
        const operations = await context.repo.listSideEffectOperations(incident.bookingId);
        const operation = operations.find((candidate) => sideEffectIncidentSourceKey(candidate) === sourceKey);
        if (!operation) throw new HttpError(404, 'not_found', 'Operation not found');
        await retrySideEffectOperation(context, booking, operation);
      } else {
        const refundOperation = await context.repo.getRefundOperationByBookingId(incident.bookingId);
        if (refundOperation) {
          const attemptNumber = await context.repo.claimRefundExecutionForRetry(refundOperation.id, nowIso(context));
          if (attemptNumber !== null) {
            await attemptRefund(context, booking, refundOperation.id, refundOperation.choice, refundOperation.paymentIntent, { attemptNumber });
          }
        }
      }
      // An admin retry happens outside any reconciliation pass — reproject this incident directly so
      // a successful retry can auto-resolve without waiting for a scan that won't revisit this booking.
      await reprojectIncidentAfterAdminRetry(context, sourceType, incident.bookingId);
      location.searchParams.set('saved', 'incident-retried');
      return new Response(null, { status: 303, headers: { location: location.toString(), 'cache-control': 'no-store' } });
    }
    if (action.startsWith('settings-')) {
      // Redirect target carries saved=1 so the settings page can confirm the change visibly.
      const location = new URL(request.url);
      location.searchParams.set('saved', '1');
      if (action.startsWith('settings-reset:')) {
        const key = action.slice('settings-reset:'.length);
        const definition = settingDefinitions.find((entry) => entry.key === key);
        if (!definition) throw new HttpError(400, 'validation_failed', 'Unknown setting');
        await context.repo.deleteSetting(definition.key, audit);
        return new Response(null, { status: 303, headers: { location: location.toString(), 'cache-control': 'no-store' } });
      }
      if (action !== 'settings-save' && action !== 'settings-reset') throw new HttpError(400, 'validation_failed', 'Unknown admin action');
      const section = requireString(form.get('section'), 'section');
      const definitions = settingDefinitions.filter((definition) => definition.section === section);
      if (definitions.length === 0) throw new HttpError(400, 'validation_failed', 'Unknown settings section');
      // Compare against the file config, not the merged one: a value equal to the file default deletes
      // the row, keeping "follow the config" the resting state.
      const base = context.baseConfig ?? context.config;
      // candidateRows starts from every currently stored override (not just this section) so the
      // merge-then-validate check below sees the config the way a request would actually merge it,
      // catching cross-field rules that no single field's SettingKind bound can.
      const candidateRows = await context.repo.listSettings();
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
          if (error instanceof SettingParseError) throw new HttpError(400, 'validation_failed', error.message);
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
      if (action === 'settings-save') {
        try {
          mergeAndValidateSettings(base, candidateRows);
        } catch (error) {
          if (error instanceof SettingsMergeError) throw new HttpError(400, 'validation_failed', error.message);
          throw error;
        }
      }
      if (operations.length > 0) await context.repo.applySettingsBatch(operations, audit);
      return new Response(null, { status: 303, headers: { location: location.toString(), 'cache-control': 'no-store' } });
    }
    // Day actions may target several days at once: repeated date fields (the enhancer's
    // multi-select) and/or an optional toDate expanding to the contiguous range (the no-JS bulk
    // path). Default-capacity actions always take a single date.
    const dates = form.getAll('date').map((value) => parseDate(requireString(value, 'date'), 'date'));
    const firstDate = dates[0];
    if (firstDate === undefined) throw new HttpError(400, 'validation_failed', 'date is required');
    const isDefault = action.startsWith('default-');
    let dayDates = [...new Set(dates)].sort();
    const earliest = dayDates[0] ?? firstDate;
    if (!isDefault) {
      const toRaw = form.get('toDate');
      if (typeof toRaw === 'string' && toRaw.trim()) {
        const toDate = parseDate(toRaw.trim(), 'toDate');
        if (toDate < earliest) throw new HttpError(400, 'validation_failed', 'toDate must not be before date');
        dayDates = [...new Set([...dayDates, ...enumerateDateKeys(earliest, toDate)])].sort();
      }
      if (dayDates.length > 366) throw new HttpError(400, 'validation_failed', 'Too many days in one request');
    }
    const reasonValue = form.get('reason');
    const reason = typeof reasonValue === 'string' && reasonValue.trim() ? reasonValue.trim() : null;
    if (action === 'clear') {
      await context.repo.deleteDayOverrides(dayDates, audit);
    } else if (action === 'set' || action === 'close') {
      const capacity = action === 'close' ? 0 : requireInteger(Number(form.get('capacity')), 'capacity', 0);
      await context.repo.upsertDayOverrides(dayDates, capacity, reason, audit);
    } else if (action === 'default-clear') await context.repo.deleteCapacityDefault(firstDate, audit);
    else if (action === 'default-set') {
      const capacity = requireInteger(Number(form.get('capacity')), 'capacity', 0);
      await context.repo.upsertCapacityDefault(firstDate, capacity, reason, audit);
    } else throw new HttpError(400, 'validation_failed', 'Unknown admin action');
    // saved=day|default renders a confirmation inside the submitted form; the hash lands there.
    // Day actions also pin ?date= to the first edited day so the form reflects what was just saved.
    const location = new URL(request.url);
    location.searchParams.set('saved', isDefault ? 'default' : 'day');
    if (!isDefault) location.searchParams.set('date', earliest);
    location.hash = isDefault ? 'bk-default' : 'bk-override';
    return new Response(null, { status: 303, headers: { location: location.toString(), 'cache-control': 'no-store' } });
  });
}
