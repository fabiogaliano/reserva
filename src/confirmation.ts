import { confirmBooking, type Booking } from './core/booking';
import type { BookingEvent, EmailBookingEvent, StripeCustomerDetails } from './core/events';
import type { BookkitContext } from './context';
import { nowIso } from './context';

export class ConfirmationInProgressError extends Error {
  readonly status = 503;
  readonly code = 'confirmation_in_progress';

  constructor() {
    super('Booking confirmation is already in progress');
    this.name = 'ConfirmationInProgressError';
  }
}

async function confirmBookingFromPaymentUnlocked(
  context: BookkitContext,
  booking: Booking,
  paymentIntent?: string | null,
  details: StripeCustomerDetails = {},
): Promise<Booking> {
  const now = nowIso(context);
  const shouldDispatchConfirmation = booking.status !== 'confirmed'
    || !booking.calendarSynced
    || !booking.emailSynced
    || !booking.tourflowSynced;
  const customerPatch: StripeCustomerDetails = {};
  if (details.customerName !== undefined) customerPatch.customerName = details.customerName;
  if (details.customerEmail !== undefined) customerPatch.customerEmail = details.customerEmail;
  if (details.customerPhone !== undefined) customerPatch.customerPhone = details.customerPhone;
  if (details.pickupAddress !== undefined) customerPatch.pickupAddress = details.pickupAddress;
  let current = booking;
  if (current.status === 'hold' || current.status === 'expired') {
    if (current.status === 'expired') {
      // Spec §6: payment can land after a hold's window expires; we still honor it,
      // accepting a possible one-slot oversell, but an operator needs a signal.
      context.logger.warn?.('confirming expired hold after payment; possible one-slot oversell', {
        bookingId: current.id,
        reference: current.reference,
        startsAt: current.startsAt,
      });
    }
    current = confirmBooking(current, now, paymentIntent === undefined ? customerPatch : {
      ...customerPatch,
      stripePaymentIntent: paymentIntent,
    });
    current = await context.repo.updateBooking(current.id, {
      status: current.status,
      holdExpiresAt: null,
      stripePaymentIntent: paymentIntent === undefined ? current.stripePaymentIntent : paymentIntent,
      ...customerPatch,
      updatedAt: current.updatedAt,
    });
  } else if (paymentIntent || Object.keys(customerPatch).length > 0) {
    current = await context.repo.updateBooking(current.id, {
      ...(paymentIntent ? { stripePaymentIntent: paymentIntent } : {}),
      ...customerPatch,
      updatedAt: now,
    });
  }
  if (current.status !== 'confirmed') return current;

  if (!current.calendarSynced) {
    if (context.providers.calendar) {
      const eventId = current.calendarEventId
        ? current.calendarEventId
        : await context.providers.calendar.createEvent(current, context.config);
      current = await context.repo.updateBooking(current.id, {
        calendarEventId: eventId,
        calendarSynced: true,
        updatedAt: nowIso(context),
      });
    } else {
      current = await context.repo.updateBooking(current.id, { calendarSynced: true, updatedAt: nowIso(context) });
    }
  }
  if (!current.emailSynced) {
    if (context.providers.email) await context.providers.email.send('booking.confirmed', current, context.config);
    current = await context.repo.updateBooking(current.id, { emailSynced: true, updatedAt: nowIso(context) });
  }
  if (shouldDispatchConfirmation) dispatchNonCritical(context, 'booking.confirmed', current);
  return current;
}

async function confirmBookingWithLease(
  context: BookkitContext,
  booking: Booking,
  paymentIntent: string | null | undefined,
  details: StripeCustomerDetails,
): Promise<Booking> {
  const startedAt = context.clock();
  const token = crypto.randomUUID();
  const acquired = await context.repo.acquireConfirmationLease(
    booking.id,
    token,
    startedAt.toISOString(),
    new Date(startedAt.getTime() + 5 * 60_000).toISOString(),
  );
  if (!acquired) {
    const current = await context.repo.getBookingById(booking.id) ?? booking;
    if (current.status === 'confirmed' && current.calendarSynced && current.emailSynced) return current;
    throw new ConfirmationInProgressError();
  }
  try {
    const current = await context.repo.getBookingById(booking.id) ?? booking;
    return await confirmBookingFromPaymentUnlocked(context, current, paymentIntent, details);
  } finally {
    await context.repo.releaseConfirmationLease(booking.id, token);
  }
}

export async function confirmBookingFromPayment(
  context: BookkitContext,
  booking: Booking,
  paymentIntent?: string | null,
  details: StripeCustomerDetails = {},
): Promise<Booking> {
  const locks = context.confirmationLocks;
  if (!locks) return confirmBookingWithLease(context, booking, paymentIntent, details);
  const previous = locks.get(booking.id) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  locks.set(booking.id, queued);
  await previous;
  try {
    return await confirmBookingWithLease(context, booking, paymentIntent, details);
  } finally {
    release();
    if (locks.get(booking.id) === queued) locks.delete(booking.id);
  }
}

export function dispatchNonCritical(
  context: BookkitContext,
  event: BookingEvent,
  booking: Booking,
): void {
  const task = (async () => {
    if (context.providers.ops && (event !== 'booking.confirmed' || !booking.tourflowSynced)) {
      try {
        await context.providers.ops.push(event, booking);
        if (event === 'booking.confirmed') {
          await context.repo.updateBooking(booking.id, { tourflowSynced: true, updatedAt: nowIso(context) });
        }
      } catch (error) {
        context.logger.warn?.('bookkit ops sink failed', { event, bookingId: booking.id, error: String(error) });
      }
    }
    if (context.providers.analytics) {
      try {
        await context.providers.analytics.track(event, booking);
      } catch (error) {
        context.logger.warn?.('bookkit analytics sink failed', { event, bookingId: booking.id, error: String(error) });
      }
    }
  })();
  if (context.waitUntil) context.waitUntil(task);
  else void task;
}

export async function dispatchMutation(
  context: BookkitContext,
  event: EmailBookingEvent,
  booking: Booking,
): Promise<void> {
  if (context.providers.email) {
    try {
      await context.providers.email.send(event, booking, context.config);
    } catch (error) {
      context.logger.warn?.('bookkit mutation email failed', { event, bookingId: booking.id, error: String(error) });
    }
  }
  dispatchNonCritical(context, event, booking);
}
