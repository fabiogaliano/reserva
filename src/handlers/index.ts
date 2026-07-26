import {
  canCancelBooking,
  canRescheduleBooking,
  cancelBooking,
  markNoShow,
  rescheduleBooking,
  type Booking,
} from '../core/booking';
import { DEFAULT_TOKEN_EXPIRY_DAYS, resolveTour, type PickupType } from '../core/config';
import { availabilityForDay, capacityForDate, defaultCapacityForDate, occupancyFor, type CalEvent, type CapacityDefault } from '../core/occupancy';
import { verifyPayment } from '../core/payment-verification';
import { priceFor } from '../core/pricing';
import { generateUniqueReference } from '../core/reference';
import {
  SettingParseError,
  SettingsMergeError,
  mergeAndValidateSettings,
  parseSettingForm,
  serializeSettingValue,
  settingDefinitions,
  settingSections,
  settingValuesEqual,
  type SettingDefinition,
  type SettingSection,
  type SettingValue,
} from '../core/settings';
import { generateSlots } from '../core/slots';
import { addDaysToDateKey, enumerateDateKeys, localDateKey, localDateTimeToUtcIso, parseUtcInstant, utcToLocalIso } from '../core/time';
import { adminOriginAllowed, mintAdminCsrfToken, verifyAdminCsrfToken } from '../admin-csrf';
import {
  ConfirmationInProgressError,
  confirmBookingFromPayment,
  dispatchMutation,
  dispatchNonCritical,
  isConfirmationSideEffectOperation,
  mutationSideEffectKinds,
  runOwedMutationSideEffects,
} from '../confirmation';
import type { BookkitContext } from '../context';
import { getSecret, nowIso } from '../context';
import { isManageableToken } from '../providers/brevo';
import { HoldLimitExceededError, type SettingsBatchOperation } from '../repo';
import { cssAssetHref, jsAssetHref } from '../ui/asset-hrefs';
import { formatDateTime, formatDayDate, formatPrice } from '../ui/format';
import { factList, pageShell, statusBadge, statusToneOf, themeToggle } from '../ui/layout';
import { formatMessage, resolveMessages } from '../ui/messages';
import {
  bearerToken,
  constantTimeEqual,
  errorResponse,
  escapeHtml,
  html,
  HttpError,
  json,
  parseDate,
  requestJson,
  requireInteger,
  requireString,
  tokenBytes,
} from '../http';

function run(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch(errorResponse);
}

function withSensitiveHeaders(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

// BK-SEC-001: the successful admin POST redirects already set Cache-Control: no-store, but a
// thrown HttpError (bad origin, invalid/expired CSRF token, bad Access, validation failure, ...)
// went through plain errorResponse (src/http.ts), which sets no cache-control at all — a shared
// cache could then serve a stale admin error page. Scoped to admin POST only: the public booking
// API's error responses are unaffected.
function runAdminPost(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    const response = errorResponse(error);
    response.headers.set('cache-control', 'no-store');
    return response;
  });
}

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

function maxPartySize(tour: ReturnType<typeof resolveTour>): number {
  return Math.max(...tour.pricing.map((rule) => rule.maxPeople));
}

