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
import type { RefundChoice, RefundOperationRecord } from '../repo.js';
import { attemptRefund, type RefundAttemptTarget } from '../refund-executor.js';
import { bearerToken, constantTimeEqual, HttpError, json, requestJson, requireString } from '../http.js';
import { checkSlot } from './checkout.js';
import { run, warnDeprecatedField, withSensitiveHeaders } from './shared.js';
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
        throw new HttpError(409, 'invalid_transition', 'booking was rescheduled; reload and try again');
      }
      throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
    }
    await dispatchMutation(context, 'booking.cancelled_by_customer', updated);
    return json<ManageActionResponse>({ ok: true });
  }).then(withSensitiveHeaders);
}

// `start` is the one spelling, matching checkout; `newStart` still reads so a consumer can upgrade
// on its own schedule, and says so once per isolate in the log.
function readStart(context: ReservaContext, body: Record<string, unknown>): string {
  if (body.start === undefined && body.newStart !== undefined) {
    warnDeprecatedField(context, 'reschedule', 'newStart');
    return requireString(body.newStart, 'start');
  }
  return requireString(body.start, 'start');
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
    await rescheduleWithToken(context, booking, readStart(context, body), false);
    return json<ManageActionResponse>({ ok: true });
  }).then(withSensitiveHeaders);
}

// The bearer half of operator auth, on its own so the ops reconcile route gates on exactly the
// same secret and comparison as the operator booking routes rather than re-deriving them.
export async function operatorBearerAuthorized(context: ReservaContext, request: Request): Promise<boolean> {
  const expected = await getSecret(context, OPERATOR_SECRET_NAME);
  const supplied = bearerToken(request);
  return Boolean(expected) && Boolean(supplied) && constantTimeEqual(expected!, supplied!);
}

async function operatorBooking(
  context: ReservaContext,
  request: Request,
  body: Record<string, unknown>,
  refundRecovery = false,
): Promise<Booking> {
  const operatorToken = typeof body.operatorToken === 'string' ? body.operatorToken : null;
  if (operatorToken) return tokenBooking(context, operatorToken, true, refundRecovery);
  if (!(await operatorBearerAuthorized(context, request))) throw new HttpError(403, 'forbidden', 'Operator authorization required');
  const bookingId = requireString(body.bookingId, 'bookingId');
  const booking = await context.repo.getBookingById(bookingId);
  if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');
  // The operator-token branch above already drains via tokenBooking — this bearer-token branch is
  // the other way an operator-adjacent request loads a booking, so it needs the same drain call.
  await runOwedMutationSideEffects(context, booking);
  return booking;
}

// What one request asked for, before any durable row exists to compare it against. `amountMinor`
// is null for every choice but 'partial', whose amount is not derivable from the booking.
interface RefundDecision {
  choice: RefundChoice;
  amountMinor: number | null;
}

function readRefundDecision(body: Record<string, unknown>, booking: Booking): RefundDecision {
  const choice = body.refund === 'full' || body.refund === 'none' || body.refund === 'partial' ? body.refund : null;
  if (!choice) throw new HttpError(400, 'validation_failed', 'refund must be none, full or partial');
  const amount = body.refundAmountMinor;
  if (choice !== 'partial') {
    // Rejected rather than ignored: an amount sent alongside 'full'/'none' means the caller thinks
    // it is deciding something the durable record would not reflect.
    if (amount !== undefined) {
      throw new HttpError(400, 'validation_failed', 'refundAmountMinor is only valid with refund=partial');
    }
    return { choice, amountMinor: null };
  }
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    throw new HttpError(400, 'validation_failed', 'refundAmountMinor must be a whole number of minor units');
  }
  // Strictly between the two other choices: 0 is refund=none and the whole price is refund=full, so
  // a 'partial' row can never describe a refund of a size its own choice contradicts.
  if (amount < 1 || amount >= booking.priceMinor) {
    throw new HttpError(400, 'validation_failed', `refundAmountMinor must be at least 1 and below the booking price (${booking.priceMinor})`);
  }
  return { choice, amountMinor: amount };
}

// Two requests are the same logical operation only when they decided the same thing — refunding
// €20 and refunding €50 are different decisions even though both are 'partial'.
function sameDecision(operation: RefundOperationRecord, decision: RefundDecision): boolean {
  return operation.choice === decision.choice && operation.requestedAmountCents === decision.amountMinor;
}

// Always built from the winning ROW, never from the request: a resumed operation must move the
// amount that was durably decided, not whatever this request happens to be carrying.
function targetFor(operation: RefundOperationRecord, fallbackPaymentRef: string | null): RefundAttemptTarget {
  return {
    operationId: operation.id,
    choice: operation.choice,
    requestedAmountCents: operation.requestedAmountCents,
    paymentRef: operation.paymentIntent ?? fallbackPaymentRef,
  };
}

// Executes (or resumes) the Stripe side of a claimed refund operation and records the outcome.
// Safe to call more than once for the same operation id: refund() carries Stripe's own idempotency
// key, so a resumed/retried call cannot double-refund even when a previous attempt's D1 write never
// landed (crash between Stripe success and recording it).
async function resolvePendingRefund(
  context: ReservaContext,
  booking: Booking,
  target: RefundAttemptTarget,
): Promise<void> {
  const outcome = await attemptRefund(context, booking, target);
  if (outcome.kind === 'payment_ref_missing') {
    throw new HttpError(409, 'refund_payment_ref_missing', 'Cannot refund a booking without a payment reference');
  }
  if (outcome.kind === 'amount_missing') {
    // Permanent, so never the 502 "will be retried" below: the row itself is unusable.
    throw new HttpError(409, 'refund_failed', 'The recorded refund decision is missing its amount');
  }
  if (outcome.kind === 'failed') {
    throw new HttpError(502, 'refund_failed', 'The refund could not be completed; it will be retried');
  }
}

