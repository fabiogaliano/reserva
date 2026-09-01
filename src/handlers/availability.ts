import { resolveService } from '../core/config';
import { availabilityForDay, capacityForDate, defaultCapacityForDate, type CalEvent } from '../core/occupancy';
import { priceFor } from '../core/pricing';
import { generateSlots } from '../core/slots';
import { addDaysToDateKey, enumerateDateKeys, localDateKey, localDateTimeToUtcIso, parseUtcInstant } from '../core/time';
import type { BookkitContext } from '../context';
import { nowIso } from '../context';
import { HttpError, json, parseDate, requireInteger, requireString } from '../http';
import { run } from './shared';

function validDateRange(from: string, to: string): string[] {
  parseDate(from, 'from');
  parseDate(to, 'to');
  // Bound the span before enumerating (zero-padded keys compare lexicographically),
  // so an adversarial multi-century range fails fast instead of allocating one key per day.
  if (to > addDaysToDateKey(from, 61)) throw new HttpError(400, 'validation_failed', 'Date range cannot exceed 62 days');
  return enumerateDateKeys(from, to);
}

const CALENDAR_FRESH_SECONDS = 60;
const CALENDAR_STORED_AT_HEADER = 'x-bookkit-calendar-stored-at';
const calendarReadFlights = new Map<string, Promise<CalEvent[]>>();

function maxPartySize(service: ReturnType<typeof resolveService>): number {
  return Math.max(...service.pricing.map((rule) => rule.maxQuantity));
}

