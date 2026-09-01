import type { ClientConfig } from './config.js';
import type { Booking, WireBooking } from './booking.js';
import type { CalEvent } from './occupancy.js';
import type { ReservaResolvedRouteConfig } from '../routes-manifest.js';

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

export interface PaymentCustomerDetails {
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  pickupAddress?: string | null;
}

// Plan 022 (design decision 7): the closed set of payment events Reserva reacts to, exported as a
// runtime VALUE so a provider author (or an agent) can enumerate every case an adapter has to map
// its vendor's event names onto. A provider that parses an event outside this set returns its own
// vendor string and Reserva ignores it, which is why `type` stays open.
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
  // The provider's own id for the refund a 'refunded' event describes, when its payload carries one
  // — lets the webhook branch record which refund actually moved the money, not just that a refund
  // happened (BK-REFUND-001).
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

// BK-SIDE-001 (handoff 13): who a given event's email goes to. Kept generic here (not
// Brevo-specific) so the mutation dispatcher (src/confirmation.ts) can ask any provider which
// recipients apply without depending on a concrete implementation's template config.
export type EmailRecipientRole = 'customer' | 'owner';

export interface EmailProvider {
  // Plan 027 (design decision 8): the whole resolved route config, not just its paths — an email
  // template is a link producer, and `routes.manage: false` means the built-in manage page doesn't
  // exist, so a renderer needs `groups.manage` to decide whether the manage button is a live link
  // or a dead one. (PaymentProvider stays paths-only: it never links into an optional page.)
  send(
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routeConfig?: ReservaResolvedRouteConfig,
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
    routeConfig?: ReservaResolvedRouteConfig,
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

// Plan 022 (design decision 7): provider-neutral by construction — no name here belongs to any one
// payment vendor. Reserva ships and tests exactly one implementation (Stripe), but a community
// adapter implements this same interface from its own package, using only the exported core types
// and helpers. Amounts are always minor units of the booking's own currency (core/currency.ts); a
// "ref" is whatever opaque identifier the provider uses for that object.
export interface PaymentProvider {
  createCheckout(
    booking: Booking,
    config: ClientConfig,
    routePaths?: ReservaResolvedRouteConfig['paths'],
  ): Promise<{ url: string; sessionRef: string }>;
  parseWebhook(request: Request): Promise<PaymentEventParsed>;
  getSession(sessionRef: string): Promise<SessionStatus>;
  // The expected total lets a retry distinguish an incomplete historical partial refund from a
  // completed full refund; amountMinor reports the cumulative total the operation satisfied.
  refund(paymentRef: string, expectedAmountMinor: number): Promise<{ refundRef: string; amountMinor: number }>;
  // Optional synchronous config check, invoked exactly once while the runtime definition
  // initializes (runtime-context.ts) — never per request and never at first checkout. This is where
  // a provider's OWN limits live (its supported currencies and locales, how long it lets a checkout
  // session stay open), so core config validation can stay vendor-neutral. Throw with the offending
  // config path and the fix; the deployment fails before it serves anything.
  validateConfig?(config: ClientConfig): void;
}

export function isBookingEvent(value: string): value is BookingEvent {
  return (BOOKING_EVENTS as readonly string[]).includes(value);
}

// Plan 021 (design decision 1): a subscriber's `events` filter is checked against the catalog at
// startup, and the rejection lists the whole valid vocabulary — an agent wiring a hook learns every
// event name from the error alone, without reading source.
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
