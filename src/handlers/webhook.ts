import { verifyPayment } from '../core/payment-verification';
import {
  confirmBookingFromPayment,
  dispatchMutation,
  dispatchNonCritical,
  runOwedMutationSideEffects,
} from '../confirmation';
import type { BookkitContext } from '../context';
import { nowIso } from '../context';
import { HttpError, json } from '../http';
import { cancellationSideEffectKinds } from './booking-actions';
import { run } from './shared';

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
