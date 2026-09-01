import type { ClientConfig } from './config';
import type { Booking, WireBooking } from './booking';
import type { CalEvent } from './occupancy';
import type { BookkitResolvedRouteConfig } from '../routes-manifest';

// Plan 021 (design decision 1): the closed set of emittable booking events, exported as a runtime
// VALUE (not only a type) so a consumer — or an agent reading the package — can enumerate every
// case, and so hook/webhook `events` filters can be validated against it at startup instead of
// failing silently on a typo. `BookingEvent` derives from it, which is what keeps the two from
// drifting.
export const BOOKING_EVENTS = [
  'booking.confirmed',
  'booking.cancelled_by_customer',
  'booking.cancelled_by_operator',
  'booking.rescheduled',
  'booking.no_show',
  'payment.dispute_created',
] as const;

export type BookingEvent = (typeof BOOKING_EVENTS)[number];

export interface BookingEventPayload {
  bookingId: string;
  reference: string;
  event: BookingEvent;
  occurredAt: string;
  previousStartsAt?: string;
  cancelledBy?: 'customer' | 'operator';
  refund?: 'full' | 'none';
}

export interface DomainBookingEvent extends BookingEventPayload {
  booking: Booking;
}

export interface StripeCustomerDetails {
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  pickupAddress?: string | null;
}

export interface StripeEventParsed extends StripeCustomerDetails {
  id: string;
  type:
    | 'checkout.session.completed'
    | 'checkout.session.expired'
    | 'charge.refunded'
    | 'charge.dispute.created'
    | string;
  bookingId?: string;
  sessionId?: string;
  paymentIntent?: string;
  amountCaptured?: number;
  amountRefunded?: number;
  currency?: string;
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required' | string;
  // The Stripe Refund id for a charge.refunded event, when Stripe's payload includes one (see
  // stripeEventToParsed) — lets the webhook branch record which refund actually moved the money,
  // not just that a refund happened (BK-REFUND-001).
  refundId?: string;
  paid?: boolean;
  raw?: unknown;
}

export interface SessionStatus extends StripeCustomerDetails {
  id?: string;
  status: 'open' | 'complete' | 'expired' | string;
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required' | string;
  amountTotal?: number;
  currency?: string;
  paymentIntent?: string | null;
  metadata?: Record<string, string>;
}

export type EmailBookingEvent = Exclude<BookingEvent, 'payment.dispute_created'>;

// BK-SIDE-001 (handoff 13): who a given event's email goes to. Kept generic here (not
// Brevo-specific) so the mutation dispatcher (src/confirmation.ts) can ask any provider which
// recipients apply without depending on a concrete implementation's template config.
export type EmailRecipientRole = 'customer' | 'owner';

export interface EmailProvider {
  send(
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routePaths?: BookkitResolvedRouteConfig['paths'],
  ): Promise<void>;
  // Optional per-recipient split (BK-SIDE-001): a provider that implements both of these lets the
  // mutation dispatcher record + retry each recipient as its own durable outbox operation, so an
  // owner-send failure can never cause a retry to re-send the customer's already-delivered
  // message. A provider without them falls back to `send` as a single, unsplit operation — still
  // recorded and retried durably, just not per-recipient.
  recipientsForEvent?(event: EmailBookingEvent): EmailRecipientRole[];
  sendToRecipient?(
    recipient: EmailRecipientRole,
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routePaths?: BookkitResolvedRouteConfig['paths'],
  ): Promise<void>;
}

export interface CalendarProvider {
  // Distinguishes occupancy cache entries when a deployment can select calendar sources.
  cacheKey?: string;
  listEvents(fromUtc: string, toUtc: string): Promise<CalEvent[]>;
  createEvent(booking: Booking, config: ClientConfig): Promise<string>;
  patchEvent(eventId: string, booking: Booking, config?: ClientConfig): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

export interface PaymentProvider {
  createCheckout(
    booking: Booking,
    config: ClientConfig,
    routePaths?: BookkitResolvedRouteConfig['paths'],
  ): Promise<{ url: string; sessionId: string }>;
  parseWebhook(request: Request): Promise<StripeEventParsed>;
  getSession(sessionId: string): Promise<SessionStatus>;
  // The expected total lets a retry distinguish an incomplete historical partial refund from a
  // completed full refund; amountCents reports the cumulative total the operation satisfied.
  refund(paymentIntent: string, expectedAmountCents: number): Promise<{ refundId: string; amountCents: number }>;
}

export interface OpsSink {
  push(event: BookingEvent, booking: Booking): Promise<void>;
  mapBooking?(booking: Booking, config: ClientConfig): unknown;
}

export interface AnalyticsSink {
  track(event: BookingEvent, booking: Booking): Promise<void>;
}

export const noopAnalyticsSink: AnalyticsSink = {
  track: async () => undefined,
};

// Plan 020 (design decision 10): the independent alert channel to the central technical operator.
// Deliberately narrow — exactly these seven fields, reference/operation metadata only. Excludes
// booking/customer ids, names, contact details, addresses, raw provider bodies, session ids, and
// manage tokens (see docs/plans/020's privacy constraint). `action`/`severity` mirror the
// operational-incident domain (src/repo.ts OperationalIncidentAction/-Severity) so the alert and
// the admin card the operator opens from `adminUrl` always describe the same thing.
export interface OperationalAlert {
  incidentId: string;
  reference: string;
  action: 'confirmation_email' | 'customer_notification' | 'calendar' | 'operations_sync' | 'refund' | 'oversell';
  severity: 'delayed' | 'action_required';
  attemptCount: number;
  firstDetectedAt: string;
  adminUrl: string;
}

// Plan 020 (design decision 11): durable delivery (claim/attempt/backoff) is the reconciler's job,
// not this sink's — send() is a single best-effort attempt; a thrown error just means "not
// delivered this attempt", picked up again by the next eligible alert-claim pass.
export interface OperationalAlertSink {
  send(alert: OperationalAlert): Promise<void>;
}

// Plan 021 (design decision 3): the versioned envelope every durable booking event is delivered
// in. `apiVersion` is an integer consumers dispatch shape on; `id` is stable across retries so
// they can deduplicate on it; the booking payload comes from the single toWireBooking projection,
// so pushed and pulled shapes cannot fork. Serialized once, when the occurrence happens — it is
// the historical record of that occurrence, never a cache of the booking's current state.
export const BOOKING_EVENT_API_VERSION = 1;

export interface BookingEventEnvelope {
  apiVersion: number;
  id: string;
  event: BookingEvent;
  occurredAt: string;
  data: { booking: WireBooking };
}

// Plan 021 (design decision 1/2): hook and webhook names share this domain because outbox rows
// distinguish them by their `family` column, not by a qualified string key.
export const BOOKING_EVENT_SUBSCRIBER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export interface BookingEventHookContext {
  // The envelope id of this occurrence: identical to what a webhook subscriber would receive, so a
  // hook can deduplicate against the same key an HTTP consumer does.
  id: string;
  occurredAt: string;
  config: ClientConfig;
}

// Plan 021 (design decision 1): an in-process listener. `durable: false` (the default) fires
// post-commit and is never retried; `durable: true` gets an outbox row per subscribed event and
// rides the existing claim/attempt/abandon machinery. The handler receives the wire projection —
// the same snapshot a webhook subscriber gets — so durability never changes an event's meaning.
export interface BookingEventHook {
  name: string;
  events?: readonly BookingEvent[];
  durable?: boolean;
  handler(event: BookingEvent, booking: WireBooking, context: BookingEventHookContext): Promise<void>;
}
