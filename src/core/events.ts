import type { ResolvedClientConfig } from './config.js';
import type { Booking, WireBooking } from './booking.js';
import type { CalEvent } from './occupancy.js';
import type { ReservaResolvedRouteConfig } from '../routes-manifest.js';

// The closed set of emittable booking events, exported as a runtime value so hook/webhook
// `events` filters validate against it at startup. `BookingEvent` derives from it.
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

export interface PaymentCustomerDetails {
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  pickupAddress?: string | null;
}

// The closed set of payment events Reserva reacts to, exported as a runtime value so a provider
// can enumerate every case. An event outside this set keeps its vendor string; Reserva ignores it.
export const PAYMENT_EVENTS = [
  'checkout_completed',
  'checkout_expired',
  'refunded',
  'dispute_created',
] as const;

export type PaymentEvent = (typeof PAYMENT_EVENTS)[number];

export interface PaymentEventParsed extends PaymentCustomerDetails {
  id: string;
  type: PaymentEvent | (string & {});
  bookingId?: string;
  sessionRef?: string;
  paymentRef?: string;
  amountCaptured?: number;
  amountRefunded?: number;
  currency?: string;
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required' | string;
  // The provider's own id for the refund a 'refunded' event describes, so the webhook branch can
  // record which refund actually moved the money.
  refundRef?: string;
  paid?: boolean;
  raw?: unknown;
}

export interface SessionStatus extends PaymentCustomerDetails {
  id?: string;
  status: 'open' | 'complete' | 'expired' | string;
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required' | string;
  amountTotal?: number;
  currency?: string;
  paymentRef?: string | null;
  metadata?: Record<string, string>;
}

export type EmailBookingEvent = Exclude<BookingEvent, 'payment.dispute_created'>;

// Who a given event's email goes to. Kept generic (not provider-specific) so the mutation
// dispatcher can ask any provider which recipients apply.
export type EmailRecipientRole = 'customer' | 'owner';

export interface EmailProvider {
  // The whole resolved route config, not just its paths: an email template is a link producer, and
  // `routes.manage: false` means the manage page doesn't exist, so it needs `groups.manage` to know
  // whether the manage button is live. `PaymentProvider` stays paths-only — it never links to it.
  send(
    event: EmailBookingEvent,
    booking: Booking,
    config: ResolvedClientConfig,
    routeConfig?: ReservaResolvedRouteConfig,
  ): Promise<void>;
  // Optional per-recipient split: implementing both lets the dispatcher retry each recipient as
  // its own durable operation, so an owner-send failure can't cause a re-send to the customer.
  // Without them, `send` runs as one unsplit (but still durable) operation.
  recipientsForEvent?(event: EmailBookingEvent): EmailRecipientRole[];
  sendToRecipient?(
    recipient: EmailRecipientRole,
    event: EmailBookingEvent,
    booking: Booking,
    config: ResolvedClientConfig,
    routeConfig?: ReservaResolvedRouteConfig,
  ): Promise<void>;
}

