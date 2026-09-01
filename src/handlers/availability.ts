import type { AvailabilityDay, AvailabilityResponse } from '../core/api.js';
import { resolveService } from '../core/config.js';
import { availabilityForDay, capacityForDate, defaultCapacityForDate, type CalEvent, type DayAvailability } from '../core/occupancy.js';
import { priceFor } from '../core/pricing.js';
import { generateSlots } from '../core/slots.js';
import { addDaysToDateKey, enumerateDateKeys, localDateKey, localDateTimeToUtcIso, parseUtcInstant } from '../core/time.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import { HttpError, json, parseDate, requireInteger, requireString } from '../http.js';
import { run } from './shared.js';

// The bound is the deployment's own booking horizon, not a fixed cap — a fixed cap would force a
// consumer to chunk-and-merge availability requests, which nothing here should require. Nothing
// bookable exists past `maxHorizonDays`
// (core/occupancy.ts filters those slots out anyway), so a request may span the whole window and no
// more. The span is still bounded BEFORE enumerating (zero-padded keys compare lexicographically),
// so an adversarial multi-century range fails fast instead of allocating one key per day.
function validDateRange(from: string, to: string, maxHorizonDays: number): string[] {
  parseDate(from, 'from');
  parseDate(to, 'to');
  if (to > addDaysToDateKey(from, maxHorizonDays)) {
    throw new HttpError(400, 'validation_failed', `Date range cannot exceed the booking horizon of ${maxHorizonDays} days (config.booking.maxHorizonDays); request a narrower range`);
  }
  return enumerateDateKeys(from, to);
}

const CALENDAR_FRESH_SECONDS = 60;
const CALENDAR_STORED_AT_HEADER = 'x-reserva-calendar-stored-at';
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
      ...(typeof item.reservaBookingId === 'string' ? { reservaBookingId: item.reservaBookingId } : {}),
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

function calendarCacheRequest(context: ReservaContext, calendarKey: string, fromUtc: string, toUtc: string): Request {
  const url = new URL('/__reserva/calendar-occupancy', context.config.business.url);
  url.search = new URLSearchParams({ calendar: calendarKey, from: fromUtc, to: toUtc }).toString();
  return new Request(url.toString(), { method: 'GET' });
}

interface CalendarEventsResult {
  events: CalEvent[];
  stale: boolean;
}

export async function calendarEventsForWindow(context: ReservaContext, fromUtc: string, toUtc: string, now: string): Promise<CalendarEventsResult> {
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

function availabilityInput(request: Request, context: ReservaContext): AvailabilityInput {
  const url = new URL(request.url);
  const serviceSlug = requireString(url.searchParams.get('service'), 'service');
  if (!context.config.services[serviceSlug]) throw new HttpError(400, 'validation_failed', 'Unknown service');
  const quantity = requireInteger(Number(url.searchParams.get('quantity')), 'quantity');
  const from = requireString(url.searchParams.get('from'), 'from');
  const to = requireString(url.searchParams.get('to'), 'to');
  const dates = validDateRange(from, to, context.config.booking.maxHorizonDays);
  const service = resolveService(context.config, serviceSlug);
  assertSupportedPartySize(service, quantity);
  try {
    // The party size must price under every pickup id the service's
    // own pricing rows declare — derived like resolvedPriceTableFor, not a fixed
    // default/custom pair, since a service with declared location.pickupOptions need not use one.
    // A location-less rule's `pickup` is undefined, normalized to null (the same key
    // priceFor expects for such a service).
    for (const pickup of new Set(service.pricing.map((row) => row.pickup ?? null))) {
      priceFor(service, quantity, pickup);
    }
  } catch {
    throw new HttpError(400, 'validation_failed', 'No price is configured for this party size');
  }
  return { quantity, dates, service };
}

// Scarcity leaves the library as a structured number, never a
// rendered string, and the exact count is published only inside the scarce band — at or below
// `limitedThreshold` a consumer gets the number it needs to say "only N left" (the copy keys are
// exported: SLOT_STATUS_MESSAGE_KEYS, src/ui/messages.ts), and above it the field is null so a
// deployment's real capacity stays private. Slots that fit nothing are already filtered out
// upstream, so `remaining` is never 0.
function wireDay(day: DayAvailability, limitedThreshold: number): AvailabilityDay {
  return {
    date: day.date,
    status: day.status,
    closedReason: day.closedReason ?? null,
    slots: day.slots.map((slot) => ({
      start: slot.start,
      remaining: slot.remainingBookings <= limitedThreshold ? slot.remainingBookings : null,
    })),
  };
}

async function availabilityPayload(context: ReservaContext, now: string, input: AvailabilityInput): Promise<{ payload: AvailabilityResponse; stale: boolean }> {
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
  const limitedThreshold = context.config.booking.limitedThreshold;
  const days = dates.map((date) => {
    const capacityInfo = capacityForDate(date, defaultCapacityForDate(date, context.config.capacity.default, capacityDefaults), overridesByDate);
    if (generateSlots(service, date, context.config.business.timezone).length === 0) {
      return wireDay({
        date,
        status: 'closed' as const,
        ...(capacityInfo.closedReason ? { closedReason: capacityInfo.closedReason } : {}),
        slots: [],
      }, limitedThreshold);
    }
    return wireDay(availabilityForDay({
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
      limitedThreshold,
    }), limitedThreshold);
  });
  return {
    // The threshold travels with the payload so a consumer can explain the scarcity policy behind
    // both the day statuses and each slot's gated `remaining`, instead of assuming one.
    payload: { timezone: context.config.business.timezone, limitedThreshold, days },
    stale: calendar.stale,
  };
}

export function handleAvailability(request: Request, context: ReservaContext): Promise<Response> {
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
      // fresh cache entry that bypasses and bloats the 60s public cache. Reading
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
