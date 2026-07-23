import type { Booking } from '../core/booking';
import type { ClientConfig } from '../core/config';
import type { BookingEvent, OpsSink } from '../core/events';

export const TOURFLOW_SOURCE = 'website' as const;
export const TOURFLOW_AUTHORIZATION_HEADER = 'Authorization';

// BK-SIDE-001 (handoff 13): cap the embedded response body (status pages / HTML error bodies are
// the realistic payloads) so an Error message — which a naive `String(error)` catch could
// otherwise dump verbatim into logs — is bounded, and expose `status` so a caller can log it as a
// structured field instead of parsing the message.
const MAX_ERROR_BODY_CHARS = 200;
export class TourflowResponseError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Tourflow webhook request failed (${status}): ${body.slice(0, MAX_ERROR_BODY_CHARS)}`);
    this.name = 'TourflowResponseError';
    this.status = status;
  }
}
export interface TourflowReservation {
  externalId: string; source: typeof TOURFLOW_SOURCE; operatorSlug?: string; reference: string; tourSlug: string;
  customerName: string | null; customerEmail: string | null; customerPhone: string | null; startsAt: string; endsAt: string;
  partySize: number; pickupType: Booking['pickupType']; pickupAddress: string | null; priceEurCents: number;
  paymentStatus: 'paid' | 'unpaid'; status: Booking['status']; event: BookingEvent; updatedAt: string;
}
export interface TourflowFeed { bookings: TourflowReservation[] }
export type TourflowBookingMapper = (event: BookingEvent, booking: Booking, config?: ClientConfig, operatorSlug?: string) => TourflowReservation;
export interface TourflowOpsSinkOptions {
  webhookUrl: string; sharedSecret: string; operatorSlug?: string; fetch?: typeof fetch; fetchImpl?: typeof fetch;
  mapBooking?: TourflowBookingMapper; map?: TourflowBookingMapper;
}
function eventForBooking(booking: Booking): BookingEvent {
  if (booking.status === 'no_show') return 'booking.no_show';
  if (booking.status === 'cancelled') return booking.cancelledBy === 'customer' ? 'booking.cancelled_by_customer' : 'booking.cancelled_by_operator';
  if (booking.rescheduledFrom) return 'booking.rescheduled';
  return 'booking.confirmed';
}
export const mapTourflowBooking: TourflowBookingMapper = (event, booking, _config, operatorSlug) => ({
  externalId: booking.id, source: TOURFLOW_SOURCE, ...(operatorSlug ? { operatorSlug } : {}), reference: booking.reference, tourSlug: booking.tourSlug,
  customerName: booking.customerName, customerEmail: booking.customerEmail, customerPhone: booking.customerPhone, startsAt: booking.startsAt, endsAt: booking.endsAt,
  partySize: booking.people, pickupType: booking.pickupType, pickupAddress: booking.pickupAddress, priceEurCents: booking.priceCents,
  paymentStatus: booking.stripePaymentIntent && booking.status !== 'hold' ? 'paid' : 'unpaid', status: booking.status, event, updatedAt: booking.updatedAt,
});
export function mapTourflowFeed(bookings: readonly Booking[], config: ClientConfig, operatorSlug?: string, mapper: TourflowBookingMapper = mapTourflowBooking): TourflowFeed {
  return { bookings: bookings.map((booking) => mapper(eventForBooking(booking), booking, config, operatorSlug)) };
}
export const toTourflowReservation = mapTourflowBooking;
export const toTourflowFeed = mapTourflowFeed;
export const mapBookingForTourflow = mapTourflowBooking;
export class TourflowOpsSink implements OpsSink {
  private readonly webhookUrl: string; private readonly sharedSecret: string; private readonly operatorSlug: string | undefined; private readonly request: typeof fetch; private readonly mapper: TourflowBookingMapper;
  constructor(options: TourflowOpsSinkOptions) {
    if (!options.webhookUrl) throw new Error('Tourflow webhookUrl is required'); if (!options.sharedSecret) throw new Error('Tourflow sharedSecret is required');
    this.webhookUrl = options.webhookUrl; this.sharedSecret = options.sharedSecret; this.operatorSlug = options.operatorSlug;
    this.request = options.fetchImpl ?? options.fetch ?? globalThis.fetch.bind(globalThis); this.mapper = options.mapBooking ?? options.map ?? mapTourflowBooking;
  }
  mapBooking(booking: Booking, config: ClientConfig): TourflowReservation {
    return this.mapper(eventForBooking(booking), booking, config, this.operatorSlug);
  }
  async push(event: BookingEvent, booking: Booking): Promise<void> {
    const response = await this.request(this.webhookUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', [TOURFLOW_AUTHORIZATION_HEADER]: `Bearer ${this.sharedSecret}` }, body: JSON.stringify(this.mapper(event, booking, undefined, this.operatorSlug)) });
    if (!response.ok) throw new TourflowResponseError(response.status, await response.text());
  }
}
export function tourflow(options: TourflowOpsSinkOptions): TourflowOpsSink { return new TourflowOpsSink(options); }
export const createTourflowOpsSink = tourflow;
