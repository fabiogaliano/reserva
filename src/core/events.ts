import type { ClientConfig } from './config';
import type { Booking } from './booking';
import type { CalEvent } from './occupancy';
import type { BookkitResolvedRouteConfig } from '../routes-manifest';

export type BookingEvent =
  | 'booking.confirmed'
  | 'booking.cancelled_by_customer'
  | 'booking.cancelled_by_operator'
  | 'booking.rescheduled'
  | 'booking.no_show'
  | 'payment.dispute_created'
  | 'booking.reminder'
  | 'booking.review_request';

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
  // Returns the Stripe refund id + amount instead of discarding them (BK-REFUND-001), so the
  // caller can record what actually happened rather than just that the call didn't throw.
  refund(paymentIntent: string): Promise<{ refundId: string; amountCents: number }>;
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

export const bookingEvents: readonly BookingEvent[] = [
  'booking.confirmed',
  'booking.cancelled_by_customer',
  'booking.cancelled_by_operator',
  'booking.rescheduled',
  'booking.no_show',
  'payment.dispute_created',
  'booking.reminder',
  'booking.review_request',
];
