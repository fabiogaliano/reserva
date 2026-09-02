import type { ManageActionResponse } from '../core/api.js';
import {
  canCancelBooking,
  canRescheduleBooking,
  cancelBooking,
  markNoShow,
  rescheduleBooking,
  type Booking,
} from '../core/booking.js';
import { DEFAULT_TOKEN_EXPIRY_DAYS } from '../core/config.js';
import { occupancyFor } from '../core/occupancy.js';
import { localDateKey, parseUtcInstant } from '../core/time.js';
import { cancellationSideEffectSeeds, dispatchMutation, mutationSideEffectSeeds, runOwedMutationSideEffects } from '../confirmation.js';
import type { ReservaContext } from '../context.js';
import { getSecret, nowIso, OPERATOR_SECRET_NAME } from '../context.js';
import { resumeClaimedOperatorCancellation } from '../operator-cancellation.js';
import type { RefundChoice } from '../repo.js';
import { attemptRefund } from '../refund-executor.js';
import { bearerToken, constantTimeEqual, HttpError, json, requestJson, requireString } from '../http.js';
import { checkSlot } from './checkout.js';
import { run, withSensitiveHeaders } from './shared.js';
import { tokenBooking } from './status-manage.js';

async function calendarPatch(context: ReservaContext, booking: Booking): Promise<void> {
  if (booking.calendarEventId && context.providers.calendar) {
    await context.providers.calendar.patchEvent(booking.calendarEventId, booking, context.config);
  }
}

export function handleCustomerCancel(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const token = requireString(body.token, 'token');
    const booking = await tokenBooking(context, token);
    if (booking.status === 'cancelled') return json<ManageActionResponse>({ ok: true });
    if (booking.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
    if (!canCancelBooking(booking, nowIso(context), context.config.booking.cancelCutoffHours)) throw new HttpError(403, 'past_cutoff', 'The cancellation deadline has passed');
    const cancelled = cancelBooking(booking, 'customer', nowIso(context));
    const updated = await context.repo.transitionToCancelled(cancelled.id, {
      expectedStatusIn: ['confirmed'], expectedStartsAt: booking.startsAt,
      cancelledAt: cancelled.updatedAt, cancelledBy: 'customer', updatedAt: cancelled.updatedAt,
      mutationSideEffects: cancellationSideEffectSeeds(context, booking, 'booking.cancelled_by_customer', cancelled.updatedAt),
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
    return json<ManageActionResponse>({ ok: true });
  }).then(withSensitiveHeaders);
}

async function readNewStart(body: Record<string, unknown>): Promise<string> {
  return requireString(body.newStart, 'newStart');
}

async function rescheduleWithToken(context: ReservaContext, booking: Booking, newStart: string, operator: boolean): Promise<Booking> {
  const now = nowIso(context);
  if (booking.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be rescheduled');
  if (!operator && !canRescheduleBooking(booking, now, context.config.booking.reschedule.cutoffHours, context.config.booking.reschedule.enabled)) throw new HttpError(403, 'past_cutoff', 'The reschedule deadline has passed');
  const candidate = await checkSlot(context, booking.serviceSlug, booking.quantity, newStart, now, booking.id);
  const next = rescheduleBooking(booking, candidate.startsAt, candidate.service.durationMin, now);
  if (next.startsAt === booking.startsAt && next.endsAt === booking.endsAt) {
    // A prior calendar patch can fail after the transition and notification debt committed. Retrying
    // the same target must repair that patch without minting a second reschedule version or notice.
    await calendarPatch(context, booking);
    return booking;
  }
  // checkSlot above is only a fast-path pre-check (TOCTOU — two concurrent reschedules into the
  // same last unit can both pass it). rescheduleWithCapacity is the authority: it re-evaluates the
  // CAS and occupancy inside the same atomic UPDATE ... WHERE as the write itself.
  const occupancyUnits = occupancyFor(candidate.service, booking.quantity);
  const occupancyEndsAt = new Date(parseUtcInstant(next.endsAt).getTime() + candidate.service.turnaroundMin * 60_000).toISOString();
  const localDate = localDateKey(next.startsAt, context.config.business.timezone);
  // Recompute from the NEW endsAt, exactly like checkout does from the original — otherwise a
  // booking moved later could have its manage link expire before the service happens, and one moved
  // earlier would keep an over-long window relative to its new end.
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
    occupancyUnits, occupancyEndsAt, localDate, defaultCapacity: context.config.capacity.default,
    mutationSideEffects: mutationSideEffectSeeds(context, 'booking.rescheduled', next, next.updatedAt),
  });
  if (!updated) {
    const fresh = await context.repo.getBookingById(next.id);
    if (!fresh || fresh.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be rescheduled');
    // Status is still confirmed but the write lost the atomic guard — either a concurrent reschedule
    // moved starts_at, or capacity shrank concurrently. Both surface identically: the slot this
    // request computed availability against is gone.
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  }
  await calendarPatch(context, updated);
  await dispatchMutation(context, 'booking.rescheduled', updated);
  return updated;
}

export function handleCustomerReschedule(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await tokenBooking(context, requireString(body.token, 'token'));
    await rescheduleWithToken(context, booking, await readNewStart(body), false);
    return json<ManageActionResponse>({ ok: true });
  }).then(withSensitiveHeaders);
}