function assertSupportedPartySize(tour: ReturnType<typeof resolveTour>, people: number): void {
  if (people > maxPartySize(tour)) {
    throw new HttpError(400, 'validation_failed', `people must not exceed the configured maximum of ${maxPartySize(tour)}`);
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

async function calendarEventsForWindow(context: BookkitContext, fromUtc: string, toUtc: string, now: string): Promise<CalendarEventsResult> {
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
  people: number;
  dates: string[];
  tour: ReturnType<typeof resolveTour>;
}

function availabilityInput(request: Request, context: BookkitContext): AvailabilityInput {
  const url = new URL(request.url);
  const tourSlug = requireString(url.searchParams.get('tour'), 'tour');
  if (!context.config.tours[tourSlug]) throw new HttpError(400, 'validation_failed', 'Unknown tour');
  const people = requireInteger(Number(url.searchParams.get('people')), 'people');
  const from = requireString(url.searchParams.get('from'), 'from');
  const to = requireString(url.searchParams.get('to'), 'to');
  const dates = validDateRange(from, to);
  const tour = resolveTour(context.config, tourSlug);
  assertSupportedPartySize(tour, people);
  try {
    priceFor(tour, people, 'default');
    priceFor(tour, people, 'custom');
  } catch {
    throw new HttpError(400, 'validation_failed', 'No price is configured for this party size');
  }
  return { people, dates, tour };
}

async function availabilityPayload(context: BookkitContext, now: string, input: AvailabilityInput): Promise<{ payload: { timezone: string; limitedThreshold: number; days: unknown[] }; stale: boolean }> {
  const { people, dates, tour } = input;
  const firstDay = dates[0];
  const lastDay = dates[dates.length - 1];
  if (!firstDay || !lastDay) throw new HttpError(400, 'validation_failed', 'Date range is empty');
  const dayAfterLast = addDaysToDateKey(lastDay, 1);
  const horizonStart = parseUtcInstant(localDateTimeToUtcIso(`${firstDay}T00:00`, context.config.business.timezone));
  const horizonEnd = parseUtcInstant(localDateTimeToUtcIso(`${dayAfterLast}T00:00`, context.config.business.timezone));
  const lookback = Math.max(...Object.values(context.config.tours).map((candidate) => candidate.durationMin + candidate.turnaroundMin), 0);
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
    const capacityInfo = capacityForDate(date, defaultCapacityForDate(date, context.config.fleet.defaultCapacity, capacityDefaults), overridesByDate);
    if (generateSlots(tour, date, context.config.business.timezone).length === 0) {
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
      tour,
      capacity: capacityInfo.capacity,
      ...(capacityInfo.closedReason !== undefined ? { closedReason: capacityInfo.closedReason } : {}),
      bookings,
      calendarEvents: calendar.events,
      tours: context.config.tours,
      requestedPeople: people,
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
      const normalized = new URL(request.url);
      normalized.searchParams.sort();
      cacheKey = new Request(normalized.toString(), { method: 'GET' });
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

function parsePickup(value: unknown): PickupType {
  if (value !== 'default' && value !== 'custom') throw new HttpError(400, 'validation_failed', 'pickupType must be default or custom');
  return value;
}

function assertSlot(config: BookkitContext['config'], tourSlug: string, start: string, now: string): { tour: ReturnType<typeof resolveTour>; startsAt: string; endsAt: string } {
  const tour = resolveTour(config, tourSlug);
  let instant: Date;
  try {
    instant = parseUtcInstant(start);
  } catch {
    throw new HttpError(400, 'validation_failed', 'start must be an ISO 8601 instant with an explicit offset');
  }
  const localDate = localDateKey(instant, config.business.timezone);
  const slot = generateSlots(tour, localDate, config.business.timezone).find((candidate) => parseUtcInstant(candidate.utcStart).getTime() === instant.getTime());
  if (!slot) throw new HttpError(409, 'slot_unavailable', 'The selected slot is not available');
  if (instant.getTime() < parseUtcInstant(now).getTime() + config.booking.minNoticeHours * 3_600_000) {
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  }
  if (instant.getTime() > parseUtcInstant(now).getTime() + config.booking.maxHorizonDays * 86_400_000) {
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is outside the booking horizon');
  }
  return { tour, startsAt: slot.utcStart, endsAt: slot.utcEnd };
}

async function checkSlot(
  context: BookkitContext,
  tourSlug: string,
  people: number,
  start: string,
  now: string,
  excludeBookingId?: string,
): Promise<{ tour: ReturnType<typeof resolveTour>; startsAt: string; endsAt: string }> {
  const candidate = assertSlot(context.config, tourSlug, start, now);
  const localDate = localDateKey(candidate.startsAt, context.config.business.timezone);
  const override = await context.repo.getDayOverride(localDate);
  const capacityDefaults = await context.repo.listCapacityDefaults();
  const lookback = Math.max(
    ...Object.values(context.config.tours).map((tour) => tour.durationMin + tour.turnaroundMin),
  );
  const windowStart = new Date(parseUtcInstant(candidate.startsAt).getTime() - lookback * 60_000).toISOString();
  const windowEnd = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.tour.turnaroundMin * 60_000).toISOString();
  const bookings = await context.repo.listOccupancyBookings(windowStart, windowEnd);
  const { events: calendarEvents } = await calendarEventsForWindow(context, windowStart, windowEnd, now);
  const day = availabilityForDay({
    date: localDate,
    timezone: context.config.business.timezone,
    tour: candidate.tour,
    capacity: capacityForDate(localDate, defaultCapacityForDate(localDate, context.config.fleet.defaultCapacity, capacityDefaults), override ? [override] : []).capacity,
    bookings,
    calendarEvents,
    tours: context.config.tours,
    requestedPeople: people,
    now,
    minNoticeHours: context.config.booking.minNoticeHours,
    maxHorizonDays: context.config.booking.maxHorizonDays,
    limitedThreshold: context.config.booking.limitedThreshold,
    ...(excludeBookingId ? { excludeBookingId } : {}),
  });
  const available = day.slots.some((slot) => parseUtcInstant(slot.start).getTime() === parseUtcInstant(candidate.startsAt).getTime());
  if (!available) throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  return candidate;
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function handleCheckout(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const tourSlug = requireString(body.tourSlug, 'tourSlug');
    if (!context.config.tours[tourSlug]) throw new HttpError(400, 'validation_failed', 'Unknown tour');
    const start = requireString(body.start, 'start');
    const people = requireInteger(body.people, 'people');
    const pickupType = parsePickup(body.pickupType);
    const locale = requireString(body.locale, 'locale');
    if (!context.config.locales.supported.includes(locale)) throw new HttpError(400, 'validation_failed', 'Unsupported locale');
    const now = nowIso(context);
    await context.repo.sweepExpiredHolds(now);
    assertSupportedPartySize(resolveTour(context.config, tourSlug), people);
    const candidate = await checkSlot(context, tourSlug, people, start, now);
    let priceCents: number;
    try {
      priceCents = priceFor(candidate.tour, people, pickupType);
    } catch {
      throw new HttpError(400, 'validation_failed', 'No price is configured for this party and pickup type');
    }
    const year = Number(localDateKey(candidate.startsAt, context.config.business.timezone).slice(0, 4));
    const prefix = `${context.config.business.shortCode.toUpperCase()}-${year}-`;
    const referenceExists = async (candidateReference: string): Promise<boolean> =>
      (await context.repo.getBookingByReference(candidateReference)) !== null;
    let sequence = await context.repo.countReferencesForYear(prefix) + 1;
    // BK-CAP-001 / AR-001: checkSlot above is only a fast-path pre-check (read-then-write TOCTOU
    // — two concurrent checkouts can both pass it for the same last unit). insertHoldWithCapacity
    // is the authority: it re-evaluates occupied-units-in-interval + requested <= capacity inside
    // the same atomic INSERT ... SELECT ... WHERE as the write itself, so only one concurrent
    // request for the last unit can ever succeed.
    const occupancyUnits = occupancyFor(candidate.tour, people);
    const occupancyEndsAt = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.tour.turnaroundMin * 60_000).toISOString();
    const localDate = localDateKey(candidate.startsAt, context.config.business.timezone);
    let booking: Booking | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reference = await generateUniqueReference(context.config.business.shortCode, year, sequence, referenceExists);
      try {
        const holdLimit = context.config.booking.maxHoldsPerIp;
        // BK-SEC-002: expiry counts from the tour's end, not from creation, so the link keeps
        // working through the whole pre-tour period plus a post-tour grace window — see
        // ClientConfig.booking.tokenExpiryDays (src/core/config.ts).
        const tokenExpiryDays = context.config.booking.tokenExpiryDays ?? DEFAULT_TOKEN_EXPIRY_DAYS;
        const tokensExpireAt = new Date(parseUtcInstant(candidate.endsAt).getTime() + tokenExpiryDays * 86_400_000).toISOString();
        const created = await context.repo.insertHoldWithCapacity({
          id: crypto.randomUUID(), reference, tourSlug, people, pickupType,
          startsAt: candidate.startsAt, endsAt: candidate.endsAt, locale, priceCents,
          holdExpiresAt: new Date(parseUtcInstant(now).getTime() + context.config.booking.holdMinutes * 60_000).toISOString(),
          cancelToken: tokenBytes(), operatorToken: tokenBytes(), createdAt: now, updatedAt: now,
          tokensExpireAt,
          occupancyUnits, occupancyEndsAt, localDate, fleetDefaultCapacity: context.config.fleet.defaultCapacity,
          ...(holdLimit ? { holdIp: clientIp(request), maxActiveHoldsForIp: holdLimit } : {}),
        });
        if (!created) throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
        booking = created;
        break;
      } catch (error) {
        if (error instanceof HoldLimitExceededError) {
          throw new HttpError(429, 'too_many_holds', error.message);
        }
        if (error instanceof HttpError) throw error;
        // Classify the insert failure by re-checking the DB rather than parsing the error
        // message: the table has other UNIQUE columns, so message-sniffing could misfire.
        if (attempt === 11 || !(await referenceExists(reference))) throw error;
        sequence += Math.floor(Math.random() * 5) + 1;
      }
    }
    if (!booking) throw new Error('Unable to create booking hold');
    try {
      // BK-PAY-002: the idempotency key createCheckout derives is scoped to this hold, not this
      // request, so it's fine to expire the hold below on any failure here (a Stripe rejection, a
      // missing Checkout URL, or the updateBooking write) rather than distinguish them. If the
      // *whole* POST is retried by the client after a 5xx, this path mints a fresh hold (and thus a
      // fresh key) rather than reusing this one; that's fine because the idempotency key only needs
      // to prevent a duplicate payable session per hold, not across holds — this hold's now-expired
      // row and any session Stripe did create for it still resolve via the late-webhook backfill
      // path (getBookingBySessionId / metadata.bookingId), same as before this fix.
      const checkout = await context.providers.payments.createCheckout(booking, context.config, context.routeConfig.paths);
      await context.repo.updateBooking(booking.id, { stripeSessionId: checkout.sessionId, updatedAt: nowIso(context) });
      return json({ checkoutUrl: checkout.url, bookingId: booking.id, reference: booking.reference }, 201);
    } catch (error) {
      await context.repo.expireHold(booking.id, nowIso(context)).catch(() => undefined);
      throw error;
    }
  });
}

