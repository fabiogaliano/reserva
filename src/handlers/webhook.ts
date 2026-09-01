import { verifyPayment } from '../core/payment-verification';
import {
  cancellationSideEffectSeeds,
  confirmBookingFromPayment,
  dispatchDisputeEvent,
  dispatchMutation,
  runOwedMutationSideEffects,
} from '../confirmation';
import type { ReservaContext } from '../context';
import { nowIso } from '../context';
import { HttpError, json } from '../http';
import { run } from './shared';

export function handlePaymentWebhook(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const event = await context.providers.payments.parseWebhook(request);
    if (event.type === 'checkout_completed') {
      const booking = event.bookingId ? await context.repo.getBookingById(event.bookingId) : event.sessionRef ? await context.repo.getBookingBySessionRef(event.sessionRef) : null;
      if (!booking) return json({ received: true });
      const verification = verifyPayment(booking, {
        completed: true,
        sessionRef: event.sessionRef,
        paid: event.paid,
        paymentStatus: event.paymentStatus,
        amountTotal: event.amountCaptured,
        currency: event.currency,
        expectedCurrency: context.config.business.currency,
      });
      if (!verification.allowed) {
        context.logger.warn?.('payment verification rejected', { eventId: event.id, bookingId: booking.id, reason: verification.reason });
        if (verification.reason === 'session_ref_missing' || verification.reason === 'session_mismatch') {
          throw new HttpError(409, 'payment_session_mismatch', 'Payment session does not match the booking');
        }
        throw new HttpError(409, 'payment_amount_mismatch', 'Payment does not match the booking price');
      }
      const confirmed = await confirmBookingFromPayment(context, booking, event.paymentRef ?? null, event);
      await runOwedMutationSideEffects(context, confirmed);
      if (verification.sessionRefToBackfill && confirmed.paymentSessionRef !== verification.sessionRefToBackfill) {
        await context.repo.updateBooking(confirmed.id, { paymentSessionRef: verification.sessionRefToBackfill, updatedAt: nowIso(context) });
      }
    } else if (event.type === 'checkout_expired') {
      const booking = event.bookingId ? await context.repo.getBookingById(event.bookingId) : event.sessionRef ? await context.repo.getBookingBySessionRef(event.sessionRef) : null;
      if (booking) await context.repo.expireHold(booking.id, nowIso(context));
    } else if (event.type === 'refunded') {
      if (event.amountCaptured === undefined || event.amountRefunded === undefined || event.amountRefunded !== event.amountCaptured) {
        context.logger.warn?.('non-full refund does not cancel booking', { eventId: event.id });
      } else {
        const byPayment = event.paymentRef && context.repo.getBookingByPaymentRef
          ? await context.repo.getBookingByPaymentRef(event.paymentRef)
          : null;
        const booking = byPayment ?? (event.bookingId ? await context.repo.getBookingById(event.bookingId) : null);
        if (booking) {
          const timestamp = nowIso(context);
          // Reconcile the durable operation record regardless of which side (this webhook or an
          // operator's own claim) ends up owning the booking's cancelled_by — the payment provider
          // is the source of truth for whether the money moved, so its refund id/amount wins here
          // (BK-REFUND-001). Upsert rather than claim: a dashboard-initiated refund has no prior
          // claim to race against.
          const refund = {
            id: crypto.randomUUID(),
            bookingId: booking.id,
            paymentIntent: event.paymentRef ?? booking.paymentRef ?? null,
            choice: 'full' as const,
            status: 'succeeded' as const,
            stripeRefundId: event.refundRef ?? null,
            amountCents: event.amountRefunded,
            requestedAt: timestamp,
            resolvedAt: timestamp,
          };
          if (booking.status !== 'cancelled') {
            const updated = await context.repo.upsertRefundOperationAndTransitionToCancelled(refund, booking.id, {
              // no_show and cancelled are terminal: a refund arriving after either must not
              // resurrect/overwrite them (spec item 4). CAS loss leaves this webhook's
              // transition as a no-op; the winner's existing outbox drains below, and the provider
              // still gets 200 so a retry never causes redelivery storms.
              expectedStatusIn: ['hold', 'confirmed', 'expired'],
              cancelledAt: timestamp, cancelledBy: 'operator', updatedAt: timestamp,
              mutationSideEffects: cancellationSideEffectSeeds(context, booking, 'booking.cancelled_by_operator', timestamp),
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
    } else if (event.type === 'dispute_created') {
      const byPayment = event.paymentRef && context.repo.getBookingByPaymentRef
        ? await context.repo.getBookingByPaymentRef(event.paymentRef)
        : null;
      const booking = byPayment ?? (event.bookingId ? await context.repo.getBookingById(event.bookingId) : null);
      context.logger.warn?.('payment dispute created', { eventId: event.id, bookingId: booking?.id ?? event.bookingId });
      if (booking) await dispatchDisputeEvent(context, booking, event.id);
    }
    return json({ received: true });
  });
}
