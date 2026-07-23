import type { Booking } from './core/booking';
import { resolveTour } from './core/config';
import type { BookingEvent, EmailBookingEvent, StripeCustomerDetails } from './core/events';
import {
  capacityForDate,
  defaultCapacityForDate,
  getOccupancyIntervals,
  isSlotAvailable,
} from './core/occupancy';
import { localDateKey, parseUtcInstant } from './core/time';
import type { BookkitContext } from './context';
import { nowIso } from './context';
import type { SideEffectOperationRecord } from './repo';

export class ConfirmationInProgressError extends Error {
  readonly status = 503;
  readonly code = 'confirmation_in_progress';

  constructor() {
    super('Booking confirmation is already in progress');
    this.name = 'ConfirmationInProgressError';
  }
}

async function expiredHoldOversold(context: BookkitContext, booking: Booking, now: string): Promise<boolean> {
  const tour = resolveTour(context.config, booking.tourSlug);
  const date = localDateKey(booking.startsAt, context.config.business.timezone);
  const [override, capacityDefaults] = await Promise.all([
    context.repo.getDayOverride(date),
    context.repo.listCapacityDefaults(),
  ]);
  const lookback = Math.max(...Object.values(context.config.tours).map((candidate) => candidate.durationMin + candidate.turnaroundMin));
  const windowStart = new Date(parseUtcInstant(booking.startsAt).getTime() - lookback * 60_000).toISOString();
  const windowEnd = new Date(parseUtcInstant(booking.endsAt).getTime() + tour.turnaroundMin * 60_000).toISOString();
  const [bookings, calendarEvents] = await Promise.all([
    context.repo.listOccupancyBookings(windowStart, windowEnd),
    context.providers.calendar ? context.providers.calendar.listEvents(windowStart, windowEnd) : Promise.resolve([]),
  ]);
  const capacity = capacityForDate(
    date,
    defaultCapacityForDate(date, context.config.fleet.defaultCapacity, capacityDefaults),
    override ? [override] : [],
  ).capacity;
  return !isSlotAvailable(booking.startsAt, booking.endsAt, {
    capacity,
    intervals: getOccupancyIntervals({
      bookings,
      calendarEvents,
      tour,
      tours: context.config.tours,
      now,
    }),
    requestedUnits: tour.occupancyFor ? tour.occupancyFor(booking.people) : 1,
    turnaroundMin: tour.turnaroundMin,
  });
}

async function renewConfirmationLease(context: BookkitContext, bookingId: string, token: string): Promise<void> {
  const now = context.clock();
  const renewed = await context.repo.renewConfirmationLease(
    bookingId,
    token,
    now.toISOString(),
    new Date(now.getTime() + 5 * 60_000).toISOString(),
  );
  if (!renewed) throw new ConfirmationInProgressError();
}

async function resolveOperation(
  context: BookkitContext,
  input: Parameters<BookkitContext['repo']['resolveSideEffectOperation']>[0],
): Promise<void> {
  if (!await context.repo.resolveSideEffectOperation(input)) throw new ConfirmationInProgressError();
}

async function executeOperation(
  context: BookkitContext,
  booking: Booking,
  operation: SideEffectOperationRecord,
  token: string,
): Promise<void> {
  if (operation.status === 'succeeded' || operation.kind === 'oversell') return;
  await renewConfirmationLease(context, booking.id, token);
  if (!await context.repo.claimSideEffectOperation(booking.id, operation.kind, token, nowIso(context))) {
    throw new ConfirmationInProgressError();
  }
  try {
    await renewConfirmationLease(context, booking.id, token);
    const providerResultId = operation.kind === 'calendar_create'
      ? context.providers.calendar
        ? await context.providers.calendar.createEvent(booking, context.config)
        : null
      : (context.providers.email
        ? await context.providers.email.send('booking.confirmed', booking, context.config, context.routeConfig.paths)
        : null);
    await renewConfirmationLease(context, booking.id, token);
    await resolveOperation(context, {
      bookingId: booking.id,
      kind: operation.kind,
      leaseToken: token,
      status: 'succeeded',
      ...(providerResultId ? { providerResultId } : {}),
      resolvedAt: nowIso(context),
    });
  } catch (error) {
    if (error instanceof ConfirmationInProgressError) throw error;
    await resolveOperation(context, {
      bookingId: booking.id,
      kind: operation.kind,
      leaseToken: token,
      status: 'failed',
      error: String(error),
      resolvedAt: nowIso(context),
    });
    throw error;
  }
}

