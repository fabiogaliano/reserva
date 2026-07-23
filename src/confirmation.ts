import type { Booking } from './core/booking';
import { resolveTour } from './core/config';
import type { BookingEvent, EmailBookingEvent, EmailRecipientRole, StripeCustomerDetails } from './core/events';
import {
  capacityForDate,
  defaultCapacityForDate,
  getOccupancyIntervals,
  isSlotAvailable,
} from './core/occupancy';
import { localDateKey, parseUtcInstant } from './core/time';
import type { BookkitContext } from './context';
import { nowIso } from './context';
import type {
  ConfirmationSideEffectKind,
  MutationSideEffectOperationKind,
  SideEffectOperationKind,
  SideEffectOperationRecord,
} from './repo';

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

export function isConfirmationSideEffectOperation(operation: SideEffectOperationRecord): operation is SideEffectOperationRecord & { kind: ConfirmationSideEffectKind } {
  return operation.kind === 'calendar_create' || operation.kind === 'email_confirmation' || operation.kind === 'oversell';
}

async function executeOperation(
  context: BookkitContext,
  booking: Booking,
  operation: SideEffectOperationRecord & { kind: ConfirmationSideEffectKind },
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
  const operations = (await context.repo.listSideEffectOperations(current.id)).filter(isConfirmationSideEffectOperation);
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

// BK-SIDE-001 (handoff 13): providers that throw a status-carrying error (BrevoResponseError,
// TourflowResponseError) let a catch here log the HTTP status as a structured field instead of
// embedding the provider's (possibly PII-bearing) response body via String(error) — that body is
// already capped at the throw site (src/providers/brevo.ts, src/providers/tourflow.ts), but the
// dispatcher logs shouldn't carry it at all, only the status.
function extractStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
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
        const status = extractStatus(error);
        context.logger.warn?.('bookkit ops sink failed', {
          event, bookingId: booking.id, provider: 'tourflow',
          ...(status !== undefined ? { status } : {}),
        });
      }
    }
    if (context.providers.analytics) {
      try {
        await context.providers.analytics.track(event, booking);
      } catch (error) {
        const status = extractStatus(error);
        context.logger.warn?.('bookkit analytics sink failed', {
          event, bookingId: booking.id, provider: 'analytics',
          ...(status !== undefined ? { status } : {}),
        });
      }
    }
  })();
  if (context.waitUntil) context.waitUntil(task);
  else void task;
}

// BK-SIDE-001: analytics is the one deliberate best-effort carve-out for the mutation path — loss
// is cheap, so it stays fire-and-forget (waitUntil when available, else an unawaited task, same
// pattern as dispatchNonCritical) rather than going through the durable outbox below.
function dispatchAnalytics(context: BookkitContext, event: BookingEvent, booking: Booking): void {
  if (!context.providers.analytics) return;
  const task = context.providers.analytics.track(event, booking).catch((error: unknown) => {
    const status = extractStatus(error);
    context.logger.warn?.('bookkit analytics sink failed', {
      event, bookingId: booking.id, provider: 'analytics',
      ...(status !== undefined ? { status } : {}),
    });
  });
  if (context.waitUntil) context.waitUntil(task);
  else void task;
}

function emailKind(event: EmailBookingEvent, recipient: EmailRecipientRole | undefined, discriminator: string | undefined): MutationSideEffectOperationKind {
  return ['email', event, ...(recipient ? [recipient] : []), ...(discriminator ? [discriminator] : [])].join(':') as MutationSideEffectOperationKind;
}
function tourflowKind(event: EmailBookingEvent, discriminator: string | undefined): MutationSideEffectOperationKind {
  return ['tourflow', event, ...(discriminator ? [discriminator] : [])].join(':') as MutationSideEffectOperationKind;
}

// BK-SIDE-001: terminal events use a stable kind because each can happen only once. Reschedule
// kinds receive their strictly increasing suffix inside the winning repository batch, where the
// booking transition version is incremented atomically with the outbox row.
export function mutationSideEffectKinds(
  context: BookkitContext,
  event: EmailBookingEvent,
): MutationSideEffectOperationKind[] {
  const kinds: MutationSideEffectOperationKind[] = [];
  const email = context.providers.email;
  if (email) {
    if (email.recipientsForEvent && email.sendToRecipient) {
      for (const recipient of email.recipientsForEvent(event)) kinds.push(emailKind(event, recipient, undefined));
    } else {
      // Split rows require a matching split sender; otherwise each retry must remain one combined send.
      kinds.push(emailKind(event, undefined, undefined));
    }
  }
  if (context.providers.ops) kinds.push(tourflowKind(event, undefined));
  return kinds;
}

interface MutationSideEffectAttempt {
  event: EmailBookingEvent;
  provider: 'email' | 'tourflow';
  run: () => Promise<void>;
}

function isMutationSideEffectKind(kind: SideEffectOperationKind): kind is MutationSideEffectOperationKind {
  return kind.startsWith('email:') || kind.startsWith('tourflow:');
}