// Reconciles a request against the refund-operation row for an already-cancelled booking. Used both
// when the booking was already cancelled on entry and when this request's own CAS cancel attempt
// lost to a concurrent same-decision winner. Stripe may only be touched for the operation that
// actually won the claim, and only once its decision matches this request's own.
async function reconcileCancelledRefund(
  context: ReservaContext,
  booking: Booking,
  decision: RefundDecision,
): Promise<Response> {
  const existing = await context.repo.getRefundOperationByBookingId(booking.id);
  if (!existing) {
    if (decision.choice === 'none') return json<ManageActionResponse>({ ok: true });
    if (booking.paymentRef === null) {
      throw new HttpError(409, 'refund_payment_ref_missing', 'Cannot refund a booking without a payment reference');
    }
    const operationId = crypto.randomUUID();
    const claimed = await context.repo.claimRefundOperation({
      id: operationId,
      bookingId: booking.id,
      paymentIntent: booking.paymentRef,
      choice: decision.choice,
      requestedAmountCents: decision.amountMinor,
      requestedAt: nowIso(context),
    });
    if (claimed) {
      await resolvePendingRefund(context, booking, {
        operationId, choice: decision.choice, requestedAmountCents: decision.amountMinor, paymentRef: booking.paymentRef,
      });
      return json<ManageActionResponse>({ ok: true });
    }
    const concurrent = await context.repo.getRefundOperationByBookingId(booking.id);
    if (!concurrent || !sameDecision(concurrent, decision)) {
      throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
    }
    if (concurrent.status !== 'succeeded') {
      await resolvePendingRefund(context, booking, targetFor(concurrent, booking.paymentRef));
    }
    return json<ManageActionResponse>({ ok: true });
  }
  if (!sameDecision(existing, decision)) {
    throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
  }
  if (existing.status !== 'succeeded') {
    await resolvePendingRefund(context, booking, targetFor(existing, booking.paymentRef ?? null));
  }
  return json<ManageActionResponse>({ ok: true });
}

async function completeClaimedOperatorCancellation(
  context: ReservaContext,
  booking: Booking,
  operationId: string,
  decision: RefundDecision,
): Promise<Response> {
  const result = await resumeClaimedOperatorCancellation(context, booking, operationId);
  if (result.kind === 'slot_changed') {
    throw new HttpError(409, 'slot_unavailable', 'The selected slot is no longer available');
  }
  if (result.kind === 'invalid_transition') {
    throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
  }
  await resolvePendingRefund(context, result.booking, {
    operationId,
    choice: decision.choice,
    requestedAmountCents: decision.amountMinor,
    paymentRef: result.booking.paymentRef ?? booking.paymentRef ?? null,
  });
  return json<ManageActionResponse>({ ok: true });
}

export function handleOperatorCancel(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body, true);
    const decision = readRefundDecision(body, booking);

    if (booking.status === 'cancelled') {
      // Already cancelled, but the refund claimed for it might not have finished. Resume it instead
      // of silently reporting ok while the money side is unresolved — only when this request's own
      // decision is the one that actually won the claim.
      return reconcileCancelledRefund(context, booking, decision);
    }
    if (booking.status !== 'confirmed') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
    if (decision.choice !== 'none' && booking.paymentRef === null) {
      // Free bookings also use refund='none': requiring an intent for every choice that moves money
      // keeps the durable operation record an honest statement that Stripe money was refunded.
      throw new HttpError(409, 'refund_payment_ref_missing', 'Cannot refund a booking without a payment reference');
    }

    // Claim-then-act: the refund decision is durably recorded before Stripe is ever touched, so two
    // requests deciding differently on this booking can never both call Stripe. The CAS cancel
    // below, not the claim, is the authoritative gate on when Stripe is reached.
    const operationId = crypto.randomUUID();
    const claimed = await context.repo.claimRefundOperation({
      id: operationId, bookingId: booking.id, paymentIntent: booking.paymentRef ?? null,
      choice: decision.choice, requestedAmountCents: decision.amountMinor, requestedAt: nowIso(context),
    });
    if (!claimed) {
      // Lost the claim to a concurrent request for this booking. Same decision = treat as the same
      // logical operation and resume it; a different one already won = surface the conflict.
      const existing = await context.repo.getRefundOperationByBookingId(booking.id);
      if (!existing || !sameDecision(existing, decision)) {
        throw new HttpError(409, 'refund_conflict', 'A different refund decision already won for this booking');
      }
      if (existing.status === 'succeeded') return json<ManageActionResponse>({ ok: true });
      const fresh = await context.repo.getBookingById(booking.id);
      if (existing.status === 'requested' && fresh?.status === 'confirmed') {
        // A crash or calendar failure can leave a claimed decision before its CAS. Resume the
        // whole operation, not only Stripe: the CAS remains the gate that makes a refund safe.
        return completeClaimedOperatorCancellation(context, booking, existing.id, decision);
      }
      // Never resume the claim-holder's refund until the booking is durably cancelled.
      if (fresh?.status !== 'cancelled') throw new HttpError(409, 'invalid_transition', 'Only confirmed bookings can be cancelled');
      await resolvePendingRefund(context, booking, targetFor(existing, booking.paymentRef ?? null));
      return json<ManageActionResponse>({ ok: true });
    }

    return completeClaimedOperatorCancellation(context, booking, operationId, decision);
  }).then(withSensitiveHeaders);
}

export function handleOperatorReschedule(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const booking = await operatorBooking(context, request, body);
    await rescheduleWithToken(context, booking, readStart(context, body), true);
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