export function assertSupportedPartySize(service: ReturnType<typeof resolveService>, quantity: number): void {
  if (quantity > maxPartySize(service)) {
    throw new HttpError(400, 'validation_failed', `quantity must not exceed the configured maximum of ${maxPartySize(service)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cachedEventTime(value: unknown): string | { dateTime?: string; date?: string } | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const dateTime = typeof value.dateTime === 'string' ? value.dateTime : undefined;
  const date = typeof value.date === 'string' ? value.date : undefined;
  return dateTime || date ? { ...(dateTime ? { dateTime } : {}), ...(date ? { date } : {}) } : undefined;
}

function cachedCalendarEvents(value: unknown): CalEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: CalEvent[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const start = cachedEventTime(item.start);
    const end = cachedEventTime(item.end);
    if (!start || !end) return undefined;
    let privateProperties: Record<string, string> | undefined;
    if (isRecord(item.extendedProperties) && isRecord(item.extendedProperties.private)) {
      privateProperties = {};
      for (const [key, property] of Object.entries(item.extendedProperties.private)) {
        if (typeof property === 'string') privateProperties[key] = property;
      }
    }
    events.push({
      start,
      end,
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      ...(typeof item.allDay === 'boolean' ? { allDay: item.allDay } : {}),
      ...(typeof item.bookkitBookingId === 'string' ? { bookkitBookingId: item.bookkitBookingId } : {}),
      ...(privateProperties ? { extendedProperties: { private: privateProperties } } : {}),
    });
  }
  return events;
}

function calendarWindow(fromUtc: string, toUtc: string, timezone: string): { fromUtc: string; toUtc: string } {
  const fromDate = localDateKey(fromUtc, timezone);
  const finalInstant = new Date(parseUtcInstant(toUtc).getTime() - 1);
  const toDate = addDaysToDateKey(localDateKey(finalInstant, timezone), 1);
  return {
    fromUtc: localDateTimeToUtcIso(`${fromDate}T00:00`, timezone),
    toUtc: localDateTimeToUtcIso(`${toDate}T00:00`, timezone),
  };
}

function calendarCacheRequest(context: BookkitContext, calendarKey: string, fromUtc: string, toUtc: string): Request {
  const url = new URL('/__bookkit/calendar-occupancy', context.config.business.url);
  url.search = new URLSearchParams({ calendar: calendarKey, from: fromUtc, to: toUtc }).toString();
  return new Request(url.toString(), { method: 'GET' });
}

interface CalendarEventsResult {
  events: CalEvent[];
  stale: boolean;
}

export async function calendarEventsForWindow(context: BookkitContext, fromUtc: string, toUtc: string, now: string): Promise<CalendarEventsResult> {
  const calendar = context.providers.calendar;
  if (!calendar) return { events: [], stale: false };
  const window = calendarWindow(fromUtc, toUtc, context.config.business.timezone);
  const cacheKey = calendarCacheRequest(context, calendar.cacheKey ?? 'default', window.fromUtc, window.toUtc);
  let cached: { events: CalEvent[]; ageMs: number } | undefined;
  if (context.cache) {
    try {
      const hit = await context.cache.match(cacheKey);
      if (hit) {
        const storedAt = hit.headers.get(CALENDAR_STORED_AT_HEADER);
        const events = cachedCalendarEvents(await hit.json());
        const storedAtMs = storedAt ? Date.parse(storedAt) : Number.NaN;
        const ageMs = parseUtcInstant(now).getTime() - storedAtMs;
        if (events && Number.isFinite(storedAtMs) && ageMs >= 0) cached = { events, ageMs };
      }
    } catch {
      // A malformed or unavailable cache must not make a healthy calendar unavailable.
    }
  }
  if (cached && cached.ageMs <= CALENDAR_FRESH_SECONDS * 1_000) return { events: cached.events, stale: false };
  const existingFlight = calendarReadFlights.get(cacheKey.url);
  const flight = existingFlight ?? Promise.resolve().then(() => calendar.listEvents(window.fromUtc, window.toUtc));
  if (!existingFlight) calendarReadFlights.set(cacheKey.url, flight);
  try {
    const events = await flight;
    if (context.cache) {
      try {
        // caches.default is per-colo, so this outage grace is intentionally local to each datacenter.
        await context.cache.put(cacheKey, json(events, 200, {
          'cache-control': `public, max-age=${context.config.booking.calendarMaxStaleSeconds}`,
          [CALENDAR_STORED_AT_HEADER]: now,
        }));
      } catch {
        // Calendar data is still authoritative when a cache write fails.
      }
    }
    return { events, stale: false };
  } catch {
    if (cached && cached.ageMs <= context.config.booking.calendarMaxStaleSeconds * 1_000) return { events: cached.events, stale: true };
    throw new HttpError(503, 'calendar_unavailable', 'Calendar availability is temporarily unavailable');
  } finally {
    if (calendarReadFlights.get(cacheKey.url) === flight) calendarReadFlights.delete(cacheKey.url);
  }
}

interface AvailabilityInput {
  quantity: number;
  dates: string[];
  service: ReturnType<typeof resolveService>;
}

function availabilityInput(request: Request, context: BookkitContext): AvailabilityInput {
  const url = new URL(request.url);
  const serviceSlug = requireString(url.searchParams.get('service'), 'service');
  if (!context.config.services[serviceSlug]) throw new HttpError(400, 'validation_failed', 'Unknown service');
  const quantity = requireInteger(Number(url.searchParams.get('quantity')), 'quantity');
  const from = requireString(url.searchParams.get('from'), 'from');
  const to = requireString(url.searchParams.get('to'), 'to');
  const dates = validDateRange(from, to);
  const service = resolveService(context.config, serviceSlug);
  assertSupportedPartySize(service, quantity);
  try {
    // Plan 018 (design decision 3): the party size must price under every pickup id the service's
    // own pricing rows declare — derived like resolvedPriceTableFor, not the old literal
    // default/custom pair, which a service with declared pickupOptions need not use at all.
    for (const pickup of new Set(service.pricing.map((row) => row.pickup))) {
      priceFor(service, quantity, pickup);
    }
  } catch {
    throw new HttpError(400, 'validation_failed', 'No price is configured for this party size');
  }
  return { quantity, dates, service };
}

async function availabilityPayload(context: BookkitContext, now: string, input: AvailabilityInput): Promise<{ payload: { timezone: string; limitedThreshold: number; days: unknown[] }; stale: boolean }> {
  const { quantity, dates, service } = input;
  const firstDay = dates[0];
  const lastDay = dates[dates.length - 1];
  if (!firstDay || !lastDay) throw new HttpError(400, 'validation_failed', 'Date range is empty');
  const dayAfterLast = addDaysToDateKey(lastDay, 1);
  const horizonStart = parseUtcInstant(localDateTimeToUtcIso(`${firstDay}T00:00`, context.config.business.timezone));
  const horizonEnd = parseUtcInstant(localDateTimeToUtcIso(`${dayAfterLast}T00:00`, context.config.business.timezone));
  const lookback = Math.max(...Object.values(context.config.services).map((candidate) => candidate.durationMin + candidate.turnaroundMin), 0);
  const bookings = await context.repo.listOccupancyBookings(
    new Date(horizonStart.getTime() - lookback * 60_000).toISOString(),
    horizonEnd.toISOString(),
  );
  const calendar = await calendarEventsForWindow(
    context,
    new Date(horizonStart.getTime() - lookback * 60_000).toISOString(),
    horizonEnd.toISOString(),
    now,
  );
  const overrides = await context.repo.listDayOverrides(firstDay, lastDay);
  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));
  const capacityDefaults = await context.repo.listCapacityDefaults();
  const days = dates.map((date) => {
    const capacityInfo = capacityForDate(date, defaultCapacityForDate(date, context.config.capacity.default, capacityDefaults), overridesByDate);
    if (generateSlots(service, date, context.config.business.timezone).length === 0) {
      return {
        date,
        status: 'closed' as const,
        ...(capacityInfo.closedReason ? { closedReason: capacityInfo.closedReason } : {}),
        slots: [],
      };
    }
    return availabilityForDay({
      date,
      timezone: context.config.business.timezone,
      service,
      capacity: capacityInfo.capacity,
      ...(capacityInfo.closedReason !== undefined ? { closedReason: capacityInfo.closedReason } : {}),
      bookings,
      calendarEvents: calendar.events,
      services: context.config.services,
      requestedQuantity: quantity,
      now,
      minNoticeHours: context.config.booking.minNoticeHours,
      maxHorizonDays: context.config.booking.maxHorizonDays,
      limitedThreshold: context.config.booking.limitedThreshold,
    });
  });
  return {
    // The widget consumes this with every availability refresh, so its slot hints follow the
    // same server policy as the day-level statuses instead of a consumer-supplied default.
    payload: { timezone: context.config.business.timezone, limitedThreshold: context.config.booking.limitedThreshold, days },
    stale: calendar.stale,
  };
}

export function handleAvailability(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const input = availabilityInput(request, context);
    const now = nowIso(context);
    await context.repo.sweepExpiredHolds(now);
    const availabilityCache = context.providers.calendar ? undefined : context.cache;
    let cacheKey: Request | undefined;
    if (availabilityCache) {
      // Built from exactly the four availabilityInput validates, in fixed order — not the raw
      // request URL — so a junk query parameter (nonce, cache-buster, tracking param) can't mint a
      // fresh cache entry that bypasses and bloats the 60s public cache (audit finding #11). Reading
      // these again (rather than threading them out of AvailabilityInput) is safe: availabilityInput
      // above already validated them, so this is a lossless re-read of the exact strings that
      // validated cleanly, not a second, divergent parse.
      const requestParams = new URL(request.url).searchParams;
      const keyUrl = new URL(request.url);
      keyUrl.search = '';
      for (const name of ['service', 'quantity', 'from', 'to']) keyUrl.searchParams.set(name, requestParams.get(name) ?? '');
      cacheKey = new Request(keyUrl.toString(), { method: 'GET' });
      const hit = await availabilityCache.match(cacheKey);
      if (hit) return hit;
    }
    const { payload, stale } = await availabilityPayload(context, now, input);
    if (availabilityCache && cacheKey) {
      const response = json(payload, 200, { 'cache-control': 'public, max-age=60' });
      await availabilityCache.put(cacheKey, response.clone());
      return response;
    }
    return json(payload, 200, { 'cache-control': stale ? 'no-store' : context.providers.calendar ? 'public, max-age=60' : 'no-store' });
  });
}