export function handleStripeWebhook(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const event = await context.providers.payments.parseWebhook(request);
    if (event.type === 'checkout.session.completed') {
      const booking = event.bookingId ? await context.repo.getBookingById(event.bookingId) : event.sessionId ? await context.repo.getBookingBySessionId(event.sessionId) : null;
      if (!booking) return json({ received: true });
      const verification = verifyPayment(booking, {
        completed: true,
        sessionId: event.sessionId,
        paid: event.paid,
        paymentStatus: event.paymentStatus,
        amountTotal: event.amountCaptured,
        currency: event.currency,
        expectedCurrency: context.config.business.currency,
      });
      if (!verification.allowed) {
        context.logger.warn?.('Stripe payment verification rejected', { eventId: event.id, bookingId: booking.id, reason: verification.reason });
        if (verification.reason === 'session_id_missing' || verification.reason === 'session_mismatch') {
          throw new HttpError(409, 'stripe_session_mismatch', 'Stripe session does not match the booking');
        }
        throw new HttpError(409, 'stripe_amount_mismatch', 'Stripe payment does not match the booking price');
      }
      const confirmed = await confirmBookingFromPayment(context, booking, event.paymentIntent ?? null, event);
      await runOwedMutationSideEffects(context, confirmed);
      if (verification.sessionIdToBackfill && confirmed.stripeSessionId !== verification.sessionIdToBackfill) {
        await context.repo.updateBooking(confirmed.id, { stripeSessionId: verification.sessionIdToBackfill, updatedAt: nowIso(context) });
      }
    } else if (event.type === 'checkout.session.expired') {
      const booking = event.bookingId ? await context.repo.getBookingById(event.bookingId) : event.sessionId ? await context.repo.getBookingBySessionId(event.sessionId) : null;
      if (booking) await context.repo.expireHold(booking.id, nowIso(context));
    } else if (event.type === 'charge.refunded') {
      if (event.amountCaptured === undefined || event.amountRefunded === undefined || event.amountRefunded !== event.amountCaptured) {
        context.logger.warn?.('non-full Stripe refund does not cancel booking', { eventId: event.id });
      } else {
        const byPayment = event.paymentIntent && context.repo.getBookingByPaymentIntent
          ? await context.repo.getBookingByPaymentIntent(event.paymentIntent)
          : null;
        const booking = byPayment ?? (event.bookingId ? await context.repo.getBookingById(event.bookingId) : null);
        if (booking) {
          const timestamp = nowIso(context);
          // Reconcile the durable operation record regardless of which side (this webhook or an
          // operator's own claim) ends up owning the booking's cancelled_by — Stripe is the
          // source of truth for whether the money moved, so its refund id/amount always wins here
          // (BK-REFUND-001). Upsert rather than claim: a dashboard-initiated refund has no prior
          // claim to race against.
          const refund = {
            id: crypto.randomUUID(),
            bookingId: booking.id,
            paymentIntent: event.paymentIntent ?? booking.stripePaymentIntent ?? null,
            choice: 'full' as const,
            status: 'succeeded' as const,
            stripeRefundId: event.refundId ?? null,
            amountCents: event.amountRefunded,
            requestedAt: timestamp,
            resolvedAt: timestamp,
          };
          if (booking.status !== 'cancelled') {
            const updated = await context.repo.upsertRefundOperationAndTransitionToCancelled(refund, booking.id, {
              // no_show and cancelled are terminal: a refund arriving after either must not
              // resurrect/overwrite them (spec item 4). CAS loss leaves this webhook's
              // transition as a no-op; the winner's existing outbox drains below, and Stripe
              // still gets 200 so a retry never causes redelivery storms.
              expectedStatusIn: ['hold', 'confirmed', 'expired'],
              cancelledAt: timestamp, cancelledBy: 'operator', updatedAt: timestamp,
              mutationSideEffectKinds: cancellationSideEffectKinds(context, booking, 'booking.cancelled_by_operator'),
            });
            // A concurrent transition (e.g. a customer cancel) can win this race. Only the CAS
            // winner may record and dispatch operator-cancellation side effects.
            if (updated) {
              await dispatchMutation(context, 'booking.cancelled_by_operator', updated);
            } else {
              const fresh = await context.repo.getBookingById(booking.id);
              if (fresh) await runOwedMutationSideEffects(context, fresh);
            }
          } else {
            await context.repo.reconcileStripeRefundOperation(refund);
            // BK-SIDE-001 (handoff 13): idempotent redelivery of an already-cancelled booking —
            // still a booking-touching request, so drain any rows a prior delivery left owed
            // (e.g. the isolate died between this same webhook's earlier CAS win and its attempt).
            await runOwedMutationSideEffects(context, booking);
          }
        }
      }
    } else if (event.type === 'charge.dispute.created') {
      const byPayment = event.paymentIntent && context.repo.getBookingByPaymentIntent
        ? await context.repo.getBookingByPaymentIntent(event.paymentIntent)
        : null;
      const booking = byPayment ?? (event.bookingId ? await context.repo.getBookingById(event.bookingId) : null);
      context.logger.warn?.('Stripe dispute created', { eventId: event.id, bookingId: booking?.id ?? event.bookingId });
      if (booking) dispatchNonCritical(context, 'payment.dispute_created', booking);
    }
    return json({ received: true });
  });
}

function bookingSummary(context: BookkitContext, booking: Booking): Record<string, unknown> {
  const tour = resolveTour(context.config, booking.tourSlug);
  return {
    reference: booking.reference,
    tourSlug: booking.tourSlug,
    start: utcToLocalIso(booking.startsAt, context.config.business.timezone),
    end: utcToLocalIso(booking.endsAt, context.config.business.timezone),
    people: booking.people,
    pickupType: booking.pickupType,
    pickupAddress: booking.pickupAddress,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    locale: booking.locale,
    status: booking.status,
    priceCents: booking.priceCents,
    meetingPoint: tour.meetingPoint,
  };
}

function confirmationSummary(context: BookkitContext, booking: Booking): Record<string, unknown> {
  const tour = resolveTour(context.config, booking.tourSlug);
  return {
    reference: booking.reference,
    tourSlug: booking.tourSlug,
    start: utcToLocalIso(booking.startsAt, context.config.business.timezone),
    end: utcToLocalIso(booking.endsAt, context.config.business.timezone),
    people: booking.people,
    priceCents: booking.priceCents,
    meetingPoint: tour.meetingPoint,
    locale: booking.locale,
  };
}

// Anchored on immutable createdAt so polling and fulfillment retries cannot renew access; four hours covers the normal hold TTL plus post-payment viewing.
const STATUS_DETAIL_GRACE_MS = 4 * 60 * 60_000;

export function handleStatus(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const sessionId = new URL(request.url).searchParams.get('session_id');
    if (!sessionId) throw new HttpError(400, 'validation_failed', 'session_id is required');
    const booking = await context.repo.getBookingBySessionId(sessionId);
    if (!booking) return json({ status: 'not_found' });
    let current = booking;
    if (current.status === 'hold' || current.status === 'expired') {
      const session = await context.providers.payments.getSession(sessionId);
      const verification = verifyPayment(current, {
        completed: session.status === 'complete',
        sessionId: session.id,
        paid: session.paymentStatus === 'paid',
        paymentStatus: session.paymentStatus,
        amountTotal: session.amountTotal,
        currency: session.currency,
        expectedCurrency: context.config.business.currency,
      });
      if (verification.allowed) {
        try {
          current = await confirmBookingFromPayment(context, current, session.paymentIntent ?? null, session);
        } catch (error) {
          if (!(error instanceof ConfirmationInProgressError)) throw error;
          current = await context.repo.getBookingById(current.id) ?? current;
        }
      } else if (session.status === 'complete') {
        context.logger.warn?.('Stripe payment verification rejected', { bookingId: current.id, reason: verification.reason });
        return json({ status: 'pending' });
      } else if (session.status === 'expired' && current.status === 'hold') {
        current = await context.repo.expireHold(current.id, nowIso(context))
          ?? await context.repo.getBookingById(current.id)
          ?? current;
      }
    } else if (current.status === 'confirmed') {
      const confirmationOperations = (await context.repo.listSideEffectOperations(current.id))
        .filter(isConfirmationSideEffectOperation);
      const needsFulfillment = confirmationOperations.some((operation) => operation.status !== 'succeeded')
        || (confirmationOperations.length === 0 && (!current.calendarSynced || !current.emailSynced));
      if (needsFulfillment) {
        try {
          current = await confirmBookingFromPayment(context, current);
        } catch (error) {
          if (!(error instanceof ConfirmationInProgressError)) throw error;
          current = await context.repo.getBookingById(current.id) ?? current;
        }
      }
    }
    // BK-SIDE-001 (handoff 13): a booking-touching request — drain any mutation-path side effects
    // (per-recipient email, Tourflow push) still owed from a prior cancel/reschedule/no-show whose
    // delivery attempt didn't finish. Confirmed/cancelled/no_show are the only statuses a mutation
    // event ever fires for; hold/expired never have rows here.
    if (current.status === 'confirmed' || current.status === 'cancelled' || current.status === 'no_show') {
      await runOwedMutationSideEffects(context, current);
    }
    if (current.status === 'confirmed') {
      const age = parseUtcInstant(nowIso(context)).getTime() - parseUtcInstant(current.createdAt).getTime();
      if (age > STATUS_DETAIL_GRACE_MS) return json({ status: 'confirmed' });
      return json({ status: 'confirmed', booking: confirmationSummary(context, current) });
    }
    if (current.status === 'expired') return json({ status: 'expired' });
    if (current.status === 'cancelled' || current.status === 'no_show') return json({ status: 'cancelled' });
    return json({ status: 'pending' });
  }).then(withSensitiveHeaders);
}

