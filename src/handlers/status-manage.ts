import { canCancelBooking, canRescheduleBooking, type Booking } from '../core/booking';
import { meetingPointForBooking, pickupOptionFor, resolveService } from '../core/config';
import { verifyPayment } from '../core/payment-verification';
import { parseUtcInstant, utcToLocalIso } from '../core/time';
import {
  ConfirmationInProgressError,
  confirmBookingFromPayment,
  isActionableSideEffectStatus,
  isConfirmationSideEffectOperation,
  missingConfirmationEventOperations,
  runOwedMutationSideEffects,
} from '../confirmation';
import type { BookkitContext } from '../context';
import { nowIso } from '../context';
import { HttpError, json } from '../http';
import { run, withSensitiveHeaders } from './shared';

function bookingSummary(context: BookkitContext, booking: Booking): Record<string, unknown> {
  const service = resolveService(context.config, booking.serviceSlug);
  // Plan 018 (design decision 8): the manage page renders off these two flags, not off the raw
  // pickupType — a declared option like Maze's custom pick-up must show its address and hide the
  // meeting point regardless of what its id happens to be. A stored id no longer declared in
  // config degrades to the pre-018 rendering: address only for the literal 'custom' id, meeting
  // point always shown.
  const option = pickupOptionFor(service, booking.pickupType);
  return {
    reference: booking.reference,
    serviceSlug: booking.serviceSlug,
    start: utcToLocalIso(booking.startsAt, context.config.business.timezone),
    end: utcToLocalIso(booking.endsAt, context.config.business.timezone),
    quantity: booking.quantity,
    pickupType: booking.pickupType,
    pickupAddress: booking.pickupAddress,
    pickupRequiresAddress: option ? option.requiresAddress : booking.pickupType === 'custom',
    pickupUsesMeetingPoint: option ? option.usesMeetingPoint : true,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    locale: booking.locale,
    status: booking.status,
    priceMinor: booking.priceMinor,
    // Plan 017 (design decision 3): resolved per booking, not read live off the service — a stored
    // id no longer declared in config falls back to the booking's own label snapshot instead of
    // silently pointing the customer at whatever point happens to be first today.
    meetingPoint: meetingPointForBooking(service, booking.meetingPointId, booking.meetingPointLabel),
  };
}

function confirmationSummary(context: BookkitContext, booking: Booking): Record<string, unknown> {
  const service = resolveService(context.config, booking.serviceSlug);
  // Plan 019 (design decision 2): gate the meeting point on the selected option's
  // usesMeetingPoint, the same read-model filter bookingSummary already applies (plan 018
  // decision 8) — otherwise custom_both (requiresAddress, no meeting point) would still tell the
  // customer to meet at a dock their option never uses. A stored id no longer declared in config
  // has no option to check, so it preserves the pre-018 behavior and includes the meeting point.
  const option = pickupOptionFor(service, booking.pickupType);
  const includeMeetingPoint = option ? option.usesMeetingPoint : true;
  return {
    reference: booking.reference,
    serviceSlug: booking.serviceSlug,
    start: utcToLocalIso(booking.startsAt, context.config.business.timezone),
    end: utcToLocalIso(booking.endsAt, context.config.business.timezone),
    quantity: booking.quantity,
    priceMinor: booking.priceMinor,
    ...(includeMeetingPoint ? { meetingPoint: meetingPointForBooking(service, booking.meetingPointId, booking.meetingPointLabel) } : {}),
    locale: booking.locale,
  };
}

// Anchored on immutable createdAt so polling and fulfillment retries cannot renew access; four hours covers the normal hold TTL plus post-payment viewing.
const STATUS_DETAIL_GRACE_MS = 4 * 60 * 60_000;

export function handleStatus(request: Request, context: BookkitContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const sessionRef = new URL(request.url).searchParams.get('session_id');
    if (!sessionRef) throw new HttpError(400, 'validation_failed', 'session_id is required');
    const booking = await context.repo.getBookingBySessionRef(sessionRef);
    if (!booking) return json({ status: 'not_found' });
    let current = booking;
    if (current.status === 'hold' || current.status === 'expired') {
      const session = await context.providers.payments.getSession(sessionRef);
      const verification = verifyPayment(current, {
        completed: session.status === 'complete',
        sessionRef: session.id,
        paid: session.paymentStatus === 'paid',
        paymentStatus: session.paymentStatus,
        amountTotal: session.amountTotal,
        currency: session.currency,
        expectedCurrency: context.config.business.currency,
      });
      if (verification.allowed) {
        try {
          current = await confirmBookingFromPayment(context, current, session.paymentRef ?? null, session);
        } catch (error) {
          if (!(error instanceof ConfirmationInProgressError)) throw error;
          current = await context.repo.getBookingById(current.id) ?? current;
        }
      } else if (session.status === 'complete') {
        context.logger.warn?.('payment verification rejected', { bookingId: current.id, reason: verification.reason });
        return json({ status: 'pending' });
      } else if (session.status === 'expired' && current.status === 'hold') {
        current = await context.repo.expireHold(current.id, nowIso(context))
          ?? await context.repo.getBookingById(current.id)
          ?? current;
      }
    } else if (current.status === 'confirmed') {
      // Unfiltered (not just isConfirmationSideEffectOperation) so the booking.confirmed
      // subscriber rows are visible below too — that helper deliberately excludes them (see its
      // doc comment in src/confirmation.ts).
      const allOperations = await context.repo.listSideEffectOperations(current.id);
      const confirmationOperations = allOperations.filter(isConfirmationSideEffectOperation);
      // Plan 011 (design decision 5), generalized by plan 021: also runs the confirmation-lease-
      // guarded repair path when a registered durable subscriber has no row at all — the only way a
      // legacy booking (subscriber registered after it was originally confirmed) gets one lazily
      // created (ensureConfirmationSideEffectOperations). runOwedMutationSideEffects below is what
      // actually delivers it.
      //
      // Plan 016 (design decision 6): isActionableSideEffectStatus excludes 'abandoned' (not just
      // 'succeeded'), so a permanently-failed delivery cannot keep tripping needsFulfillment (and
      // re-entering confirmBookingFromPayment) on every future request forever, even though the
      // claim predicate itself would just no-op every time.
      // Plan 022: no confirmation rows at all is now the whole legacy signal. The sync flags that
      // used to qualify it are gone, and migration 0018 converted every "already delivered" flag
      // into the succeeded row it described — so a booking that reaches this branch with zero rows
      // genuinely has no delivery record and needs the repair path.
      const needsFulfillment = confirmationOperations.some((operation) => isActionableSideEffectStatus(operation.status))
        || confirmationOperations.length === 0
        || missingConfirmationEventOperations(context, allOperations);
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
    // (per-recipient email, subscriber delivery) still owed from a prior cancel/reschedule/no-show whose
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
export async function tokenBooking(context: BookkitContext, token: string, operator = false, refundRecovery = false): Promise<Booking> {
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
