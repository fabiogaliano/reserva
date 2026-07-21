import {
  canCancelBooking,
  canRescheduleBooking,
  cancelBooking,
  markNoShow,
  rescheduleBooking,
  type Booking,
} from '../core/booking';
import { resolveTour, type PickupType } from '../core/config';
import { availabilityForDay, capacityForDate } from '../core/occupancy';
import { priceFor } from '../core/pricing';
import { formatReference } from '../core/reference';
import { generateSlots } from '../core/slots';
import { localDateKey, localDateTimeToUtcIso, parseUtcInstant, utcToLocalIso } from '../core/time';
import { ConfirmationInProgressError, confirmBookingFromPayment, dispatchMutation, dispatchNonCritical } from '../confirmation';
import type { BookkitContext } from '../context';
import { getSecret, nowIso } from '../context';
import { HoldLimitExceededError } from '../repo';
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

function dateRange(from: string, to: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function validDateRange(from: string, to: string): string[] {
  parseDate(from, 'from');
  parseDate(to, 'to');
  const dates = dateRange(from, to);
  if (dates.length > 62) throw new HttpError(400, 'validation_failed', 'Date range cannot exceed 62 days');
  return dates;
}

async function availabilityPayload(request: Request, context: BookkitContext, now: string): Promise<{ timezone: string; days: unknown[] }> {
  const url = new URL(request.url);
  const tourSlug = requireString(url.searchParams.get('tour'), 'tour');
  if (!context.config.tours[tourSlug]) throw new HttpError(400, 'validation_failed', 'Unknown tour');
  const people = requireInteger(Number(url.searchParams.get('people')), 'people');
  const from = requireString(url.searchParams.get('from'), 'from');
  const to = requireString(url.searchParams.get('to'), 'to');
  const dates = validDateRange(from, to);
  const tour = resolveTour(context.config, tourSlug);
  try {
    priceFor(tour, people, 'default');
    priceFor(tour, people, 'custom');
  } catch {
    throw new HttpError(400, 'validation_failed', 'No price is configured for this party size');
  }
  const firstDay = dates[0];
  const lastDay = dates[dates.length - 1];
  if (!firstDay || !lastDay) throw new HttpError(400, 'validation_failed', 'Date range is empty');
  const dayAfterLast = new Date(`${lastDay}T12:00:00Z`);
  dayAfterLast.setUTCDate(dayAfterLast.getUTCDate() + 1);
  const horizonStart = parseUtcInstant(localDateTimeToUtcIso(`${firstDay}T00:00`, context.config.business.timezone));
  const horizonEnd = parseUtcInstant(localDateTimeToUtcIso(`${dayAfterLast.toISOString().slice(0, 10)}T00:00`, context.config.business.timezone));
  const lookback = Math.max(...Object.values(context.config.tours).map((candidate) => candidate.durationMin + candidate.turnaroundMin), 0);
  const bookings = await context.repo.listOccupancyBookings(
    new Date(horizonStart.getTime() - lookback * 60_000).toISOString(),
    horizonEnd.toISOString(),
  );
  const calendarEvents = context.providers.calendar
    ? await context.providers.calendar.listEvents(new Date(horizonStart.getTime() - lookback * 60_000).toISOString(), horizonEnd.toISOString())
    : [];
  const overrides = await context.repo.listDayOverrides(firstDay, lastDay);
  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));
  const days = dates.map((date) => {
    const capacityInfo = capacityForDate(date, context.config.fleet.defaultCapacity, overridesByDate);
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
      calendarEvents,
      tours: context.config.tours,
      requestedPeople: people,
      now,
      minNoticeHours: context.config.booking.minNoticeHours,
      maxHorizonDays: context.config.booking.maxHorizonDays,
      limitedThreshold: context.config.booking.limitedThreshold,
    });
  });
  return { timezone: context.config.business.timezone, days };
}

