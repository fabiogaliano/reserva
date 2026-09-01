import { confirmBooking, type Booking } from './core/booking';
import { resolveService } from './core/config';
import type { BookingEvent, EmailBookingEvent, EmailRecipientRole, PaymentCustomerDetails } from './core/events';
import {
  capacityForDate,
  defaultCapacityForDate,
  getOccupancyIntervals,
  isSlotAvailable,
} from './core/occupancy';
import { localDateKey, parseUtcInstant } from './core/time';
import type { BookkitContext } from './context';
import { nowIso } from './context';
import { classifyProviderError } from './provider-failure';
import {
  bookingEventSeeds,
  deliverBookingEventOperation,
  dispatchNonDurableBookingEvent,
  durableSubscriberIdentities,
} from './booking-events';
import {
  SIDE_EFFECT_MAX_ATTEMPTS,
  sameSideEffectOperation,
  sideEffectOperationKey,
  type SideEffectOperationIdentity,
  type SideEffectOperationRecord,
  type SideEffectOperationSeed,
  type SideEffectOperationStatus,
} from './repo';

// Plan 021 (design decision 4): which rows are CONFIRMATION debt drained under the confirmation
// lease (executeOperation). Everything else — including a durable hook/webhook row for
// booking.confirmed — is claimed through the row's own attempted_at lease, exactly as the v1
// confirmation ops row was (plan 011 design decision 3).
export function isConfirmationSideEffectOperation(operation: SideEffectOperationIdentity): boolean {
  if (operation.family === 'calendar_create' || operation.family === 'email_confirmation' || operation.family === 'oversell') return true;
  return operation.family === 'email' && operation.event === 'booking.confirmed';
}

// Rows drained by the ungated row-lease path: mutation debt plus the confirmation-event rows.
function isRowLeaseOperation(operation: SideEffectOperationIdentity): boolean {
  return !isConfirmationSideEffectOperation(operation);
}

function isConfirmationEventOperation(operation: SideEffectOperationIdentity): boolean {
  return (operation.family === 'hook' || operation.family === 'webhook') && operation.event === 'booking.confirmed';
}

// Plan 016 (design decision 6): the single "still worth attempting" predicate shared by both
// drains (executeOperation below, runOwedMutationSideEffects) and handleStatus's fulfillment
// check (src/handlers/index.ts) — 'succeeded' and 'abandoned' are both terminal; everything else
// (pending/in_flight/failed) is actionable.
export function isActionableSideEffectStatus(status: SideEffectOperationStatus): boolean {
  return status !== 'succeeded' && status !== 'abandoned';
}

export interface AttemptOutcome {
  status: 'failed' | 'abandoned';
  error: string;
  statusCode: number | undefined;
  reason: 'permanent_failure' | 'max_attempts_exceeded' | undefined;
}

// Plan 016 (design decisions 1/4): classifies a just-caught provider error against the attempt
// NUMBER that just ran (1-based — the claim that preceded this call already incremented
// attempt_count, so `attemptNumber` is that new count) into the row's next status. A permanent
// failure (classifyProviderError says not retryable) abandons immediately, regardless of attempt
// number; a retryable failure abandons only once it has exhausted SIDE_EFFECT_MAX_ATTEMPTS
// attempts; otherwise it stays 'failed' for a later touch to retry.
// Exported (plan 020) so src/refund-executor.ts's scheduled-attempt path classifies a refund
// failure with the exact same permanent-vs-exhausted rule side-effect operations already use,
// rather than a second, potentially-drifting copy of the same decision.
export function classifyAttemptOutcome(attemptNumber: number, error: unknown): AttemptOutcome {
  const classification = classifyProviderError(error);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  if (!classification.retryable) {
    return { status: 'abandoned', error: message, statusCode: classification.status, reason: 'permanent_failure' };
  }
  if (attemptNumber >= SIDE_EFFECT_MAX_ATTEMPTS) {
    return {
      status: 'abandoned',
      error: `max attempts (${SIDE_EFFECT_MAX_ATTEMPTS}) reached; last error: ${message}`.slice(0, 200),
      statusCode: classification.status,
      reason: 'max_attempts_exceeded',
    };
  }
  return { status: 'failed', error: message, statusCode: classification.status, reason: undefined };
}

