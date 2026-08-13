import type { PickupType } from './config';
import { addMinutes, compareInstants, parseUtcInstant } from './time';

export const bookingStatuses = ['hold', 'confirmed', 'cancelled', 'expired', 'no_show'] as const;
export type BookingStatus = (typeof bookingStatuses)[number];
export type CancellationActor = 'customer' | 'operator';

export interface Booking {
  id: string;
  reference: string;
  tourSlug: string;
  people: number;
  // Plan 018 (design decision 2/4): widened from the fixed 'default' | 'custom' union — the
  // pickup domain now lives in TourConfig.pickupOptions (core/config.ts), not the DB or this type.
  pickupType: PickupType;
  pickupAddress: string | null;
  // Plan 017 (design decision 3): the resolved meeting point chosen at checkout, when the tour
  // declares more than one. label is a point-in-time snapshot, used only as a fallback when the id
  // is no longer declared in config (see migrations/0014_meeting_points.sql). Both null for
  // pre-0014 rows.
  meetingPointId: string | null;
  meetingPointLabel: string | null;
  startsAt: string;
  endsAt: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  locale: string;
  priceCents: number;
  status: BookingStatus;
  holdExpiresAt: string | null;
  stripeSessionId: string | null;
  stripePaymentIntent: string | null;
  calendarEventId: string | null;
  calendarSynced: boolean;
  emailSynced: boolean;
  tourflowSynced: boolean;
  remindedAt: string | null;
  reviewRequestedAt: string | null;
  cancelToken: string;
  operatorToken: string;
  cancelledAt: string | null;
  cancelledBy: CancellationActor | null;
  rescheduledFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BookingPatch = Partial<Omit<Booking, 'id' | 'reference' | 'status'>>;

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