export function handleAvailability(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const now = nowIso(context);
    await context.repo.sweepExpiredHolds(now);
    const normalized = new URL(request.url);
    normalized.searchParams.sort();
    const cacheKey = new Request(normalized.toString(), { method: 'GET' });
    if (context.cache) {
      const hit = await context.cache.match(cacheKey);
      if (hit) return hit;
    }
    const payload = await availabilityPayload(request, context, now);
    if (context.cache) {
      const response = json(payload, 200, { 'cache-control': 'public, max-age=60' });
      await context.cache.put(cacheKey, response.clone());
      return response;
    }
    return json(payload, 200, { 'cache-control': 'no-store' });
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
  const lookback = Math.max(
    ...Object.values(context.config.tours).map((tour) => tour.durationMin + tour.turnaroundMin),
  );
  const windowStart = new Date(parseUtcInstant(candidate.startsAt).getTime() - lookback * 60_000).toISOString();
  const windowEnd = new Date(parseUtcInstant(candidate.endsAt).getTime() + candidate.tour.turnaroundMin * 60_000).toISOString();
  const bookings = await context.repo.listOccupancyBookings(windowStart, windowEnd);
  const calendarEvents = context.providers.calendar
    ? await context.providers.calendar.listEvents(windowStart, windowEnd)
    : [];
  const day = availabilityForDay({
    date: localDate,
    timezone: context.config.business.timezone,
    tour: candidate.tour,
    capacity: capacityForDate(localDate, context.config.fleet.defaultCapacity, override ? [override] : []).capacity,
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
    const candidate = await checkSlot(context, tourSlug, people, start, now);
    let priceCents: number;
    try {
      priceCents = priceFor(candidate.tour, people, pickupType);
    } catch {
      throw new HttpError(400, 'validation_failed', 'No price is configured for this party and pickup type');
    }
    const year = Number(localDateKey(candidate.startsAt, context.config.business.timezone).slice(0, 4));
    const prefix = `${context.config.business.shortCode.toUpperCase()}-${year}-`;
    const sequence = await context.repo.countReferencesForYear(prefix) + 1;
    let booking: Booking | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = formatReference(context.config.business.shortCode, year, sequence + attempt);
      try {
        const holdLimit = context.config.booking.maxHoldsPerIp;
        booking = await context.repo.insertHold({
          id: crypto.randomUUID(), reference, tourSlug, people, pickupType,
          startsAt: candidate.startsAt, endsAt: candidate.endsAt, locale, priceCents,
          holdExpiresAt: new Date(parseUtcInstant(now).getTime() + context.config.booking.holdMinutes * 60_000).toISOString(),
          cancelToken: tokenBytes(), operatorToken: tokenBytes(), createdAt: now, updatedAt: now,
          ...(holdLimit ? { holdIp: clientIp(request), maxActiveHoldsForIp: holdLimit } : {}),
        });
        break;
      } catch (error) {
        if (error instanceof HoldLimitExceededError) {
          throw new HttpError(429, 'too_many_holds', error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        const referenceCollision = /unique|constraint/i.test(message) && /reference/i.test(message);
        if (!referenceCollision || attempt === 7) throw error;
      }
    }
    if (!booking) throw new Error('Unable to create booking hold');
    try {
      const checkout = await context.providers.payments.createCheckout(booking, context.config);
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
      if (booking.stripeSessionId && event.sessionId && booking.stripeSessionId !== event.sessionId) {
        throw new HttpError(409, 'stripe_session_mismatch', 'Stripe session does not match the booking');
      }
      if (booking.priceCents > 0 && event.paid !== true) {
        context.logger.warn?.('Stripe completed event is not paid', { eventId: event.id, bookingId: booking.id });
        return json({ received: true });
      }
      if (event.amountCaptured !== undefined && event.amountCaptured !== booking.priceCents) {
        throw new HttpError(409, 'stripe_amount_mismatch', 'Stripe amount does not match the booking price');
      }
      const confirmed = await confirmBookingFromPayment(context, booking, event.paymentIntent ?? null, event);
      if (event.sessionId && confirmed.stripeSessionId !== event.sessionId) {
        await context.repo.updateBooking(confirmed.id, { stripeSessionId: event.sessionId, updatedAt: nowIso(context) });
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
        if (booking && booking.status !== 'cancelled') {
          await calendarDelete(context, booking);
          const timestamp = nowIso(context);
          const updated = await context.repo.updateBooking(booking.id, {
            status: 'cancelled', cancelledAt: timestamp, cancelledBy: 'operator', updatedAt: timestamp,
          });
          await dispatchMutation(context, 'booking.cancelled_by_operator', updated);
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
  return { reference: booking.reference, tourSlug: booking.tourSlug, start: utcToLocalIso(booking.startsAt, context.config.business.timezone), people: booking.people, meetingPoint: tour.meetingPoint };
}

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
      if (session.status === 'complete' && (session.paymentStatus === 'paid' || (current.priceCents === 0 && session.paymentStatus === 'no_payment_required'))) {
        try {
          current = await confirmBookingFromPayment(context, current, session.paymentIntent ?? null, session);
        } catch (error) {
          if (!(error instanceof ConfirmationInProgressError)) throw error;
          current = await context.repo.getBookingById(current.id) ?? current;
        }
      } else if (session.status === 'expired' && current.status === 'hold') {
        current = await context.repo.expireHold(current.id, nowIso(context))
          ?? await context.repo.getBookingById(current.id)
          ?? current;
      }
    }
    if (current.status === 'confirmed') return json({ status: 'confirmed', booking: bookingSummary(context, current) });
    if (current.status === 'expired') return json({ status: 'expired' });
    return json({ status: 'pending' });
  });
}

async function tokenBooking(context: BookkitContext, token: string, operator = false): Promise<Booking> {
  const booking = operator ? await context.repo.getBookingByOperatorToken(token) : await context.repo.getBookingByCancelToken(token);
  if (!booking) throw new HttpError(403, 'forbidden', 'Invalid booking token');
  return booking;
}

export function handleManage(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const token = new URL(request.url).searchParams.get('token');
    if (!token) throw new HttpError(403, 'forbidden', 'A booking token is required');
    const customer = await context.repo.getBookingByCancelToken(token);
    const booking = customer ?? await context.repo.getBookingByOperatorToken(token);
    if (!booking) throw new HttpError(403, 'forbidden', 'Invalid booking token');
    const operator = !customer;
    const now = nowIso(context);
    return json({ booking: bookingSummary(context, booking), role: operator ? 'operator' : 'customer', canCancel: operator ? booking.status === 'confirmed' : canCancelBooking(booking, now, context.config.booking.cancelCutoffHours), canReschedule: operator ? booking.status === 'confirmed' : canRescheduleBooking(booking, now, context.config.booking.reschedule.cutoffHours, context.config.booking.reschedule.enabled), canNoShow: operator && booking.status === 'confirmed' && parseUtcInstant(booking.startsAt).getTime() < parseUtcInstant(now).getTime(), deadline: new Date(parseUtcInstant(booking.startsAt).getTime() - context.config.booking.cancelCutoffHours * 3_600_000).toISOString() });
  });
}