// Plan 016 (design decision 7): the one operator signal this scoped plan ships — a structured
// error-level log, no customer-visible state and no admin UI (see docs/plans/016's "Current
// state": there is no existing read surface for side-effect-operation rows to extend).
// Plan 021: `operation` is the built display string (never parsed back), and `error` carries the
// remediating message — for an unregistered hook/webhook name that message is the only place a
// deployment learns which registration is missing.
function logAbandonment(context: BookkitContext, input: {
  bookingId: string;
  operation: string;
  provider: string;
  status: number | undefined;
  attemptCount: number;
  reason: 'permanent_failure' | 'max_attempts_exceeded';
  error: string;
}): void {
  context.logger.error?.('bookkit side effect operation abandoned', {
    bookingId: input.bookingId, operation: input.operation, provider: input.provider,
    ...(input.status !== undefined ? { status: input.status } : {}),
    attemptCount: input.attemptCount, reason: input.reason, error: input.error,
  });
}

function providerNameForConfirmationOperation(operation: SideEffectOperationIdentity): 'calendar' | 'email' {
  return operation.family === 'calendar_create' ? 'calendar' : 'email';
}

export class ConfirmationInProgressError extends Error {
  readonly status = 503;
  readonly code = 'confirmation_in_progress';

  constructor() {
    super('Booking confirmation is already in progress');
    this.name = 'ConfirmationInProgressError';
  }
}