// BK-SEC-002: getBookingByCancelToken/getBookingByOperatorToken enforce expiry (tokens_expire_at)
// and, for the cancel token, revocation (cancel_token_revoked_at) as part of the same lookup
// query (src/repo.ts) — an expired or revoked token comes back as a plain null here, identical to
// an unknown one, so this stays a single `if (!booking) throw 403` with no separate check needed.
async function tokenBooking(context: BookkitContext, token: string, operator = false, refundRecovery = false): Promise<Booking> {
  const now = nowIso(context);
  const booking = operator
    ? await (refundRecovery
      ? context.repo.getBookingByOperatorTokenForRefundRecovery(token, now)
      : context.repo.getBookingByOperatorToken(token, now))
    : await context.repo.getBookingByCancelToken(token, now);
  if (!booking) throw new HttpError(403, 'forbidden', 'Invalid booking token');
  // BK-SIDE-001 (handoff 13): every caller of tokenBooking is a mutation-adjacent request
  // (customer cancel/reschedule, and — via operatorBooking below — operator cancel/reschedule/
  // no-show) touching this exact booking, so this is one of the places a later request must drain
  // rows a prior mutation's delivery attempt left owed. Draining here doesn't affect the booking
  // object itself (it only ever touches side_effect_operations, never `bookings`).
  await runOwedMutationSideEffects(context, booking);
  return booking;
}

export function handleManage(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const token = new URL(request.url).searchParams.get('token');
    if (!token) throw new HttpError(403, 'forbidden', 'A booking token is required');
    const now = nowIso(context);
    const customer = await context.repo.getBookingByCancelToken(token, now);
    const booking = customer ?? await context.repo.getBookingByOperatorToken(token, now);
    if (!booking) throw new HttpError(403, 'forbidden', 'Invalid booking token');
    // BK-SIDE-001 (handoff 13): the manage page is read via a direct token lookup, not
    // tokenBooking, so it needs its own drain call — still a booking-touching request a prior
    // mutation's undelivered side effects should get to piggyback on.
    await runOwedMutationSideEffects(context, booking);
    const operator = !customer;
    return json({ booking: bookingSummary(context, booking), role: operator ? 'operator' : 'customer', canCancel: operator ? booking.status === 'confirmed' : canCancelBooking(booking, now, context.config.booking.cancelCutoffHours), canReschedule: operator ? booking.status === 'confirmed' : canRescheduleBooking(booking, now, context.config.booking.reschedule.cutoffHours, context.config.booking.reschedule.enabled), canNoShow: operator && booking.status === 'confirmed' && parseUtcInstant(booking.startsAt).getTime() < parseUtcInstant(now).getTime(), deadline: new Date(parseUtcInstant(booking.startsAt).getTime() - context.config.booking.cancelCutoffHours * 3_600_000).toISOString() });
  }).then(withSensitiveHeaders);
}

function cancellationSideEffectKinds(
  context: BookkitContext,
  booking: Booking,
  event: 'booking.cancelled_by_customer' | 'booking.cancelled_by_operator',
) {
  return [
    ...mutationSideEffectKinds(context, event),
    ...(booking.calendarEventId ? ['calendar_delete' as const] : []),
  ];
}

async function calendarPatch(context: BookkitContext, booking: Booking): Promise<void> {
  if (booking.calendarEventId && context.providers.calendar) {
    await context.providers.calendar.patchEvent(booking.calendarEventId, booking, context.config);
  }
}

export function handleCustomerCancel(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const token = requireString(body.token, 'token');
    const booking = await tokenBooking(context, token);
    if (booking.status === 'cancelled') return json({ ok: true });
    if (booking.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
    if (!canCancelBooking(booking, nowIso(context), context.config.booking.cancelCutoffHours)) throw new HttpError(403, 'past_cutoff', 'The cancellation deadline has passed');
    const cancelled = cancelBooking(booking, 'customer', nowIso(context));
    const updated = await context.repo.transitionToCancelled(cancelled.id, {
      expectedStatusIn: ['confirmed'], expectedStartsAt: booking.startsAt,
      cancelledAt: cancelled.updatedAt, cancelledBy: 'customer', updatedAt: cancelled.updatedAt,
      mutationSideEffectKinds: cancellationSideEffectKinds(context, booking, 'booking.cancelled_by_customer'),
    });
    if (!updated) {
      // CAS loss always surfaces as a conflict here (never an idempotent 200): a concurrent
      // reschedule leaves status='confirmed' but a different starts_at — the customer's cancel
      // decision was computed against the stale start time, so it must not silently succeed.
      const fresh = await context.repo.getBookingById(cancelled.id);
      if (fresh?.status === 'confirmed' && fresh.startsAt !== booking.startsAt) {
        throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
      }
      throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
    }
    await dispatchMutation(context, 'booking.cancelled_by_customer', updated);
    return json({ ok: true });
  });
}

async function readNewStart(body: Record<string, unknown>): Promise<string> {
  return requireString(body.newStart, 'newStart');
}

async function rescheduleWithToken(context: BookkitContext, booking: Booking, newStart: string, operator: boolean): Promise<Booking> {
  const now = nowIso(context);
  if (booking.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be rescheduled');
  if (!operator && !canRescheduleBooking(booking, now, context.config.booking.reschedule.cutoffHours, context.config.booking.reschedule.enabled)) throw new HttpError(403, 'past_cutoff', 'The reschedule deadline has passed');
  const candidate = await checkSlot(context, booking.tourSlug, booking.people, newStart, now, booking.id);
  const next = rescheduleBooking(booking, candidate.startsAt, candidate.tour.durationMin, now);
  if (next.startsAt === booking.startsAt && next.endsAt === booking.endsAt) {
    // A prior calendar patch can fail after the transition and notification debt committed. Retrying
    // the same target must repair that patch without minting a second reschedule version or notice.
    await calendarPatch(context, booking);
    return booking;
  }
  // BK-CAP-001: checkSlot above is only a fast-path pre-check (read-then-write TOCTOU — two
  // concurrent reschedules into the same last unit can both pass it). rescheduleWithCapacity is
  // the authority: it re-evaluates the CAS (status + starts_at) and occupied-units-in-interval +
  // requested <= capacity inside the same atomic UPDATE ... WHERE as the write itself.
  const occupancyUnits = occupancyFor(candidate.tour, booking.people);
  const occupancyEndsAt = new Date(parseUtcInstant(next.endsAt).getTime() + candidate.tour.turnaroundMin * 60_000).toISOString();
  const localDate = localDateKey(next.startsAt, context.config.business.timezone);
  // BK-SEC-002 (patch-11-r1 MEDIUM 2): recompute from the NEW endsAt, exactly like checkout does
  // from the original endsAt (see handleCheckout above) — otherwise a booking moved later could
  // have its manage link expire before the rescheduled tour happens, and one moved earlier would
  // keep an over-long window relative to its new end.
  const tokenExpiryDays = context.config.booking.tokenExpiryDays ?? DEFAULT_TOKEN_EXPIRY_DAYS;
  const tokensExpireAt = new Date(parseUtcInstant(next.endsAt).getTime() + tokenExpiryDays * 86_400_000).toISOString();
  const updated = await context.repo.rescheduleWithCapacity(next.id, {
    expectedStatus: 'confirmed',
    expectedStartsAt: booking.startsAt,
    startsAt: next.startsAt,
    endsAt: next.endsAt,
    rescheduledFrom: booking.startsAt,
    updatedAt: next.updatedAt,
    now,
    tokensExpireAt,
    occupancyUnits, occupancyEndsAt, localDate, fleetDefaultCapacity: context.config.fleet.defaultCapacity,
    mutationSideEffectKinds: mutationSideEffectKinds(context, 'booking.rescheduled'),
  });
  if (!updated) {
    const fresh = await context.repo.getBookingById(next.id);
    if (!fresh || fresh.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be rescheduled');
    // Status is still confirmed but the write lost the atomic guard — either a concurrent
    // reschedule moved starts_at, or no capacity remained (someone else took the last unit, or
    // an admin day-override shrank capacity concurrently). Both surface identically: the slot
    // this request computed availability against is gone.
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  }
  await calendarPatch(context, updated);
  await dispatchMutation(context, 'booking.rescheduled', updated);
  return updated;
}

export function handleCustomerReschedule(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await tokenBooking(context, requireString(body.token, 'token'));
    await rescheduleWithToken(context, booking, await readNewStart(body), false);
    return json({ ok: true });
  });
}