async function operatorBooking(
  context: ReservaContext,
  request: Request,
  body: Record<string, unknown>,
  refundRecovery = false,
): Promise<Booking> {
  const operatorToken = typeof body.operatorToken === 'string' ? body.operatorToken : null;
  if (operatorToken) return tokenBooking(context, operatorToken, true, refundRecovery);
  const expected = await getSecret(context, OPERATOR_SECRET_NAME);
  const supplied = bearerToken(request);
  if (!expected || !supplied || !constantTimeEqual(expected, supplied)) throw new HttpError(403, 'forbidden', 'Operator authorization required');
  const bookingId = requireString(body.bookingId, 'bookingId');
  const booking = await context.repo.getBookingById(bookingId);
  if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');
  // The operator-token branch above already drains via tokenBooking — this bearer-token branch is
  // the other way an operator-adjacent request loads a booking, so it needs the same drain call.
  await runOwedMutationSideEffects(context, booking);
  return booking;
}

// Executes (or resumes) the Stripe side of a claimed refund operation and records the outcome.
// Safe to call more than once for the same operation id: refund() carries Stripe's own idempotency
// key, so a resumed/retried call cannot double-refund even when a previous attempt's D1 write never
// landed (crash between Stripe success and recording it).
async function resolvePendingRefund(
  context: ReservaContext,
  booking: Booking,
  operationId: string,
  choice: RefundChoice,
  paymentRef: string | null,
): Promise<void> {
  const outcome = await attemptRefund(context, booking, operationId, choice, paymentRef);
  if (outcome.kind === 'payment_ref_missing') {
    throw new HttpError(409, 'refund_payment_ref_missing', 'Cannot refund a booking without a payment reference');
  }
  if (outcome.kind === 'failed') {
    throw new HttpError(502, 'refund_failed', 'The refund could not be completed; it will be retried');
  }
}

// Reconciles a request against the refund-operation row for an already-cancelled booking. Used both
// when the booking was already cancelled on entry and when this request's own CAS cancel attempt
// lost to a concurrent same-choice winner. Stripe may only be touched for the operation that
// actually won the claim, and only once its choice matches this request's own.
async function reconcileCancelledRefund(
  context: ReservaContext,
  booking: Booking,
  refund: 'full' | 'none',
): Promise<Response> {
  const existing = await context.repo.getRefundOperationByBookingId(booking.id);
  if (!existing) {
    if (refund === 'none') return json<ManageActionResponse>({ ok: true });
    if (booking.paymentRef === null) {
      throw new HttpError(409, 'refund_payment_ref_missing', 'Cannot refund a booking without a payment reference');
    }
    const operationId = crypto.randomUUID();
    const claimed = await context.repo.claimRefundOperation({
      id: operationId,
      bookingId: booking.id,
      paymentIntent: booking.paymentRef,
      choice: refund,
      requestedAt: nowIso(context),
    });
    if (claimed) {
      await resolvePendingRefund(context, booking, operationId, refund, booking.paymentRef);
      return json<ManageActionResponse>({ ok: true });
    }
    const concurrent = await context.repo.getRefundOperationByBookingId(booking.id);
    if (!concurrent || concurrent.choice !== refund) {
      throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
    }
    if (concurrent.status !== 'succeeded') {
      await resolvePendingRefund(context, booking, concurrent.id, concurrent.choice, concurrent.paymentIntent ?? booking.paymentRef);
    }
    return json<ManageActionResponse>({ ok: true });
  }
  if (existing.choice !== refund) {
    throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
  }
  if (existing.status !== 'succeeded') {
    await resolvePendingRefund(context, booking, existing.id, existing.choice, existing.paymentIntent ?? booking.paymentRef ?? null);
  }
  return json<ManageActionResponse>({ ok: true });
}

