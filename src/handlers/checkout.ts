import type { Booking } from '../core/booking';
import { DEFAULT_PICKUP_OPTIONS, DEFAULT_TOKEN_EXPIRY_DAYS, pickupOptionFor, resolveMeetingPoint, resolveService, type MeetingPoint, type PickupType, type ServiceConfig } from '../core/config';
import { availabilityForDay, capacityForDate, defaultCapacityForDate, occupancyFor } from '../core/occupancy';
import { priceFor } from '../core/pricing';
import { generateUniqueReference } from '../core/reference';
import { generateSlots } from '../core/slots';
import { localDateKey, parseUtcInstant } from '../core/time';
import type { BookkitContext } from '../context';
import { nowIso } from '../context';
import { HoldLimitExceededError } from '../repo';
import { HttpError, json, requestJson, requireInteger, requireString, tokenBytes } from '../http';
import { assertSupportedPartySize, calendarEventsForWindow } from './availability';
import { run } from './shared';

// Plan 018 (design decision 6): validated against the service's own declared option ids (via
// pickupOptionFor, which already falls back to DEFAULT_PICKUP_OPTIONS for a service with none) rather
// than a fixed 'default'/'custom' enum — a legacy service still only accepts that same pair, but a
// service that declares more gets every id it names. For a declared set, the 400 names the valid ids
// so a client with a stale option list gets an actionable error.
function parsePickup(service: ServiceConfig, value: unknown): PickupType {
  if (typeof value === 'string' && pickupOptionFor(service, value)) return value;
  const validIds = (service.pickupOptions ?? DEFAULT_PICKUP_OPTIONS).map((option) => option.id);
  // Byte-identity done criterion (plan 018): a service on the default pair must keep emitting the
  // exact pre-018 error, for missing and invalid values alike — API callers may match on it.
  if (validIds.length === 2 && validIds[0] === 'default' && validIds[1] === 'custom') {
    throw new HttpError(400, 'validation_failed', 'pickupType must be default or custom');
  }
  requireString(value, 'pickupType');
  throw new HttpError(400, 'validation_failed', `pickupType must be one of: ${validIds.join(', ')}`);
}

// Plan 017 (design decision 2): meetingPointId is optional on the wire but the RESOLVED id is
// always what gets stored, so downstream rendering (bookingSummary/confirmationSummary, admin,
// providers) never has to branch on "absent" — only ever on a stored id that's since been
// removed from config (meetingPointForBooking's fallback).
//
// Plan 018 (design decision 6): required onto the chosen option's usesMeetingPoint rather than
// `pickupType === 'default'` — Maze's "custom drop-off" option still starts at a meeting point
// (usesMeetingPoint: true) even though it also collects an address, so it must still require the
// choice on a multi-point service; an option with usesMeetingPoint: false accepts-but-doesn't-require
// a supplied id, exactly like 'custom' did before this plan. `pickupType` here has already been
// validated by parsePickup against this same service, so the option is always declared.
function resolveCheckoutMeetingPoint(service: ReturnType<typeof resolveService>, pickupType: PickupType, body: Record<string, unknown>): MeetingPoint {
  const raw = body.meetingPointId;
  if (raw !== undefined) {
    const suppliedId = requireString(raw, 'meetingPointId');
    const point = resolveMeetingPoint(service, suppliedId);
    if (point.id !== suppliedId) throw new HttpError(400, 'validation_failed', 'Unknown meetingPointId');
    return point;
  }
  if ((service.meetingPoints?.length ?? 0) > 1 && pickupOptionFor(service, pickupType)?.usesMeetingPoint) {
    throw new HttpError(400, 'validation_failed', 'meetingPointId is required for a service with more than one meeting point');
  }
  return resolveMeetingPoint(service);
}

function assertSlot(config: BookkitContext['config'], serviceSlug: string, start: string, now: string): { service: ReturnType<typeof resolveService>; startsAt: string; endsAt: string } {
  const service = resolveService(config, serviceSlug);
  let instant: Date;
  try {
    instant = parseUtcInstant(start);
  } catch {
    throw new HttpError(400, 'validation_failed', 'start must be an ISO 8601 instant with an explicit offset');
  }
  const localDate = localDateKey(instant, config.business.timezone);
  const slot = generateSlots(service, localDate, config.business.timezone).find((candidate) => parseUtcInstant(candidate.utcStart).getTime() === instant.getTime());
  if (!slot) throw new HttpError(409, 'slot_unavailable', 'The selected slot is not available');
  if (instant.getTime() < parseUtcInstant(now).getTime() + config.booking.minNoticeHours * 3_600_000) {
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  }
  if (instant.getTime() > parseUtcInstant(now).getTime() + config.booking.maxHorizonDays * 86_400_000) {
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is outside the booking horizon');
  }
  return { service, startsAt: slot.utcStart, endsAt: slot.utcEnd };
}

