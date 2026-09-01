import type { Booking } from '../core/booking';
import { DEFAULT_PICKUP_OPTIONS, DEFAULT_TOKEN_EXPIRY_DAYS, pickupOptionFor, resolveMeetingPoint, resolveTour, type MeetingPoint, type PickupType, type TourConfig } from '../core/config';
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

// Plan 018 (design decision 6): validated against the tour's own declared option ids (via
// pickupOptionFor, which already falls back to DEFAULT_PICKUP_OPTIONS for a tour with none) rather
// than a fixed 'default'/'custom' enum — a legacy tour still only accepts that same pair, but a
// tour that declares more gets every id it names. For a declared set, the 400 names the valid ids
// so a client with a stale option list gets an actionable error.
function parsePickup(tour: TourConfig, value: unknown): PickupType {
  if (typeof value === 'string' && pickupOptionFor(tour, value)) return value;
  const validIds = (tour.pickupOptions ?? DEFAULT_PICKUP_OPTIONS).map((option) => option.id);
  // Byte-identity done criterion (plan 018): a tour on the default pair must keep emitting the
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
// choice on a multi-point tour; an option with usesMeetingPoint: false accepts-but-doesn't-require
// a supplied id, exactly like 'custom' did before this plan. `pickupType` here has already been
// validated by parsePickup against this same tour, so the option is always declared.
function resolveCheckoutMeetingPoint(tour: ReturnType<typeof resolveTour>, pickupType: PickupType, body: Record<string, unknown>): MeetingPoint {
  const raw = body.meetingPointId;
  if (raw !== undefined) {
    const suppliedId = requireString(raw, 'meetingPointId');
    const point = resolveMeetingPoint(tour, suppliedId);
    if (point.id !== suppliedId) throw new HttpError(400, 'validation_failed', 'Unknown meetingPointId');
    return point;
  }
  if ((tour.meetingPoints?.length ?? 0) > 1 && pickupOptionFor(tour, pickupType)?.usesMeetingPoint) {
    throw new HttpError(400, 'validation_failed', 'meetingPointId is required for a tour with more than one meeting point');
  }
  return resolveMeetingPoint(tour);
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

export async function checkSlot(
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
    // Plan 018 (design decision 6): resolveTour is a cheap in-memory lookup (already needed below
    // for assertSupportedPartySize), so it's pulled forward here rather than duplicated — parsePickup
    // needs the tour itself to validate pickupType against its declared option ids.
    const tour = resolveTour(context.config, tourSlug);
    const pickupType = parsePickup(tour, body.pickupType);
    const locale = requireString(body.locale, 'locale');
    if (!context.config.locales.supported.includes(locale)) throw new HttpError(400, 'validation_failed', 'Unsupported locale');
    const now = nowIso(context);
    await context.repo.sweepExpiredHolds(now);
    assertSupportedPartySize(tour, people);
    const candidate = await checkSlot(context, tourSlug, people, start, now);
    const meetingPoint = resolveCheckoutMeetingPoint(candidate.tour, pickupType, body);
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
          meetingPointId: meetingPoint.id, meetingPointLabel: meetingPoint.label,
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