async function confirmBookingFromPaymentUnlocked(
  context: BookkitContext,
  booking: Booking,
  token: string,
  paymentIntent?: string | null,
  details: StripeCustomerDetails = {},
): Promise<Booking> {
  const now = nowIso(context);
  const customerPatch: StripeCustomerDetails = {};
  if (details.customerName !== undefined) customerPatch.customerName = details.customerName;
  if (details.customerEmail !== undefined) customerPatch.customerEmail = details.customerEmail;
  if (details.customerPhone !== undefined) customerPatch.customerPhone = details.customerPhone;
  if (details.pickupAddress !== undefined) customerPatch.pickupAddress = details.pickupAddress;
  let current = booking;
  let shouldDispatchConfirmation = current.status !== 'confirmed';
  let transitionApplied = false;
  if (current.status === 'hold' || current.status === 'expired') {
    let oversold = false;
    if (current.status === 'expired') {
      context.logger.warn?.('confirming expired hold after payment; possible one-slot oversell', {
        bookingId: current.id,
        reference: current.reference,
        startsAt: current.startsAt,
      });
      try {
        oversold = await expiredHoldOversold(context, current, now);
      } catch (error) {
        context.logger.warn?.('could not recheck capacity for expired paid hold', { bookingId: current.id, error: String(error) });
        oversold = true;
      }
    }
    const result = await context.repo.confirmWithSideEffectOperations(current.id, {
      expectedStatusIn: ['hold', 'expired'],
      ...(paymentIntent !== undefined ? { stripePaymentIntent: paymentIntent } : {}),
      ...customerPatch,
      leaseToken: token,
      oversold,
      updatedAt: now,
    });
    transitionApplied = result !== null;
    current = result ?? await context.repo.getBookingById(current.id) ?? current;
    if (!transitionApplied && current.status !== 'confirmed') throw new ConfirmationInProgressError();
  }
  if (current.status !== 'confirmed') return current;

  if (!transitionApplied && (paymentIntent !== undefined || Object.keys(customerPatch).length > 0)) {
    await renewConfirmationLease(context, current.id, token);
    if (!await context.repo.applyConfirmedPaymentDetails(current.id, {
      ...(paymentIntent !== undefined ? { stripePaymentIntent: paymentIntent } : {}),
      ...customerPatch,
    }, token, nowIso(context))) {
      throw new ConfirmationInProgressError();
    }
    current = await context.repo.getBookingById(current.id) ?? current;
  }

  await renewConfirmationLease(context, current.id, token);
  await context.repo.ensureConfirmationSideEffectOperations(current.id, token, nowIso(context));
  const operations = await context.repo.listSideEffectOperations(current.id);
  shouldDispatchConfirmation ||= operations.some((operation) => operation.status !== 'succeeded');
  for (const operation of operations) await executeOperation(context, current, operation, token);
  current = await context.repo.getBookingById(current.id) ?? current;
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
    return await confirmBookingFromPaymentUnlocked(context, current, token, paymentIntent, details);
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
      await context.providers.email.send(event, booking, context.config, context.routeConfig.paths);
    } catch (error) {
      context.logger.warn?.('bookkit mutation email failed', { event, bookingId: booking.id, error: String(error) });
    }
  }
  dispatchNonCritical(context, event, booking);
}