export async function checkSlot(
  context: BookkitContext,
  serviceSlug: string,
  quantity: number,
  start: string,
  now: string,
  excludeBookingId?: string,
): Promise<{ service: ReturnType<typeof resolveService>; startsAt: string; endsAt: string }> {
  const candidate = assertSlot(context.config, serviceSlug, start, now);
  const localDate = localDateKey(candidate.startsAt, context.config.business.timezone);
  const override = await context.repo.getDayOverride(localDate);
  const capacityDefaults = await context.repo.listCapacityDefaults();
  const lookback = Math.max(
    ...Object.values(context.config.services).map((service) => service.durationMin + service.turnaroundMin),
  );
  const windowStart = new Date(parseUtcInstant(candidate.startsAt).getTime() - lookback * 60_000).toISOString();
  const windowEnd = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.service.turnaroundMin * 60_000).toISOString();
  const bookings = await context.repo.listOccupancyBookings(windowStart, windowEnd);
  const { events: calendarEvents } = await calendarEventsForWindow(context, windowStart, windowEnd, now);
  const day = availabilityForDay({
    date: localDate,
    timezone: context.config.business.timezone,
    service: candidate.service,
    capacity: capacityForDate(localDate, defaultCapacityForDate(localDate, context.config.capacity.default, capacityDefaults), override ? [override] : []).capacity,
    bookings,
    calendarEvents,
    services: context.config.services,
    requestedQuantity: quantity,
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
    const serviceSlug = requireString(body.serviceSlug, 'serviceSlug');
    if (!context.config.services[serviceSlug]) throw new HttpError(400, 'validation_failed', 'Unknown service');
    const start = requireString(body.start, 'start');
    const quantity = requireInteger(body.quantity, 'quantity');
    // Plan 018 (design decision 6): resolveService is a cheap in-memory lookup (already needed below
    // for assertSupportedPartySize), so it's pulled forward here rather than duplicated — parsePickup
    // needs the service itself to validate pickupType against its declared option ids.
    const service = resolveService(context.config, serviceSlug);
    const pickupType = parsePickup(service, body.pickupType);
    const locale = requireString(body.locale, 'locale');
    if (!context.config.locales.supported.includes(locale)) throw new HttpError(400, 'validation_failed', 'Unsupported locale');
    const now = nowIso(context);
    await context.repo.sweepExpiredHolds(now);
    assertSupportedPartySize(service, quantity);
    const candidate = await checkSlot(context, serviceSlug, quantity, start, now);
    const meetingPoint = resolveCheckoutMeetingPoint(candidate.service, pickupType, body);
    let priceMinor: number;
    try {
      priceMinor = priceFor(candidate.service, quantity, pickupType);
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
    const occupancyUnits = occupancyFor(candidate.service, quantity);
    const occupancyEndsAt = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.service.turnaroundMin * 60_000).toISOString();
    const localDate = localDateKey(candidate.startsAt, context.config.business.timezone);
    let booking: Booking | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reference = await generateUniqueReference(context.config.business.shortCode, year, sequence, referenceExists);
      try {
        const holdLimit = context.config.booking.maxHoldsPerIp;
        // BK-SEC-002: expiry counts from the service's end, not from creation, so the link keeps
        // working through the whole pre-service period plus a post-service grace window — see
        // ClientConfig.booking.tokenExpiryDays (src/core/config.ts).
        const tokenExpiryDays = context.config.booking.tokenExpiryDays ?? DEFAULT_TOKEN_EXPIRY_DAYS;
        const tokensExpireAt = new Date(parseUtcInstant(candidate.endsAt).getTime() + tokenExpiryDays * 86_400_000).toISOString();
        const created = await context.repo.insertHoldWithCapacity({
          id: crypto.randomUUID(), reference, serviceSlug, quantity, pickupType,
          meetingPointId: meetingPoint.id, meetingPointLabel: meetingPoint.label,
          startsAt: candidate.startsAt, endsAt: candidate.endsAt, locale, priceMinor,
          currency: context.config.business.currency,
          holdExpiresAt: new Date(parseUtcInstant(now).getTime() + context.config.booking.holdMinutes * 60_000).toISOString(),
          cancelToken: tokenBytes(), operatorToken: tokenBytes(), createdAt: now, updatedAt: now,
          tokensExpireAt,
          occupancyUnits, occupancyEndsAt, localDate, defaultCapacity: context.config.capacity.default,
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
      // request, so it's fine to expire the hold below on any failure here (a provider rejection, a
      // missing checkout URL, or the updateBooking write) rather than distinguish them. If the
      // *whole* POST is retried by the client after a 5xx, this path mints a fresh hold (and thus a
      // fresh key) rather than reusing this one; that's fine because the idempotency key only needs
      // to prevent a duplicate payable session per hold, not across holds — this hold's now-expired
      // row and any session the provider did create for it still resolve via the late-webhook
      // backfill path (getBookingBySessionRef / metadata.bookingId), same as before this fix.
      const checkout = await context.providers.payments.createCheckout(booking, context.config, context.routeConfig.paths);
      await context.repo.updateBooking(booking.id, { paymentSessionRef: checkout.sessionRef, updatedAt: nowIso(context) });
      return json({ checkoutUrl: checkout.url, bookingId: booking.id, reference: booking.reference }, 201);
    } catch (error) {
      await context.repo.expireHold(booking.id, nowIso(context)).catch(() => undefined);
      throw error;
    }
  });
}
