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
  paymentIntent?: string | null;
  metadata?: Record<string, string>;
}

export type EmailBookingEvent = Exclude<BookingEvent, 'payment.dispute_created'>;

export interface EmailProvider {
  send(
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routePaths?: BookkitResolvedRouteConfig['paths'],
  ): Promise<void>;
}

export interface CalendarProvider {
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
