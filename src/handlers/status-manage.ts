import type { ConfirmationBooking, ManageBooking, ManageResponse, StatusResponse } from '../core/api.js';
import { canCancelBooking, canRescheduleBooking, toWireBooking, type Booking } from '../core/booking.js';
import { meetingPointForBooking, metadataRowsForBooking, pickupPresentationFor, resolveService } from '../core/config.js';
import { verifyPayment } from '../core/payment-verification.js';
import { parseUtcInstant, utcToLocalIso } from '../core/time.js';
import {
  ConfirmationInProgressError,
  confirmBookingFromPayment,
  isActionableSideEffectStatus,
  isConfirmationSideEffectOperation,
  missingConfirmationEventOperations,
  runOwedMutationSideEffects,
} from '../confirmation.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import { HttpError, json } from '../http.js';
import { run, withSensitiveHeaders } from './shared.js';

// Both summaries are built from `toWireBooking` and typed via `Pick<WireBooking>`, so a projection
// change breaks these at compile time instead of letting pushed and pulled bookings diverge. They
// add only presentation: local start/end, the resolved meeting point, and locale-resolved labels.
function manageBookingPayload(context: ReservaContext, booking: Booking): ManageBooking {
  const service = resolveService(context.config, booking.serviceSlug);
  const wire = toWireBooking(booking);
  // Gates on the booking ROW's data, not config — a location-less booking has no pickup presentation,
  // and an older booking whose service later drops its location module still renders correctly. The
  // fields stay present as `null` rather than vanishing, so a consumer never branches on key presence.
  const presentation = pickupPresentationFor(service, booking);
  return {
    reference: wire.reference,
    serviceSlug: wire.serviceSlug,
    start: utcToLocalIso(wire.startsAt, context.config.business.timezone),
    end: utcToLocalIso(wire.endsAt, context.config.business.timezone),
    quantity: wire.quantity,
    pickupType: wire.pickupType,
    pickupAddress: wire.pickupAddress,
    pickupRequiresAddress: presentation ? presentation.requiresAddress : null,
    pickupUsesMeetingPoint: presentation ? presentation.usesMeetingPoint : null,
    // Resolved per booking, not read live off the service — a stored id no longer declared in config
    // falls back to the booking's own label snapshot instead of silently pointing the customer
    // at whatever point happens to be first today.
    meetingPoint: presentation ? meetingPointForBooking(service, wire.meetingPointId, wire.meetingPointLabel) : null,
    customerName: wire.customerName,
    customerEmail: wire.customerEmail,
    customerPhone: wire.customerPhone,
    locale: wire.locale,
    status: wire.status,
    priceMinor: wire.priceMinor,
    currency: wire.currency,
    metadata: wire.metadata,
    // Labeled rows for rendering; the raw values stay on `metadata` above. This payload doubles as
    // the admin operator's view of the same booking (a role toggle, not a separate render path).
    metadataRows: metadataRowsForBooking(service, booking.metadata, wire.locale, context.config.locales.default),
  };
}

function confirmationBookingPayload(context: ReservaContext, booking: Booking): ConfirmationBooking {
  const service = resolveService(context.config, booking.serviceSlug);
  const wire = toWireBooking(booking);
  // Gate the meeting point on the row's own presentation — no location data, or an option that
  // never used a meeting point, must not tell the customer to meet anywhere.
  const presentation = pickupPresentationFor(service, booking);
  return {
    reference: wire.reference,
    serviceSlug: wire.serviceSlug,
    start: utcToLocalIso(wire.startsAt, context.config.business.timezone),
    end: utcToLocalIso(wire.endsAt, context.config.business.timezone),
    quantity: wire.quantity,
    priceMinor: wire.priceMinor,
    currency: wire.currency,
    meetingPoint: presentation?.usesMeetingPoint
      ? meetingPointForBooking(service, wire.meetingPointId, wire.meetingPointLabel)
      : null,
    locale: wire.locale,
    metadataRows: metadataRowsForBooking(service, booking.metadata, wire.locale, context.config.locales.default),
  };
}

// Anchored on immutable createdAt so polling and fulfillment retries cannot renew access; four hours covers the normal hold TTL plus post-payment viewing.
const STATUS_DETAIL_GRACE_MS = 4 * 60 * 60_000;