async function operatorBooking(
  context: BookkitContext,
  request: Request,
  body: Record<string, unknown>,
  refundRecovery = false,
): Promise<Booking> {
  const operatorToken = typeof body.operatorToken === 'string' ? body.operatorToken : null;
  if (operatorToken) return tokenBooking(context, operatorToken, true, refundRecovery);
  const expected = await getSecret(context, 'TOURFLOW_SHARED_SECRET');
  const supplied = bearerToken(request);
  if (!expected || !supplied || !constantTimeEqual(expected, supplied)) throw new HttpError(403, 'forbidden', 'Operator authorization required');
  const bookingId = requireString(body.bookingId, 'bookingId');
  const booking = await context.repo.getBookingById(bookingId);
  if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');
  // BK-SIDE-001 (handoff 13): the operator-token branch above already drains via tokenBooking —
  // this bearer-token branch is the other way an operator-adjacent request loads a booking, so it
  // needs the same drain call.
  await runOwedMutationSideEffects(context, booking);
  return booking;
}

// Executes (or resumes) the Stripe side of a claimed refund operation and records the outcome
// (BK-REFUND-001). Safe to call more than once for the same operation id: refund() carries
// Stripe's own idempotency key, so a resumed/retried call cannot double-refund even when a
// previous attempt's D1 write never landed (crash between Stripe success and recording it).
async function resolvePendingRefund(
  context: BookkitContext,
  booking: Booking,
  operationId: string,
  choice: 'full' | 'none',
  paymentIntent: string | null,
): Promise<void> {
  const { id: bookingId, priceCents } = booking;
  if (choice === 'none') {
    await context.repo.resolveRefundOperation(operationId, { status: 'succeeded', resolvedAt: nowIso(context) });
    return;
  }
  if (!paymentIntent) {
    // Legacy requested rows can bypass the pre-claim guard below. They must remain visibly
    // unresolved rather than claiming a full refund succeeded when Stripe was never called.
    await context.repo.resolveRefundOperation(operationId, {
      status: 'failed', error: 'Stripe payment intent is missing', resolvedAt: nowIso(context),
    });
    throw new HttpError(409, 'refund_payment_intent_missing', 'Cannot refund a booking without a Stripe payment intent');
  }
  // A same-choice loser can hold a stale requested snapshot while the winner records success.
  // Re-read immediately before Stripe so it does not turn that success into a needless retry.
  const current = await context.repo.getRefundOperationByBookingId(bookingId);
  if (current?.id !== operationId || current.status === 'succeeded') return;
  let result: { refundId: string; amountCents: number };
  try {
    result = await context.providers.payments.refund(paymentIntent, priceCents);
  } catch (error) {
    // Only a failure of the Stripe call itself is a genuine refund failure — record it so the
    // operation row remains for retry/reconciliation.
    await context.repo.resolveRefundOperation(operationId, {
      status: 'failed', error: error instanceof Error ? error.message : 'Refund failed', resolvedAt: nowIso(context),
    });
    throw new HttpError(502, 'refund_failed', 'The refund could not be completed; it will be retried');
  }
  // Stripe has already moved the money by this point — a failure recording that outcome to D1
  // must never be classified as a Stripe failure (that would misreport a completed refund as
  // failed, or mark it 'failed' forever). Let a write failure here propagate as a plain error
  // instead: the row stays 'requested', and a retry recovers the same result via Stripe's
  // idempotency key (or, once that key's ~24h window has lapsed, via refunds.list reconciliation
  // in StripeProvider.refund) rather than ever double-refunding or losing the outcome.
  await context.repo.resolveRefundOperation(operationId, {
    status: 'succeeded', stripeRefundId: result.refundId, amountCents: result.amountCents, resolvedAt: nowIso(context),
  });
}

// Reconciles a request against the refund-operation row for an already-cancelled booking
// (BK-REFUND-001). Used both when the booking was already cancelled on entry and when this
// request's own CAS cancel attempt lost to a concurrent same-choice winner. In both cases Stripe
// may only be touched for the operation that actually won the claim, and only once its choice
// matches this request's own — a different-choice request must never drive (or silently agree
// with) another request's Stripe call.
async function reconcileCancelledRefund(
  context: BookkitContext,
  booking: Booking,
  refund: 'full' | 'none',
): Promise<Response> {
  const existing = await context.repo.getRefundOperationByBookingId(booking.id);
  if (!existing) {
    if (refund === 'none') return json({ ok: true });
    if (booking.stripePaymentIntent === null) {
      throw new HttpError(409, 'refund_payment_intent_missing', 'Cannot refund a booking without a Stripe payment intent');
    }
    const operationId = crypto.randomUUID();
    const claimed = await context.repo.claimRefundOperation({
      id: operationId,
      bookingId: booking.id,
      paymentIntent: booking.stripePaymentIntent,
      choice: refund,
      requestedAt: nowIso(context),
    });
    if (claimed) {
      await resolvePendingRefund(context, booking, operationId, refund, booking.stripePaymentIntent);
      return json({ ok: true });
    }
    const concurrent = await context.repo.getRefundOperationByBookingId(booking.id);
    if (!concurrent || concurrent.choice !== refund) {
      throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
    }
    if (concurrent.status !== 'succeeded') {
      await resolvePendingRefund(context, booking, concurrent.id, concurrent.choice, concurrent.paymentIntent ?? booking.stripePaymentIntent);
    }
    return json({ ok: true });
  }
  if (existing.choice !== refund) {
    throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
  }
  if (existing.status !== 'succeeded') {
    await resolvePendingRefund(context, booking, existing.id, existing.choice, existing.paymentIntent ?? booking.stripePaymentIntent ?? null);
  }
  return json({ ok: true });
}

async function completeClaimedOperatorCancellation(
  context: BookkitContext,
  booking: Booking,
  operationId: string,
  refund: 'full' | 'none',
): Promise<Response> {
  const cancelled = cancelBooking(booking, 'operator', nowIso(context));
  const updated = await context.repo.transitionToCancelled(cancelled.id, {
    expectedStatusIn: ['confirmed'], expectedStartsAt: booking.startsAt,
    cancelledAt: cancelled.updatedAt, cancelledBy: 'operator', updatedAt: cancelled.updatedAt,
    mutationSideEffectKinds: cancellationSideEffectKinds(context, booking, 'booking.cancelled_by_operator'),
  });
  if (!updated) {
    const fresh = await context.repo.getBookingById(cancelled.id);
    if (fresh?.status === 'cancelled') return reconcileCancelledRefund(context, fresh, refund);
    // A non-cancelled winner makes this request's decision unusable. The repository only
    // deletes requested rows, so a webhook's already-recorded Stripe success cannot be lost.
    await context.repo.deleteRefundOperation(operationId);
    if (fresh?.status === 'confirmed' && fresh.startsAt !== booking.startsAt) {
      throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
    }
    throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
  }

  await dispatchMutation(context, 'booking.cancelled_by_operator', updated);
  await resolvePendingRefund(context, booking, operationId, refund, booking.stripePaymentIntent ?? null);
  return json({ ok: true });
}

