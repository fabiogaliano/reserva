import type { ConfirmationBooking, ManageBooking, ManageResponse, StatusResponse } from '../core/api';
import { canCancelBooking, canRescheduleBooking, toWireBooking, type Booking } from '../core/booking';
import { meetingPointForBooking, metadataRowsForBooking, pickupPresentationFor, resolveService } from '../core/config';
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
import type { ReservaContext } from '../context';
import { nowIso } from '../context';
import { HttpError, json } from '../http';
import { run, withSensitiveHeaders } from './shared';

// Plan 027 (design decision 2): both summaries below are built from `toWireBooking` — the one
// public booking projection — and their exported types are `Pick`ed from `WireBooking`, so a
// change to that projection breaks these at compile time instead of letting a pushed booking and a
// pulled booking describe the same row differently. What they add on top is presentation only:
// business-local start/end (the projection's are UTC), the meeting point resolved against the
// booking's own stored id, and locale-resolved metadata labels.
function manageBookingPayload(context: ReservaContext, booking: Booking): ManageBooking {
  const service = resolveService(context.config, booking.serviceSlug);
  const wire = toWireBooking(booking);
  // Plan 023 (design decision 4): read surfaces gate on the booking ROW's data, not config — a
  // location-less booking (pickupType null) has no pickup presentation at all, and a pre-023
  // booking of a service that later drops its location module still renders (pickupType stays
  // non-null on that row even though the service config no longer declares any options). Plan 027:
  // the fields stay present as `null` rather than vanishing, so a consumer never branches on key
  // presence.
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
    // Plan 017 (design decision 3): resolved per booking, not read live off the service — a stored
    // id no longer declared in config falls back to the booking's own label snapshot instead of
    // silently pointing the customer at whatever point happens to be first today.
    meetingPoint: presentation ? meetingPointForBooking(service, wire.meetingPointId, wire.meetingPointLabel) : null,
    customerName: wire.customerName,
    customerEmail: wire.customerEmail,
    customerPhone: wire.customerPhone,
    locale: wire.locale,
    status: wire.status,
    priceMinor: wire.priceMinor,
    currency: wire.currency,
    metadata: wire.metadata,
    // Plan 024 (design decision 3): labeled rows for rendering; the raw values stay on `metadata`
    // above. This payload doubles as the admin operator's view of the same booking (role toggles
    // inside manage-page.ts, not a separate render path).
    metadataRows: metadataRowsForBooking(service, booking.metadata, wire.locale, context.config.locales.default),
  };
}

function confirmationBookingPayload(context: ReservaContext, booking: Booking): ConfirmationBooking {
  const service = resolveService(context.config, booking.serviceSlug);
  const wire = toWireBooking(booking);
  // Plan 019 (design decision 2), generalized by plan 023 (design decision 4): gate the meeting
  // point on the row's own presentation — no location data at all (pickupType null) or a selected
  // option that never used a meeting point (custom_both) must not tell the customer to meet
  // anywhere.
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
      if (age > STATUS_DETAIL_GRACE_MS) return json<StatusResponse>({ status: 'confirmed', booking: null });
      return json<StatusResponse>({ status: 'confirmed', booking: confirmationBookingPayload(context, current) });
    }
    if (current.status === 'expired') return json<StatusResponse>({ status: 'expired', booking: null });
    if (current.status === 'cancelled' || current.status === 'no_show') return json<StatusResponse>({ status: 'cancelled', booking: null });
    return json<StatusResponse>({ status: 'pending', booking: null });
  }).then(withSensitiveHeaders);
}

// BK-SEC-002: getBookingByCancelToken/getBookingByOperatorToken enforce expiry (tokens_expire_at)
// and, for the cancel token, revocation (cancel_token_revoked_at) as part of the same lookup
// query (src/repo.ts) — an expired or revoked token comes back as a plain null here, identical to
// an unknown one, so this stays a single `if (!booking) throw 403` with no separate check needed.
export async function tokenBooking(context: ReservaContext, token: string, operator = false, refundRecovery = false): Promise<Booking> {
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

export function handleManage(request: Request, context: ReservaContext): Promise<Response> {
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
    return json<ManageResponse>({ booking: manageBookingPayload(context, booking), role: operator ? 'operator' : 'customer', canCancel: operator ? booking.status === 'confirmed' : canCancelBooking(booking, now, context.config.booking.cancelCutoffHours), canReschedule: operator ? booking.status === 'confirmed' : canRescheduleBooking(booking, now, context.config.booking.reschedule.cutoffHours, context.config.booking.reschedule.enabled), canNoShow: operator && booking.status === 'confirmed' && parseUtcInstant(booking.startsAt).getTime() < parseUtcInstant(now).getTime(), deadline: new Date(parseUtcInstant(booking.startsAt).getTime() - context.config.booking.cancelCutoffHours * 3_600_000).toISOString() });
  }).then(withSensitiveHeaders);
}