// BK-SIDE-001 (handoff 13) HIGH-1(b): reconstructs a runnable attempt from a durable row's `kind`
// ALONE (not from whatever event dispatchMutation was originally called with) so the request-
// driven drain below can resume ANY owed mutation side effect for this booking, regardless of
// which dispatchMutation call originally recorded it. Segment layout (see mutationSideEffectKinds
// above): 'email:<event>:<recipient>[:<discriminator>]' | 'email:<event>[:<discriminator>]' (no
// per-recipient support) | 'tourflow:<event>[:<discriminator>]'. `event` is always segments[1] —
// event names contain '.', never ':', so this position is unambiguous regardless of what follows.
// A trailing discriminator (only ever present to make the STORED kind unique — see above) is inert
// here: it never affects which provider call gets re-issued, only whether rest[0] happens to be
// 'customer'/'owner' (recipient) or something else (no recipient, non-split fallback) — real
// recipient values can never collide with a discriminator, since reschedule versions are numeric.
function attemptForKind(context: BookkitContext, booking: Booking, kind: MutationSideEffectOperationKind): MutationSideEffectAttempt | null {
  const [providerName, event, ...rest] = kind.split(':');
  if (!providerName || !event) return null;
  const emailBookingEvent = event as EmailBookingEvent;
  if (providerName === 'email') {
    const email = context.providers.email;
    if (!email) return null;
    const recipient: EmailRecipientRole | undefined = rest[0] === 'customer' || rest[0] === 'owner' ? rest[0] : undefined;
    if (recipient) {
      if (!email.sendToRecipient) return null;
      const sendToRecipient = email.sendToRecipient;
      return {
        event: emailBookingEvent, provider: 'email',
        run: () => sendToRecipient(recipient, emailBookingEvent, booking, context.config, context.routeConfig.paths),
      };
    }
    return {
      event: emailBookingEvent, provider: 'email',
      run: () => email.send(emailBookingEvent, booking, context.config, context.routeConfig.paths),
    };
  }
  if (providerName === 'tourflow') {
    const ops = context.providers.ops;
    if (!ops) return null;
    return { event: emailBookingEvent, provider: 'tourflow', run: () => ops.push(emailBookingEvent, booking) };
  }
  return null;
}

// Claims, runs, and resolves exactly one durable operation. Never throws — a mutation-critical
// side-effect failure must never turn the customer's already-durable cancel/reschedule/no-show
// into a 500; it leaves a 'failed' row for a later request touching this booking to retry.
async function runMutationSideEffect(
  context: BookkitContext,
  booking: Booking,
  kind: MutationSideEffectOperationKind,
  attempt: MutationSideEffectAttempt,
): Promise<void> {
  const attemptedAt = nowIso(context);
  if (!await context.repo.claimMutationSideEffectOperation(booking.id, kind, attemptedAt)) return;
  try {
    await attempt.run();
    await context.repo.resolveMutationSideEffectOperation({
      bookingId: booking.id, kind, status: 'succeeded', claimedAt: attemptedAt, resolvedAt: nowIso(context),
    });
  } catch (error) {
    const status = extractStatus(error);
    await context.repo.resolveMutationSideEffectOperation({
      bookingId: booking.id, kind, status: 'failed', claimedAt: attemptedAt,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      resolvedAt: nowIso(context),
    });
    context.logger.warn?.('bookkit mutation side effect failed', {
      event: attempt.event, bookingId: booking.id, provider: attempt.provider, kind,
      ...(status !== undefined ? { status } : {}),
    });
  }
}

// BK-SIDE-001 (handoff 13) HIGH-1(b): the request-driven drain. Lists this booking's side-effect
// operations and claims->runs->resolves every non-succeeded email:%/tourflow:% row (the
// confirmation-path literals are skipped — those drain through executeOperation/handleStatus's
// needsFulfillment instead). Called from every mutation handler AFTER its own transition (so newly
// -recorded rows get their first attempt immediately) AND from every place a booking is loaded for
// a mutation-adjacent request — idempotent short-circuits, handleManage, handleStatus — so rows
// left behind by a dead isolate (crashed between claim and resolve, or between record and attempt)
// still get delivered on a LATER request even though there is no cron in this project. Does not
// touch analytics — that's the deliberate best-effort carve-out (dispatchAnalytics), never durable.
export async function runOwedMutationSideEffects(context: BookkitContext, booking: Booking): Promise<void> {
  const operations = await context.repo.listSideEffectOperations(booking.id);
  for (const operation of operations) {
    if (operation.status === 'succeeded' || !isMutationSideEffectKind(operation.kind)) continue;
    const attempt = attemptForKind(context, booking, operation.kind);
    if (!attempt) continue; // provider no longer configured — leave the row for a later request.
    await runMutationSideEffect(context, booking, operation.kind, attempt);
  }
}

export async function dispatchMutation(
  context: BookkitContext,
  event: EmailBookingEvent,
  booking: Booking,
): Promise<void> {
  // The outbox rows this dispatch owes were already recorded atomically by the transition method
  // that produced `booking` (HIGH-1(a) — see transitionToCancelled/transitionToNoShow/
  // transitionReschedule/rescheduleWithCapacity in src/repo.ts), so there is nothing left to record here: draining runs
  // every owed row (the ones this transition just recorded, plus any older stragglers) through the
  // same claim/run/resolve path a later request's drain would use.
  await runOwedMutationSideEffects(context, booking);
  dispatchAnalytics(context, event, booking);
}