export function handleStatus(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const sessionRef = new URL(request.url).searchParams.get('session_id');
    if (!sessionRef) throw new HttpError(400, 'validation_failed', 'session_id is required');
    const booking = await context.repo.getBookingBySessionRef(sessionRef);
    if (!booking) return json<StatusResponse>({ status: 'not_found', booking: null });
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
        return json<StatusResponse>({ status: 'pending', booking: null });
      } else if (session.status === 'expired' && current.status === 'hold') {
        current = await context.repo.expireHold(current.id, nowIso(context))
          ?? await context.repo.getBookingById(current.id)
          ?? current;
      }
    } else if (current.status === 'confirmed') {
      // Unfiltered (not just isConfirmationSideEffectOperation) so the booking.confirmed subscriber
      // rows are visible below too — that helper excludes them.
      const allOperations = await context.repo.listSideEffectOperations(current.id);
      const confirmationOperations = allOperations.filter(isConfirmationSideEffectOperation);
      // needsFulfillment also covers legacy repair: a registered subscriber with no row at all
      // (created lazily via ensureConfirmationSideEffectOperations), or zero rows at all (no delivery
      // record). Excluding only 'abandoned' (not just 'succeeded') stops a permanently-failed
      // delivery from re-entering confirmBookingFromPayment forever.
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
    // A booking-touching request — drain any mutation-path side effects still owed from a prior
    // cancel/reschedule/no-show whose delivery attempt didn't finish. Confirmed/cancelled/no_show are
    // the only statuses a mutation event ever fires for; hold/expired never have rows here.
    if (current.status === 'confirmed' || current.status === 'cancelled' || current.status === 'no_show') {
      await runOwedMutationSideEffects(context, current);
    }
    if (current.status === 'confirmed') {
      const age = parseUtcInstant(nowIso(context)).getTime() - parseUtcInstant(current.createdAt).getTime();
      if (age > STATUS_DETAIL_GRACE_MS) return json<StatusResponse>({ status: 'confirmed', booking: null });
      return json<StatusResponse>({ status: 'confirmed', booking: confirmationBookingPayload(context, current) });
    }
    if (current.status === 'expired') return json<StatusResponse>({ status: 'expired', booking: null });
    if (current.status === 'cancelled' || current.status === 'no_show') return json<StatusResponse>({ status: 'cancelled', booking: null });
    return json<StatusResponse>({ status: 'pending', booking: null });
  }).then(withSensitiveHeaders);
}

// getBookingByCancelToken/getBookingByOperatorToken enforce expiry and, for the cancel token,
// revocation as part of the same lookup query — an expired or revoked token comes back as a plain
// null here, identical to an unknown one, so this stays a single `if (!booking) throw 403`.
export async function tokenBooking(context: ReservaContext, token: string, operator = false, refundRecovery = false): Promise<Booking> {
  const now = nowIso(context);
  const booking = operator
    ? await (refundRecovery
      ? context.repo.getBookingByOperatorTokenForRefundRecovery(token, now)
      : context.repo.getBookingByOperatorToken(token, now))
    : await context.repo.getBookingByCancelToken(token, now);
  if (!booking) throw new HttpError(403, 'forbidden', 'Invalid booking token');
  // Every caller of tokenBooking is a mutation-adjacent request touching this exact booking, so this
  // is one of the places a later request must drain rows a prior mutation left owed. Draining here
  // never touches `bookings`, only side_effect_operations.
  await runOwedMutationSideEffects(context, booking);
  return booking;
}

export function handleManage(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const token = new URL(request.url).searchParams.get('token');
    if (!token) throw new HttpError(403, 'forbidden', 'A booking token is required');
    const now = nowIso(context);
    const customer = await context.repo.getBookingByCancelToken(token, now);
    const booking = customer ?? await context.repo.getBookingByOperatorToken(token, now);
    if (!booking) throw new HttpError(403, 'forbidden', 'Invalid booking token');
    // The manage page is read via a direct token lookup, not
    // tokenBooking, so it needs its own drain call — still a booking-touching request a prior
    // mutation's undelivered side effects should get to piggyback on.
    await runOwedMutationSideEffects(context, booking);
    const operator = !customer;
    return json<ManageResponse>({ booking: manageBookingPayload(context, booking), role: operator ? 'operator' : 'customer', canCancel: operator ? booking.status === 'confirmed' : canCancelBooking(booking, now, context.config.booking.cancelCutoffHours), canReschedule: operator ? booking.status === 'confirmed' : canRescheduleBooking(booking, now, context.config.booking.reschedule.cutoffHours, context.config.booking.reschedule.enabled), canNoShow: operator && booking.status === 'confirmed' && parseUtcInstant(booking.startsAt).getTime() < parseUtcInstant(now).getTime(), deadline: new Date(parseUtcInstant(booking.startsAt).getTime() - context.config.booking.cancelCutoffHours * 3_600_000).toISOString() });
  }).then(withSensitiveHeaders);
}