async function calendarDelete(context: BookkitContext, booking: Booking): Promise<void> {
  if (booking.calendarEventId && context.providers.calendar) await context.providers.calendar.deleteEvent(booking.calendarEventId);
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
    if (!canCancelBooking(booking, nowIso(context), context.config.booking.cancelCutoffHours)) throw new HttpError(403, 'past_cutoff', 'The cancellation deadline has passed');
    await calendarDelete(context, booking);
    const cancelled = cancelBooking(booking, 'customer', nowIso(context));
    const updated = await context.repo.updateBooking(cancelled.id, { status: 'cancelled', cancelledAt: cancelled.cancelledAt, cancelledBy: 'customer', updatedAt: cancelled.updatedAt });
    await dispatchMutation(context, 'booking.cancelled_by_customer', updated);
    return json({ ok: true });
  });
}

async function readNewStart(body: Record<string, unknown>): Promise<string> {
  return requireString(body.newStart, 'newStart');
}

async function rescheduleWithToken(context: BookkitContext, booking: Booking, newStart: string, operator: boolean): Promise<Booking> {
  const now = nowIso(context);
  if (!operator && !canRescheduleBooking(booking, now, context.config.booking.reschedule.cutoffHours, context.config.booking.reschedule.enabled)) throw new HttpError(403, 'past_cutoff', 'The reschedule deadline has passed');
  if (booking.status !== 'confirmed') throw new HttpError(409, 'slot_unavailable', 'Only confirmed bookings can be rescheduled');
  const candidate = await checkSlot(context, booking.tourSlug, booking.people, newStart, now, booking.id);
  const next = rescheduleBooking(booking, candidate.startsAt, candidate.tour.durationMin, now);
  const updated = await context.repo.updateBooking(next.id, { startsAt: next.startsAt, endsAt: next.endsAt, rescheduledFrom: next.rescheduledFrom, updatedAt: next.updatedAt });
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

async function operatorBooking(context: BookkitContext, request: Request, body: Record<string, unknown>): Promise<Booking> {
  const operatorToken = typeof body.operatorToken === 'string' ? body.operatorToken : null;
  if (operatorToken) return tokenBooking(context, operatorToken, true);
  const expected = await getSecret(context, 'TOURFLOW_SHARED_SECRET');
  const supplied = bearerToken(request);
  if (!expected || !supplied || !constantTimeEqual(expected, supplied)) throw new HttpError(403, 'forbidden', 'Operator authorization required');
  const bookingId = requireString(body.bookingId, 'bookingId');
  const booking = await context.repo.getBookingById(bookingId);
  if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');
  return booking;
}

export function handleOperatorCancel(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body);
    const refund = body.refund === 'full' ? 'full' : body.refund === 'none' ? 'none' : null;
    if (!refund) throw new HttpError(400, 'validation_failed', 'refund must be full or none');
    if (booking.status === 'cancelled') return json({ ok: true });
    if (booking.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
    await calendarDelete(context, booking);
    if (refund === 'full' && booking.stripePaymentIntent && !context.refundedPayments?.has(booking.id)) {
      await context.providers.payments.refund(booking.stripePaymentIntent);
      context.refundedPayments?.add(booking.id);
    }
    const cancelled = cancelBooking(booking, 'operator', nowIso(context));
    const updated = await context.repo.updateBooking(cancelled.id, { status: 'cancelled', cancelledAt: cancelled.cancelledAt, cancelledBy: 'operator', updatedAt: cancelled.updatedAt });
    await dispatchMutation(context, 'booking.cancelled_by_operator', updated);
    return json({ ok: true });
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
      const updated = await context.repo.updateBooking(next.id, { status: 'no_show', updatedAt: next.updatedAt });
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

async function accessAllowed(request: Request, context: BookkitContext): Promise<boolean> {
  if (!context.verifyAccess) return false;
  try {
    return await context.verifyAccess(request);
  } catch {
    return false;
  }
}

function adminPage(
  context: BookkitContext,
  bookings: Booking[],
  overrides: Awaited<ReturnType<BookkitContext['repo']['listDayOverrides']>>,
  fromDate: string,
  toDate: string,
): string {
  const rows = bookings.map((booking) => `<tr><td>${escapeHtml(booking.reference)}</td><td>${escapeHtml(utcToLocalIso(booking.startsAt, context.config.business.timezone))}</td><td>${escapeHtml(booking.tourSlug)}</td><td>${booking.people}</td><td>${escapeHtml(booking.pickupType)}</td><td>${escapeHtml(booking.status)}</td><td><a href="/booking/manage?token=${encodeURIComponent(booking.operatorToken)}">manage</a></td></tr>`).join('');
  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));
  const bookingCounts = new Map<string, number>();
  for (const booking of bookings) {
    const date = localDateKey(booking.startsAt, context.config.business.timezone);
    bookingCounts.set(date, (bookingCounts.get(date) ?? 0) + 1);
  }
  const dayRows = dateRange(fromDate, toDate).map((date) => {
    const override = overridesByDate.get(date);
    const capacity = override?.capacity ?? context.config.fleet.defaultCapacity;
    const state = override ? 'override' : 'default';
    return `<tr><td>${escapeHtml(date)}</td><td>${capacity}</td><td>${bookingCounts.get(date) ?? 0}</td><td>${state}</td><td>${escapeHtml(override?.reason ?? '')}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><title>${escapeHtml(context.config.business.name)} bookings</title></head><body><h1>Booking admin</h1><section><h2>Days</h2><table><thead><tr><th>Date</th><th>Capacity</th><th>Bookings</th><th>State</th><th>Reason</th></tr></thead><tbody>${dayRows}</tbody></table><form method="post"><label>Date <input name="date" type="date" required></label><label>Capacity <input name="capacity" type="number" min="0"></label><label>Reason <input name="reason"></label><button name="action" value="set">Save</button><button name="action" value="clear">Clear</button></form></section><section><h2>Upcoming bookings</h2><table><thead><tr><th>Reference</th><th>Start</th><th>Tour</th><th>People</th><th>Pickup</th><th>Status</th><th>Manage</th></tr></thead><tbody>${rows}</tbody></table></section></body></html>`;
}

export function handleAdminGet(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    if (!await accessAllowed(request, context)) throw new HttpError(403, 'forbidden', 'Cloudflare Access authorization required');
    const now = nowIso(context);
    await context.repo.sweepExpiredHolds(now);
    const end = new Date(parseUtcInstant(now).getTime() + context.config.booking.maxHorizonDays * 86_400_000).toISOString();
    const bookings = await context.repo.listUpcoming(now);
    const fromDate = localDateKey(now, context.config.business.timezone);
    const toDate = localDateKey(end, context.config.business.timezone);
    const overrides = await context.repo.listDayOverrides(fromDate, toDate);
    return html(adminPage(context, bookings, overrides, fromDate, toDate), 200, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  });
}

export function handleAdminPost(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    if (!await accessAllowed(request, context)) throw new HttpError(403, 'forbidden', 'Cloudflare Access authorization required');
    const form = await request.formData();
    const date = parseDate(requireString(form.get('date'), 'date'), 'date');
    const action = requireString(form.get('action'), 'action');
    if (action === 'clear') await context.repo.deleteDayOverride(date);
    else if (action === 'set') {
      const capacity = requireInteger(Number(form.get('capacity')), 'capacity', 0);
      const reasonValue = form.get('reason');
      await context.repo.upsertDayOverride(date, capacity, typeof reasonValue === 'string' && reasonValue.trim() ? reasonValue.trim() : null);
    } else throw new HttpError(400, 'validation_failed', 'Unknown admin action');
    return new Response(null, { status: 303, headers: { location: request.url } });
  });
}