export interface CalendarProvider {
  // Distinguishes occupancy cache entries when a deployment can select calendar sources.
  cacheKey?: string;
  listEvents(fromUtc: string, toUtc: string): Promise<CalEvent[]>;
  createEvent(booking: Booking, config: ResolvedClientConfig): Promise<string>;
  patchEvent(eventId: string, booking: Booking, config?: ResolvedClientConfig): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

// Provider-neutral: no name here belongs to any one vendor. Reserva ships one implementation
// (Stripe); a community adapter can implement this from its own package. Amounts are always minor
// units of the booking's own currency; a "ref" is whatever opaque id the provider uses.
export interface PaymentProvider {
  createCheckout(
    booking: Booking,
    config: ResolvedClientConfig,
    routePaths?: ReservaResolvedRouteConfig['paths'],
  ): Promise<{ url: string; sessionRef: string }>;
  parseWebhook(request: Request): Promise<PaymentEventParsed>;
  getSession(sessionRef: string): Promise<SessionStatus>;
  // The expected total lets a retry distinguish an incomplete historical partial refund from a
  // completed full refund; amountMinor reports the cumulative total the operation satisfied.
  refund(paymentRef: string, expectedAmountMinor: number): Promise<{ refundRef: string; amountMinor: number }>;
  // Optional synchronous config check, invoked once at runtime-definition init — never per
  // request. This is where a provider's own limits live (currencies, locales, session lifetime),
  // keeping core config validation vendor-neutral. Throw with the offending path and the fix.
  validateConfig?(config: ResolvedClientConfig): void;
}

export function isBookingEvent(value: string): value is BookingEvent {
  return (BOOKING_EVENTS as readonly string[]).includes(value);
}

// Lists the whole valid vocabulary in the rejection, so a hook author learns every event name
// from the error alone.
export function unknownBookingEventsMessage(event: string): string {
  return `Unknown booking event "${event}". Valid events: ${BOOKING_EVENTS.join(', ')}.`;
}

export function invalidSubscriberNameMessage(name: string): string {
  return `Invalid name "${name}": use 1-32 characters matching ${BOOKING_EVENT_SUBSCRIBER_NAME_PATTERN.source}.`;
}

export function validateBookingEventHooks(hooks: readonly BookingEventHook[]): void {
  const seen = new Set<string>();
  for (const hook of hooks) {
    if (!BOOKING_EVENT_SUBSCRIBER_NAME_PATTERN.test(hook.name)) {
      throw new Error(`Booking event hook: ${invalidSubscriberNameMessage(hook.name)}`);
    }
    if (seen.has(hook.name)) throw new Error(`Booking event hook name "${hook.name}" is registered twice; names must be unique.`);
    seen.add(hook.name);
    for (const event of hook.events ?? []) {
      if (!isBookingEvent(event)) throw new Error(`Booking event hook "${hook.name}": ${unknownBookingEventsMessage(event)}`);
    }
  }
}

// The alert channel to the central technical operator: reference/operation metadata only — no
// booking/customer ids, names, contact details, or tokens. `action`/`severity` mirror the
// operational-incident domain so the alert and the admin card describe the same thing.
export interface OperationalAlert {
  incidentId: string;
  reference: string;
  action: 'confirmation_email' | 'customer_notification' | 'calendar' | 'operations_sync' | 'refund' | 'oversell';
  severity: 'delayed' | 'action_required';
  attemptCount: number;
  firstDetectedAt: string;
  adminUrl: string;
}

// Durable delivery (claim/attempt/backoff) is the reconciler's job. `send` is a single
// best-effort attempt; a thrown error just means retry on the next claim pass.
export interface OperationalAlertSink {
  send(alert: OperationalAlert): Promise<void>;
}

// `apiVersion` is the dispatch-shape version; `id` is stable across retries for deduplication.
// The booking payload comes from `toWireBooking`, so pushed and pulled shapes can't fork. This is
// a historical record of the occurrence, never a cache of current state.
export const BOOKING_EVENT_API_VERSION = 1;

export interface BookingEventEnvelope {
  apiVersion: number;
  id: string;
  event: BookingEvent;
  occurredAt: string;
  data: { booking: WireBooking };
}

// Hook and webhook names share this domain because outbox rows
// distinguish them by their `family` column, not by a qualified string key.
export const BOOKING_EVENT_SUBSCRIBER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export interface BookingEventHookContext {
  // The envelope id of this occurrence: identical to what a webhook subscriber would receive, so a
  // hook can deduplicate against the same key an HTTP consumer does.
  id: string;
  occurredAt: string;
  config: ResolvedClientConfig;
}

// An in-process listener. `durable: false` (default) fires post-commit and is never retried;
// `durable: true` gets an outbox row and rides the existing claim/attempt/abandon machinery. The
// handler receives the same wire projection a webhook subscriber gets.
export interface BookingEventHook {
  name: string;
  events?: readonly BookingEvent[];
  durable?: boolean;
  handler(event: BookingEvent, booking: WireBooking, context: BookingEventHookContext): Promise<void>;
}
