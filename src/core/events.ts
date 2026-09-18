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
  'booking.reminder',
  'payment.dispute_created',
] as const;

export type BookingEvent = (typeof BOOKING_EVENTS)[number];

// Events that describe the deployment rather than a booking. Kept in their own list because a
// booking payload is exactly what they do NOT have: no booking id, no outbox row (the durable
// outbox is keyed by booking), and a `data` shape of their own.
export const SETTINGS_EVENTS = ['settings.changed'] as const;

export type SettingsEvent = (typeof SETTINGS_EVENTS)[number];

// The whole subscribable vocabulary: what `config.webhooks[].events` and hook `events` filters
// validate against. `BOOKING_EVENTS` stays the booking-payload set.
export const WEBHOOK_EVENTS = [...BOOKING_EVENTS, ...SETTINGS_EVENTS] as const;

export type WebhookEvent = BookingEvent | SettingsEvent;

export interface BookingEventPayload {
  bookingId: string;
  reference: string;
  event: BookingEvent;
  occurredAt: string;
  previousStartsAt?: string;
  cancelledBy?: 'customer' | 'operator';
  refund?: 'full' | 'none' | 'partial';
  // Present only for `refund: 'partial'`: the minor-unit amount the operator decided to return.
  refundAmountMinor?: number;
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
  // A delayed payment method (voucher, bank debit) that settled after Reserva already refused the
  // checkout and released the hold: the money arrived for a booking that does not exist, so it is
  // refunded rather than confirmed.
  'async_payment_succeeded',
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

// Every emittable booking event has customer or owner copy, including the one that is not a
// booking transition: a dispute is owner-only mail (see `recipientsForEvent`).
export type EmailBookingEvent = BookingEvent;

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
  // A plain message with no booking behind it, so Reserva can reuse a transport the deployment
  // already configured for something that is not a booking email — today, operational alerts.
  // Optional: a provider that only knows how to render bookings stays valid.
  sendMessage?(message: EmailMessage): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
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
  // `expiresAt` (UTC ISO) is when the provider's payment page stops accepting payment; optional
  // because not every processor exposes one, and callers fall back to the hold expiry.
  //
  // Contract: the session and the payment object it creates must both carry `bookingId` in their
  // provider metadata — the webhook is the only place Reserva can recover which booking the money
  // belongs to, and a session-only copy is lost on charge-level events (refunds, disputes).
  // The call must be idempotent per `booking.id`: a retried checkout has to return the same
  // session rather than mint a second, orphaned one.
  createCheckout(
    booking: Booking,
    config: ResolvedClientConfig,
    routePaths?: ReservaResolvedRouteConfig['paths'],
  ): Promise<{ url: string; sessionRef: string; expiresAt?: string }>;
  // Must throw when the signature does not verify — Reserva turns the throw into a 400 and never
  // inspects the body itself, so a lenient implementation would accept forged events.
  parseWebhook(request: Request): Promise<PaymentEventParsed>;
  getSession(sessionRef: string): Promise<SessionStatus>;
  // Best-effort by contract: Reserva calls it to stop money that should never have moved (a
  // delayed payment method Reserva refuses). An implementation that cannot cancel — or whose
  // provider rejects the call — is expected to resolve, not throw; a booking is never blocked on it.
  cancelPayment?(paymentRef: string): Promise<void>;
  // Must be idempotent per `paymentRef`: Reserva retries refunds from a durable queue, so a
  // second call for the same payment has to report the original refund instead of moving money
  // twice. The expected total lets a retry distinguish an incomplete historical partial refund
  // from a completed full refund; amountMinor reports the cumulative total the operation satisfied.
  // `expectedAmountMinor` is the amount to move, not necessarily the whole charge — an operator
  // may refund part of a booking — so an implementation must send it to the provider explicitly
  // rather than relying on a refund-everything default. Reserva makes at most one refund call per
  // booking, so the amount for a given `paymentRef` never changes between retries.
  refund(paymentRef: string, expectedAmountMinor: number): Promise<{ refundRef: string; amountMinor: number }>;
  // Optional synchronous config check, invoked once at runtime-definition init — never per
  // request. This is where a provider's own limits live (currencies, locales, session lifetime),
  // keeping core config validation vendor-neutral. Throw with the offending path and the fix.
  validateConfig?(config: ResolvedClientConfig): void;
}

export function isBookingEvent(value: string): value is BookingEvent {
  return (BOOKING_EVENTS as readonly string[]).includes(value);
}

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

// Lists the whole valid vocabulary in the rejection, so a hook author learns every event name
// from the error alone.
export function unknownBookingEventsMessage(event: string): string {
  return `Unknown booking event "${event}". Valid events: ${WEBHOOK_EVENTS.join(', ')}.`;
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
      if (!isWebhookEvent(event)) throw new Error(`Booking event hook "${hook.name}": ${unknownBookingEventsMessage(event)}`);
    }
  }
}

// The alert channel to the central technical operator: reference/operation metadata only — no
// booking/customer ids, names, contact details, or tokens. `action`/`severity` mirror the
// operational-incident domain so the alert and the admin card describe the same thing.
export interface OperationalAlert {
  incidentId: string;
  reference: string;
  action: 'confirmation_email' | 'customer_notification' | 'calendar' | 'operations_sync' | 'refund' | 'oversell'
    | 'payment_verification_rejected' | 'reconciliation_stale';
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

// One row of the admin save that produced a `settings.changed` occurrence — the `admin_changes`
// row itself, not a projection of the new config: a receiver rebuilds from the catalog, so what
// it needs is "something in this domain moved", not the value.
export interface SettingsChange {
  domain: 'setting' | 'day_override' | 'capacity_default';
  key: string;
  action: 'upsert' | 'delete';
  actor: string | null;
}

// Same envelope shape as a booking event, with a `data` of its own: there is no booking behind a
// settings save, so `data.booking` would be a lie rather than an omission.
export interface SettingsEventEnvelope {
  apiVersion: number;
  id: string;
  event: SettingsEvent;
  occurredAt: string;
  data: { changes: SettingsChange[] };
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

export interface SettingsEventHookContext extends BookingEventHookContext {
  changes: SettingsChange[];
}

// A tuple union rather than three independent parameters, so the event name narrows the other two:
// `settings.changed` has no booking, and only it carries `changes`.
export type BookingEventHookArgs =
  | [event: BookingEvent, booking: WireBooking, context: BookingEventHookContext]
  | [event: SettingsEvent, booking: null, context: SettingsEventHookContext];

// An in-process listener. `durable: false` (default) fires post-commit and is never retried;
// `durable: true` gets an outbox row and rides the existing claim/attempt/abandon machinery. The
// handler receives the same wire projection a webhook subscriber gets.
// `settings.changed` is never durable: the outbox is keyed by booking, so a settings subscriber
// gets the same best-effort, in-request delivery a non-durable hook gets, whatever `durable` says.
export interface BookingEventHook {
  name: string;
  events?: readonly WebhookEvent[];
  durable?: boolean;
  handler(...args: BookingEventHookArgs): Promise<void>;
}