async function completeClaimedOperatorCancellation(
  context: ReservaContext,
  booking: Booking,
  operationId: string,
  refund: 'full' | 'none',
): Promise<Response> {
  const result = await resumeClaimedOperatorCancellation(context, booking, operationId);
  if (result.kind === 'slot_changed') {
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  }
  if (result.kind === 'invalid_transition') {
    throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
  }
  await resolvePendingRefund(
    context,
    result.booking,
    operationId,
    refund,
    result.booking.paymentRef ?? booking.paymentRef ?? null,
  );
  return json<ManageActionResponse>({ ok: true });
}

export function handleOperatorCancel(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body, true);
    const refund = body.refund === 'full' ? 'full' : body.refund === 'none' ? 'none' : null;
    if (!refund) throw new HttpError(400, 'validation_failed', 'refund must be full or none');

    if (booking.status === 'cancelled') {
      // Already cancelled, but the refund claimed for it might not have finished. Resume it instead
      // of silently reporting ok while the money side is unresolved — only when this request's own
      // choice is the one that actually won the claim.
      return reconcileCancelledRefund(context, booking, refund);
    }
    if (booking.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
    if (refund === 'full' && booking.paymentRef === null) {
      // Free bookings also use refund='none': requiring an intent for every 'full' choice keeps
      // the durable operation record an honest statement that Stripe money was refunded.
      throw new HttpError(409, 'refund_payment_ref_missing', 'Cannot refund a booking without a payment reference');
    }

    // Claim-then-act: the refund decision is durably recorded before Stripe is ever touched, so a
    // refund=full and refund=none request racing on this booking can never both call Stripe. The CAS
    // cancel below, not the claim, is the authoritative gate on when Stripe is reached.
    const operationId = crypto.randomUUID();
    const claimed = await context.repo.claimRefundOperation({
      id: operationId, bookingId: booking.id, paymentIntent: booking.paymentRef ?? null,
      choice: refund, requestedAt: nowIso(context),
    });
    if (!claimed) {
      // Lost the claim to a concurrent request for this booking. Same choice = treat as the same
      // logical operation and resume it; a different choice already won = surface the conflict.
      const existing = await context.repo.getRefundOperationByBookingId(booking.id);
      if (!existing || existing.choice !== refund) {
        throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
      }
      if (existing.status === 'succeeded') return json<ManageActionResponse>({ ok: true });
      const fresh = await context.repo.getBookingById(booking.id);
      if (existing.status === 'requested' && fresh?.status === 'confirmed') {
        // A crash or calendar failure can leave a claimed decision before its CAS. Resume the
        // whole operation, not only Stripe: the CAS remains the gate that makes a refund safe.
        return completeClaimedOperatorCancellation(context, booking, existing.id, refund);
      }
      // Never resume the claim-holder's refund until the booking is durably cancelled.
      if (fresh?.status !== 'cancelled') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
      await resolvePendingRefund(context, booking, existing.id, existing.choice, existing.paymentIntent ?? booking.paymentRef ?? null);
      return json<ManageActionResponse>({ ok: true });
    }

    return completeClaimedOperatorCancellation(context, booking, operationId, refund);
  }).then(withSensitiveHeaders);
}

export function handleOperatorReschedule(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body);
    await rescheduleWithToken(context, booking, await readNewStart(body), true);
    return json<ManageActionResponse>({ ok: true });
  }).then(withSensitiveHeaders);
}

export function handleOperatorNoShow(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body);
    if (booking.status === 'no_show') return json<ManageActionResponse>({ ok: true });
    try {
      const next = markNoShow(booking, nowIso(context));
      const updated = await context.repo.transitionToNoShow(next.id, {
        expectedStatusIn: ['confirmed'], updatedAt: next.updatedAt,
        mutationSideEffects: mutationSideEffectSeeds(context, 'booking.no_show', next, next.updatedAt),
      });
      // CAS loss is always a conflict here, not an idempotent 200.
      if (!updated) throw new Error('Booking cannot be marked no-show');
      await dispatchMutation(context, 'booking.no_show', updated);
      return json<ManageActionResponse>({ ok: true });
    } catch (error) {
      throw new HttpError(409, 'invalid_transition', error instanceof Error ? error.message : 'Booking cannot be marked no-show');
    }
  }).then(withSensitiveHeaders);
}