async function expiredHoldOversold(context: BookkitContext, booking: Booking, now: string): Promise<boolean> {
  const service = resolveService(context.config, booking.serviceSlug);
  const date = localDateKey(booking.startsAt, context.config.business.timezone);
  const [override, capacityDefaults] = await Promise.all([
    context.repo.getDayOverride(date),
    context.repo.listCapacityDefaults(),
  ]);
  const lookback = Math.max(...Object.values(context.config.services).map((candidate) => candidate.durationMin + candidate.turnaroundMin));
  const windowStart = new Date(parseUtcInstant(booking.startsAt).getTime() - lookback * 60_000).toISOString();
  const windowEnd = new Date(parseUtcInstant(booking.endsAt).getTime() + service.turnaroundMin * 60_000).toISOString();
  const [bookings, calendarEvents] = await Promise.all([
    context.repo.listOccupancyBookings(windowStart, windowEnd),
    context.providers.calendar ? context.providers.calendar.listEvents(windowStart, windowEnd) : Promise.resolve([]),
  ]);
  const capacity = capacityForDate(
    date,
    defaultCapacityForDate(date, context.config.capacity.default, capacityDefaults),
    override ? [override] : [],
  ).capacity;
  return !isSlotAvailable(booking.startsAt, booking.endsAt, {
    capacity,
    intervals: getOccupancyIntervals({
      bookings,
      calendarEvents,
      service,
      services: context.config.services,
      now,
    }),
    requestedUnits: service.occupancyFor ? service.occupancyFor(booking.quantity) : 1,
    turnaroundMin: service.turnaroundMin,
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

// Plan 012 (design decision 1/6): which recipient a split confirmation-path email row targets, or
// undefined for the unsplit shapes (calendar_create/email_confirmation).
function confirmationEmailRecipient(operation: SideEffectOperationIdentity): EmailRecipientRole | undefined {
  if (operation.family !== 'email') return undefined;
  return operation.name === 'customer' || operation.name === 'owner' ? operation.name : undefined;
}

// Plan 012 (design decision 1/6): dispatches to the right provider call for a confirmation-path
// row — calendar_create unchanged, the legacy combined email_confirmation row still calls send()
// (both recipients in one call, content unchanged), and a split row calls sendToRecipient for
// exactly the one recipient its kind encodes, so an owner-recipient failure can never re-trigger
// the customer's already-delivered send on retry.
async function runConfirmationOperation(context: BookkitContext, booking: Booking, operation: SideEffectOperationIdentity): Promise<string | null> {
  if (operation.family === 'calendar_create') {
    return context.providers.calendar ? await context.providers.calendar.createEvent(booking, context.config) : null;
  }
  const recipient = confirmationEmailRecipient(operation);
  if (recipient) {
    if (context.providers.email?.sendToRecipient) {
      await context.providers.email.sendToRecipient(recipient, 'booking.confirmed', booking, context.config, context.routeConfig.paths);
    }
    return null;
  }
  if (context.providers.email) await context.providers.email.send('booking.confirmed', booking, context.config, context.routeConfig.paths);
  return null;
}

async function executeOperation(
  context: BookkitContext,
  booking: Booking,
  operation: SideEffectOperationRecord,
  token: string,
): Promise<void> {
  if (!isActionableSideEffectStatus(operation.status) || operation.family === 'oversell') return;
  await renewConfirmationLease(context, booking.id, token);
  const attemptNumber = await context.repo.claimSideEffectOperation(booking.id, operation, token, nowIso(context));
  if (attemptNumber === null) throw new ConfirmationInProgressError();
  try {
    await renewConfirmationLease(context, booking.id, token);
    const providerResultId = await runConfirmationOperation(context, booking, operation);
    await renewConfirmationLease(context, booking.id, token);
    await resolveOperation(context, {
      bookingId: booking.id,
      identity: operation,
      leaseToken: token,
      status: 'succeeded',
      ...(providerResultId ? { providerResultId } : {}),
      resolvedAt: nowIso(context),
    });
  } catch (error) {
    if (error instanceof ConfirmationInProgressError) throw error;
    const outcome = classifyAttemptOutcome(attemptNumber, error);
    // Plan 020 (design decision 5): deliberately does NOT set next_attempt_at here. This same
    // drain path (executeOperation) is what an HTTP request touching the booking already uses to
    // retry immediately — see tests/confirmation-outbox.test.ts and friends, which pin an
    // immediate same-tick retry recovering a failed row. A real backoff window here would block
    // that legitimate HTTP-driven retry exactly as long as it blocks the scheduled reconciler
    // (both claim through the same claimSideEffectOperation call), so backoff for side-effect
    // operations comes only from the reconciler's own five-minute cron cadence, not from this
    // column — next_attempt_at's gate is a no-op (always null) for rows resolved through here.
    await resolveOperation(context, {
      bookingId: booking.id,
      identity: operation,
      leaseToken: token,
      status: outcome.status,
      error: outcome.error,
      resolvedAt: nowIso(context),
    });
    if (outcome.status === 'abandoned') {
      logAbandonment(context, {
        bookingId: booking.id, operation: sideEffectOperationKey(operation), provider: providerNameForConfirmationOperation(operation),
        status: outcome.statusCode, attemptCount: attemptNumber, reason: outcome.reason ?? 'permanent_failure',
        error: outcome.error,
      });
      // Plan 016 (design decision 5): terminal means deliberately stopped retrying — never throw
      // back to the payment webhook/`/status`, unlike the still-retryable 'failed' case below.
      return;
    }
    throw error;
  }
}

async function confirmBookingFromPaymentUnlocked(
  context: BookkitContext,
  booking: Booking,
  token: string,
  paymentRef?: string | null,
  details: PaymentCustomerDetails = {},
): Promise<Booking> {
  const now = nowIso(context);
  const customerPatch: PaymentCustomerDetails = {};
  if (details.customerName !== undefined) customerPatch.customerName = details.customerName;
  if (details.customerEmail !== undefined) customerPatch.customerEmail = details.customerEmail;
  if (details.customerPhone !== undefined) customerPatch.customerPhone = details.customerPhone;
  if (details.pickupAddress !== undefined) customerPatch.pickupAddress = details.pickupAddress;
  let current = booking;
  let shouldDispatchConfirmation = current.status !== 'confirmed';
  let transitionApplied = false;
  const emailRecipients = confirmationEmailRecipients(context);
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
    // Plan 021 (design decision 3): the envelope each subscriber will receive is serialized from
    // the booking as this transition will leave it, and inserted in the transition's own batch —
    // so `occurredAt` and the snapshot's `updatedAt` are the same instant by construction, and a
    // later mutation can never rewrite what this occurrence said.
    const confirmedSnapshot = confirmBooking(current, now, {
      ...(paymentRef !== undefined ? { paymentRef } : {}),
      ...customerPatch,
    });
    const eventSeeds = bookingEventSeeds(context, 'booking.confirmed', confirmedSnapshot, now);
    const result = await context.repo.confirmWithSideEffectOperations(current.id, {
      expectedStatusIn: ['hold', 'expired'],
      ...(paymentRef !== undefined ? { paymentRef } : {}),
      ...customerPatch,
      leaseToken: token,
      oversold,
      updatedAt: now,
      ...(eventSeeds.length > 0 ? { eventSeeds } : {}),
      ...(emailRecipients ? { emailRecipients } : {}),
    });
    transitionApplied = result !== null;
    current = result ?? await context.repo.getBookingById(current.id) ?? current;
    if (!transitionApplied && current.status !== 'confirmed') throw new ConfirmationInProgressError();
  }
  if (current.status !== 'confirmed') return current;

  if (!transitionApplied && (paymentRef !== undefined || Object.keys(customerPatch).length > 0)) {
    await renewConfirmationLease(context, current.id, token);
    if (!await context.repo.applyConfirmedPaymentDetails(current.id, {
      ...(paymentRef !== undefined ? { paymentRef } : {}),
      ...customerPatch,
    }, token, nowIso(context))) {
      throw new ConfirmationInProgressError();
    }
    current = await context.repo.getBookingById(current.id) ?? current;
  }

  await renewConfirmationLease(context, current.id, token);
  // The repair path for a booking confirmed before a subscriber existed: its snapshot can only
  // describe the booking as it stands now, which is also the occurrence a late subscriber is
  // being told about.
  await context.repo.ensureConfirmationSideEffectOperations(
    current.id, token, nowIso(context),
    bookingEventSeeds(context, 'booking.confirmed', current, current.updatedAt),
    emailRecipients,
  );
  const allOperations = await context.repo.listSideEffectOperations(current.id);
  const operations = allOperations.filter(isConfirmationSideEffectOperation);
  shouldDispatchConfirmation ||= operations.some((operation) => isActionableSideEffectStatus(operation.status));
  let firstProviderError: unknown;
  let providerFailed = false;
  for (const operation of operations) {
    try {
      await executeOperation(context, current, operation, token);
    } catch (error) {
      if (error instanceof ConfirmationInProgressError) throw error;
      if (!providerFailed) firstProviderError = error;
      providerFailed = true;
    }
  }
  current = await context.repo.getBookingById(current.id) ?? current;
  if (shouldDispatchConfirmation) {
    dispatchNonDurableBookingEvent(context, 'booking.confirmed', current, current.updatedAt);
    // Plan 011 (design decision 3), generalized: detached first attempt — claim/deliver/resolve
    // each subscriber's row via waitUntil so this response path never waits on an external
    // endpoint; a later booking-touching request (runOwedMutationSideEffects below) retries a
    // failed or stale claim durably.
    scheduleConfirmationEventDelivery(context, current);
  }
  if (providerFailed) throw firstProviderError;
  return current;
}

async function confirmationFullySettled(context: BookkitContext, bookingId: string): Promise<boolean> {
  const operations = (await context.repo.listSideEffectOperations(bookingId)).filter(isConfirmationSideEffectOperation);
  return operations.length > 0 && !operations.some((operation) => isActionableSideEffectStatus(operation.status));
}

async function confirmBookingWithLease(
  context: BookkitContext,
  booking: Booking,
  paymentRef: string | null | undefined,
  details: PaymentCustomerDetails,
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
    // Plan 022: the booking row no longer carries sync flags — "nothing left to do" is read off the
    // outbox rows themselves, which is where that state has actually lived since plan 011. A
    // confirmed booking with no confirmation rows at all is a legacy one that still needs the
    // repair path, so it keeps waiting on the lease rather than returning as if it were settled.
    if (current.status === 'confirmed' && await confirmationFullySettled(context, current.id)) return current;
    throw new ConfirmationInProgressError();
  }
  try {
    const current = await context.repo.getBookingById(booking.id) ?? booking;
    return await confirmBookingFromPaymentUnlocked(context, current, token, paymentRef, details);
  } finally {
    await context.repo.releaseConfirmationLease(booking.id, token);
  }
}

export async function confirmBookingFromPayment(
  context: BookkitContext,
  booking: Booking,
  paymentRef?: string | null,
  details: PaymentCustomerDetails = {},
): Promise<Booking> {
  const locks = context.confirmationLocks;
  if (!locks) return confirmBookingWithLease(context, booking, paymentRef, details);
  const previous = locks.get(booking.id) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  locks.set(booking.id, queued);
  await previous;
  try {
    return await confirmBookingWithLease(context, booking, paymentRef, details);
  } finally {
    release();
    if (locks.get(booking.id) === queued) locks.delete(booking.id);
  }
}

// Plan 012 (design decision 1): provider-derived — a confirmation's email rows only ever split
// into per-recipient debt when the current provider actually implements BOTH recipientsForEvent
// and sendToRecipient (so each recipient can be retried independently); a provider with only
// send() keeps the single combined email_confirmation row.
function confirmationEmailRecipients(context: BookkitContext): EmailRecipientRole[] | undefined {
  const email = context.providers.email;
  if (!email?.recipientsForEvent || !email.sendToRecipient) return undefined;
  return email.recipientsForEvent('booking.confirmed');
}

// Plan 011 (design decision 3/4), generalized to every durable subscriber: claims, delivers, and
// resolves each booking.confirmed subscriber row through its OWN row lease — never the confirmation
// lease, which the caller may already have released by the time this runs detached. With the v1
// per-provider sync flag gone, the row transition is the single atomic record of delivery.
async function runConfirmationEventSideEffects(context: BookkitContext, booking: Booking): Promise<void> {
  const operations = await context.repo.listSideEffectOperations(booking.id);
  for (const operation of operations) {
    if (!isConfirmationEventOperation(operation) || !isActionableSideEffectStatus(operation.status)) continue;
    await runMutationSideEffect(context, booking, operation);
  }
}

// Plan 011 (design decision 3): the detached first attempt, scheduled right after the rows are
// minted, so the confirming request never waits on an external endpoint.
function detach(context: BookkitContext, task: Promise<void>): void {
  if (context.waitUntil) context.waitUntil(task);
  else void task;
}

function scheduleConfirmationEventDelivery(context: BookkitContext, booking: Booking): void {
  detach(context, runConfirmationEventSideEffects(context, booking));
}

// Plan 021: payment.dispute_created is the one emittable event that is NOT a booking transition —
// the occurrence belongs to Stripe, so there is no CAS to record the rows inside. The row itself is
// the record, keyed by the payment event id as its discriminator: a Stripe redelivery of the same
// dispute conflicts with the existing row instead of minting a second delivery, and two genuinely
// different disputes on one booking still get distinct event ids.
export async function dispatchDisputeEvent(context: BookkitContext, booking: Booking, occurrenceId: string): Promise<void> {
  const now = nowIso(context);
  const seeds = bookingEventSeeds(context, 'payment.dispute_created', booking, now, occurrenceId);
  if (seeds.length > 0) {
    await context.repo.recordBookingEventOperations(booking.id, seeds, now);
    detach(context, runOwedMutationSideEffects(context, booking));
  }
  dispatchNonDurableBookingEvent(context, 'payment.dispute_created', booking, now);
}

// Plan 021 (design decision 4): a confirmed booking still owes fulfillment when a registered
// durable subscriber has no row at all — the lazy-repair case a legacy deployment hits after
// registering a hook. Derived from the rows plus the current registration, never from an entity
// flag (direction doc invariant 2).
export function missingConfirmationEventOperations(
  context: BookkitContext,
  operations: readonly SideEffectOperationRecord[],
): boolean {
  return durableSubscriberIdentities(context, 'booking.confirmed')
    .some((identity) => !operations.some((operation) => sameSideEffectOperation(operation, identity)));
}

// Plan 021 (design decision 1/2): the durable rows one mutation owes — the email provider's, plus
// one per durable hook/webhook subscribed to this event. `snapshot` is the booking AS THE
// TRANSITION WILL LEAVE IT, because the event envelope is serialized here and never rebuilt.
// Terminal events need no discriminator (each happens once per booking); reschedule rows receive
// their strictly increasing version inside the winning repository batch.
export function mutationSideEffectSeeds(
  context: BookkitContext,
  event: EmailBookingEvent,
  snapshot: Booking,
  occurredAt: string,
): SideEffectOperationSeed[] {
  const seeds: SideEffectOperationSeed[] = [];
  const email = context.providers.email;
  if (email) {
    // Split rows require a matching split sender; otherwise each retry must remain one combined send.
    const recipients = email.recipientsForEvent && email.sendToRecipient ? email.recipientsForEvent(event) : [undefined];
    for (const recipient of recipients) {
      seeds.push({ family: 'email', name: recipient ?? null, event, discriminator: null, eventPayloadJson: null, eventIdPrefix: null });
    }
  }
  seeds.push(...bookingEventSeeds(context, event, snapshot, occurredAt));
  return seeds;
}

// A cancellation additionally owes calendar deletion. The snapshot is projected here rather than at
// each call site so all three cancellation paths (customer, operator, Stripe refund) describe the
// occurrence identically — including the refund path, whose CAS also accepts hold/expired and so
// cannot go through the domain's confirmed-only cancelBooking.
export function cancellationSideEffectSeeds(
  context: BookkitContext,
  booking: Booking,
  event: 'booking.cancelled_by_customer' | 'booking.cancelled_by_operator',
  occurredAt: string,
): SideEffectOperationSeed[] {
  const snapshot: Booking = {
    ...booking,
    status: 'cancelled',
    cancelledAt: occurredAt,
    cancelledBy: event === 'booking.cancelled_by_customer' ? 'customer' : 'operator',
    updatedAt: occurredAt,
  };
  return [
    ...mutationSideEffectSeeds(context, event, snapshot, occurredAt),
    ...(booking.calendarEventId ? [{ family: 'calendar_delete' as const, eventPayloadJson: null, eventIdPrefix: null }] : []),
  ];
}

interface MutationSideEffectAttempt {
  provider: 'calendar' | 'email' | 'hook' | 'webhook';
  run: () => Promise<void>;
}

// Plan 021 (design decision 5): reconstructs a runnable attempt from the row's identity COLUMNS —
// no string is split, and no positional convention decides what a segment means. Returning null
// means "the thing that would run this is not configured": the row is left actionable for a later
// request. A hook/webhook row is the deliberate exception — an unregistered name is a permanent
// failure raised by the delivery itself, so it abandons with a remediating log instead of sitting
// pending forever.
function attemptForOperation(context: BookkitContext, booking: Booking, operation: SideEffectOperationRecord): MutationSideEffectAttempt | null {
  if (operation.family === 'calendar_delete') {
    const calendar = context.providers.calendar;
    if (!calendar) return null;
    return {
      provider: 'calendar',
      run: async () => {
        if (!booking.calendarEventId) return;
        await calendar.deleteEvent(booking.calendarEventId);
        await context.repo.updateBooking(booking.id, { calendarEventId: null, updatedAt: nowIso(context) });
      },
    };
  }
  if (operation.family === 'email') {
    const email = context.providers.email;
    if (!email || !operation.event) return null;
    const event = operation.event as EmailBookingEvent;
    const recipient = confirmationEmailRecipient(operation);
    if (recipient) {
      if (!email.sendToRecipient) return null;
      const sendToRecipient = email.sendToRecipient.bind(email);
      return { provider: 'email', run: () => sendToRecipient(recipient, event, booking, context.config, context.routeConfig.paths) };
    }
    return { provider: 'email', run: () => email.send(event, booking, context.config, context.routeConfig.paths) };
  }
  if (operation.family === 'hook' || operation.family === 'webhook') {
    return { provider: operation.family, run: () => deliverBookingEventOperation(context, booking, operation) };
  }
  return null;
}

// Claims, runs, and resolves exactly one durable operation. Never throws — a mutation-critical
// side-effect failure must never turn the customer's already-durable cancel/reschedule/no-show
// into a 500; it leaves a 'failed' row for a later request touching this booking to retry.
async function runMutationSideEffect(
  context: BookkitContext,
  booking: Booking,
  operation: SideEffectOperationRecord,
): Promise<void> {
  const attempt = attemptForOperation(context, booking, operation);
  if (!attempt) return;
  const key = sideEffectOperationKey(operation);
  const attemptedAt = nowIso(context);
  const attemptNumber = await context.repo.claimMutationSideEffectOperation(booking.id, operation, attemptedAt);
  if (attemptNumber === null) return;
  try {
    await attempt.run();
    await context.repo.resolveMutationSideEffectOperation({
      bookingId: booking.id, identity: operation, status: 'succeeded', claimedAt: attemptedAt, resolvedAt: nowIso(context),
    });
  } catch (error) {
    const outcome = classifyAttemptOutcome(attemptNumber, error);
    // Plan 020 (design decision 5): see the matching comment in executeOperation above — this
    // drain also runs from an HTTP-driven retry, so next_attempt_at is deliberately left unset.
    await context.repo.resolveMutationSideEffectOperation({
      bookingId: booking.id, identity: operation, status: outcome.status, claimedAt: attemptedAt,
      error: outcome.error, resolvedAt: nowIso(context),
    });
    context.logger.warn?.('bookkit mutation side effect failed', {
      event: operation.event ?? operation.family, bookingId: booking.id, provider: attempt.provider, operation: key,
      ...(outcome.statusCode !== undefined ? { status: outcome.statusCode } : {}),
    });
    if (outcome.status === 'abandoned') {
      logAbandonment(context, {
        bookingId: booking.id, operation: key, provider: attempt.provider,
        status: outcome.statusCode, attemptCount: attemptNumber, reason: outcome.reason ?? 'permanent_failure',
        error: outcome.error,
      });
    }
  }
}

// BK-SIDE-001 (handoff 13) HIGH-1(b): the request-driven drain. Lists this booking's side-effect
// operations and claims->runs->resolves every actionable row that is not confirmation-lease debt
// (those drain through executeOperation/handleStatus's needsFulfillment instead). Called from every
// mutation handler AFTER its own transition (so newly-recorded rows get their first attempt
// immediately) AND from every place a booking is loaded for a mutation-adjacent request —
// idempotent short-circuits, handleManage, handleStatus — so rows left behind by a dead isolate
// (crashed between claim and resolve, or between record and attempt) still get delivered on a LATER
// request. Plan 021: this now covers the booking.confirmed subscriber rows too, which v1's single
// ops row needed a dedicated drain for.
export async function runOwedMutationSideEffects(context: BookkitContext, booking: Booking): Promise<void> {
  const operations = await context.repo.listSideEffectOperations(booking.id);
  for (const operation of operations) {
    if (!isActionableSideEffectStatus(operation.status) || !isRowLeaseOperation(operation)) continue;
    await runMutationSideEffect(context, booking, operation);
  }
}

// Scheduled reconciliation receives row-level eligible candidates from the repository and executes
// exactly that row. Reusing the operation-specific claim/run/resolve primitives here prevents one
// due row from pulling a sibling out of backoff through a booking-wide drain.
export async function runScheduledSideEffectOperation(
  context: BookkitContext,
  booking: Booking,
  operation: SideEffectOperationRecord,
): Promise<void> {
  if (!isActionableSideEffectStatus(operation.status)) return;
  if (isConfirmationSideEffectOperation(operation)) {
    if (operation.family === 'oversell' || booking.status !== 'confirmed') return;
    const startedAt = context.clock();
    const token = crypto.randomUUID();
    const acquired = await context.repo.acquireConfirmationLease(
      booking.id,
      token,
      startedAt.toISOString(),
      new Date(startedAt.getTime() + 5 * 60_000).toISOString(),
    );
    if (!acquired) return;
    try {
      await executeOperation(context, booking, operation, token);
    } finally {
      await context.repo.releaseConfirmationLease(booking.id, token);
    }
    return;
  }
  await runMutationSideEffect(context, booking, operation);
}

// Plan 020 (design decision 13): the admin "Try again" action's result — 'nothing_to_retry' covers
// every reason a claim didn't happen (already succeeded, the row doesn't exist, a concurrent
// claimant already holds it, or the provider is no longer configured) without conflating them with
// 'not_retryable', which is reserved for an operation this function refuses to ever retry (STOP
// condition: "a safe one-shot retry cannot be implemented for an operation type... do not label an
// unsafe action safe" — 'oversell' is a permanent marker, not a retryable operation at all;
// decision 13: "Oversell cards expose manual handling only").
export type SideEffectRetryOutcome = 'succeeded' | 'failed' | 'nothing_to_retry' | 'lease_unavailable' | 'not_retryable';

// Plan 020 (design decision 13): the admin "Try again" action's one-shot leased retry. Deliberately
// reuses this file's own claim -> run -> resolve logic (runConfirmationOperation for
// confirmation-lease rows, attemptForOperation for every other row) rather than a second,
// hand-rolled dispatch table — the exact same call an ordinary drain would have made, just claimed
// through the *ForRetry variant (ignores backoff/cap, still refuses a live lease).
export async function retrySideEffectOperation(
  context: BookkitContext,
  booking: Booking,
  operation: SideEffectOperationRecord,
): Promise<SideEffectRetryOutcome> {
  if (operation.family === 'oversell') return 'not_retryable';
  if (isConfirmationSideEffectOperation(operation)) return retryConfirmationSideEffectOperation(context, booking, operation);
  return retryMutationSideEffectOperation(context, booking, operation);
}

async function retryConfirmationSideEffectOperation(
  context: BookkitContext,
  booking: Booking,
  operation: SideEffectOperationRecord,
): Promise<SideEffectRetryOutcome> {
  const startedAt = context.clock();
  const token = crypto.randomUUID();
  const acquired = await context.repo.acquireConfirmationLease(booking.id, token, startedAt.toISOString(), new Date(startedAt.getTime() + 5 * 60_000).toISOString());
  if (!acquired) return 'lease_unavailable';
  try {
    const attemptNumber = await context.repo.claimSideEffectOperationForRetry(booking.id, operation, token, nowIso(context));
    if (attemptNumber === null) return 'nothing_to_retry';
    try {
      const providerResultId = await runConfirmationOperation(context, booking, operation);
      const resolved = await context.repo.resolveSideEffectOperation({
        bookingId: booking.id, identity: operation, leaseToken: token, status: 'succeeded',
        ...(providerResultId ? { providerResultId } : {}), resolvedAt: nowIso(context),
      });
      return resolved ? 'succeeded' : 'nothing_to_retry';
    } catch (error) {
      const outcome = classifyAttemptOutcome(attemptNumber, error);
      const resolved = await context.repo.resolveSideEffectOperation({
        bookingId: booking.id, identity: operation, leaseToken: token, status: outcome.status, error: outcome.error, resolvedAt: nowIso(context),
      });
      return resolved ? 'failed' : 'nothing_to_retry';
    }
  } finally {
    await context.repo.releaseConfirmationLease(booking.id, token);
  }
}

async function retryMutationSideEffectOperation(
  context: BookkitContext,
  booking: Booking,
  operation: SideEffectOperationRecord,
): Promise<SideEffectRetryOutcome> {
  const attemptedAt = nowIso(context);
  const attemptNumber = await context.repo.claimMutationSideEffectOperationForRetry(booking.id, operation, attemptedAt);
  if (attemptNumber === null) return 'nothing_to_retry';
  const attempt = attemptForOperation(context, booking, operation);
  if (!attempt) {
    // Provider no longer configured — leave the row 'failed' (actionable again, exactly like an
    // ordinary drain's provider-missing skip) rather than silently holding the claim forever.
    await context.repo.resolveMutationSideEffectOperation({
      bookingId: booking.id, identity: operation, status: 'failed', claimedAt: attemptedAt, error: 'Provider not configured', resolvedAt: nowIso(context),
    });
    return 'not_retryable';
  }
  try {
    await attempt.run();
    const resolved = await context.repo.resolveMutationSideEffectOperation({
      bookingId: booking.id, identity: operation, status: 'succeeded', claimedAt: attemptedAt, resolvedAt: nowIso(context),
    });
    return resolved ? 'succeeded' : 'nothing_to_retry';
  } catch (error) {
    const outcome = classifyAttemptOutcome(attemptNumber, error);
    const resolved = await context.repo.resolveMutationSideEffectOperation({
      bookingId: booking.id, identity: operation, status: outcome.status, claimedAt: attemptedAt, error: outcome.error, resolvedAt: nowIso(context),
    });
    return resolved ? 'failed' : 'nothing_to_retry';
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
  dispatchNonDurableBookingEvent(context, event, booking, booking.updatedAt);
}
