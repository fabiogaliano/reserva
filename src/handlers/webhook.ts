import { verifyPayment } from '../core/payment-verification.js';
import {
  cancellationSideEffectSeeds,
  confirmBookingFromPayment,
  dispatchDisputeEvent,
  dispatchMutation,
  openPaymentVerificationIncident,
  runOwedMutationSideEffects,
} from '../confirmation.js';
import type { Booking } from '../core/booking.js';
import type { PaymentEventParsed } from '../core/events.js';
import type { ReservaContext } from '../context.js';
import { nowIso } from '../context.js';
import { HttpError, json } from '../http.js';
import { attemptRefund } from '../refund-executor.js';
import { run } from './shared.js';

// Reserva does not support delayed payment methods (vouchers, bank debits): their money arrives
// days after the capacity hold dies. Releasing the hold and cancelling the payment is everything
// this path can do synchronously; `async_payment_succeeded` below covers the money that still lands.
async function refuseDelayedPayment(context: ReservaContext, booking: Booking, event: PaymentEventParsed): Promise<void> {
  // The webhook is the authoritative path and the customer may never poll `status`, so the
  // operator's incident is opened here, not left to the confirmation page.
  await openPaymentVerificationIncident(context, booking, 'payment_not_paid');
  await context.repo.expireHold(booking.id, nowIso(context));
  await cancelPaymentBestEffort(context, event.paymentRef ?? booking.paymentRef ?? null, booking.id);
  context.logger.warn?.('delayed payment method refused', {
    eventId: event.id, bookingId: booking.id, paymentStatus: event.paymentStatus,
  });
}

// Never lets a cancellation problem fail the webhook: the customer's booking is already refused
// either way, and a payment that cannot be cancelled is refunded when it settles.
async function cancelPaymentBestEffort(context: ReservaContext, paymentRef: string | null, bookingId: string): Promise<void> {
  const cancel = context.providers.payments.cancelPayment;
  if (!paymentRef || !cancel) {
    context.logger.error?.('cannot cancel refused payment', { bookingId, reason: paymentRef ? 'provider has no cancelPayment' : 'no payment reference' });
    return;
  }
  try {
    await cancel.call(context.providers.payments, paymentRef);
  } catch (error) {
    context.logger.error?.('cancel refused payment failed', { bookingId, error: error instanceof Error ? error.message : String(error) });
  }
}

// Records the refund as a durable refund_operations row FIRST, so a failed provider call is picked
// up by the ordinary refund retry loop and its incident projection rather than needing a bespoke
// "refund manually" alert. The booking stays expired: it was never confirmed.
async function refundRefusedDelayedPayment(context: ReservaContext, booking: Booking, event: PaymentEventParsed): Promise<void> {
  if (booking.paymentSessionRef && event.sessionRef && booking.paymentSessionRef !== event.sessionRef) {
    context.logger.warn?.('async payment for a different session', { eventId: event.id, bookingId: booking.id });
    return;
  }
  if (event.amountCaptured !== booking.priceMinor || (event.currency !== undefined && event.currency !== context.config.business.currency)) {
    context.logger.warn?.('async payment amount does not match the refused booking', {
      eventId: event.id, bookingId: booking.id, amountCaptured: event.amountCaptured, currency: event.currency,
    });
    return;
  }
  const paymentRef = event.paymentRef ?? booking.paymentRef ?? null;
  if (!paymentRef) {
    context.logger.error?.('async payment has no payment reference to refund', { eventId: event.id, bookingId: booking.id });
    return;
  }
  const operationId = crypto.randomUUID();
  const claimed = await context.repo.claimRefundOperation({
    id: operationId, bookingId: booking.id, paymentIntent: paymentRef, choice: 'full', requestedAt: nowIso(context),
  });
  const operation = claimed ? null : await context.repo.getRefundOperationByBookingId(booking.id);
  if (operation?.status === 'succeeded') return;
  context.logger.warn?.('refunding a delayed payment for a refused booking', { eventId: event.id, bookingId: booking.id });
  await attemptRefund(context, booking, operation?.id ?? operationId, 'full', paymentRef);
}

export function handlePaymentWebhook(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const event = await context.providers.payments.parseWebhook(request);
    if (event.type === 'checkout_completed') {
      const booking = event.bookingId ? await context.repo.getBookingById(event.bookingId) : event.sessionRef ? await context.repo.getBookingBySessionRef(event.sessionRef) : null;
      if (!booking) return json({ received: true });
      // A completed session that is not paid means the customer picked a delayed method (voucher,
      // bank debit) whose money arrives days after the hold dies. Reserva refuses it outright
      // instead of verifying: release the capacity, try to stop the payment, and answer 200 so the
      // provider stops redelivering an event that will never become acceptable.
      if (event.paid === false && event.paymentStatus !== 'no_payment_required') {
        await refuseDelayedPayment(context, booking, event);
        return json({ received: true });
      }
      const verification = verifyPayment(booking, {
        completed: true,
        sessionRef: event.sessionRef,
        paid: event.paid,
        paymentStatus: event.paymentStatus,
        amountTotal: event.amountCaptured,
        currency: event.currency,
        expectedCurrency: context.config.business.currency,
      });
      // 'payment_not_paid' can no longer reach here: an unpaid completed session was refused above.
      if (!verification.allowed) {
        context.logger.warn?.('payment verification rejected', { eventId: event.id, bookingId: booking.id, reason: verification.reason });
        await openPaymentVerificationIncident(context, booking, verification.reason);
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
    } else if (event.type === 'async_payment_succeeded') {
      // The delayed payment Reserva already refused has now settled. The hold is long gone and no
      // booking was made, so the only correct outcome is to give the money back.
      const booking = event.bookingId ? await context.repo.getBookingById(event.bookingId) : event.sessionRef ? await context.repo.getBookingBySessionRef(event.sessionRef) : null;
      if (booking) await refundRefusedDelayedPayment(context, booking, event);
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
          // Reconcile the durable operation record regardless of which side ends up owning
          // cancelled_by — the payment provider is the source of truth for whether the money moved,
          // so its refund id/amount wins here. Upsert rather than claim: a dashboard-initiated refund has no prior claim to race against.
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
              // resurrect/overwrite them. CAS loss leaves this webhook's transition as a no-op; the
              // winner's existing outbox drains below, and the provider still gets 200 so a retry never causes redelivery storms.
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
            // Idempotent redelivery of an already-cancelled booking — still a booking-touching
            // request, so drain any rows a prior delivery left owed (e.g. the isolate died mid-attempt).
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