export function handleOperatorCancel(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body, true);
    const refund = body.refund === 'full' ? 'full' : body.refund === 'none' ? 'none' : null;
    if (!refund) throw new HttpError(400, 'validation_failed', 'refund must be full or none');

    if (booking.status === 'cancelled') {
      // Already cancelled, but the refund claimed for it might not have finished (a crash
      // between the Stripe call and recording it, or an earlier Stripe failure never retried).
      // Resume it instead of silently reporting ok while the money side is unresolved — but only
      // when this request's own choice is the one that actually won the claim (finding #2).
      return reconcileCancelledRefund(context, booking, refund);
    }
    if (booking.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
    if (refund === 'full' && booking.stripePaymentIntent === null) {
      // Free bookings also use refund='none': requiring an intent for every 'full' choice keeps
      // the durable operation record an honest statement that Stripe money was refunded.
      throw new HttpError(409, 'refund_payment_intent_missing', 'Cannot refund a booking without a Stripe payment intent');
    }

    // Claim-then-act (BK-REFUND-001): the refund decision is durably recorded before Stripe is
    // ever touched, so a refund=full and refund=none request racing on this booking can never
    // both call Stripe. Winning this claim only earns the right to attempt the CAS cancel below —
    // it is that CAS transition, not the claim, that is the authoritative gate: Stripe is only
    // ever reached once the booking is confirmed durably cancelled (finding #1).
    const operationId = crypto.randomUUID();
    const claimed = await context.repo.claimRefundOperation({
      id: operationId, bookingId: booking.id, paymentIntent: booking.stripePaymentIntent ?? null,
      choice: refund, requestedAt: nowIso(context),
    });
    if (!claimed) {
      // Lost the claim to a concurrent request for this booking. Same choice = treat as the same
      // logical operation and resume it; a different choice already won = surface the conflict
      // rather than silently agreeing with (or fighting) a decision this request didn't make.
      const existing = await context.repo.getRefundOperationByBookingId(booking.id);
      if (!existing || existing.choice !== refund) {
        throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
      }
      if (existing.status === 'succeeded') return json({ ok: true });
      const fresh = await context.repo.getBookingById(booking.id);
      if (existing.status === 'requested' && fresh?.status === 'confirmed') {
        // A crash or calendar failure can leave a claimed decision before its CAS. Resume the
        // whole operation, not only Stripe: the CAS remains the gate that makes a refund safe.
        return completeClaimedOperatorCancellation(context, booking, existing.id, refund);
      }
      // The claim-holder may have won its CAS but not resolved Stripe yet. Never resume its
      // refund until the booking is durably cancelled (finding #1).
      if (fresh?.status !== 'cancelled') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
      await resolvePendingRefund(context, booking, existing.id, existing.choice, existing.paymentIntent ?? booking.stripePaymentIntent ?? null);
      return json({ ok: true });
    }

    return completeClaimedOperatorCancellation(context, booking, operationId, refund);
  });
}

export function handleOperatorReschedule(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body);
    await rescheduleWithToken(context, booking, await readNewStart(body), true);
    return json({ ok: true });
  });
}

export function handleOperatorNoShow(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body);
    if (booking.status === 'no_show') return json({ ok: true });
    try {
      const next = markNoShow(booking, nowIso(context));
      const updated = await context.repo.transitionToNoShow(next.id, {
        expectedStatusIn: ['confirmed'], updatedAt: next.updatedAt,
        mutationSideEffectKinds: mutationSideEffectKinds(context, 'booking.no_show'),
      });
      // CAS loss is always a conflict here, not an idempotent 200 — the caught error below
      // converts it to the same 409 invalid_transition the wrong-state check already uses.
      if (!updated) throw new Error('Booking cannot be marked no-show');
      await dispatchMutation(context, 'booking.no_show', updated);
      return json({ ok: true });
    } catch (error) {
      throw new HttpError(409, 'invalid_transition', error instanceof Error ? error.message : 'Booking cannot be marked no-show');
    }
  });
}

function defaultFeedBooking(booking: Booking): Record<string, unknown> {
  return {
    id: booking.id,
    reference: booking.reference,
    tourSlug: booking.tourSlug,
    people: booking.people,
    pickupType: booking.pickupType,
    pickupAddress: booking.pickupAddress,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    locale: booking.locale,
    priceCents: booking.priceCents,
    status: booking.status,
    cancelledBy: booking.cancelledBy,
    rescheduledFrom: booking.rescheduledFrom,
    updatedAt: booking.updatedAt,
  };
}

export function handleFeed(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const expected = await getSecret(context, 'TOURFLOW_SHARED_SECRET');
    const supplied = bearerToken(request);
    if (!expected || !supplied || !constantTimeEqual(expected, supplied)) throw new HttpError(403, 'forbidden', 'Feed authorization required');
    const since = new URL(request.url).searchParams.get('since');
    if (!since) throw new HttpError(400, 'validation_failed', 'since is required');
    let canonicalSince: string;
    try {
      canonicalSince = parseUtcInstant(since).toISOString();
    } catch {
      throw new HttpError(400, 'validation_failed', 'since must be an ISO 8601 instant with an explicit offset');
    }
    await context.repo.sweepExpiredHolds(nowIso(context));
    const rows = await context.repo.listSince(canonicalSince);
    const bookings = rows.map((booking) => context.providers.ops?.mapBooking?.(booking, context.config) ?? defaultFeedBooking(booking));
    return json({ bookings }, 200, { 'cache-control': 'no-store' });
  });
}

interface AdminAccess {
  // The Access-authenticated subject the admin CSRF token binds to ('' when the verifier reports a
  // plain boolean rather than claims — see the BookkitContext.verifyAccess doc comment).
  sub: string;
}

async function accessAllowed(request: Request, context: BookkitContext): Promise<AdminAccess | null> {
  if (!context.verifyAccess) return null;
  try {
    const result = await context.verifyAccess(request);
    if (!result) return null;
    // A caller-supplied verifyAccess is only contractually required to return boolean (see
    // BookkitContext.verifyAccess) — there's no claim in a `true` to bind a per-user token to, so
    // this falls back to the empty subject. The resulting CSRF token is session-agnostic (any
    // Access-authorized caller's token verifies for any other), not a weaker token: it's still
    // unforgeable (HMAC'd with the real BOOKKIT_CSRF_SECRET, see src/admin-csrf.ts) and still
    // requires layer 1's same-origin check to ever reach the app. Only the default JWT-based
    // verifyAccessJwt path (src/runtime-context.ts) exposes real claims and gets a user-bound token.
    if (typeof result === 'boolean') return { sub: '' };
    const email = typeof result.email === 'string' ? result.email : undefined;
    const sub = typeof result.sub === 'string' ? result.sub : undefined;
    return { sub: email ?? sub ?? '' };
  } catch {
    return null;
  }
}

interface AdminFilters {
  q: string;
  status: string;
}

