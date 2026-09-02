import type { PickupType } from './config.js';
import { addMinutes, compareInstants, parseUtcInstant } from './time.js';

export const bookingStatuses = ['hold', 'confirmed', 'cancelled', 'expired', 'no_show'] as const;
export type BookingStatus = (typeof bookingStatuses)[number];
export type CancellationActor = 'customer' | 'operator';

export interface Booking {
  id: string;
  reference: string;
  serviceSlug: string;
  quantity: number;
  // Valid ids live in `ServiceConfig.pickupOptions`, per service — neither the DB nor this type
  // enumerates them. NULL means the service declares no location options.
  pickupType: PickupType | null;
  pickupAddress: string | null;
  // Resolved meeting point chosen at checkout, when the service declares more than one. `label`
  // is a point-in-time snapshot, used only as a fallback when the id is no longer in config.
  meetingPointId: string | null;
  meetingPointLabel: string | null;
  startsAt: string;
  endsAt: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  locale: string;
  priceMinor: number;
  // Captured per booking so a currency change in config can never re-denominate money already taken.
  currency: string;
  status: BookingStatus;
  holdExpiresAt: string | null;
  paymentSessionRef: string | null;
  paymentRef: string | null;
  calendarEventId: string | null;
  // Declared and validated via `ServiceConfig.metadataFields`; this column only carries the value.
  metadata: Record<string, unknown> | null;
  cancelToken: string;
  operatorToken: string;
  cancelledAt: string | null;
  cancelledBy: CancellationActor | null;
  rescheduledFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BookingPatch = Partial<Omit<Booking, 'id' | 'reference' | 'status'>>;

// The one public projection of a booking. Webhooks, hooks, and the status/manage wire types all
// read through this, so pushed and pulled shapes can't diverge; built field by field so a future
// column can't leak a token by accident. `updatedAt` lets consumers reject out-of-order updates.
export interface WireBooking {
  id: string;
  reference: string;
  serviceSlug: string;
  quantity: number;
  pickupType: PickupType | null;
  pickupAddress: string | null;
  meetingPointId: string | null;
  meetingPointLabel: string | null;
  startsAt: string;
  endsAt: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  locale: string;
  priceMinor: number;
  currency: string;
  status: BookingStatus;
  cancelledBy: CancellationActor | null;
  rescheduledFrom: string | null;
  // Raw consumer-declared record, not the labeled rows read surfaces render. Absent is `{}`,
  // never `null`, per the collection empty-value convention.
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function toWireBooking(booking: Booking): WireBooking {
  return {
    id: booking.id,
    reference: booking.reference,
    serviceSlug: booking.serviceSlug,
    quantity: booking.quantity,
    pickupType: booking.pickupType,
    pickupAddress: booking.pickupAddress,
    meetingPointId: booking.meetingPointId,
    meetingPointLabel: booking.meetingPointLabel,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    locale: booking.locale,
    priceMinor: booking.priceMinor,
    currency: booking.currency,
    status: booking.status,
    cancelledBy: booking.cancelledBy,
    rescheduledFrom: booking.rescheduledFrom,
    metadata: booking.metadata ?? {},
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  };
}

export class BookingTransitionError extends Error {
  readonly from: BookingStatus;
  readonly to: BookingStatus;

  constructor(from: BookingStatus, to: BookingStatus) {
    super(`Invalid booking transition: ${from} -> ${to}`);
    this.name = 'BookingTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) return true;
  if (from === 'hold') return to === 'confirmed' || to === 'expired';
  if (from === 'expired') return to === 'confirmed';
  if (from === 'confirmed') return to === 'cancelled' || to === 'no_show';
  return false;
}

export function transitionBooking(
  booking: Booking,
  to: BookingStatus,
  now: string | Date = new Date(),
  patch: BookingPatch = {},
): Booking {
  if (!canTransition(booking.status, to)) throw new BookingTransitionError(booking.status, to);
  if (booking.status === to) return booking;
  if (to === 'cancelled' && patch.cancelledBy !== 'customer' && patch.cancelledBy !== 'operator') {
    throw new Error('cancelledBy is required for cancellation');
  }
  const timestamp = parseUtcInstant(now).toISOString();
  const next: Booking = { ...booking, ...patch, status: to, updatedAt: timestamp };
  if (to === 'confirmed' || to === 'expired') next.holdExpiresAt = null;
  if (to === 'cancelled') next.cancelledAt = timestamp;
  return next;
}

export function confirmBooking(booking: Booking, now: string | Date = new Date(), patch: BookingPatch = {}): Booking {
  return transitionBooking(booking, 'confirmed', now, patch);
}

export function expireBooking(booking: Booking, now: string | Date = new Date()): Booking {
  return transitionBooking(booking, 'expired', now);
}

export function cancellationDeadline(booking: Booking, cutoffHours: number): Date {
  return new Date(parseUtcInstant(booking.startsAt).getTime() - cutoffHours * 3_600_000);
}

export function canCancelBooking(booking: Booking, now: string | Date, cutoffHours: number): boolean {
  if (booking.status !== 'confirmed') return false;
  return parseUtcInstant(now).getTime() <= cancellationDeadline(booking, cutoffHours).getTime();
}

export const isCancellationAllowed = canCancelBooking;

export function cancelBooking(
  booking: Booking,
  actor: CancellationActor,
  now: string | Date = new Date(),
): Booking {
  if (booking.status === 'cancelled') return booking;
  return transitionBooking(booking, 'cancelled', now, { cancelledBy: actor });
}

export function canRescheduleBooking(
  booking: Booking,
  now: string | Date,
  cutoffHours: number,
  enabled = true,
): boolean {
  if (!enabled || booking.status !== 'confirmed') return false;
  return parseUtcInstant(now).getTime() <= cancellationDeadline(booking, cutoffHours).getTime();
}

export function rescheduleBooking(
  booking: Booking,
  newStartsAt: string | Date,
  durationMin: number,
  now: string | Date = new Date(),
): Booking {
  if (booking.status !== 'confirmed') throw new BookingTransitionError(booking.status, 'confirmed');
  if (!Number.isInteger(durationMin) || durationMin < 1) throw new RangeError('durationMin must be a positive integer');
  const start = parseUtcInstant(newStartsAt).toISOString();
  const end = addMinutes(start, durationMin).toISOString();
  return {
    ...booking,
    startsAt: start,
    endsAt: end,
    rescheduledFrom: booking.startsAt,
    updatedAt: parseUtcInstant(now).toISOString(),
  };
}

export function markNoShow(booking: Booking, now: string | Date = new Date()): Booking {
  if (booking.status !== 'confirmed') throw new BookingTransitionError(booking.status, 'no_show');
  if (compareInstants(now, booking.startsAt) <= 0) {
    throw new Error('A booking can only be marked no-show after its start');
  }
  return transitionBooking(booking, 'no_show', now);
}

export function isHoldActive(booking: Pick<Booking, 'status' | 'holdExpiresAt'>, now: string | Date = new Date()): boolean {
  return booking.status === 'hold' && booking.holdExpiresAt !== null && compareInstants(now, booking.holdExpiresAt) <= 0;
}