const navIcons = {
  bookings: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
  days: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>',
  settings: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

// The app-shell navigation shared by the admin and settings pages. Anchors deep-link into the
// admin page's sections; everything stays plain links, no script.
function adminSidebar(context: BookkitContext, messages: ReturnType<typeof resolveMessages>, active: 'admin' | 'settings'): string {
  const adminPath = escapeHtml(context.routeConfig.paths.adminPage);
  const link = (href: string, icon: string, label: string, isActive: boolean): string =>
    `<a href="${href}"${isActive ? ' class="bk-active" aria-current="page"' : ''}>${icon} ${escapeHtml(label)}</a>`;
  return `<p class="bk-sidebar-brand">${escapeHtml(context.config.business.name)}</p>`
    + link(`${adminPath}#bk-bookings`, navIcons.bookings, messages['admin.navBookings'], active === 'admin')
    + link(`${adminPath}#bk-days`, navIcons.days, messages['admin.navDays'], false)
    + link(`${adminPath}?view=settings`, navIcons.settings, messages['admin.settings'], active === 'settings');
}

function matchesAdminFilters(booking: Booking, filters: AdminFilters): boolean {
  if (filters.status && booking.status !== filters.status) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack = [booking.reference, booking.tourSlug, booking.pickupType, booking.pickupAddress ?? '', booking.customerName ?? '', booking.customerEmail ?? ''].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

// BK-SEC-002 (patch-11-r1 LOW 1): shared by every admin manage-link render site below (the
// bookings table, the day-detail island, and its server-rendered fallback) — never build an href
// from a token that isn't presentable (see isManageableToken, src/providers/brevo.ts: a
// `nohash:`-prefixed placeholder, meaning no decryptable blob exists to regenerate the real link
// from). null tells each call site to render the "unavailable" fallback instead of a dead link.
function manageLinkHref(managePagePath: string, token: string): string | null {
  return isManageableToken(token) ? `${managePagePath}?token=${encodeURIComponent(token)}` : null;
}

function adminPage(
  context: BookkitContext,
  bookings: Booking[],
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
): string {
  // Admin is operator-facing (behind Cloudflare Access), so copy uses the business default locale.
  const locale = context.config.locales.default;
  const messages = resolveMessages(context.config, locale);
  const timezone = context.config.business.timezone;
  const managePagePath = context.routeConfig.paths.managePage;
  const filtered = bookings.filter((booking) => matchesAdminFilters(booking, filters));

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
    const pickupLabel = booking.pickupType === 'custom' ? messages['widget.pickupCustom'] : messages['widget.pickupDefault'];
    const pickupSub = booking.pickupType === 'custom' && booking.pickupAddress
      ? `<span class="bk-sub">${escapeHtml(booking.pickupAddress)}</span>`
      : '';
    const manageHref = manageLinkHref(managePagePath, booking.operatorToken);
    const manageCell = manageHref
      ? `<a href="${escapeHtml(manageHref)}">${escapeHtml(messages['admin.manage'])}</a>`
      : `<span class="bk-sub">${escapeHtml(messages['admin.manageUnavailable'])}</span>`;
    return `<tr>`
      + `<td>${escapeHtml(formatDateTime(utcToLocalIso(booking.startsAt, timezone), locale, timezone))}<span class="bk-sub bk-mono">${escapeHtml(booking.reference)}</span></td>`
      + `<td><strong>${escapeHtml(customerPrimary)}</strong>${customerSub}</td>`
      + `<td>${escapeHtml(booking.tourSlug)}<span class="bk-sub">${escapeHtml(people)} · ${escapeHtml(price)}</span></td>`
      + `<td>${escapeHtml(pickupLabel)}${pickupSub}</td>`
      + `<td>${statusBadge(booking.status, messages)}</td>`
      + `<td>${manageCell}</td>`
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
  const filterForm = `<form method="get" class="bk-filters" role="search">`
    + (editDate ? `<input type="hidden" name="date" value="${escapeHtml(editDate)}">` : '')
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.search'])}</span><input class="bk-input" type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="${escapeHtml(messages['admin.searchPlaceholder'])}"></label>`
    + `<label class="bk-field"><span>${escapeHtml(messages['admin.filterStatus'])}</span><select class="bk-select" name="status">${statusOptions}</select></label>`
    + `<button type="submit" class="bk-btn bk-btn--secondary">${escapeHtml(messages['admin.apply'])}</button></form>`;

  const resultsBadge = formatMessage(messages[filtered.length === 1 ? 'admin.resultsOne' : 'admin.results'], { n: filtered.length });
  const bookingsSection = `<section class="bk-card" id="bk-bookings"><h2>${escapeHtml(messages['admin.bookings'])} <span class="bk-badge">${escapeHtml(resultsBadge)}</span></h2>`
    + filterForm
    + (filtered.length === 0
      ? `<p class="bk-lead">${escapeHtml(messages['admin.noBookings'])}</p>`
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
    + `<h2 data-bookkit-day-title>${escapeHtml(editDate ? formatDayDate(editDate, locale) : messages['admin.overrideTitle'])}</h2>`
    + savedAlert('day')
    + dayDetail
    + `<p class="bk-hint">${escapeHtml(messages['admin.overrideHint'])} ${escapeHtml(formatMessage(messages['admin.overrideDefault'], { n: editDefault }))}</p>`
    + `<label class="bk-field"><span>${escapeHtml(messages['common.date'])}</span><input class="bk-input" name="date" type="date" required value="${escapeHtml(editDate)}"></label>`
    + `<label class="bk-field" data-bookkit-to><span>${escapeHtml(messages['admin.overrideTo'])}</span><input class="bk-input" name="toDate" type="date"></label>`
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
  const daysSection = `<section class="bk-card" id="bk-days"><h2>${escapeHtml(messages['admin.days'])}</h2>`
    + `<p class="bk-hint">${escapeHtml(messages['admin.daysHint'])}</p>`
    + `<p class="bk-legend">${legend}</p>`
    + `<div class="bk-days-layout"><div class="bk-months">${monthGrids}</div><div>${overrideForm}${defaultForm}</div></div>`
    + `</section>`;

  return pageShell({
    lang: locale,
    title: `${messages['admin.title']} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss),
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    sidebar: adminSidebar(context, messages, 'admin'),
    theme: context.viewerTheme,
    themeToggle: themeToggle(messages, context.viewerTheme),
    body: `<div class="bk-toolbar"><h1>${escapeHtml(messages['admin.title'])}</h1></div>${bookingsSection}${daysSection}`,
  });
}

// The admin settings page (?view=settings). Layout follows settings-page UX conventions: grouped
// sections behind a tab bar (one section on screen at a time), single-column fields within a
// section (multi-column forms measurably hurt comprehension), plain-language helper text per
// setting, switches for booleans, a per-field "Reset" where a value deviates from the file config,
// and a visible saved confirmation after POST. Tabs degrade to plain links without JS.
// csrfToken is undefined when BOOKKIT_CSRF_SECRET isn't configured — see adminPage's csrfToken param above.
function settingsPage(context: BookkitContext, storedRows: Record<string, string>, saved: boolean, sectionParam: string, csrfToken: string | undefined): string {
  const locale = context.config.locales.default;
  const messages = resolveMessages(context.config, locale);
  const catalog = messages as Record<string, string>;
  // One section visible at a time behind a tab bar; tabs are plain links (?section=) so switching
  // works without JS, and the enhancer upgrades them to instant in-page toggles. The section query
  // param survives save redirects because forms post to the current URL.
  const activeSection = ([...settingSections, 'config'] as string[]).includes(sectionParam)
    ? sectionParam
    : settingSections[0] ?? 'policy';
  // What the operator's values fall back to: the pristine file config when overrides are active.
  const base = context.baseConfig ?? context.config;
  const sectionTitles: Record<SettingSection, string> = {
    policy: messages['admin.sectionPolicy'],
    contact: messages['admin.sectionContact'],
    payments: messages['admin.sectionPayments'],
    legal: messages['admin.sectionLegal'],
  };
  const sectionHints: Record<SettingSection, string> = {
    policy: messages['admin.sectionPolicyHint'],
    contact: messages['admin.sectionContactHint'],
    payments: messages['admin.sectionPaymentsHint'],
    legal: messages['admin.sectionLegalHint'],
  };
  const methodLabel = (method: string): string =>
    method === 'card' ? messages['setting.paymentsCard'] : messages['setting.paymentsMbway'];
  const displayValue = (value: SettingValue): string => {
    if (value === null) return messages['admin.none'];
    if (typeof value === 'boolean') return value ? messages['admin.on'] : messages['admin.off'];
    if (Array.isArray(value)) return value.map(methodLabel).join(', ');
    return String(value);
  };

  const fieldMarkup = (definition: SettingDefinition): string => {
    const label = catalog[definition.labelKey] ?? definition.key;
    const helpText = catalog[`${definition.labelKey}.hint`];
    const help = helpText ? `<span class="bk-hint">${escapeHtml(helpText)}</span>` : '';
    const effective = definition.get(context.config);
    // The deviation row: only where a DB override exists — shows what the value falls back to and
    // resets just this field. The reset button lives outside the <label> so clicking it never
    // toggles or focuses the control it belongs to.
    const modified = storedRows[definition.key] !== undefined
      ? `<span class="bk-modified"><span class="bk-badge bk-badge--accent">${escapeHtml(messages['admin.modified'])}</span>`
        + `<span>${escapeHtml(formatMessage(messages['admin.default'], { v: displayValue(definition.get(base)) }))}</span>`
        + `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset:${escapeHtml(definition.key)}" formnovalidate>${escapeHtml(messages['admin.resetField'])}</button></span>`
      : '';
    const kind = definition.kind;
    if (kind.type === 'boolean') {
      return `<div class="bk-setting"><label class="bk-switch"><input type="checkbox" name="${escapeHtml(definition.key)}"${effective ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>${help}${modified}</div>`;
    }
    if (kind.type === 'methods') {
      const selected = new Set(effective as string[]);
      const boxes = (['card', 'mb_way'] as const).map((method) =>
        `<label class="bk-check"><input type="checkbox" name="${escapeHtml(definition.key)}" value="${method}"${selected.has(method) ? ' checked' : ''}><span>${escapeHtml(methodLabel(method))}</span></label>`).join('');
      return `<div class="bk-setting"><fieldset class="bk-fieldset"><legend>${escapeHtml(label)}</legend>${boxes}</fieldset>${help}${modified}</div>`;
    }
    const inputType = kind.type === 'int' || kind.type === 'number' ? 'number' : kind.type === 'email' ? 'email' : kind.type === 'url' ? 'url' : 'text';
    const constraints = kind.type === 'int' ? ` min="${kind.min}"${kind.max !== undefined ? ` max="${kind.max}"` : ''} step="1"${kind.optional ? '' : ' required'}`
      : kind.type === 'number' ? ` min="${kind.min}" step="any" required`
      : kind.type === 'text' && kind.optional ? '' : ' required';
    const value = effective === null ? '' : String(effective);
    return `<div class="bk-setting"><label class="bk-field"><span>${escapeHtml(label)}</span><input class="bk-input" type="${inputType}" name="${escapeHtml(definition.key)}" value="${escapeHtml(value)}"${constraints}></label>${help}${modified}</div>`;
  };

  const sections = settingSections.map((section) => {
    let lastGroup: string | undefined;
    const fields = settingDefinitions.filter((definition) => definition.section === section).map((definition) => {
      const heading = definition.groupKey && definition.groupKey !== lastGroup
        ? `<h3 class="bk-setting-group">${escapeHtml(catalog[definition.groupKey] ?? definition.groupKey)}</h3>`
        : '';
      lastGroup = definition.groupKey;
      return heading + fieldMarkup(definition);
    }).join('');
    const hasOverrides = settingDefinitions.some((definition) => definition.section === section && storedRows[definition.key] !== undefined);
    // formnovalidate on resets: emptied required fields must not block returning to config values.
    const sectionReset = hasOverrides
      ? `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset" formnovalidate>${escapeHtml(messages['admin.resetSection'])}</button>`
      : '';
    return `<form method="post" class="bk-card" id="bk-s-${section}"${section === activeSection ? '' : ' hidden'}><h2>${escapeHtml(sectionTitles[section])}</h2>`
      + `<p class="bk-hint bk-section-hint">${escapeHtml(sectionHints[section])}</p>`
      + `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="section" value="${escapeHtml(section)}">${fields}`
      + `<div class="bk-actions bk-actions--split"><button type="submit" class="bk-btn" name="action" value="settings-save">${escapeHtml(messages['admin.save'])}</button>${sectionReset}</div></form>`;
  }).join('');

  // Deploy-time values on their own tab: reference material, not daily controls.
  const readonlySection = `<section class="bk-card" id="bk-s-config"${activeSection === 'config' ? '' : ' hidden'}><h2>${escapeHtml(messages['admin.sectionReadonly'])}</h2>`
    + `<p class="bk-hint">${escapeHtml(messages['admin.readonlyHint'])}</p>`
    + factList([
      [messages['setting.timezone'], escapeHtml(context.config.business.timezone)],
      [messages['setting.currency'], escapeHtml(context.config.business.currency.toUpperCase())],
      [messages['setting.locales'], escapeHtml(context.config.locales.supported.join(', '))],
      [messages['setting.shortCode'], escapeHtml(context.config.business.shortCode)],
      [messages['setting.siteUrl'], escapeHtml(context.config.business.url)],
      [messages['setting.tours'], escapeHtml(Object.keys(context.config.tours).join(', '))],
      [messages['setting.fleetCapacity'], `${context.config.fleet.defaultCapacity}<span class="bk-sub">${escapeHtml(messages['admin.fleetCapacityNote'])}</span>`],
    ])
    + `</section>`;

  const tabLink = (id: string, label: string): string =>
    `<a href="?view=settings&section=${id}" data-bookkit-tab="${id}"${id === activeSection ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  const tabs = `<nav class="bk-tabs" aria-label="${escapeHtml(messages['admin.settings'])}">`
    + settingSections.map((section) => tabLink(section, sectionTitles[section])).join('')
    + tabLink('config', messages['admin.sectionReadonly'])
    + `</nav>`;

  const savedAlert = saved ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['admin.saved'])}</p>` : '';
  return pageShell({
    lang: locale,
    title: `${messages['admin.settings']} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss),
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    sidebar: adminSidebar(context, messages, 'settings'),
    theme: context.viewerTheme,
    themeToggle: themeToggle(messages, context.viewerTheme),
    body: `<div class="bk-toolbar"><div><h1>${escapeHtml(messages['admin.settings'])}</h1><p class="bk-lead">${escapeHtml(messages['admin.settingsHint'])}</p></div></div>`
      + savedAlert
      + tabs
      + `<div class="bk-settings-sections">${sections}${readonlySection}</div>`,
  });
}

export function handleAdminGet(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const access = await accessAllowed(request, context);
    if (!access) throw new HttpError(403, 'forbidden', 'Cloudflare Access authorization required');
    // Minted fresh per render and embedded as a hidden field in every admin form (BK-SEC-001 layer
    // 2); handleAdminPost verifies it against the same Access-authenticated subject.
    const csrfToken = await mintAdminCsrfToken(context, access.sub, context.clock().getTime());
    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.get('view') === 'settings') {
      return html(settingsPage(context, await context.repo.listSettings(), requestUrl.searchParams.get('saved') === '1', requestUrl.searchParams.get('section') ?? '', csrfToken), 200, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
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
    const editDate = url.searchParams.get('date')?.trim() ?? '';
    const saved = url.searchParams.get('saved') ?? '';
    return html(adminPage(context, bookings, overrides, fromDate, toDate, filters, editDate, capacityDefaults, saved, csrfToken), 200, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  });
}

export function handleAdminPost(request: Request, context: BookkitContext): Promise<Response> {
  return runAdminPost(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const access = await accessAllowed(request, context);
    if (!access) throw new HttpError(403, 'forbidden', 'Cloudflare Access authorization required');
    // BK-SEC-001 layer 1: Fetch-Metadata / Origin enforcement. Wired only here (the admin mutation
    // route), never on the public booking API — see src/admin-csrf.ts.
    if (!adminOriginAllowed(request)) throw new HttpError(403, 'forbidden', 'Cross-origin admin requests are not allowed');
    const form = await request.formData();
    // BK-SEC-001 layer 2: per-session CSRF token, bound to the same Access-authenticated subject
    // the request was just verified against.
    const csrfToken = form.get('csrf_token');
    const csrfOk = await verifyAdminCsrfToken(context, typeof csrfToken === 'string' ? csrfToken : null, access.sub, context.clock().getTime());
    if (!csrfOk) throw new HttpError(403, 'forbidden', 'Invalid or expired CSRF token');
    const action = requireString(form.get('action'), 'action');
    if (action.startsWith('settings-')) {
      // Redirect target carries saved=1 so the settings page can confirm the change visibly.
      const location = new URL(request.url);
      location.searchParams.set('saved', '1');
      if (action.startsWith('settings-reset:')) {
        const key = action.slice('settings-reset:'.length);
        const definition = settingDefinitions.find((entry) => entry.key === key);
        if (!definition) throw new HttpError(400, 'validation_failed', 'Unknown setting');
        await context.repo.deleteSetting(definition.key);
        return new Response(null, { status: 303, headers: { location: location.toString(), 'cache-control': 'no-store' } });
      }
      if (action !== 'settings-save' && action !== 'settings-reset') throw new HttpError(400, 'validation_failed', 'Unknown admin action');
      const section = requireString(form.get('section'), 'section');
      const definitions = settingDefinitions.filter((definition) => definition.section === section);
      if (definitions.length === 0) throw new HttpError(400, 'validation_failed', 'Unknown settings section');
      // Compare against the file config, not the merged one: a submitted value equal to the file
      // default deletes the row, keeping "follow the config" the resting state (core/settings.ts).
      const base = context.baseConfig ?? context.config;
      // candidateRows starts from every currently stored override (not just this section) so the
      // merge-then-validate check below sees the config the way a request would actually merge it,
      // catching cross-field rules that no single field's SettingKind bound can (BK-CONFIG-001).
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
      if (operations.length > 0) await context.repo.applySettingsBatch(operations);
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
      for (const date of dayDates) await context.repo.deleteDayOverride(date);
    } else if (action === 'set' || action === 'close') {
      const capacity = action === 'close' ? 0 : requireInteger(Number(form.get('capacity')), 'capacity', 0);
      for (const date of dayDates) await context.repo.upsertDayOverride(date, capacity, reason);
    } else if (action === 'default-clear') await context.repo.deleteCapacityDefault(firstDate);
    else if (action === 'default-set') {
      const capacity = requireInteger(Number(form.get('capacity')), 'capacity', 0);
      await context.repo.upsertCapacityDefault(firstDate, capacity, reason);
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
